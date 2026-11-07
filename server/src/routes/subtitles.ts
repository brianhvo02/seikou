import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { StoredSubtitle, SubtitleAttachment } from '@seikou/nas/nas-api';
import { parseDiscKey } from '@seikou/nas/disc-key';
import { LockHeldError } from '@seikou/titles/atomic-json';
import type { Auth } from '../auth';
import { BodyTooLargeError, bodyStream, json, readJson } from '../http';
import type { Handler, Response } from '../http';
import type { Library } from '../library';
import type { FansubService } from '../fansubs/service';
import type { DiscEvidence } from '../titles/evidence';
import { BadNameError, EmptyBodyError, NotFoundError, FONTS_LIMIT_BYTES, SUBTITLE_LIMIT_BYTES, SubtitleStore, TooLargeError } from '../subtitle-store';
import type { SubtitleMeta } from '../subtitle-store';
import { decodeSegment, requestDevice } from './titles';
import type { TitleLibrary } from './titles';

const LIST = '/api/subtitles';
const PREFIX = `${LIST}/`;
const MAX_NAME = 200;
const LANGUAGE = /^[A-Za-z0-9-]{1,35}$/;
const MAX_OFFSET_MS = 600_000;

/**
 * What the routes work on besides the store: the title library (the gate, episodes), the library (disc evidence) and
 * the fansub runs (told of a deleted fansub; they mark one lined up on another disc).
 */
export interface SubtitleCatalogue {
  readonly titles?: TitleLibrary;
  readonly library?: Library;
  readonly fansubs?: Pick<FansubService, 'deleted' | 'stale'>;
}

const notFound = (): Response => json(404, { error: 'not found' });
const bad = (error = 'bad-request'): Response => json(400, { error });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1_000_000;

type For =
  | { kind: 'episode'; titleId: string; seasonId: string; episode: number }
  | { kind: 'chapter'; discId: string; playlistId: string; chapter: number; titleId?: string };

function parseFor(v: unknown): For | null {
  if (!isObject(v)) return null;
  const keys = Object.keys(v).sort().join();
  if (v.kind === 'episode' && keys === 'episode,kind,seasonId,titleId' && isString(v.titleId) && isString(v.seasonId) && isIndex(v.episode)) {
    return { kind: 'episode', titleId: v.titleId, seasonId: v.seasonId, episode: v.episode };
  }
  if (v.kind === 'chapter' && (keys === 'chapter,discId,kind,playlistId' || (keys === 'chapter,discId,kind,playlistId,titleId' && isString(v.titleId)))
    && isString(v.discId) && isString(v.playlistId) && isIndex(v.chapter)) {
    return { kind: 'chapter', discId: v.discId, playlistId: v.playlistId, chapter: v.chapter, ...(typeof v.titleId === 'string' ? { titleId: v.titleId } : {}) };
  }
  return null;
}

const validName = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= MAX_NAME;
const validLanguage = (v: unknown): v is string => typeof v === 'string' && LANGUAGE.test(v);
const validOffset = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_OFFSET_MS;

/**
 * `/api/subtitles`: subtitles owners upload to the NAS, with their fonts. Everyone paired lists and downloads them
 * (404 to a guest while the title gate is `owners`, as the title routes answer; a guest never sees one that isn't
 * attached); only owners create, upload, edit and delete. Behind `requireToken`.
 */
export function subtitleRoutes(auth: Auth, store: SubtitleStore, catalogue: SubtitleCatalogue = {}): Handler {
  const { titles, library, fansubs } = catalogue;
  const evidence = (): readonly DiscEvidence[] => library?.evidence() ?? [];
  const keyOf = (discId: string): string | null => {
    const ev = evidence().find((e) => e.discId === discId);
    return ev ? (ev.fingerprint ? `f.${ev.fingerprint}` : `d.${ev.discId}`) : null;
  };
  /** The listed discs a key stands for. */
  const discsOf = (discKey: string): readonly DiscEvidence[] => {
    const parsed = parseDiscKey(discKey);
    if (!parsed) return [];
    return evidence().filter((e) => (parsed.kind === 'disc' ? e.discId === parsed.discId : e.fingerprint === parsed.fingerprint));
  };
  const isAttached = (a: SubtitleAttachment): boolean => discsOf(a.discKey).some((e) => e.playlists.some((p) => p.id === a.playlistId));
  const withAttached = (s: StoredSubtitle): StoredSubtitle => ({ ...s, attached: isAttached(s.attachment) });
  // Who uploaded a subtitle is the owners' business; other people get the list without it.
  const withoutUploader = (s: StoredSubtitle): StoredSubtitle => { const { uploaderPersonId: _uploader, ...rest } = s; return rest; };

  /** The attachment a `for` stands for, or null when the episode, disc or playlist doesn't resolve. */
  const resolve = (f: For): SubtitleAttachment | null => {
    if (f.kind === 'chapter') {
      const ev = evidence().find((e) => e.discId === f.discId);
      const playlist = ev?.playlists.find((p) => p.id === f.playlistId);
      const discKey = keyOf(f.discId);
      return playlist && discKey !== null && f.chapter < playlist.chapters
        ? { kind: 'chapter', discKey, playlistId: f.playlistId, chapter: f.chapter, ...(f.titleId !== undefined ? { titleId: f.titleId } : {}) }
        : null;
    }
    const ep = titles?.service.catalogue().detail(f.titleId)?.seasons.find((s) => s.id === f.seasonId)?.episodes?.find((e) => e.number === f.episode);
    const discKey = ep ? keyOf(ep.discId) : null;
    return ep && discKey !== null ? { kind: 'episode', discKey, playlistId: ep.playlistId, titleId: f.titleId, seasonId: f.seasonId, episode: f.episode } : null;
  };

  /** The disc keys of every copy of a title's discs, in its seasons and extras. */
  const titleKeys = (titleId: string): Set<string> => {
    const detail = titles?.service.catalogue().detail(titleId);
    const keys = new Set<string>();
    if (!detail) return keys;
    for (const slot of [...detail.extras, ...detail.seasons.flatMap((s) => [...s.discs, ...s.extras])]) {
      for (const copy of slot.copies) {
        const key = keyOf(copy.discId);
        if (key !== null) keys.add(key);
      }
    }
    return keys;
  };

  const list = (query: URLSearchParams, owner: boolean): Response => {
    const discKey = query.get('discKey');
    const titleId = query.get('titleId');
    if (discKey === null && titleId === null) return bad();
    const keys = titleId === null ? new Set<string>() : titleKeys(titleId);
    // an episode upload is listed by its disc too once the title it names is gone (a rematch gave the disc another id),
    // so the owners of the title its disc is under now can see it and attach it again
    const titleGone = (id: string | undefined): boolean => id !== undefined && !titles?.service.catalogue().detail(id);
    const found = store.list()
      .filter((s) => (discKey !== null && s.attachment.discKey === discKey)
        || (titleId !== null && (s.attachment.titleId === titleId
          || ((s.attachment.kind === 'chapter' || titleGone(s.attachment.titleId)) && keys.has(s.attachment.discKey)))))
      .map(withAttached)
      .filter((s) => owner || s.attached !== false)
      .map((s) => (owner ? (s.source && fansubs?.stale(s) ? { ...s, stale: true } : s) : withoutUploader(s)))
      .sort((a, b) => a.uploadedAt - b.uploadedAt || a.id.localeCompare(b.id));
    return json(200, found, { 'Cache-Control': 'no-store' });
  };

  const download = async (path: string | null): Promise<Response> => {
    if (path === null) return notFound();
    try {
      const { size } = await stat(path);
      return { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'Cache-Control': 'private, no-cache' }, body: createReadStream(path) };
    } catch {
      return notFound();
    }
  };

  const create = async (req: Parameters<Handler>[0], personId: string): Promise<Response> => {
    const body = await readJson(req);
    const f = isObject(body) ? parseFor(body.for) : null;
    if (!isObject(body) || !f || !validName(body.name) || !validLanguage(body.language) || (body.offsetMs !== undefined && !validOffset(body.offsetMs))
      || !Object.keys(body).every((k) => ['name', 'language', 'offsetMs', 'for'].includes(k))) return bad();
    const attachment = resolve(f);
    if (!attachment) return bad('not-found');
    const meta: SubtitleMeta = { name: body.name, language: body.language, offsetMs: (body.offsetMs as number | undefined) ?? 0, attachment, uploaderPersonId: personId };
    return json(201, withAttached(store.create(meta)));
  };

  const patch = async (req: Parameters<Handler>[0], id: string): Promise<Response> => {
    const body = await readJson(req);
    if (!isObject(body) || Object.keys(body).length === 0 || !Object.keys(body).every((k) => ['name', 'language', 'offsetMs', 'for'].includes(k))) return bad();
    const changes: { -readonly [K in keyof Parameters<SubtitleStore['update']>[1]]: Parameters<SubtitleStore['update']>[1][K] } = {};
    if (body.name !== undefined) {
      if (!validName(body.name)) return bad();
      changes.name = body.name;
    }
    if (body.language !== undefined) {
      if (!validLanguage(body.language)) return bad();
      changes.language = body.language;
    }
    if (body.offsetMs !== undefined) {
      if (!validOffset(body.offsetMs)) return bad();
      changes.offsetMs = body.offsetMs;
    }
    if (body.for !== undefined) {
      const f = parseFor(body.for);
      if (!f) return bad();
      const attachment = resolve(f);
      if (!attachment) return bad('not-found');
      changes.attachment = attachment;
    }
    const updated = store.update(id, changes);
    return updated ? json(200, withAttached(updated)) : notFound();
  };

  const upload = async (req: Parameters<Handler>[0], id: string, kind: 'file' | 'fonts', name: string): Promise<Response> => {
    const cur = store.get(id);
    if (!cur) return notFound();
    // what the store allows this one: its fonts together stay under the limit, the same name replacing
    const fontRoom = FONTS_LIMIT_BYTES - cur.fonts.filter((f) => f.name !== name).reduce((n, f) => n + f.size, 0);
    const stored = kind === 'file'
      ? await store.writeFile(id, name, bodyStream(req, SUBTITLE_LIMIT_BYTES))
      : await store.writeFont(id, name, bodyStream(req, Math.max(0, fontRoom)));
    return json(200, withAttached(stored));
  };

  return async (req, url) => {
    if (url.pathname !== LIST && !url.pathname.startsWith(PREFIX)) return null;
    const device = requestDevice(auth, req.headers.authorization, url);
    if (!device) return json(401, { error: 'unauthorized' });
    const method = req.method ?? 'GET';
    const segments = url.pathname === LIST ? [] : url.pathname.slice(PREFIX.length).split('/').map(decodeSegment);
    const [id, part, name, ...extra] = segments;
    const shape = segments.length === 0 ? 'list' : segments.length === 1 ? 'one' : (part === 'file' || part === 'fonts') && segments.length === 3 ? 'named'
      : part === 'file' && segments.length === 2 ? 'file' : null;
    const allowed = shape === 'list' ? 'GET, POST' : shape === 'one' ? 'PATCH, DELETE' : shape === 'named' ? (part === 'fonts' ? 'GET, PUT' : 'PUT') : shape === 'file' ? 'GET' : null;
    if (shape === null || extra.length > 0 || id === '') return notFound();
    if (!allowed!.split(', ').includes(method)) return json(405, { error: 'method not allowed' }, { Allow: allowed! });
    // `GET <id>/fonts/<name>` is the one GET with a third segment; `PUT <id>/file/<name>` has no GET
    const write = method !== 'GET';
    if (write && !device.owner) return json(403, { error: 'forbidden' }, { Connection: 'close' });
    const open = device.owner || (titles !== undefined && titles.service.gate() === 'everyone');
    if (!write && !open) return notFound();
    // a refused PUT leaves its body unread, so the connection can't carry another request
    const refuse = (r: Response): Response => (method === 'PUT' ? { ...r, headers: { ...r.headers, Connection: 'close' } } : r);
    try {
      if (shape === 'list') return method === 'GET' ? list(url.searchParams, device.owner) : await create(req, device.personId);
      if (shape === 'one') {
        if (method === 'DELETE') {
          const s = store.get(id!);
          if (!store.delete(id!)) return notFound();
          // a deleted fansub's track isn't attached again by the next run
          if (s?.source) fansubs?.deleted(s);
          return { status: 204 };
        }
        return await patch(req, id!);
      }
      if (method === 'PUT') {
        const res = await upload(req, id!, part as 'file' | 'fonts', name!);
        return res.status === 200 ? res : refuse(res);
      }
      const s = store.get(id!);
      if (!s || (!device.owner && !isAttached(s.attachment))) return notFound();
      return await download(part === 'file' && shape === 'file' ? store.filePath(id!) : store.fontPath(id!, name!));
    } catch (err) {
      if (err instanceof EmptyBodyError) return refuse(bad('empty'));
      if (err instanceof BadNameError) return refuse(bad('bad-name'));
      if (err instanceof NotFoundError) return refuse(notFound());
      if (err instanceof TooLargeError || err instanceof BodyTooLargeError) return refuse(json(413, { error: 'too-large' }));
      if (err instanceof LockHeldError) return refuse(json(503, { error: 'busy' }, { 'Retry-After': '1' }));
      throw err;
    }
  };
}
