/*
 * Original code for bluray-web: BD-J saved data on the NAS, per person (the NAS store contract; spec §4.4, rulings
 * R15 and R17). NasBdjStore is the HTTP client of `bdj-store/<scope>`; WriteAheadNasStore keeps every change in this
 * browser's IndexedDB first (100 ms after a write, marked pending) and puts it on the NAS 2 s later, so a page closed
 * before the NAS has it loses nothing here and the NAS catches up at the next open; NasDiscStore picks between them
 * for a disc opened from a server, by whose device this is (`GET me`).
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import {
  NasQuotaError, SCOPE_QUOTA_BYTES, ScopeQuotaError, mergeKeepingRemote, mergeSnapshots, sameSnapshot, snapshotBytes, sortFiles,
  type BdjStore, type LoadedSnapshot, type SaveResult, type Snapshot, type SnapshotFile, type StorageLoss,
} from './bdj-store';
import { IDB_SAVE_DEBOUNCE_MS, IdbBdjStore, recordKey, type ScopeRecord } from './idb-store';
import { readTar, tarPathFits, writeTar } from './tar';

/** A store request that has not answered after this long has failed (the write-ahead copy keeps the data). */
export const NAS_STORE_REQUEST_TIMEOUT_MS = 15_000;
/** A 503 (the scope's lock is busy) is tried again this many times, after its Retry-After (1 s). */
export const NAS_STORE_BUSY_RETRIES = 5;
/** The NAS put follows the last write by this much (the plan's 2 s; the write-ahead copy is saved after 100 ms). */
export const NAS_PUSH_DEBOUNCE_MS = 2000;
/** A disc that keeps writing is still put on the NAS this often. */
export const NAS_PUSH_MAX_WAIT_MS = 10_000;
/** After a put that failed (the NAS unreachable), the next try, while BD-J runs. */
export const NAS_PUSH_RETRY_MS = 30_000;
/**
 * The NAS's part of the boot: whose device this is, each scope's snapshot and the check of whose device it is after
 * that GET, within this long from the store's creation, or the scope loads from this browser's copy (ruling R28: in
 * line with the disc's own reads on a slow link, the WebRTC route's; the load counts as I/O for the start-up timer,
 * whose 120 s ceiling bounds it, ruling R26). The three requests go one after another, so each has about 4 s.
 */
export const NAS_LOAD_BUDGET_MS = 12_000;
/** ScopeSync waits this much longer than the budget (BdjStore.loadTimeoutMs), so the store's own fallback answers first. */
export const NAS_LOAD_MARGIN_MS = 500;
/** A save that keeps meeting newer snapshots on the NAS gives up after this many tries (until the next push). */
const PUSH_ATTEMPTS = 3;

type SetTimer = (ms: number, fn: () => void) => () => void;
type Log = (line: string, error?: boolean) => void;

/** A request to the NAS store that failed: its HTTP status, or null when the NAS did not answer. */
export class NasStoreError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'NasStoreError';
  }
}

/**
 * The device is no longer the person a write was meant for (the NAS session's X-Bdj-Person guard answered 409
 * `person-changed`, or `GET me` named someone else before the write): nothing was written.
 */
export class PersonChangedError extends NasStoreError {
  constructor(message = 'this device now belongs to another person on the NAS') {
    super(409, message);
    this.name = 'PersonChangedError';
  }
}

/**
 * Whether a failed put will not go through however often it is tried (the bdj-storage notice, ruling R32): the NAS
 * answered a 4xx that is not a conflict or a request to wait (a 401 here is a device no longer paired: its fresh token
 * was refused or never came). An unreachable NAS, a timeout, a 5xx (a 503 past its retries) and a 412 that kept
 * changing are tried again.
 */
export function failedForGood(e: unknown): boolean {
  if (!(e instanceof NasStoreError) || e instanceof PersonChangedError || e.status === null) return false;
  return e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 412 && e.status !== 425 && e.status !== 429;
}

/** The request header naming the person a write is for (the NAS store contract's X-Bdj-Person guard). */
export const PERSON_HEADER = 'X-Bdj-Person';

/**
 * The NAS APIs (by API base) that have answered a write carrying X-Bdj-Person (ruling R25): their CORS takes it, so a
 * write there that cannot leave is a network failure, never sent again without the header. Kept for the worker's
 * life (one BD-J session); see NasBdjStore.write.
 */
const personHeaderAccepted = new Set<string>();

/** Answers that prove a write carrying the header reached the server (its CORS let it through). */
const REACHED = (status: number): boolean => (status >= 200 && status < 300) || status === 409 || status === 412 || status === 507;

/** Per write, before each PUT is sent (503 retries included): throws (PersonChangedError) to send nothing. */
export interface SaveOptions {
  readonly beforePut?: () => Promise<void>;
}

/** The NAS API base (`…/api/`) of a disc's base (`…/api/discs/<id>/`, RemoteDiscSpec.base); null for another shape. */
export function storeApiBase(discBase: string): string | null {
  const m = /^(.*\/)discs\/[^/]+\/$/.exec(discBase);
  return m ? m[1]! : null;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface NasBdjStoreDeps {
  readonly fetch: typeof fetch;
  /** The device's session token (the disc's); a 401 asks `refreshToken` for a fresh one, once per request. */
  readonly token: string;
  readonly refreshToken?: () => Promise<string>;
  /** Waits out a 503's Retry-After; setTimeout by default. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly log?: (line: string, error?: boolean) => void;
}

/**
 * The NAS store's HTTP API (`<api>bdj-store/<scope>`, `<api>me`), the token as `t=` as for the disc's reads. A scope
 * is a ustar snapshot under a quoted ETag, sent back exactly as received: PUT with `If-Match: "<etag>"`, or
 * `If-None-Match: *` when the NAS has none; a 412 answers what the NAS holds now, as a conflict; a 507 throws
 * NasQuotaError; a 503 is tried again after its Retry-After.
 */
export class NasBdjStore implements BdjStore {
  readonly saveDebounceMs = NAS_PUSH_DEBOUNCE_MS;
  readonly quotaAccounting = 'tar';
  private token: string;
  private refreshing: Promise<string> | null = null;
  /** Sent as X-Bdj-Person on every write once known (setPerson). */
  private person: string | null = null;
  /** The fallback without X-Bdj-Person was logged (once). */
  private headerFallbackLogged = false;

  constructor(
    readonly apiBase: string,
    private readonly deps: NasBdjStoreDeps,
  ) {
    this.token = deps.token;
  }

  setToken(token: string): void {
    this.token = token;
  }

  /** The person every write is for (X-Bdj-Person): a NAS with the guard refuses it (409) once the token is someone else's. */
  setPerson(personId: string): void {
    this.person = personId;
  }

  /** Whose device this is: null when the server keeps no people (the dev disc server, an older NAS). */
  async me(): Promise<{ readonly personId: string; readonly personName: string | null } | null> {
    const res = await this.send('GET', 'me');
    if (res.status === 404) return discard(res, null);
    if (res.status !== 200) throw await failure(res, 'me');
    const body = (await res.json()) as { personId?: unknown; personName?: unknown };
    if (typeof body.personId !== 'string' || body.personId === '') return null;
    return { personId: body.personId, personName: typeof body.personName === 'string' ? body.personName : null };
  }

  async load(scope: string): Promise<LoadedSnapshot> {
    const res = await this.send('GET', `bdj-store/${scope}`);
    if (res.status !== 200) throw await failure(res, scope);
    const etag = res.headers.get('ETag');
    const files = readTar(new Uint8Array(await res.arrayBuffer()));
    return { files: sortFiles(files), etag: etag ?? null };
  }

  async save(scope: string, snapshot: Snapshot, etag: string | null, opts: SaveOptions = {}): Promise<SaveResult> {
    const body = writeTar(snapshot.files);
    // the NAS refuses an archive over 16 MB (`>`, so exactly 16 MB is taken): refused here, without the 507's round trip
    if (body.length > SCOPE_QUOTA_BYTES) throw new NasQuotaError(scope, body.length, 'scope');
    const res = await this.send('PUT', `bdj-store/${scope}`, {
      'Content-Type': 'application/x-tar',
      ...(etag !== null ? { 'If-Match': etag } : { 'If-None-Match': '*' }),
    }, body, opts.beforePut);
    switch (res.status) {
      case 200: {
        const next = res.headers.get('ETag');
        await discard(res, null);
        if (next === null) throw new NasStoreError(200, `${scope}: the NAS answered no ETag`);
        return { etag: next };
      }
      case 412: {
        // stored meanwhile elsewhere (another device of this person): what is there now, to merge
        await discard(res, null);
        const now = await this.load(scope);
        return { conflict: now };
      }
      case 409: {
        let error: unknown = null;
        try {
          error = ((await res.json()) as { error?: unknown }).error;
        } catch {
          // no JSON body
        }
        if (error === 'person-changed') throw new PersonChangedError(`${scope}: the NAS refused the write: this device now belongs to another person`);
        throw new NasStoreError(409, `${scope}: HTTP 409${typeof error === 'string' ? `: ${error}` : ''}`);
      }
      case 507: {
        let limit: 'scope' | 'person' = 'scope';
        try {
          if (((await res.json()) as { limit?: unknown }).limit === 'person') limit = 'person';
        } catch {
          // the scope's, when the body does not say
        }
        // the archive's size, as the NAS counts it (ruling R24)
        throw new NasQuotaError(scope, body.length, limit);
      }
      default:
        throw await failure(res, scope);
    }
  }

  /** One request, with a fresh token after a 401 (once) and again after a 503's Retry-After. */
  private async send(
    method: 'GET' | 'PUT',
    path: string,
    headers: Record<string, string> = {},
    body?: Uint8Array<ArrayBuffer>,
    beforePut?: () => Promise<void>,
  ): Promise<Response> {
    let refreshed = false;
    for (let busy = 0; ; ) {
      const token = this.token;
      if (method === 'PUT') await beforePut?.();
      const res = await this.write(method, path, token, headers, body);
      if (res.status === 401) {
        await discard(res, null);
        if (refreshed || !this.deps.refreshToken) throw new NasStoreError(401, 'this device is no longer paired with the NAS');
        refreshed = true;
        // a request that went out with an older token tries the current one first
        if (this.token === token) {
          this.refreshing ??= this.deps.refreshToken().finally(() => (this.refreshing = null));
          try {
            this.token = await this.refreshing;
          } catch (e) {
            throw new NasStoreError(401, `no fresh session token (${messageOf(e)})`);
          }
        }
        continue;
      }
      if (res.status === 503 && busy < NAS_STORE_BUSY_RETRIES) {
        busy++;
        const seconds = Number(res.headers.get('Retry-After'));
        await discard(res, null);
        await (this.deps.sleep ?? sleep)(Number.isFinite(seconds) && seconds >= 0 && res.headers.has('Retry-After') ? seconds * 1000 : 1000);
        continue;
      }
      return res;
    }
  }

  /** A request, a write carrying X-Bdj-Person while the server takes it. */
  private async write(method: 'GET' | 'PUT', path: string, token: string, headers: Record<string, string>, body?: Uint8Array<ArrayBuffer>): Promise<Response> {
    if (method === 'GET' || this.person === null) return this.request(method, path, token, headers, body);
    try {
      const res = await this.request(method, path, token, { ...headers, [PERSON_HEADER]: this.person }, body);
      if (REACHED(res.status)) personHeaderAccepted.add(this.apiBase);
      return res;
    } catch (e) {
      if (!(e instanceof NasStoreError) || e.status !== null) throw e;
      // this NAS has taken the header before: a write that cannot leave is the network's, kept pending and tried again
      // later with the header (ruling R25), never sent without it
      if (personHeaderAccepted.has(this.apiBase)) throw e;
      // unreachable with the header: a server from before the guard refuses it in CORS (the browser then sends nothing),
      // which a page cannot tell from a network failure. This one write goes again without it, right after the caller's
      // own check of whose device this is (beforePut); the next write tries the header first again, so a server with
      // the guard keeps it for every write that reaches it
      const res = await this.request(method, path, token, headers, body);
      if (!this.headerFallbackLogged) {
        this.headerFallbackLogged = true;
        this.deps.log?.(`BD-J storage: a write with the ${PERSON_HEADER} header did not reach the NAS, and went without it (a server from before its guard)`, true);
      }
      return res;
    }
  }

  private async request(method: string, path: string, token: string, headers: Record<string, string>, body?: Uint8Array<ArrayBuffer>): Promise<Response> {
    const url = `${this.apiBase}${path}?t=${encodeURIComponent(token)}`;
    const controller = new AbortController();
    const timeoutMs = this.deps.timeoutMs ?? NAS_STORE_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.deps.fetch(url, { method, headers, ...(body ? { body } : {}), signal: controller.signal, cache: 'no-store' });
      // the body too, within the time: a scope is at most 16 MB
      const bytes = res.status === 200 || res.status === 507 ? await res.arrayBuffer() : null;
      return bytes === null ? res : new Response(bytes, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
      if (controller.signal.aborted) throw new NasStoreError(null, `the NAS did not answer within ${timeoutMs / 1000} s`);
      throw new NasStoreError(null, `the NAS could not be reached (${messageOf(e)})`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discard<T>(res: Response, value: T): Promise<T> {
  try {
    await res.body?.cancel();
  } catch {
    // already read
  }
  return value;
}

/** A NasStoreError naming the status and the body's `error`. */
async function failure(res: Response, what: string): Promise<NasStoreError> {
  let error = '';
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') error = `: ${body.error}`;
  } catch {
    // no JSON body
  }
  return new NasStoreError(res.status, `${what}: HTTP ${res.status}${error}`);
}

/** Rejects with `budget`'s reason if it settles first. */
function within<T>(p: Promise<T>, budget: Promise<never>): Promise<T> {
  return Promise.race([p, budget]);
}

/** The record marked as on the NAS (and merged with it), its files and version as they are. */
function settled(r: ScopeRecord): ScopeRecord {
  const { unmerged, ...rest } = r;
  void unmerged;
  return { ...rest, pending: false };
}

/** The write-ahead copies of one person's scopes, in this browser: the IndexedDB source of a NAS person. */
export function personSource(personId: string): string {
  return `nas-person:${personId}`;
}

/**
 * The copies saved in a session whose `GET me` did not answer (ruling R28), on a device last confirmed as `personId`
 * (DEVICE_SOURCE): the next boot whose `GET me` names that same person merges them into the person's write-ahead
 * copy; a boot that names another person leaves them (never another person's).
 */
export function unconfirmedSource(apiBase: string, personId: string): string {
  return `${UNCONFIRMED_PREFIX}${apiBase}#${personId}`;
}

/** The start of every unconfirmedSource. */
export const UNCONFIRMED_PREFIX = 'nas-unconfirmed:';

/** Notes (IdbBdjStore.loadNote, keyed by the copy's record key) of when each copy kept apart was last saved. */
export const UNCONFIRMED_AGE_SOURCE = 'nas-unconfirmed-age';

/** Notes (IdbBdjStore.loadNote, keyed by API base) of the person each NAS last said this device is. */
export const DEVICE_SOURCE = 'nas-device';

export interface WriteAheadDeps {
  readonly nas: Pick<NasBdjStore, 'load'> & { save(scope: string, snapshot: Snapshot, etag: string | null, opts?: SaveOptions): Promise<SaveResult> };
  /** This person's write-ahead copies (personSource). */
  readonly local: IdbBdjStore;
  /** The disc's browser-only records from before (`nas:<discId>`, scopes.ts storeSource), moved to the NAS once. */
  readonly legacy?: IdbBdjStore | null;
  /** This person's copies from sessions whose `GET me` did not answer (unconfirmedSource), merged in at the load. */
  readonly unconfirmed?: IdbBdjStore | null;
  readonly personId: string;
  /**
   * Whose device this is now (`GET me`'s personId; null when the server keeps no people), asked before each put and
   * before a 412 is merged: an owner can move a device to another person while BD-J runs, and the token then reaches
   * that person's store. Without it the person is the boot's for the whole session.
   */
  readonly whoAmI?: () => Promise<string | null>;
  readonly setTimer: SetTimer;
  readonly log: Log;
  /**
   * The NAS refused a scope for room (507), or has taken it again: Java then sees a full disk (ScopeSync.full), as
   * libbluray's JVM does when its disk fills.
   */
  readonly onFull?: (scope: string, full: boolean) => void;
  /** A put the NAS refused for good (failedForGood; ruling R32): it is still tried again, but the viewer is told. */
  readonly onLost?: (reason: StorageLoss) => void;
  /** Settles (rejects) when the NAS's part of the boot has run out of time: the loads then use this browser's copy. */
  readonly budget?: Promise<never>;
  readonly pushDebounceMs?: number;
  readonly pushMaxWaitMs?: number;
  readonly retryMs?: number;
}

interface WriteAheadScope {
  /** The NAS's version as last seen (null: it has none); undefined while unknown (the NAS did not answer). */
  nasEtag: string | null | undefined;
  /** The write-ahead record's version (null: none yet). */
  localEtag: string | null;
  /** What the NAS should hold: the last snapshot saved here, merged with what the NAS had. */
  local: Snapshot;
  /** The write-ahead copy is not on the NAS yet. */
  pending: boolean;
  /** Counts the saves, so a put knows whether a newer one came while it ran. */
  gen: number;
  /** A browser-only record merged into this one: its version, removed once the NAS has the merge. */
  legacyEtag: string | null;
  /** The NAS refused it for room (onFull). */
  full: boolean;
  /** The copy was never merged with the NAS's (ScopeRecord.unmerged): the boot had none here and no answer there. */
  unmerged: boolean;
  /** Puts of this scope, one after another. */
  pushing: Promise<void>;
}

/**
 * Ruling R17. A NAS disc's saves go to this browser's IndexedDB first, within 100 ms (saveDebounceMs) and marked
 * pending, then to the NAS 2 s after the last one (at most 10 s after the first; at once on flush). A copy still
 * pending at the next load is merged per file by mtime with the NAS's, as on a 412, and put on the NAS straight away.
 * A load the NAS does not answer uses this browser's copy, when there is one; with none, Java starts with nothing and
 * what it writes is kept here as a pending copy marked unmerged, merged at the next boot with the NAS's files winning
 * on every path both have (rulings R28, R29). A failed put is tried again later and at the next open. Nothing is lost on this device when
 * the page goes before the NAS has it.
 */
export class WriteAheadNasStore implements BdjStore {
  readonly saveDebounceMs = IDB_SAVE_DEBOUNCE_MS;
  readonly quotaAccounting = 'tar';
  /** The device now belongs to another person: nothing more is put on the NAS this session (its copies stay pending). */
  private moved = false;
  private readonly scopes = new Map<string, WriteAheadScope>();
  private cancelDebounce: (() => void) | null = null;
  private cancelMaxWait: (() => void) | null = null;
  private cancelRetry: (() => void) | null = null;
  private readonly tooLongLogged = new Set<string>();
  private readonly unmergedLogged = new Set<string>();

  constructor(private readonly deps: WriteAheadDeps) {}

  async load(scope: string): Promise<LoadedSnapshot> {
    const { local, legacy, unconfirmed, personId, log } = this.deps;
    const fromNas = this.withinBudget(this.deps.nas.load(scope));
    fromNas.catch(() => undefined); // awaited below
    const [rec, old, unc] = await Promise.all([
      local.loadRecord(scope),
      legacy ? legacy.loadRecord(scope) : Promise.resolve(null),
      unconfirmed ? unconfirmed.loadRecord(scope) : Promise.resolve(null),
    ]);
    let files: readonly SnapshotFile[] = rec?.files ?? [];
    let etag = rec?.etag ?? null;
    let pending = rec?.pending === true;
    let unmerged = pending && rec?.unmerged === true;
    let legacyEtag: string | null = null;
    if (old && legacy) {
      if (old.migratedTo === undefined) {
        // the disc's saves from before the NAS kept them: into this person's copy, once (ruling R15's keys, unchanged)
        const moved = await this.absorb(scope, old.files, files, etag, unmerged);
        // marked, not removed: it goes only once the NAS has it
        await legacy.mark(scope, old.etag, (r) => ({ ...r, migratedTo: personId }));
        log(`BD-J storage: ${scope}: this browser's saved data for the disc (${old.files.length} files) moves to the NAS`);
        files = moved.files;
        etag = moved.etag;
        pending = true;
        legacyEtag = old.etag;
      } else if (old.migratedTo === personId) {
        legacyEtag = old.etag; // merged before; removed once the NAS has it
      }
    }
    if (unc && unconfirmed) {
      // saved on this device while the NAS did not say whose it was; it was this person's before, and is again now.
      // Onto a settled copy's files it goes alone: those are only an old picture of the NAS, and kept beside an
      // unmerged copy they would come back where another device deleted them (review N4)
      const taken = await this.absorb(scope, unc.files, pending ? files : [], etag, true);
      files = taken.files;
      etag = taken.etag;
      pending = true;
      unmerged = true;
      log(`BD-J storage: ${scope}: what this device saved while the NAS did not say whose device it was (${unc.files.length} files) is merged into this person's copy`);
      try {
        await unconfirmed.remove(scope, unc.etag);
      } catch (e) {
        // merged again at the next boot (a merge of the same files changes nothing)
        log(`BD-J storage: ${scope}: the copy saved while the NAS did not say whose device this was could not be removed (${messageOf(e)})`, true);
      }
    }
    const hadCopy = rec !== null || legacyEtag !== null || unc !== null;
    const state: WriteAheadScope = { nasEtag: undefined, localEtag: etag, local: { files: sortFiles([...files]) }, pending, gen: 0, legacyEtag, full: false, unmerged, pushing: Promise.resolve() };
    this.scopes.set(scope, state);
    let remote: LoadedSnapshot;
    try {
      remote = await fromNas;
      // the GET went with the token as it is now: if the device moved to another person since the boot asked, that is
      // their snapshot, never merged into this person's copy (checked within the boot's budget too)
      if (!(await this.withinBudget(this.samePerson()))) {
        if (this.moved) {
          // this session's saves stay here, pending, for this person (never put while the device is another's)
          if (!hadCopy) state.unmerged = true;
          return { files: state.local.files, etag };
        }
        throw new NasStoreError(null, 'whose device this is could not be checked after the GET');
      }
    } catch (e) {
      if (!hadCopy) {
        // nothing to show Java, but what it writes is kept: a pending copy, merged with the NAS's when it answers
        state.unmerged = true;
        log(`BD-J storage: ${scope} could not be loaded from the NAS (${messageOf(e)}), and this browser has no copy: the disc starts with no saved data, and what it saves is kept in this browser and merged with the NAS's copy at the next open (the NAS's files win)`, true);
        return { files: [], etag: null };
      }
      log(`BD-J storage: ${scope} could not be loaded from the NAS (${messageOf(e)}); this browser's copy is used${pending ? ', and put on the NAS once it answers' : ''}`, true);
      if (pending) this.retryLater();
      return { files: state.local.files, etag };
    }
    state.nasEtag = remote.etag;
    if (pending) {
      // the last session's changes the NAS did not get: merged as on a 412 (newer mtime wins, ties ours) and put now;
      // a copy written without seeing the NAS's (unmerged) only adds the paths the NAS lacks (ruling R29)
      const mergeWith = (mine: Snapshot): { merged: Snapshot; dropped: number } =>
        unmerged ? mergeKeepingRemote(mine, remote) : { merged: mergeSnapshots(mine, remote).merged, dropped: 0 };
      const { merged, dropped } = mergeWith(state.local);
      if (dropped > 0) log(`BD-J storage: ${scope}: ${dropped} files saved here while the NAS did not answer are dropped for the NAS's own (ruling R29); only the files the NAS lacks are added`);
      state.unmerged = false; // merged with the NAS's now
      if (!sameSnapshot(merged, state.local)) {
        // the write-ahead copy holds the merge before anything marks it as on the NAS
        const result = await local.save(scope, merged, etag, { pending: true });
        if ('etag' in result) {
          etag = result.etag;
          state.localEtag = etag;
          state.local = merged;
        } else {
          log(`BD-J storage: ${scope}: this browser's copy changed while it loaded; its pending changes are put as they are`, true);
          etag = result.conflict.etag;
          // no version to mark: the record holds less than what is put, so it stays pending until ScopeSync saves
          state.localEtag = null;
          state.local = mergeWith(result.conflict).merged;
        }
      }
      log(`BD-J storage: ${scope} has changes from this browser the NAS does not have yet${unmerged ? ' (saved while the NAS did not answer, never merged with its copy)' : ''}: merged, and put on the NAS now`);
      this.soon();
      return { files: state.local.files, etag };
    }
    state.local = { files: remote.files };
    if (legacyEtag !== null) await this.dropLegacy(scope, state); // already on the NAS
    return { files: remote.files, etag };
  }

  async save(scope: string, snapshot: Snapshot, etag: string | null): Promise<SaveResult> {
    const state = this.state(scope);
    const result = await this.deps.local.save(scope, snapshot, etag, { pending: true, unmerged: state.unmerged });
    if ('conflict' in result) return result;
    state.localEtag = result.etag;
    state.local = snapshot;
    state.pending = true;
    state.gen++;
    this.schedule();
    return result;
  }

  /** Puts every pending scope on the NAS now; settles once each is there or has failed (logged). */
  async flush(): Promise<void> {
    this.cancelDebounce?.();
    this.cancelDebounce = null;
    this.cancelMaxWait?.();
    this.cancelMaxWait = null;
    this.cancelRetry?.();
    this.cancelRetry = null;
    // a copy written without seeing the NAS's (unmerged) waits for the next boot: no `GET me` for it (review N2)
    if (![...this.scopes.values()].some((s) => s.pending && !s.unmerged)) return;
    if (!(await this.samePerson())) return;
    await Promise.all(
      [...this.scopes].map(([scope, state]) => {
        state.pushing = state.pushing.then(() => this.push(scope, state));
        return state.pushing;
      }),
    );
  }

  /** Whether a scope's write-ahead copy is still to go to the NAS (tests, diagnostics). */
  pendingScopes(): string[] {
    return [...this.scopes].filter(([, s]) => s.pending).map(([scope]) => scope).sort();
  }

  /**
   * Whether the device is still the boot's person's (whoAmI). When it is not, nothing more goes to the NAS: the copies
   * stay pending in this browser under the person they were written for (logged as an error once). A failed check is a
   * failed put (tried again later).
   */
  private async samePerson(): Promise<boolean> {
    if (this.moved) return false;
    if (!this.deps.whoAmI) return true;
    let now: string | null;
    try {
      now = await this.deps.whoAmI();
    } catch (e) {
      this.deps.log(`BD-J storage: the NAS did not say whose device this is (${messageOf(e)}); saved data is put on the NAS later`, true);
      this.retryLater();
      return false;
    }
    if (now === this.deps.personId) return true;
    this.personMoved();
    return false;
  }

  /** samePerson for a PUT about to go: throws PersonChangedError (or the check's failure) instead of answering false. */
  private async assertSamePerson(): Promise<void> {
    if (this.moved) throw new PersonChangedError();
    if (!this.deps.whoAmI) return;
    if ((await this.deps.whoAmI()) !== this.deps.personId) throw new PersonChangedError();
  }

  /** Nothing more goes to the NAS this session (logged as an error once). */
  private personMoved(detail?: string): void {
    if (this.moved) return;
    this.moved = true;
    this.deps.log(
      `BD-J storage: this device now belongs to another person on the NAS${detail ? ` (${detail})` : ''}; this session's saved data stays in this browser for the person it was written for, and is not put on the NAS`,
      true,
    );
  }

  private state(scope: string): WriteAheadScope {
    let state = this.scopes.get(scope);
    if (!state) {
      state = { nasEtag: undefined, localEtag: null, local: { files: [] }, pending: false, gen: 0, legacyEtag: null, full: false, unmerged: false, pushing: Promise.resolve() };
      this.scopes.set(scope, state);
    }
    return state;
  }

  /**
   * Merges `extra` (an older record's files) into this person's copy (`files` at `etag`) and saves it pending; again
   * on a conflict, over what is stored then.
   */
  private async absorb(scope: string, extra: readonly SnapshotFile[], files: readonly SnapshotFile[], etag: string | null, unmerged: boolean): Promise<{ files: readonly SnapshotFile[]; etag: string }> {
    let mine: Snapshot = { files };
    let at = etag;
    for (let attempt = 1; ; attempt++) {
      const merged = mergeSnapshots(mine, { files: extra }).merged;
      const result = await this.deps.local.save(scope, merged, at, { pending: true, unmerged });
      if ('etag' in result) return { files: merged.files, etag: result.etag };
      if (attempt >= PUSH_ATTEMPTS) throw new Error(`${scope}: the copy in this browser kept changing while older saves moved into it`);
      mine = result.conflict;
      at = result.conflict.etag;
    }
  }

  private async dropLegacy(scope: string, state: WriteAheadScope): Promise<void> {
    const etag = state.legacyEtag;
    if (etag === null || !this.deps.legacy) return;
    state.legacyEtag = null;
    try {
      if (await this.deps.legacy.remove(scope, etag)) this.deps.log(`BD-J storage: ${scope}: the NAS has this browser's old saved data; the old copy is removed`);
    } catch (e) {
      this.deps.log(`BD-J storage: ${scope}: the old copy in this browser could not be removed (${messageOf(e)})`, true);
    }
  }

  /** `p`, failed when the NAS's part of the boot runs out of time first (deps.budget). */
  private withinBudget<T>(p: Promise<T>): Promise<T> {
    return this.deps.budget ? within(p, this.deps.budget) : p;
  }

  /** The snapshot as the NAS can hold it: a path too long for a ustar header stays in this browser only (logged once). */
  private forNas(scope: string, snapshot: Snapshot): Snapshot {
    if (snapshot.files.every((f) => tarPathFits(f.path))) return snapshot;
    const files = snapshot.files.filter((f) => {
      if (tarPathFits(f.path)) return true;
      const key = `${scope}/${f.path}`;
      if (!this.tooLongLogged.has(key)) {
        this.tooLongLogged.add(key);
        this.deps.log(`BD-J storage: ${scope}: ${f.path} has a path too long for the NAS (255 bytes); it stays in this browser only`, true);
      }
      return false;
    });
    return { files };
  }

  private async push(scope: string, state: WriteAheadScope): Promise<void> {
    if (!state.pending) return;
    if (state.unmerged) {
      // written without seeing the NAS's copy: merged only at the next boot, where the NAS's files win (ruling R29),
      // never put in this session, where Java would write its own again over them
      if (!this.unmergedLogged.has(scope)) {
        this.unmergedLogged.add(scope);
        this.deps.log(`BD-J storage: ${scope} is kept in this browser and merged with the NAS's copy at the next open (the NAS's files win)`);
      }
      return;
    }
    const { nas, local, log } = this.deps;
    const gen = state.gen;
    const pushed = this.forNas(scope, state.local);
    let snapshot = pushed;
    try {
      if (state.nasEtag === undefined) {
        const remote = await nas.load(scope);
        if (!(await this.samePerson())) return;
        state.nasEtag = remote.etag;
        snapshot = mergeSnapshots(snapshot, remote).merged;
      }
      for (let attempt = 1; ; attempt++) {
        // right before each PUT (503 retries too): still this person's device
        const result = await nas.save(scope, snapshot, state.nasEtag, { beforePut: () => this.assertSamePerson() });
        if ('etag' in result) {
          state.nasEtag = result.etag;
          break;
        }
        // another device of this person put it meanwhile, or the device has moved to another person (whose store the
        // token now reaches): never merged across people
        if (!(await this.samePerson())) return;
        // merged per file, newer mtime wins (whole seconds), ties ours
        snapshot = mergeSnapshots(snapshot, result.conflict).merged;
        state.nasEtag = result.conflict.etag;
        if (attempt >= PUSH_ATTEMPTS) throw new Error(`still changed elsewhere after ${attempt} tries`);
      }
    } catch (e) {
      if (e instanceof PersonChangedError) {
        // kept pending under the person it was written for; never marked as on the NAS
        this.personMoved(e.message);
        return;
      }
      if (e instanceof ScopeQuotaError) {
        // not retried on a timer: room comes back only when Java frees some (the next save) or elsewhere (the next
        // flush or boot puts it again)
        log(`BD-J storage: ${scope} was not put on the NAS: ${e.message}; this browser keeps it`, true);
        if (!state.full) {
          state.full = true;
          this.deps.onFull?.(scope, true);
        }
        return;
      }
      log(`BD-J storage: ${scope} could not be put on the NAS (${messageOf(e)}); this browser keeps it and tries again`, true);
      if (failedForGood(e)) this.deps.onLost?.('put-failed');
      this.retryLater();
      return;
    }
    if (state.full) {
      state.full = false;
      this.deps.onFull?.(scope, false);
    }
    // the files the put took from the NAS (a 412's merge, or the merge when the NAS's version was unknown): another
    // device's, which this browser's copy must hold too, or the next put (If-Match on this version) drops them. They
    // are this person's: the merge that took them came after a person check, and the PUT carried X-Bdj-Person
    const sent = new Map(pushed.files.map((f) => [f.path, f]));
    const taken = snapshot.files.filter((f) => sent.get(f.path) !== f);
    // a move between the last check and the PUT (a NAS without the guard takes it): nothing is folded or marked, the
    // copy stays this person's, and nothing more is put (the person rules). A check that fails (review N1) only keeps
    // the copy from being marked as on the NAS: the files are folded all the same, and the next put reads the NAS again
    const same = await this.samePerson();
    if (!same && this.moved) return;
    if (!same) state.nasEtag = undefined;
    else log(`BD-J storage: ${scope} is on the NAS (${snapshot.files.length} files, ${snapshotBytes(snapshot)} bytes)`);
    try {
      if (taken.length === 0) {
        // the write-ahead copy is what the NAS has now: marked (no new version), unless a save came meanwhile
        if (same && state.gen === gen && state.localEtag !== null && (await local.mark(scope, state.localEtag, settled))) {
          state.pending = false;
          state.unmerged = false;
        }
      } else {
        await this.takeFromNas(scope, state, taken, gen, same);
      }
    } catch (e) {
      log(`BD-J storage: ${scope} is on the NAS, but this browser's copy could not be marked so (${messageOf(e)}); it is put again at the next open`, true);
    }
    await this.dropLegacy(scope, state);
  }

  /**
   * Folds the files a put took from the NAS (`taken`) into this browser's copy, whatever was saved while the put ran
   * (review Important 1): the record is read again, merged per file (newer mtime wins, ties the copy's) and saved,
   * again on an IndexedDB conflict. It is marked as on the NAS only when no save came during the put (`gen`) and the
   * record is the one the put started from; else it stays pending, so the newer save goes to the NAS with these files.
   * The new version makes ScopeSync's next save meet a conflict and give the files to Java. If the copy cannot take
   * them, the NAS's version is forgotten: the next put (NAS_PUSH_RETRY_MS later) reads the NAS and merges again, so
   * they are not dropped there. `settle` is false when the person check after the PUT failed: the copy is never marked
   * as on the NAS then.
   */
  private async takeFromNas(scope: string, state: WriteAheadScope, taken: readonly SnapshotFile[], gen: number, settle: boolean): Promise<void> {
    const { local, log } = this.deps;
    try {
      for (let attempt = 1; ; attempt++) {
        const rec = await local.loadRecord(scope);
        const base: Snapshot = { files: rec?.files ?? [] };
        const merged = mergeSnapshots(base, { files: taken }).merged;
        // marked as on the NAS only after a passed person check (`settle`)
        const current = settle && rec !== null && state.gen === gen && rec.etag === state.localEtag;
        if (sameSnapshot(merged, base)) {
          // the copy has them already (a newer save took them, or newer files)
          if (current && (await local.mark(scope, rec.etag, settled))) {
            state.pending = false;
            state.unmerged = false;
          }
          return;
        }
        const result = await local.save(scope, merged, rec?.etag ?? null, current ? { pending: false } : { pending: true, unmerged: state.unmerged });
        if ('etag' in result) {
          state.localEtag = result.etag;
          state.local = merged;
          if (current) {
            state.pending = false;
            state.unmerged = false;
          } else {
            state.pending = true;
            if (settle) this.schedule();
            else this.retryLater();
          }
          return;
        }
        if (attempt >= PUSH_ATTEMPTS) throw new Error(`this browser's copy kept changing after ${attempt} tries`);
      }
    } catch (e) {
      // tried again later (review N6: not on the 2 s debounce, which would GET and PUT again and again)
      state.nasEtag = undefined;
      state.pending = true;
      this.retryLater();
      log(`BD-J storage: ${scope}: this browser's copy could not take the NAS's files (${messageOf(e)}); the next put reads the NAS and merges again`, true);
    }
  }

  /** A put of every pending scope NAS_PUSH_DEBOUNCE_MS after the last save (NAS_PUSH_MAX_WAIT_MS after the first). */
  private schedule(): void {
    const { setTimer } = this.deps;
    this.cancelDebounce?.();
    this.cancelDebounce = setTimer(this.deps.pushDebounceMs ?? NAS_PUSH_DEBOUNCE_MS, () => {
      this.cancelDebounce = null;
      void this.flush();
    });
    this.cancelMaxWait ??= setTimer(this.deps.pushMaxWaitMs ?? NAS_PUSH_MAX_WAIT_MS, () => {
      this.cancelMaxWait = null;
      void this.flush();
    });
  }

  /** A put as soon as the boot's loads are through (a pending copy from the last session). */
  private soon(): void {
    this.cancelDebounce?.();
    this.cancelDebounce = this.deps.setTimer(0, () => {
      this.cancelDebounce = null;
      void this.flush();
    });
  }

  private retryLater(): void {
    this.cancelRetry ??= this.deps.setTimer(this.deps.retryMs ?? NAS_PUSH_RETRY_MS, () => {
      this.cancelRetry = null;
      void this.flush();
    });
  }
}

export interface NasDiscStoreDeps {
  readonly nas: NasBdjStore;
  readonly idb: IDBFactory;
  /** The disc's id on its server (manifest.discId): the source of its browser-only records (`nas:<discId>`). */
  readonly discId: string;
  readonly setTimer: SetTimer;
  readonly log: Log;
  readonly onFull?: (scope: string, full: boolean) => void;
  /** WriteAheadDeps.onLost. */
  readonly onLost?: (reason: StorageLoss) => void;
  readonly loadBudgetMs?: number;
  /** Epoch ms now (UNCONFIRMED_MAX_AGE_MS); Date.now by default. */
  readonly nowMs?: () => number;
}

/** A copy kept apart while `GET me` did not answer is removed at a boot this long after its last save. */
export const UNCONFIRMED_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/**
 * The store of a session whose `GET me` did not answer (review N5): Java starts with no saved data, never with what
 * earlier such sessions kept apart (whose person may not be this device's now), and the session only adds to that
 * copy: each save is Java's files over the copy as it stood when the session first touched the scope, so what Java
 * deletes of its own goes, and the earlier files stay as they were.
 */
export class UnconfirmedStore implements BdjStore {
  readonly saveDebounceMs = IDB_SAVE_DEBOUNCE_MS;
  readonly quotaAccounting = 'tar';
  /** Per scope: the record's files from before this session, its version as last seen, and this session's paths. */
  private readonly scopes = new Map<string, { before: readonly SnapshotFile[]; etag: string | null; mine: Set<string> }>();
  private n = 0;

  constructor(
    private readonly idb: IdbBdjStore,
    /** When each save was made (UNCONFIRMED_AGE_SOURCE), for the cleanup, which reads no files. */
    private readonly ages?: IdbBdjStore,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async load(scope: string): Promise<LoadedSnapshot> {
    const rec = await this.idb.loadRecord(scope);
    this.scopes.set(scope, { before: rec?.files ?? [], etag: rec?.etag ?? null, mine: new Set() });
    return { files: [], etag: null };
  }

  async save(scope: string, snapshot: Snapshot): Promise<SaveResult> {
    let s = this.scopes.get(scope);
    if (!s) await this.load(scope);
    s = this.scopes.get(scope)!;
    for (let attempt = 1; ; attempt++) {
      const merged = mergeSnapshots(snapshot, { files: s.before }).merged;
      const result = await this.idb.save(scope, merged, s.etag);
      if ('etag' in result) {
        s.etag = result.etag;
        s.mine = new Set(snapshot.files.map((f) => f.path));
        try {
          await this.ages?.saveNote(recordKey(this.idb.source, scope), String(this.nowMs()));
        } catch {
          // the cleanup then notes it at its next run
        }
        // ScopeSync's own versions: this session is the only writer it knows of
        return { etag: `u${++this.n}` };
      }
      if (attempt >= PUSH_ATTEMPTS) throw new Error(`${scope}: the copy kept apart in this browser kept changing`);
      // another tab wrote it meanwhile: what it holds, less what this session put there, is the copy from before
      const mine = s.mine;
      s.before = result.conflict.files.filter((f) => !mine.has(f.path));
      s.etag = result.conflict.etag;
    }
  }
}

/**
 * The store of a disc opened from a server (the backend choice): the person's NAS store with its write-ahead copy
 * (WriteAheadNasStore) when the server says whose device this is; this browser only (`nas:<discId>`, as before) when
 * it keeps no people (the dev disc server); none when it does not answer (each scope then lasts the session, logged).
 */
export class NasDiscStore implements BdjStore {
  readonly saveDebounceMs = IDB_SAVE_DEBOUNCE_MS;
  /**
   * Every disc from a server counts its quota as the NAS does (ruling R24), even on a server that keeps it in this
   * browser (the same discs move to a NAS later); a picked folder counts file lengths (IdbBdjStore).
   */
  readonly quotaAccounting = 'tar';
  /** ScopeSync's wait for a load: the NAS's budget and a little (NAS_LOAD_MARGIN_MS), so the fallback comes first. */
  readonly loadTimeoutMs: number;
  private readonly backend: Promise<BdjStore>;
  private readonly budget: Promise<never>;

  constructor(private readonly deps: NasDiscStoreDeps) {
    const ms = deps.loadBudgetMs ?? NAS_LOAD_BUDGET_MS;
    this.loadTimeoutMs = ms + NAS_LOAD_MARGIN_MS;
    this.budget = new Promise<never>((_, reject) => deps.setTimer(ms, () => reject(new NasStoreError(null, `the NAS did not answer within ${ms / 1000} s`))));
    this.budget.catch(() => undefined);
    this.backend = this.choose();
    this.backend.catch(() => undefined); // each load reports it
  }

  private async choose(): Promise<BdjStore> {
    const { nas, idb, discId, setTimer, log, onFull, onLost } = this.deps;
    const devices = new IdbBdjStore(DEVICE_SOURCE, idb);
    let me: Awaited<ReturnType<NasBdjStore['me']>>;
    try {
      me = await within(nas.me(), this.budget);
    } catch (e) {
      // whose device this is now is unknown: what is saved is kept apart, under the person the NAS last said it is, and
      // becomes theirs only at a boot where the NAS says so again (never another person's); with no such person, the
      // session's saved data is not kept
      let last: string | null = null;
      try {
        last = await devices.loadNote(nas.apiBase);
      } catch {
        // none known
      }
      if (last === null) {
        log(`BD-J storage: the NAS did not say whose device this is (${messageOf(e)}); saved data lasts until BD-J stops`, true);
        throw e;
      }
      log(`BD-J storage: the NAS did not say whose device this is (${messageOf(e)}); the disc starts with no saved data from the NAS, and what it saves is kept in this browser until a later open where the NAS names the same person as before`, true);
      const source = unconfirmedSource(nas.apiBase, last);
      this.prune(devices, null, source);
      return new UnconfirmedStore(new IdbBdjStore(source, idb), new IdbBdjStore(UNCONFIRMED_AGE_SOURCE, idb), this.deps.nowMs);
    }
    const legacy = new IdbBdjStore(`nas:${discId}`, idb);
    if (me === null) {
      log('BD-J storage: the disc server keeps no saved data per person; this browser keeps it');
      return legacy;
    }
    try {
      await devices.saveNote(nas.apiBase, me.personId);
    } catch (e) {
      log(`BD-J storage: whose device this is could not be noted in this browser (${messageOf(e)})`, true);
    }
    // not awaited: the cleanup reads keys and age notes only, and never removes this person's own copy kept apart,
    // which the loads attach (round 2, M1 and M3)
    this.prune(devices, me.personId, unconfirmedSource(nas.apiBase, me.personId));
    nas.setPerson(me.personId);
    return new WriteAheadNasStore({
      nas,
      local: new IdbBdjStore(personSource(me.personId), idb),
      legacy,
      unconfirmed: new IdbBdjStore(unconfirmedSource(nas.apiBase, me.personId), idb),
      personId: me.personId,
      whoAmI: async () => (await nas.me())?.personId ?? null,
      setTimer,
      log,
      budget: this.budget,
      ...(onFull ? { onFull } : {}),
      ...(onLost ? { onLost } : {}),
    });
  }

  /**
   * Removes, in the background, the copies kept apart while `GET me` did not answer (review N5) that were last saved
   * more than UNCONFIRMED_MAX_AGE_MS ago, and, once the NAS has named this device's person (`confirmed`), this NAS's
   * ones of any other person: the device is no longer theirs. `inUse` (the confirmed person's own copy, which the
   * loads attach, or the copy this session adds to) is never removed (round 2, M1). Keys and age notes only, no files
   * (M3). A failure is logged; the copies then go at a later boot.
   */
  private prune(store: IdbBdjStore, confirmed: string | null, inUse: string): void {
    const { nas, log } = this.deps;
    const mine = unconfirmedSource(nas.apiBase, '');
    const drop = (source: string, ageMs: number | null): boolean =>
      source !== inUse && ((confirmed !== null && source.startsWith(mine)) || (ageMs !== null && ageMs > UNCONFIRMED_MAX_AGE_MS));
    store.pruneByKey(UNCONFIRMED_PREFIX, UNCONFIRMED_AGE_SOURCE, (this.deps.nowMs ?? Date.now)(), drop).then(
      (gone) => {
        if (gone > 0) log(`BD-J storage: ${gone} copies saved while the NAS did not say whose device this was are removed (older than 30 days, or this device is another person's now)`);
      },
      (e: unknown) => log(`BD-J storage: the copies saved while the NAS did not say whose device this was could not be cleaned up (${messageOf(e)})`, true),
    );
  }

  async load(scope: string): Promise<LoadedSnapshot> {
    return (await this.backend).load(scope);
  }

  async save(scope: string, snapshot: Snapshot, etag: string | null): Promise<SaveResult> {
    return (await this.backend).save(scope, snapshot, etag);
  }

  async flush(): Promise<void> {
    let backend: BdjStore;
    try {
      backend = await this.backend;
    } catch {
      return; // nothing was loaded, so nothing is kept
    }
    await backend.flush?.();
  }
}
