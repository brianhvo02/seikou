import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FansubPickRequest, FansubTitleState, SeaDexRank, StoredSubtitle, ToshoReleaseFiles, ToshoSearchResult } from '@seikou/nas/nas-api';
import { parseDiscKey } from '@seikou/nas/disc-key';
import type { Auth } from '../auth';
import { TooLargeArchive } from '../fansubs/archive';
import { rankReleases } from '../fansubs/choose';
import type { FansubDiscs } from '../fansubs/disc-lookup';
import { episodeOfFile, mainFile, seasonEpisode } from '../fansubs/episode-files';
import { PickTooLarge } from '../fansubs/pick-store';
import { PickNotFound, TooManyPicks } from '../fansubs/picks';
import type { FansubPicks } from '../fansubs/picks';
import type { SeaDex } from '../fansubs/seadex';
import type { FansubService } from '../fansubs/service';
import type { FansubState } from '../fansubs/state';
import { NotFoundOnTosho } from '../fansubs/tosho';
import type { Tosho, ToshoFile, ToshoRelease } from '../fansubs/tosho';
import { titleUnits } from '../fansubs/units';
import { json, readJson } from '../http';
import type { Handler, Response } from '../http';
import { RateLimited } from '../titles/pacer';
import { SourceUnavailable } from '../titles/sources';
import { decodeSegment, requestDevice } from './titles';
import type { TitleLibrary } from './titles';

const PREFIX = '/api/fansubs/';
/** How long `realign` waits for the alignment before answering 503 (it carries on). */
const REALIGN_WAIT_MS = 5 * 60_000;
const LANGUAGE = /^[a-z]{3}$/;
const MAX_LANGUAGES = 20;
const MAX_QUERY = 200;
const PLAYLIST = /^\d{5}$/;

/** What the fansub routes work with; built once in `main.ts`. */
export interface FansubRouteOptions {
  readonly service: FansubService;
  readonly state: FansubState;
  readonly seadex: SeaDex;
  readonly tosho: Tosho;
  readonly picks: FansubPicks;
  readonly lookup: FansubDiscs;
}

const notFound = (error = 'not found'): Response => json(404, { error });
const bad = (): Response => json(400, { error: 'bad-request' });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 2 ** 31;
const isAss = (format: string): boolean => /^(ASS|SSA)$/i.test(format);
const blank = (titleId: string): FansubTitleState => ({ titleId, lastRunAt: null, running: false, nothingFound: false, seasons: {}, episodes: {} });
const interactive = { urgent: true } as const;

/**
 * `/api/fansubs/…`, behind `requireToken`. The owner's routes (a title's run and state, undelete, realign, original
 * timing, the languages setting) answer 403 to anyone else; the viewer search (`search`, `releases/<id>`, `picks`) is
 * open to every paired person whatever `TITLE_LIBRARY` says, since a pick is their own viewing (spec §9); behind a closed
 * gate a guest's search just gets no SeaDex ranks and no file matched to the playing episode.
 */
export function fansubRoutes(auth: Auth, opts: FansubRouteOptions, titles?: TitleLibrary): Handler {
  const { service, state, seadex, tosho, picks, lookup } = opts;
  const catalogue = titles ? () => titles.service.catalogue() : null;

  const withMark = (s: StoredSubtitle): StoredSubtitle => (service.stale(s) ? { ...s, stale: true } : s);

  const download = async (path: string | null): Promise<Response> => {
    if (path === null) return notFound();
    try {
      const { size } = await stat(path);
      return { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'Cache-Control': 'private, no-cache' }, body: createReadStream(path) };
    } catch {
      return notFound();
    }
  };

  /** SeaDex's rank of each release (by info hash) in the entries of a title's seasons and movie; empty when SeaDex can't say. */
  const ranksFor = async (titleId: string | null): Promise<Map<string, SeaDexRank>> => {
    const ranks = new Map<string, SeaDexRank>();
    if (titleId === null || !catalogue) return ranks;
    for (const alId of new Set(titleUnits(catalogue(), titleId).map((u) => u.alId))) {
      try {
        const entry = await seadex.entry(alId, interactive);
        for (const r of entry ? rankReleases(entry) : []) if (!ranks.has(r.release.infoHash!)) ranks.set(r.release.infoHash!, r.rank);
      } catch (e) {
        if (!(e instanceof SourceUnavailable || e instanceof RateLimited)) throw e;
      }
    }
    return ranks;
  };
  const result = (r: ToshoRelease, ranks: ReadonlyMap<string, SeaDexRank>): ToshoSearchResult =>
    ({ id: r.id, title: r.title, date: r.date, seadex: ranks.get(r.infoHash.toLowerCase()) ?? null });

  /** The file of the episode a disc's playlist is (a movie: the release's main file), or null when it isn't one. */
  const matchedFile = (files: readonly ToshoFile[], discKey: string | null, playlistId: string | null): ToshoFile | null => {
    if (discKey === null || playlistId === null || !catalogue) return null;
    const cat = catalogue();
    for (const t of cat.titles) {
      for (const unit of titleUnits(cat, t.id)) {
        if (unit.season === null) {
          if (unit.episodes.some((e) => lookup.discKey(e.discId) === discKey)) return mainFile(files);
          continue;
        }
        const ep = unit.episodes.find((e) => e.playlistId === playlistId && lookup.discKey(e.discId) === discKey);
        const season = unit.season;
        if (ep) return files.find((f) => { const n = episodeOfFile(f.name); return n !== null && seasonEpisode(n, season) === ep.number; }) ?? null;
      }
    }
    return null;
  };

  /** `seesCatalogue`: the asker may learn of the title library (an owner, or the gate is open), so the episode's file is matched. */
  const releaseFiles = async (id: number, query: URLSearchParams, seesCatalogue: boolean): Promise<Response> => {
    const release = await tosho.byId(id, interactive);
    if (!release) return notFound();
    picks.noteRelease(release);
    const files = release.files
      .map((f) => ({ file: f, tracks: f.tracks.filter((t) => isAss(t.format)).map(({ track, language, name }) => ({ track, language, name })) }))
      .filter((f) => f.tracks.length > 0);
    const matched = seesCatalogue ? matchedFile(files.map((f) => f.file), query.get('discKey'), query.get('playlistId')) : null;
    const body: ToshoReleaseFiles = {
      release: result(release, new Map()),
      files: files.map(({ file, tracks }) => ({ id: file.id, name: file.name, episode: episodeOfFile(file.name), tracks })),
      matchedFileId: matched?.id ?? null,
    };
    return json(200, body, { 'Cache-Control': 'no-store' });
  };

  const parsePick = (v: unknown): FansubPickRequest | null => {
    if (!isObject(v) || Object.keys(v).sort().join() !== 'discKey,fileId,playlistId,track') return null;
    const { fileId, track, discKey, playlistId } = v;
    return isIndex(fileId) && isIndex(track) && typeof discKey === 'string' && parseDiscKey(discKey) !== null && typeof playlistId === 'string' && PLAYLIST.test(playlistId)
      ? { fileId, track, discKey, playlistId }
      : null;
  };

  const viewer = async (req: Parameters<Handler>[0], url: URL, device: { personId: string; owner: boolean }, segments: readonly string[]): Promise<Response | null> => {
    const method = req.method ?? 'GET';
    const { personId } = device;
    // Behind a closed gate (`TITLE_LIBRARY=owners`) a guest's search learns nothing of the catalogue: no ranks, no matched file.
    const seesCatalogue = device.owner || titles?.service.gate() === 'everyone';
    const [what, id, part, name, ...extra] = segments;
    if (what === 'search' && segments.length === 1) {
      if (method !== 'GET') return json(405, { error: 'method not allowed' }, { Allow: 'GET' });
      const q = url.searchParams.get('q')?.trim() ?? '';
      if (q === '' || q.length > MAX_QUERY) return bad();
      const [found, ranks] = await Promise.all([tosho.search(q, interactive), ranksFor(seesCatalogue ? url.searchParams.get('titleId') : null)]);
      return json(200, found.map((r) => result(r, ranks)), { 'Cache-Control': 'no-store' });
    }
    if (what === 'releases' && segments.length === 2) {
      if (method !== 'GET') return json(405, { error: 'method not allowed' }, { Allow: 'GET' });
      return /^\d{1,10}$/.test(id!) ? await releaseFiles(Number(id), url.searchParams, seesCatalogue) : notFound();
    }
    if (what !== 'picks') return null;
    if (segments.length === 1) {
      if (method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST' });
      const body = parsePick(await readJson(req));
      return body ? json(200, await picks.pick(personId, body)) : bad();
    }
    const shape = part === 'file' && segments.length === 3 ? 'file' : part === 'fonts' && segments.length === 4 ? 'font' : null;
    if (shape === null || extra.length > 0) return notFound();
    if (method !== 'GET') return json(405, { error: 'method not allowed' }, { Allow: 'GET' });
    return download(shape === 'file' ? picks.filePath(id!) : picks.fontPath(id!, name!));
  };

  const owner = async (req: Parameters<Handler>[0], segments: readonly string[]): Promise<Response | null> => {
    const method = req.method ?? 'GET';
    const allow = (m: string): Response | null => (method === m ? null : json(405, { error: 'method not allowed' }, { Allow: m }));
    const [what, id, action, ...extra] = segments;
    if (extra.length > 0) return notFound();
    if (what === 'languages' && segments.length === 1) {
      if (method === 'GET') return json(200, { languages: state.languages() });
      if (method !== 'PUT') return json(405, { error: 'method not allowed' }, { Allow: 'GET, PUT' });
      const body = await readJson(req);
      const codes = isObject(body) && Object.keys(body).join() === 'languages' ? body.languages : null;
      if (!Array.isArray(codes) || codes.length < 1 || codes.length > MAX_LANGUAGES || !codes.every((c) => typeof c === 'string' && LANGUAGE.test(c))) return bad();
      state.setLanguages(codes as string[]);
      return json(200, { languages: state.languages() });
    }
    if (what === 'titles' && id !== undefined && id !== '') {
      if (!catalogue?.().detail(id)) return notFound();
      if (action === undefined) return allow('GET') ?? json(200, state.title(id) ?? blank(id), { 'Cache-Control': 'no-store' });
      if (action === 'run') {
        const refused = allow('POST');
        if (refused) return refused;
        // a title that already runs (a nightly run waiting for the NAS to be idle) is hurried
        return json(202, service.runNow(id));
      }
      if (action === 'undelete') {
        const refused = allow('POST');
        if (refused) return refused;
        state.undelete(id);
        return { status: 204 };
      }
      return notFound();
    }
    if (what === 'subtitles' && id !== undefined && (action === 'realign' || action === 'original')) {
      const refused = allow('POST');
      if (refused) return refused;
      if (action === 'original') {
        const s = service.useOriginal(id);
        return s ? json(200, withMark(s)) : notFound();
      }
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((r) => { timer = setTimeout(() => r('late'), REALIGN_WAIT_MS); });
      const work = service.realign(id);
      // the alignment carries on after a late answer; its failure then is only logged
      work.catch((e: unknown) => console.warn(`fansubs: realign ${id}: ${e instanceof Error ? e.message : String(e)}`));
      try {
        const s = await Promise.race([work, late]);
        if (s === 'late') return json(503, { error: 'busy' }, { 'Retry-After': '60' });
        return s ? json(200, withMark(s)) : notFound();
      } finally {
        clearTimeout(timer);
      }
    }
    return notFound();
  };

  return async (req, url) => {
    if (!url.pathname.startsWith(PREFIX)) return null;
    const device = requestDevice(auth, req.headers.authorization, url);
    if (!device) return json(401, { error: 'unauthorized' });
    const segments = url.pathname.slice(PREFIX.length).split('/').map(decodeSegment);
    try {
      const open = await viewer(req, url, device, segments);
      if (open) return open;
      if (!device.owner) return json(403, { error: 'forbidden' });
      return await owner(req, segments);
    } catch (e) {
      if (e instanceof TooManyPicks) return json(429, { error: 'too-many' }, { 'Retry-After': '600' });
      if (e instanceof PickNotFound) return notFound(e.reason);
      if (e instanceof NotFoundOnTosho) return notFound('gone');
      if (e instanceof TooLargeArchive || e instanceof PickTooLarge) return json(413, { error: 'too-large' });
      if (e instanceof SourceUnavailable || e instanceof RateLimited) return json(503, { error: 'unavailable' }, { 'Retry-After': '30' });
      throw e;
    }
  };
}
