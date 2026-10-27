import { advertisable, neverDockerOrTailscale } from './rtc/public-address';

export interface LibraryRoot {
  name: string;
  dir: string;
  /** Roots sharing a group appear as one top-level folder named after it. */
  group?: string;
}

export interface Config {
  roots: LibraryRoot[];
  dataDir: string;
  port: number;
  /** Local time of the nightly rescan. */
  nightlyScanAt: { hour: number; minute: number };
  /** Pause between directory reads of a scan. */
  scanPauseMs: number;
  /** `PUBLIC_BASE` (required): this server's API as devices reach it, registered with each pairing code. */
  publicBase: string;
  /** `APP_URL`: the player pairing links open, always ending in `/`. */
  appUrl: string;
  /** `LOOKUP_CONTACT`: named in the User-Agent of the MusicBrainz and Discogs lookups; null when unset. */
  lookupContact: string | null;
  /** IP or hostname of the reverse proxy whose `X-Forwarded-For` is believed. */
  trustedProxy: string | null;
  /** The rendezvous Worker's base URL; unset (or empty) means codes aren't registered with it. */
  rendezvousUrl: string | undefined;
  /** `TMDB_API_KEY`; null (unset or empty) means AniList and TheDiscDB only. Never logged. */
  tmdbApiKey: string | null;
  /** `DISCOGS_TOKEN`; null (unset or empty) means MusicBrainz only. Never logged. */
  discogsToken: string | null;
  /** `TITLE_LIBRARY`: who gets the title routes until the owner sets it. */
  titleLibrary: 'owners' | 'everyone';
  /** The WebRTC route, served while `rendezvousUrl` is set. */
  rtc: RtcConfig;
  /** The quality levels' encoder (spec §6 of the lower-quality spec). */
  levels: LevelsConfig;
  /** Fansubs from SeaDex and Anime Tosho (spec 2026-10-23-fansubs-design). */
  fansubs: FansubsConfig;
}

export interface FansubsConfig {
  /** `SEADEX_URL`: the SeaDex site, `https://seadex.moe` by default. */
  seadexUrl: string;
  /** `TOSHO_FEED_URL`: Anime Tosho's JSON feed, `https://feed.animetosho.net` by default. */
  toshoFeedUrl: string;
  /** `TOSHO_URL`: Anime Tosho's site (font packs), `https://animetosho.net` by default. */
  toshoUrl: string;
  /** `FANSUB_WINDOW_END` (`HH:MM`, 08:00 by default): the overnight run stops here. */
  windowEnd: { hour: number; minute: number };
  /** `FANSUB_STORE_BYTES`: the fansub subtitles' byte budget, 20 GB by default. */
  storeBytes: number;
  /** `FANSUB_CACHE_BYTES`: the download cache's byte budget, 5 GB by default. */
  cacheBytes: number;
  /** `FANSUB_PICKS_BYTES`: the byte budget of viewers' own Anime Tosho picks, 2 GB by default. */
  picksBytes: number;
}

export interface LevelsConfig {
  /** `LEVELS_BACKEND`: `qsv` (Intel Quick Sync, the default), `x264` (software, for dev and CI) or `off` (Original only). */
  backend: 'qsv' | 'x264' | 'off';
  /** `TRANSCODE_CACHE_BYTES`: the segment cache's byte budget, 50 GB by default. */
  cacheBytes: number;
  /** `FFMPEG_PATH`, `ffmpeg` on the PATH by default. */
  ffmpegPath: string;
  /** `FFPROBE_PATH`, `ffprobe` on the PATH by default. */
  ffprobePath: string;
}

export interface RtcConfig {
  /** `RTC_PORT`: the one UDP port ICE uses, 47998 by default. */
  port: number;
  /** `RTC_LAN_ADDRESS`: the NAS's LAN IPv4, advertised next to its public address. */
  lanAddress?: string;
  /** `RTC_ADVERTISE` (tests): advertised instead of the public and LAN addresses, with no STUN discovery. */
  advertise?: string[];
}

/** The hosted player, which pairing links open unless `APP_URL` says otherwise. */
export const DEFAULT_APP_URL = 'https://bluray.pages.dev/';

/** Reads `LIBRARY_ROOTS` (comma-separated `name=dir` or `name=dir@group`), `DATA_DIR`, `PORT`, `NIGHTLY_SCAN_AT` (`HH:MM`), `SCAN_PAUSE_MS`, `PUBLIC_BASE` (required), `APP_URL`, `LOOKUP_CONTACT`, `TRUSTED_PROXY`, `RENDEZVOUS_URL`, `TMDB_API_KEY`, `DISCOGS_TOKEN`, `TITLE_LIBRARY`, `RTC_PORT`, `RTC_LAN_ADDRESS`, `RTC_ADVERTISE`, `LEVELS_BACKEND`, `TRANSCODE_CACHE_BYTES`, `FFMPEG_PATH` and `FFPROBE_PATH`. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const roots = (env.LIBRARY_ROOTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq <= 0 || eq === entry.length - 1) throw new Error(`LIBRARY_ROOTS entry "${entry}" is not name=dir`);
      const rest = entry.slice(eq + 1);
      const at = rest.lastIndexOf('@');
      if (at < 0) return { name: entry.slice(0, eq), dir: rest };
      const group = rest.slice(at + 1);
      if (at === 0 || group === '') throw new Error(`LIBRARY_ROOTS entry "${entry}" is not name=dir`);
      return { name: entry.slice(0, eq), dir: rest.slice(0, at), group };
    });
  const seen = new Set<string>();
  for (const { name } of roots) {
    if (seen.has(name)) throw new Error(`LIBRARY_ROOTS names "${name}" twice`);
    seen.add(name);
  }
  for (const { group } of roots) {
    if (group !== undefined && seen.has(group)) throw new Error(`LIBRARY_ROOTS group "${group}" is also a root name`);
  }
  return { roots, dataDir: env.DATA_DIR ?? '/data', port: parsePort(env.PORT), nightlyScanAt: parseTime(env.NIGHTLY_SCAN_AT), scanPauseMs: parsePause(env.SCAN_PAUSE_MS), publicBase: parseBase(env.PUBLIC_BASE), appUrl: parseAppUrl(env.APP_URL), lookupContact: parseContact(env.LOOKUP_CONTACT), trustedProxy: parseProxy(env.TRUSTED_PROXY), rendezvousUrl: parseRendezvous(env.RENDEZVOUS_URL), tmdbApiKey: env.TMDB_API_KEY?.trim() || null, discogsToken: env.DISCOGS_TOKEN?.trim() || null, titleLibrary: parseTitleLibrary(env.TITLE_LIBRARY), rtc: parseRtc(env), levels: parseLevels(env), fansubs: parseFansubs(env) };
}

function parseRtc(env: Record<string, string | undefined>): RtcConfig {
  const rtc: RtcConfig = { port: 47998 };
  if (env.RTC_PORT !== undefined && env.RTC_PORT !== '') {
    const port = Number(env.RTC_PORT);
    if (!/^\d+$/.test(env.RTC_PORT) || port === 0 || port >= 65535) throw new Error(`RTC_PORT "${env.RTC_PORT}" is not a UDP port below 65535`);
    rtc.port = port;
  }
  if (env.RTC_LAN_ADDRESS !== undefined && env.RTC_LAN_ADDRESS !== '') {
    const ip = env.RTC_LAN_ADDRESS.trim();
    if (!advertisable(ip)) throw new Error(`RTC_LAN_ADDRESS "${ip}" is not a public IPv4 address or one in 10.0.0.0/8 or 192.168.0.0/16`);
    rtc.lanAddress = ip;
  }
  if (env.RTC_ADVERTISE !== undefined && env.RTC_ADVERTISE !== '') {
    rtc.advertise = env.RTC_ADVERTISE.split(',').map((entry) => {
      const ip = entry.trim();
      if (!neverDockerOrTailscale(ip)) throw new Error(`RTC_ADVERTISE "${ip}" is not an IPv4 address outside 172.16.0.0/12 and 100.64.0.0/10`);
      return ip;
    });
  }
  return rtc;
}

const DEFAULT_TRANSCODE_CACHE_BYTES = 50_000_000_000;

function parseLevels(env: Record<string, string | undefined>): LevelsConfig {
  const backend = env.LEVELS_BACKEND === undefined || env.LEVELS_BACKEND === '' ? 'qsv' : env.LEVELS_BACKEND;
  if (backend !== 'qsv' && backend !== 'x264' && backend !== 'off') throw new Error(`LEVELS_BACKEND "${backend}" is not qsv, x264 or off`);
  let cacheBytes = DEFAULT_TRANSCODE_CACHE_BYTES;
  const cache = env.TRANSCODE_CACHE_BYTES;
  if (cache !== undefined && cache !== '') {
    if (!/^\d+$/.test(cache) || !Number.isSafeInteger(Number(cache))) throw new Error(`TRANSCODE_CACHE_BYTES "${cache}" is not a number of bytes`);
    cacheBytes = Number(cache);
  }
  return { backend, cacheBytes, ffmpegPath: env.FFMPEG_PATH || 'ffmpeg', ffprobePath: env.FFPROBE_PATH || 'ffprobe' };
}

function parseBytes(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} "${value}" is not a number of bytes`);
  return Number(value);
}

/** An https base, or http only for the loopback stand-in of the tests. */
function secureBase(env: Record<string, string | undefined>, name: string, fallback: string): string {
  const value = env[name] === undefined || env[name] === '' ? fallback : env[name]!;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  const loopback = url !== undefined && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (!url || (url.protocol !== 'https:' && !loopback)) throw new Error(`${name} "${value}" is not an https URL`);
  return value.replace(/\/+$/, '');
}

function parseFansubs(env: Record<string, string | undefined>): FansubsConfig {
  const end = env.FANSUB_WINDOW_END === undefined || env.FANSUB_WINDOW_END === '' ? '08:00' : env.FANSUB_WINDOW_END;
  const m = /^(\d{1,2}):(\d{2})$/.exec(end);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`FANSUB_WINDOW_END "${end}" is not HH:MM`);
  return {
    seadexUrl: secureBase(env, 'SEADEX_URL', 'https://seadex.moe'),
    toshoFeedUrl: secureBase(env, 'TOSHO_FEED_URL', 'https://feed.animetosho.net'),
    toshoUrl: secureBase(env, 'TOSHO_URL', 'https://animetosho.net'),
    windowEnd: { hour: Number(m[1]), minute: Number(m[2]) },
    storeBytes: parseBytes(env, 'FANSUB_STORE_BYTES', 20_000_000_000),
    cacheBytes: parseBytes(env, 'FANSUB_CACHE_BYTES', 5_000_000_000),
    picksBytes: parseBytes(env, 'FANSUB_PICKS_BYTES', 2_000_000_000),
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8080;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) throw new Error(`PORT "${value}" is not a port number`);
  return port;
}

function parseTime(value: string | undefined): { hour: number; minute: number } {
  if (value === undefined) return { hour: 4, minute: 0 };
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`NIGHTLY_SCAN_AT "${value}" is not HH:MM`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function parsePause(value: string | undefined): number {
  if (value === undefined) return 10;
  if (!/^\d+$/.test(value)) throw new Error(`SCAN_PAUSE_MS "${value}" is not a number of milliseconds`);
  return Number(value);
}

function parseBase(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error("PUBLIC_BASE is not set: the server's HTTPS API base as devices reach it, e.g. https://nas.example.com/bluray/api/");
  }
  return httpUrl('PUBLIC_BASE', value);
}

/** Goes into a User-Agent header, where anything but printable ASCII makes every lookup throw. */
function parseContact(value: string | undefined): string | null {
  const contact = value?.trim() ?? '';
  if (contact === '') return null;
  if (!/^[\x20-\x7e]+$/.test(contact)) throw new Error('LOOKUP_CONTACT must be printable ASCII (an email address or a URL)');
  return contact;
}

function parseAppUrl(value: string | undefined): string {
  if (value === undefined || value === '') return DEFAULT_APP_URL;
  const url = httpUrl('APP_URL', value);
  // Pairing links append ?pair=… to it, so it can carry neither a query nor a fragment.
  if (/[?#]/.test(url)) throw new Error(`APP_URL "${value}" has a query or fragment; pairing links add their own query`);
  return url.endsWith('/') ? url : `${url}/`;
}

function parseRendezvous(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : httpUrl('RENDEZVOUS_URL', value);
}

function httpUrl(name: string, value: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error(`${name} "${value}" is not an http(s) URL`);
  return value;
}

function parseProxy(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (!/^[A-Za-z0-9.:_-]+$/.test(value)) throw new Error(`TRUSTED_PROXY "${value}" is not an IP or hostname`);
  return value;
}

function parseTitleLibrary(value: string | undefined): 'owners' | 'everyone' {
  if (value === undefined || value === '') return 'owners';
  if (value !== 'owners' && value !== 'everyone') throw new Error(`TITLE_LIBRARY "${value}" is not owners or everyone`);
  return value;
}
