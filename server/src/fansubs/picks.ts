/**
 * A viewer's own Anime Tosho pick (spec §9): one track of a file, fetched with its file's font pack, lined up with the
 * episode the viewer plays and kept by `PickStore` (never in the subtitle store) for 30 days after its last use, within
 * the picks' byte budget. Original code.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FansubAlignment, FansubPick, FansubPickRequest } from '@seikou/nas/nas-api';
import { isCode, replaceAtomically } from '@seikou/titles/atomic-json';
import type { LevelDiscSource } from '../levels/level-discs';
import { align } from './align';
import { fontsIn7z } from './archive';
import { languageTag, normalizeLanguage } from './choose';
import type { FansubDiscs } from './disc-lookup';
import type { FetchCache } from './fetch-cache';
import { PickStore } from './pick-store';
import { retime } from './retime';
import { NotFoundOnTosho, PACK_DOWNLOAD_BYTES } from './tosho';
import type { Tosho, ToshoRelease, ToshoTrack } from './tosho';
import { fetchTrack, languageName, mostDialogue } from './tracks';

const SWEEP_EVERY_MS = 3_600_000;
const HOUR_MS = 3_600_000;
/** Picks one person may start in a rolling hour; one the NAS already keeps doesn't count. */
export const PICKS_PER_HOUR = 20;
/** Files whose release the picks remember, newest kept. */
const MAX_FILES = 20_000;
const FONT_NAME = /^[^/\\\0]{1,255}$/;
const UNSURE: FansubAlignment = { kind: 'none', reason: 'low-confidence' };

/** Past the person's hourly limit. */
export class TooManyPicks extends Error {
  override name = 'TooManyPicks';
}

/** The file or track isn't one the picks know of, or has nothing in it. */
export class PickNotFound extends Error {
  override name = 'PickNotFound';
  constructor(readonly reason: 'unknown-file' | 'unknown-track' | 'empty') {
    super(reason);
  }
}

export interface FansubPicksOptions {
  readonly dataDir: string;
  readonly tosho: Tosho;
  readonly cache: FetchCache;
  readonly discs: (discId: string) => Promise<LevelDiscSource | null>;
  readonly lookup: FansubDiscs;
  readonly ffmpegPath: string;
  /** `FANSUB_PICKS_BYTES`: what the picks may hold in all, 2 GB by default. */
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export const PICKS_LIMIT_BYTES = 2_000_000_000;

/** `p.<fileId>.<track>.<discKey>.<playlistId>`, hashed to 16 hex. */
export function pickId(req: FansubPickRequest): string {
  return createHash('sha256').update(`p.${req.fileId}.${req.track}.${req.discKey}.${req.playlistId}`).digest('hex').slice(0, 16);
}

const isAss = (t: ToshoTrack): boolean => /^(ASS|SSA)$/i.test(t.format);
/** `GroupA` from `[GroupA] Starfall Wanderer …`. */
const groupOf = (title: string): string | null => /^\s*\[([^\]]{1,100})\]/.exec(title)?.[1]?.trim() || null;

export class FansubPicks {
  private readonly store: PickStore;
  private readonly filesFile: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  /** File id to the id of its release on Anime Tosho, learnt from the releases a viewer opened. */
  private readonly releaseOf = new Map<number, number>();
  private readonly started = new Map<string, number[]>();
  private readonly building = new Map<string, Promise<FansubPick>>();
  private sweptAt = 0;

  constructor(private readonly opts: FansubPicksOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.filesFile = join(opts.dataDir, 'fansubs', 'pick-files.json');
    mkdirSync(join(opts.dataDir, 'fansubs'), { recursive: true, mode: 0o700 });
    try {
      const saved: unknown = JSON.parse(readFileSync(this.filesFile, 'utf8'));
      if (Array.isArray(saved)) {
        for (const e of saved) if (Array.isArray(e) && Number.isInteger(e[0]) && Number.isInteger(e[1])) this.releaseOf.set(e[0] as number, e[1] as number);
      }
    } catch (err) {
      if (!isCode(err, 'ENOENT') && !(err instanceof SyntaxError)) throw err;
    }
    this.store = new PickStore(opts.dataDir, { maxBytes: opts.maxBytes ?? PICKS_LIMIT_BYTES, now: this.now, building: (id) => this.building.has(id) });
    this.sweptAt = this.now();
  }

  /** A release a viewer opened: its files can be picked from now on. */
  noteRelease(release: ToshoRelease): void {
    let changed = false;
    for (const f of release.files) {
      if (this.releaseOf.get(f.id) === release.id) continue;
      this.releaseOf.delete(f.id);
      this.releaseOf.set(f.id, release.id);
      changed = true;
    }
    if (!changed) return;
    for (const id of this.releaseOf.keys()) {
      if (this.releaseOf.size <= MAX_FILES) break;
      this.releaseOf.delete(id);
    }
    replaceAtomically(this.filesFile, JSON.stringify([...this.releaseOf]));
  }

  /** The pick, from what the NAS keeps or fetched and lined up now (counted against `personId`'s hourly limit). */
  async pick(personId: string, req: FansubPickRequest): Promise<FansubPick> {
    this.sweep();
    const id = pickId(req);
    const kept = this.store.get(id);
    if (kept) {
      this.store.touch(id);
      return kept.subtitle;
    }
    const running = this.building.get(id);
    if (running) return running;
    const work = this.build(id, personId, req).finally(() => this.building.delete(id));
    this.building.set(id, work);
    return work;
  }

  /** The pick's lined-up file, or null; a use keeps it another 30 days. */
  filePath(id: string): string | null {
    return this.store.filePath(id);
  }

  fontPath(id: string, name: string): string | null {
    return this.store.fontPath(id, name);
  }

  private async build(id: string, personId: string, req: FansubPickRequest): Promise<FansubPick> {
    const { tosho, cache } = this.opts;
    const paced = { urgent: true };
    const releaseId = this.releaseOf.get(req.fileId);
    if (releaseId === undefined) throw new PickNotFound('unknown-file');
    const release = await tosho.byId(releaseId, paced);
    const file = release?.files.find((f) => f.id === req.fileId);
    if (!release || !file) throw new PickNotFound('unknown-file');
    const track = file.tracks.find((t) => t.track === req.track && isAss(t));
    if (!track) throw new PickNotFound('unknown-track');
    this.count(personId);

    const text = await fetchTrack(cache, tosho, track, paced);
    if (text === '') throw new PickNotFound('empty');
    // The file's tracks share the offset of the one with the most dialogue: a picked signs track lines up by its Full.
    const siblings: { text: string }[] = [{ text }];
    for (const t of file.tracks) {
      if (t === track || !isAss(t) || normalizeLanguage(t.language) !== normalizeLanguage(track.language)) continue;
      try {
        siblings.push({ text: await fetchTrack(cache, tosho, t, paced) });
      } catch (e) {
        this.log(`fansub pick: track ${t.track} of file ${file.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    let fonts: { name: string; data: Buffer }[] | null = null;
    const packUrl = tosho.fontPackUrl(file.id);
    try {
      fonts = (await fontsIn7z(await cache.get(packUrl, () => tosho.download(packUrl, paced, PACK_DOWNLOAD_BYTES)))).filter((f) => FONT_NAME.test(f.name) && f.name !== '.' && f.name !== '..');
    } catch (e) {
      if (!(e instanceof NotFoundOnTosho)) this.log(`fansub pick: font pack of file ${file.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const alignment = await this.alignOn(req, mostDialogue(siblings).text);

    const trackName = track.name || languageName(track.language);
    const group = groupOf(release.title);
    const data = Buffer.from(retime(text, alignment));
    const byName = new Map((fonts ?? []).map((f) => [f.name, f.data]));
    const subtitle: FansubPick = {
      id, pick: true, name: group ? `${group} · ${trackName}` : trackName, language: languageTag(track.language), offsetMs: 0,
      fileName: `${file.id}-${track.track}.ass`, fileSize: data.length, fonts: [...byName].map(([name, d]) => ({ name, size: d.length })),
      attachment: { kind: 'chapter', discKey: req.discKey, playlistId: req.playlistId, chapter: 0 }, uploadedAt: this.now(),
      // what SeaDex makes of the release isn't asked here: a pick is the viewer's own
      source: {
        kind: 'fansub', group: group ?? '', tracker: '', rank: 'other', toshoFileId: file.id, track: track.track, trackName, alignment,
        linedUpOn: { discKey: req.discKey, playlistId: req.playlistId },
      },
      ...(fonts === null ? { fontsMissing: true } : {}),
    };
    return this.store.put(subtitle, data, byName);
  }

  /** Lined up on the first copy of the disc whose playlist can be read; unsure when none can. */
  private async alignOn(req: FansubPickRequest, main: string): Promise<FansubAlignment> {
    const { lookup } = this.opts;
    for (const discId of lookup.discIds(req.discKey)) {
      const durationMs = lookup.durationMs(discId, req.playlistId);
      const disc = durationMs === null ? null : await this.opts.discs(discId);
      if (disc && durationMs !== null) return align(disc, req.playlistId, durationMs, main, this.opts.ffmpegPath, undefined, { log: this.log });
    }
    return UNSURE;
  }

  private count(personId: string): void {
    const now = this.now();
    const recent = (this.started.get(personId) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= PICKS_PER_HOUR) {
      this.started.set(personId, recent);
      throw new TooManyPicks('too many picks');
    }
    recent.push(now);
    this.started.set(personId, recent);
  }

  /** Removes old and damaged picks; at start and then at most hourly. */
  private sweep(): void {
    const now = this.now();
    if (now - this.sweptAt < SWEEP_EVERY_MS) return;
    this.sweptAt = now;
    this.store.sweep();
  }
}
