import type { OwnerChoice, TitleKind } from '@seikou/nas/nas-api';
import { AuthConflict, AuthNotFound } from '../auth';
import type { Auth, Device, Person, PersonRef } from '../auth';
import type { BdjStore } from '../bdj-store';
import { DEFAULT_APP_URL } from '../config';
import { formatCode, pairingLink, unregisterCodes } from '../codes';
import type { CodeRegistrar } from '../codes';
import { HttpError, json, readJson } from '../http';
import type { Handler, Response } from '../http';
import type { Library } from '../library';
import { LEVEL_LABELS } from '../levels/level-service';
import type { LevelService } from '../levels/level-service';
import type { RelayState } from '../rtc/relay';
import type { DiscEvidence } from '../titles/evidence';
import { groupKey } from '@seikou/titles/match';
import { parseName } from '@seikou/titles/parse-name';
import { SourceUnavailable } from '@seikou/titles/sources';
import type { TitleLibrary } from './titles';

/** What `adminRoutes` needs; each optional piece left out makes its routes answer 404. */
export interface AdminOptions {
  /** The disc library: rescans, drives, and the evidence discs are filed from. */
  library: Library;
  /** Each person's BD-J saved data: its size is listed, and it is cleared with the person. */
  bdjStore: BdjStore;
  /** The `https` route registered with each code: this server's public API base. */
  publicBase: string;
  /** The player pairing links open (ends in `/`); the hosted app by default. */
  appUrl?: string;
  /** The rendezvous Worker pairing links name; without one they name this server. */
  rendezvousUrl?: string;
  /** Absent until the rendezvous client exists: codes then come back with `rendezvous: false`. */
  registrar?: CodeRegistrar;
  /** How long a code waits for its rendezvous registration before it is returned with `rendezvous: false`. */
  registrarDeadlineMs?: number;
  /** The title library; its owner routes answer 404 without it. */
  titles?: TitleLibrary;
  /** The Cloudflare relay's settings and usage; `admin/relay` answers 404 without it. */
  relay?: RelayState;
  /** The quality levels; `admin/encoding` answers 404 without them. */
  levels?: Pick<LevelService, 'encodingNow'>;
  /** The clock in milliseconds since the epoch (the lookup limiter's); default `Date.now`. */
  now?: () => number;
  /** How long an owner's lookup may take before it answers 503. Default 10 s. */
  lookupTimeoutMs?: number;
}

const REGISTRAR_DEADLINE_MS = 5_000;

/** `promise`, or a rejection once `ms` have passed. */
async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The bearer token of `Authorization`, if any. */
export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m ? m[1]! : null;
}

/** An Auth failure as its answer: 404 for an unknown person or device, 409 for the last owner, 400 for a bad name. */
function authFailure(err: unknown): Response {
  if (err instanceof AuthNotFound) return json(404, { error: err.message });
  if (err instanceof AuthConflict) return json(409, { error: err.reason });
  if (err instanceof RangeError) return json(400, { error: 'bad name' });
  throw err;
}

/** Runs an Auth change, answering its failure. */
function attempt<T>(change: () => T): { ok: T } | { failed: Response } {
  try {
    return { ok: change() };
  } catch (err) {
    return { failed: authFailure(err) };
  }
}

/** A person as the admin screen shows them, with their devices and saved bytes. */
function personView(person: Person, devices: readonly Device[], store: BdjStore) {
  return {
    id: person.id,
    name: person.name,
    owner: person.owner,
    createdAt: person.createdAt,
    savedBytes: store.usage(person.id),
    devices: devices.filter((d) => d.personId === person.id).map(({ id, name, pairedAt, lastSeen, lastRoute }) => ({ id, name, pairedAt, lastSeen, lastRoute })),
  };
}

/** `{personId}` or `{newPerson: {name, owner}}`, each with an optional `invite`; null for anything else. */
function parseCodeRequest(body: unknown): { ref: PersonRef; invite: boolean } | null {
  if (!isObject(body)) return null;
  const invite = body.invite ?? false;
  if (typeof invite !== 'boolean') return null;
  if (hasKeys(body, ['personId'], ['invite'])) return typeof body.personId === 'string' ? { ref: { personId: body.personId }, invite } : null;
  if (!hasKeys(body, ['newPerson'], ['invite'])) return null;
  const p = body.newPerson;
  if (!isObject(p) || !hasKeys(p, ['name', 'owner']) || typeof p.name !== 'string' || typeof p.owner !== 'boolean') return null;
  return { ref: { newPerson: { name: p.name, owner: p.owner } }, invite };
}

/** `GET admin/relay` → `{enabled, allowPaid, usage}`; `PUT admin/relay {enabled?, allowPaid?}` changes the settings and answers the same. */
async function relayRoute(req: Parameters<Handler>[0], relay: RelayState): Promise<Response> {
  if (req.method === 'PUT') {
    const body = await readJson(req);
    if (!isObject(body) || Object.keys(body).length === 0 || !hasKeys(body, [], ['enabled', 'allowPaid'])) throw new HttpError(400, 'bad relay settings');
    if ((body.enabled !== undefined && typeof body.enabled !== 'boolean') || (body.allowPaid !== undefined && typeof body.allowPaid !== 'boolean')) {
      throw new HttpError(400, 'bad relay settings');
    }
    relay.set({ ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}), ...(body.allowPaid !== undefined ? { allowPaid: body.allowPaid as boolean } : {}) });
  }
  return json(200, { ...relay.settings(), usage: relay.usage() });
}

/**
 * `GET admin/encoding` → `{encoding}`: each viewing the GPU is leased to, with the person, device, disc and level. The
 * disc is named by the catalogue's display name when it is filed and has one, else the last segment of its folder.
 */
function encodingRoute(auth: Auth, levels: Pick<LevelService, 'encodingNow'>, library: Library, titles: TitleLibrary | undefined): Response {
  const viewings = levels.encodingNow();
  const devices = new Map(auth.devices().map((d) => [d.id, d]));
  const people = new Map(auth.people().map((p) => [p.id, p.name]));
  const filed = new Map<string, string>();
  if (viewings.length > 0 && titles) {
    const catalogue = titles.service.catalogue();
    const slots = (s: { copies: readonly { discId: string; displayName: string | null }[] }): void => {
      for (const c of s.copies) if (c.displayName) filed.set(c.discId, c.displayName);
    };
    for (const t of catalogue.titles) {
      const detail = catalogue.detail(t.id);
      if (!detail) continue;
      detail.extras.forEach(slots);
      for (const s of detail.seasons) [...s.discs, ...s.extras].forEach(slots);
    }
  }
  const encoding = viewings.map((v) => {
    const device = devices.get(v.deviceId);
    const disc = library.disc(v.discId);
    return {
      personName: (device && people.get(device.personId)) ?? 'Unknown',
      deviceName: device?.name ?? 'Unknown device',
      discName: filed.get(v.discId) ?? (disc ? disc.path.slice(disc.path.lastIndexOf('/') + 1) : 'Unknown disc'),
      level: v.level,
      label: LEVEL_LABELS[v.level],
      gpuPercent: Math.round(v.gpuShare * 100),
    };
  });
  return json(200, { encoding }, { 'Cache-Control': 'no-store' });
}

/**
 * `/api/admin/*`, for owner devices only; the token must come as `Authorization: Bearer` (a `t=` query is not accepted
 * here). 401 `unauthorized` without a valid token, 403 `forbidden` for a device that is not an owner's. Routes, with
 * their errors:
 * - `GET people`, `POST people {name, owner?}` (201), `PATCH people/<id> {name?, owner?}`, `DELETE people/<id>` (204,
 *   clears the person's saved data and unregisters their codes): 400 for a bad body or name, 404 for an unknown person,
 *   409 `last-owner` when the change would leave no owner device. `DELETE people/<id>/saved-data` (204) clears only the
 *   saved data; its one error is 404 `unknown person`.
 * - `GET devices`, `PATCH devices/<id> {personId}` (move), `DELETE devices/<id>` (revoke): the same errors.
 * - `GET codes`, `POST codes {personId | newPerson: {name, owner}, invite?}` (answers the code, link and whether the
 *   rendezvous registered it), `DELETE codes/<id>`.
 * - `GET drives`, `POST drives/<name>/forget` (404 `unknown-drive`, 409 `drive-present` or `scanning`), `POST rescan` (202).
 * - With the title library: `GET lookup`, `GET anilist-place/<id>`, the disc choices, own titles, names, music, the
 *   Unsorted and Hidden lists, `PUT settings/title-library` and `GET metadata/status` (`titleAdminRoute`, `choiceRoute`).
 * - `GET` and `PUT relay` with the relay, `GET encoding` with the quality levels.
 */
export function adminRoutes(auth: Auth, opts: AdminOptions): Handler {
  const lookups = new LookupLimiter(opts.now ?? Date.now);
  return async (req, url) => {
    const path = url.pathname;
    if (path !== '/api/admin' && !path.startsWith('/api/admin/')) return null;
    const token = bearerToken(req.headers.authorization);
    const device = token === null ? null : auth.verify(token);
    if (!device) return json(401, { error: 'unauthorized' });
    if (!device.owner) return json(403, { error: 'forbidden' });

    const [, , , collection, id, ...rest] = path.split('/');
    if (rest.length > 0) {
      // the three-segment routes
      if (opts.titles && collection === 'discs' && rest.length === 1 && rest[0] === 'choice') return choiceRoute(req.method, decode(id!), req, opts.library, opts.titles);
      if (req.method === 'POST' && collection === 'drives' && rest.length === 1 && rest[0] === 'forget') {
        const outcome = await opts.library.forget(decode(id!));
        if (outcome === 'unknown') return json(404, { error: 'unknown-drive' });
        if (outcome === 'present') return json(409, { error: 'drive-present', message: 'This drive was found at the last scan, so its discs stay.' });
        if (outcome === 'scanning') return json(409, { error: 'scanning', message: 'The library is being scanned. Try again when the scan has finished.' });
        return json(200, { drives: opts.library.drives() });
      }
      if (req.method === 'DELETE' && collection === 'people' && rest.length === 1 && rest[0] === 'saved-data') {
        const target = decode(id!);
        if (!auth.people().some((p) => p.id === target)) return json(404, { error: 'unknown person' });
        opts.bdjStore.clear(target);
        return { status: 204 };
      }
      return null;
    }
    const route = `${req.method} ${collection ?? ''}${id === undefined ? '' : '/:id'}`;
    if (opts.titles) {
      if (route === 'GET lookup') return lookupRoute(url, device.id, opts.titles, lookups, opts.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS);
      if (route === 'GET anilist-place/:id') return anilistPlaceRoute(id!, device.id, opts.titles, lookups, opts.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS);
      const answer = await titleAdminRoute(route, id === undefined ? undefined : decode(id), req, url, opts.library, opts.titles);
      if (answer) return answer;
    }
    if (opts.relay && (route === 'GET relay' || route === 'PUT relay')) return relayRoute(req, opts.relay);
    if (opts.levels && route === 'GET encoding') return encodingRoute(auth, opts.levels, opts.library, opts.titles);
    switch (route) {
      case 'GET devices':
        return json(200, {
          devices: auth.devices().map(({ id, name, owner, personId, personName, pairedAt, lastSeen }) => ({ id, name, owner, personId, personName, pairedAt, lastSeen })),
        });
      case 'GET people': {
        auth.pruneOrphans();
        const devices = auth.devices();
        return json(200, { people: auth.people().map((p) => personView(p, devices, opts.bdjStore)) });
      }
      case 'POST people': {
        const body = await readJson(req);
        if (!isObject(body) || !hasKeys(body, ['name'], ['owner']) || typeof body.name !== 'string') throw new HttpError(400, 'bad person');
        const owner = body.owner ?? false;
        if (typeof owner !== 'boolean') throw new HttpError(400, 'bad person');
        const made = attempt(() => auth.createPerson(body.name as string, owner));
        return 'failed' in made ? made.failed : json(201, personView(made.ok, [], opts.bdjStore));
      }
      case 'PATCH people/:id': {
        const body = await readJson(req);
        if (!isObject(body) || !hasKeys(body, [], ['name', 'owner']) || Object.keys(body).length === 0) throw new HttpError(400, 'bad person');
        if ((body.name !== undefined && typeof body.name !== 'string') || (body.owner !== undefined && typeof body.owner !== 'boolean')) throw new HttpError(400, 'bad person');
        const change = { ...(body.name !== undefined ? { name: body.name as string } : {}), ...(body.owner !== undefined ? { owner: body.owner as boolean } : {}) };
        const updated = attempt(() => auth.updatePerson(decode(id!), change));
        return 'failed' in updated ? updated.failed : json(200, personView(updated.ok, auth.devices(), opts.bdjStore));
      }
      case 'DELETE people/:id': {
        const target = decode(id!);
        const codes = auth.codes().filter((c) => c.personId === target).map((c) => c.hash);
        const removed = attempt(() => auth.removePerson(target));
        if ('failed' in removed) return removed.failed;
        opts.bdjStore.clear(target);
        unregisterCodes(opts.registrar, codes);
        return { status: 204 };
      }
      case 'PATCH devices/:id': {
        const body = await readJson(req);
        if (!isObject(body) || !hasKeys(body, ['personId']) || typeof body.personId !== 'string') throw new HttpError(400, 'bad device');
        const moved = attempt(() => auth.moveDevice(decode(id!), body.personId as string));
        return 'failed' in moved ? moved.failed : { status: 204 };
      }
      case 'GET codes': {
        auth.pruneOrphans();
        const names = new Map(auth.people().map((p) => [p.id, p.name]));
        return json(200, {
          codes: auth.codes().map(({ id, personId, invite, expiresAt }) => ({ id, personId, personName: names.get(personId) ?? '', invite, expiresAt })),
        });
      }
      case 'POST codes': {
        const request = parseCodeRequest(await readJson(req));
        if (request === null) throw new HttpError(400, 'bad request');
        const minted = attempt(() => auth.createCode(request.ref, { invite: request.invite }));
        if ('failed' in minted) return minted.failed;
        const { record, code, person } = minted.ok;
        let rendezvous = false;
        if (opts.registrar) {
          try {
            await withDeadline(
              opts.registrar.registerCode(record.hash, { https: opts.publicBase }, record.expiresAt),
              opts.registrarDeadlineMs ?? REGISTRAR_DEADLINE_MS,
              'rendezvous registration',
            );
            rendezvous = true;
          } catch (err) {
            console.error('rendezvous registration failed', err);
          }
        }
        return json(200, {
          code: formatCode(code), link: pairingLink(code, { appUrl: opts.appUrl ?? DEFAULT_APP_URL, publicBase: opts.publicBase, rendezvousUrl: opts.rendezvousUrl }), expiresAt: record.expiresAt, rendezvous, personId: person.id, personName: person.name, invite: record.invite,
        });
      }
      case 'DELETE devices/:id': {
        const target = decode(id!);
        if (!auth.devices().some((d) => d.id === target)) return json(404, { error: 'unknown device' });
        const revoked = attempt(() => auth.revokeDevice(target));
        return 'failed' in revoked ? revoked.failed : { status: 204 };
      }
      case 'DELETE codes/:id': {
        const target = decode(id!);
        const found = auth.codes().find((c) => c.id === target);
        if (!found) return json(404, { error: 'unknown code' });
        auth.deleteCode(target);
        unregisterCodes(opts.registrar, [found.hash]);
        return { status: 204 };
      }
      case 'GET drives':
        return json(200, { drives: opts.library.drives() });
      case 'POST rescan':
        opts.library.scan().catch((err: unknown) => console.error('library scan failed', err));
        return json(202, { scanning: true });
      default:
        return null;
    }
  };
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'bad request');
  }
}

const MAX_NAME = 200;
const MAX_QUERY = 200;
const MAX_NUMBER = 1000;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
/** Ids a choice may file a disc under: a source entry or an own title. */
const TITLE_ID = /^(?:anilist:\d+|tmdb-(?:tv|movie):\d+|own:[0-9a-f-]{36})$/;
const KINDS: readonly TitleKind[] = ['series', 'movie', 'music'];
const LOOKUP_TIMEOUT_MS = 10_000;
const LOOKUPS_PER_MINUTE = 20;
const MINUTE_MS = 60_000;

/** Per device: one lookup in flight and 20 started in any minute. */
class LookupLimiter {
  private readonly busy = new Set<string>();
  private readonly starts = new Map<string, number[]>();

  constructor(private readonly now: () => number) {}

  /** Starts a lookup for `device`, or the 429 that refuses it. Call `done` once it ends. */
  start(device: string): Response | null {
    if (this.busy.has(device)) return json(429, { error: 'lookup-busy' });
    const t = this.now();
    for (const [d, ts] of this.starts) {
      const live = ts.filter((s) => s > t - MINUTE_MS);
      if (live.length === 0) this.starts.delete(d);
      else this.starts.set(d, live);
    }
    const mine = this.starts.get(device) ?? [];
    if (mine.length >= LOOKUPS_PER_MINUTE) {
      const wait = Math.max(1, Math.ceil((mine[0]! + MINUTE_MS - t) / 1000));
      return json(429, { error: 'too-many-lookups' }, { 'Retry-After': String(wait) });
    }
    this.starts.set(device, [...mine, t]);
    this.busy.add(device);
    return null;
  }

  /** Marks the device's lookup as finished, so it may start another. */
  done(device: string): void {
    this.busy.delete(device);
  }
}

/** `GET admin/lookup?q&source`: paced ahead of matching, limited per device, given up after `timeoutMs`. 400 `bad query` unless `q` is 1 to 200 characters and `source` is `anilist`, `tmdb` or `own`; 429 `lookup-busy` or `too-many-lookups` (with `Retry-After`), 503 `source-unreachable`. */
async function lookupRoute(url: URL, device: string, titles: TitleLibrary, limiter: LookupLimiter, timeoutMs: number): Promise<Response> {
  const q = url.searchParams.get('q')?.trim() ?? '';
  const source = url.searchParams.get('source');
  if (q.length < 1 || q.length > MAX_QUERY || (source !== 'anilist' && source !== 'tmdb' && source !== 'own')) throw new HttpError(400, 'bad query');
  // own titles are searched locally, so they are not limited
  if (source === 'own') return json(200, { titles: await titles.service.lookup(q, source) });
  return limitedLookup(device, limiter, timeoutMs, async (signal) => json(200, { titles: await titles.service.lookup(q, source, signal) }));
}

/**
 * Runs an owner's lookup under the device's limits (`limiter`), aborting its signal and answering 503
 * `source-unreachable` after `timeoutMs`, or when the source is down.
 */
async function limitedLookup(device: string, limiter: LookupLimiter, timeoutMs: number, work: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const refused = limiter.start(device);
  if (refused) return refused;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new SourceUnavailable(`lookup took over ${timeoutMs} ms`)), timeoutMs);
  try {
    const timedOut = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason as Error), { once: true }));
    return await Promise.race([work(abort.signal), timedOut]);
  } catch (err) {
    if (err instanceof SourceUnavailable) return json(503, { error: 'source-unreachable' });
    throw err;
  } finally {
    clearTimeout(timer);
    limiter.done(device);
  }
}

/**
 * `GET admin/anilist-place/<anilistId>`: where an owner's choice files a disc under that AniList entry, even when the
 * NAS holds no disc of it (`TitleService.anilistPlace`), under the lookups' limits. 404 `not-found` for an entry AniList
 * doesn't know, 409 `no-season` for a TV entry whose chain gives it no season number, or one another member of
 * its series shares.
 */
async function anilistPlaceRoute(rawId: string, device: string, titles: TitleLibrary, limiter: LookupLimiter, timeoutMs: number): Promise<Response> {
  const n = /^[1-9]\d{0,9}$/.test(rawId) ? Number(rawId) : NaN;
  if (!Number.isSafeInteger(n) || n > 2 ** 31 - 1) throw new HttpError(400, 'bad id');
  return limitedLookup(device, limiter, timeoutMs, async (signal) => {
    const place = await titles.service.anilistPlace(n, signal);
    if (place === 'not-found') return json(404, { error: 'not-found' });
    if (place === 'no-season') return json(409, { error: 'no-season' });
    return json(200, place);
  });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Exactly these keys, the optional ones may be absent. */
const hasKeys = (o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((k) => k in o) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k));
const isCount = (v: unknown): v is number | null => v === null || (Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= MAX_NUMBER);
/** A trimmed name of 1 to 200 characters, or undefined. */
function name(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length >= 1 && t.length <= MAX_NAME ? t : undefined;
}

/** An owner choice from a request body, or null unless it has exactly the fields of one of the four kinds. */
function parseChoice(v: unknown): OwnerChoice | null {
  if (!isObject(v)) return null;
  switch (v.kind) {
    case 'title':
      return hasKeys(v, ['kind', 'titleId', 'season', 'disc']) && typeof v.titleId === 'string' && TITLE_ID.test(v.titleId) && isCount(v.season) && isCount(v.disc)
        ? { kind: 'title', titleId: v.titleId, season: v.season, disc: v.disc }
        : null;
    case 'extras':
      return hasKeys(v, ['kind', 'titleId', 'season']) && typeof v.titleId === 'string' && TITLE_ID.test(v.titleId) && isCount(v.season)
        ? { kind: 'extras', titleId: v.titleId, season: v.season }
        : null;
    case 'music': {
      if (!hasKeys(v, ['kind', 'name'])) return null;
      if (v.name === null) return { kind: 'music', name: null };
      const n = name(v.name);
      return n === undefined ? null : { kind: 'music', name: n };
    }
    case 'hidden':
      return hasKeys(v, ['kind']) ? { kind: 'hidden' } : null;
    default:
      return null;
  }
}

/** The disc or volume number a disc's own folder or titles carry, for "parsed order". */
function parsedNumber(e: DiscEvidence): number | null {
  for (const text of [e.path.slice(e.path.lastIndexOf('/') + 1), ...e.discTitles.map((t) => t.name)]) {
    const p = parseName(text);
    const n = p.volume ?? p.disc;
    if (n !== null) return n;
  }
  return null;
}

const naturalOrder = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/**
 * After an owner change: the catalogue is built again at once; a choice naming an entry that isn't loaded
 * (its disc stays Unsorted as `no-title`) also starts a run in the background to load it, and so does filing a disc as
 * Music, so its release is looked up and its folder cover found.
 */
function rebuildAfter(titles: TitleLibrary, library: Library, discId?: string, choice?: OwnerChoice): void {
  // copies of a disc follow its choice at once
  titles.owner.reattach(library.evidence().map((e) => ({ id: e.discId, fingerprint: e.fingerprint })));
  titles.service.rebuild();
  if (choice?.kind === 'music') {
    titles.service.runNow().catch((err: unknown) => console.error('title matching failed', err));
    return;
  }
  if (discId === undefined || choice === undefined || (choice.kind !== 'title' && choice.kind !== 'extras') || choice.titleId.startsWith('own:')) return;
  if (titles.service.catalogue().unsorted.some((u) => u.discId === discId && u.reason === 'no-title')) {
    titles.service.runNow().catch((err: unknown) => console.error('title matching failed', err));
  }
}

/**
 * `PUT admin/discs/<id>/choice {choice, applyToGroup?}` files a disc (204, or 200 `{skipped}` with `applyToGroup`; 400
 * `bad choice`, `disc-required` or `unknown title`, 404 `unknown disc`) and `DELETE` clears its choice (204; 409
 * `copy-follows-source` for a copy whose source disc has one). Null for another method.
 */
async function choiceRoute(method: string | undefined, discId: string, req: Parameters<Handler>[0], library: Library, titles: TitleLibrary): Promise<Response | null> {
  const { owner } = titles;
  if (method === 'DELETE') {
    const origin = owner.choiceOrigin(discId);
    // a copy's choice follows its source, so clearing it would not last; with no source left, it can go
    if (origin?.kind === 'copy' && origin.source !== null) return json(409, { error: 'copy-follows-source', source: origin.source });
    owner.clearChoice(discId);
    rebuildAfter(titles, library);
    return { status: 204 };
  }
  if (method !== 'PUT') return null;
  const body = await readJson(req);
  const choice = isObject(body) && hasKeys(body, ['choice'], ['applyToGroup']) ? parseChoice(body.choice) : null;
  const applyToGroup = isObject(body) ? (body.applyToGroup ?? false) : false;
  if (choice === null || typeof applyToGroup !== 'boolean') throw new HttpError(400, 'bad choice');
  // the other discs are numbered from this one's number, so it needs one
  if (applyToGroup && choice.kind === 'title' && choice.disc === null) throw new HttpError(400, 'disc-required');
  const evidence = library.evidence();
  const disc = evidence.find((e) => e.discId === discId);
  if (!disc) return json(404, { error: 'unknown disc' });
  if (choice.kind === 'title' || choice.kind === 'extras') {
    if (choice.titleId.startsWith('own:') && !owner.snapshot().ownTitles.some((t) => t.id === choice.titleId)) throw new HttpError(400, 'unknown title');
  }
  owner.setChoice(discId, disc.fingerprint, choice);
  const skipped: { discId: string; reason: 'direct' | 'copy' | 'no-number' | 'conflict' }[] = [];
  if (applyToGroup) {
    // the group's discs in parsed order (number, then folder). A disc the owner chose for itself keeps its choice,
    // while one filed with a group takes the new one; a copy keeps following its source while there is one. Under a
    // title, the others are numbered by their own numbers, keeping their distance from this one's: a missing volume
    // leaves a gap. Only when no disc in the group has a number are they numbered by
    // place; when some have one, those without are left as they are ('no-number'). When this disc has no number of its
    // own, the others keep theirs, and one that would take the number given here is left as it is ('conflict').
    const group = groupKey(disc);
    const order = evidence
      .filter((e) => groupKey(e) === group)
      .sort((a, b) => (parsedNumber(a) ?? Infinity) - (parsedNumber(b) ?? Infinity) || naturalOrder(a.path, b.path));
    const at = order.indexOf(disc);
    const own = parsedNumber(disc);
    const anyNumber = order.some((e) => parsedNumber(e) !== null);
    for (const [i, e] of order.entries()) {
      if (e === disc) continue;
      const origin = owner.choiceOrigin(e.discId);
      if (origin?.kind === 'direct' || (origin?.kind === 'copy' && origin.source !== null)) {
        skipped.push({ discId: e.discId, reason: origin.kind });
        continue;
      }
      let c: OwnerChoice = choice;
      if (choice.kind === 'title' && choice.disc !== null) {
        const theirs = parsedNumber(e);
        const n = theirs !== null ? (own !== null ? theirs - own + choice.disc : theirs) : anyNumber ? null : choice.disc + i - at;
        if (own === null && theirs !== null && theirs === choice.disc) {
          skipped.push({ discId: e.discId, reason: 'conflict' });
          continue;
        }
        if (n === null || n < 1) {
          skipped.push({ discId: e.discId, reason: 'no-number' });
          continue;
        }
        c = { ...choice, disc: n };
      }
      owner.setChoice(e.discId, e.fingerprint, c, 'group');
    }
  }
  rebuildAfter(titles, library, discId, choice);
  return applyToGroup ? json(200, { skipped }) : { status: 204 };
}

/** The discs of a music release with the origin a new choice on each takes; a copy that follows its source is left out. */
function musicReleaseDiscs(titles: TitleLibrary, library: Library, id: string): { discId: string; fingerprint: string | null; origin: 'group' | 'direct' }[] {
  const byId = new Map(library.evidence().map((e) => [e.discId, e]));
  const detail = titles.service.catalogue().detail(id);
  const discIds = [...(detail?.seasons ?? []).flatMap((s) => s.discs), ...(detail?.extras ?? [])].flatMap((slot) => slot.copies.map((c) => c.discId));
  const out: { discId: string; fingerprint: string | null; origin: 'group' | 'direct' }[] = [];
  for (const discId of discIds) {
    const origin = titles.owner.choiceOrigin(discId);
    if (origin?.kind === 'copy' && origin.source !== null) continue;
    out.push({ discId, fingerprint: byId.get(discId)?.fingerprint ?? null, origin: origin?.kind === 'group' ? 'group' : 'direct' });
  }
  return out;
}

/** The owner's title routes, or null for another route. `id` is decoded. `route` is `<METHOD> <collection>[/:id]`. */
async function titleAdminRoute(route: string, id: string | undefined, req: Parameters<Handler>[0], url: URL, library: Library, titles: TitleLibrary): Promise<Response | null> {
  const { service, owner } = titles;
  switch (route) {
    case 'GET unsorted': {
      const page = (key: string, fallback: number, max: number): number => {
        const raw = url.searchParams.get(key);
        if (raw === null) return fallback;
        const n = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(n) || n > max) throw new HttpError(400, 'bad paging');
        return n;
      };
      const offset = page('offset', 0, Number.MAX_SAFE_INTEGER);
      const limit = page('limit', DEFAULT_PAGE, MAX_PAGE);
      const all = service.catalogue().unsorted;
      return json(200, { items: all.slice(offset, offset + limit), total: all.length });
    }
    case 'GET hidden':
      return json(200, { discs: service.catalogue().hidden });
    case 'PUT names/:id': {
      const body = await readJson(req);
      const value = isObject(body) && hasKeys(body, ['name']) ? (body.name === null ? null : name(body.name)) : undefined;
      if (value === undefined) throw new HttpError(400, 'bad name');
      const music = service.catalogue().titles.some((t) => t.id === id && t.kind === 'music' && !t.own);
      const known = music || library.evidence().some((e) => e.discId === id);
      if (!known) return json(404, { error: 'unknown id' });
      owner.setDisplayName(id!, value);
      // a music title's id comes from its folder; the name is also kept in each disc's music choice, which follows the
      // disc when the folder moves. A copy keeps following its source.
      if (music) {
        for (const d of musicReleaseDiscs(titles, library, id!)) {
          const had = owner.snapshot().choices.get(d.discId);
          if (value === null && had?.kind !== 'music') continue;
          owner.setChoice(d.discId, d.fingerprint, { ...(had?.kind === 'music' ? had : {}), kind: 'music', name: value }, d.origin);
        }
      }
      rebuildAfter(titles, library);
      return { status: 204 };
    }
    case 'PUT music/:id': {
      const body = await readJson(req);
      if (!isObject(body) || !hasKeys(body, [], ['artist', 'rejectMatch']) || (body.artist === undefined && body.rejectMatch === undefined)) throw new HttpError(400, 'bad music');
      const artist = body.artist === undefined || body.artist === null ? body.artist : name(body.artist);
      if (artist === undefined && body.artist !== undefined) throw new HttpError(400, 'bad music');
      if (body.rejectMatch !== undefined && typeof body.rejectMatch !== 'boolean') throw new HttpError(400, 'bad music');
      if (!service.catalogue().titles.some((t) => t.id === id && t.kind === 'music' && !t.own)) return json(404, { error: 'unknown id' });
      // every disc of the release keeps its own name; only the fields sent change
      for (const d of musicReleaseDiscs(titles, library, id!)) {
        const had = owner.snapshot().choices.get(d.discId);
        const prev = had?.kind === 'music' ? had : null;
        const keptArtist = artist !== undefined ? artist : prev?.artist;
        const reject = body.rejectMatch !== undefined ? body.rejectMatch : prev?.rejectMatch;
        if (prev === null && (keptArtist === undefined || keptArtist === null) && reject !== true) continue;
        const next: OwnerChoice = { kind: 'music', name: prev?.name ?? null, ...(keptArtist !== undefined ? { artist: keptArtist } : {}), ...(reject === true ? { rejectMatch: true } : {}) };
        owner.setChoice(d.discId, d.fingerprint, next, d.origin);
      }
      rebuildAfter(titles, library);
      return { status: 204 };
    }
    case 'POST titles': {
      const body = await readJson(req);
      if (!isObject(body) || !hasKeys(body, ['kind', 'name'], ['seasons'])) throw new HttpError(400, 'bad title');
      const kind = KINDS.find((k) => k === body.kind);
      const n = name(body.name);
      const seasons = body.seasons ?? null;
      if (kind === undefined || n === undefined || !isCount(seasons) || (kind !== 'series' && seasons !== null)) throw new HttpError(400, 'bad title');
      const title = owner.createTitle(kind, n, seasons);
      rebuildAfter(titles, library);
      return json(200, title);
    }
    case 'PATCH titles/:id': {
      const body = await readJson(req);
      if (!isObject(body) || !hasKeys(body, [], ['name', 'seasons']) || Object.keys(body).length === 0) throw new HttpError(400, 'bad title');
      const n = body.name === undefined ? undefined : name(body.name);
      if (body.name !== undefined && n === undefined) throw new HttpError(400, 'bad title');
      if (body.seasons !== undefined && !isCount(body.seasons)) throw new HttpError(400, 'bad title');
      const existing = owner.snapshot().ownTitles.find((t) => t.id === id);
      if (!existing) return json(404, { error: 'unknown title' });
      if (existing.kind !== 'series' && body.seasons !== undefined && body.seasons !== null) throw new HttpError(400, 'bad title');
      const title = owner.updateTitle(existing.id, { ...(n !== undefined ? { name: n } : {}), ...(body.seasons !== undefined ? { seasons: body.seasons as number | null } : {}) });
      rebuildAfter(titles, library);
      return json(200, title);
    }
    case 'DELETE titles/:id': {
      if (!owner.snapshot().ownTitles.some((t) => t.id === id)) return json(404, { error: 'unknown title' });
      owner.deleteTitle(id!);
      rebuildAfter(titles, library);
      return { status: 204 };
    }
    case 'PUT settings/:id': {
      if (id !== 'title-library') return null;
      const body = await readJson(req);
      const gate = isObject(body) && hasKeys(body, ['gate']) ? body.gate : undefined;
      if (gate !== 'owners' && gate !== 'everyone') throw new HttpError(400, 'bad gate');
      owner.setGate(gate);
      return { status: 204 };
    }
    case 'GET metadata/:id':
      return id === 'status' ? json(200, service.status()) : null;
    default:
      return null;
  }
}
