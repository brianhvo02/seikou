import type { Auth } from './auth';
import type { BdjStore } from './bdj-store';
import type { PlaybackStore } from './playback-store';
import { playbackRoutes } from './routes/playback';
import { fansubRoutes } from './routes/fansubs';
import type { FansubRouteOptions } from './routes/fansubs';
import { subtitleRoutes } from './routes/subtitles';
import type { SubtitleStore } from './subtitle-store';
import type { CodeRegistrar } from './codes';
import { json } from './http';
import type { Handler } from './http';
import type { IsoTrees } from './iso';
import type { LevelService } from './levels/level-service';
import type { Library } from './library';
import { adminRoutes, bearerToken } from './routes/admin';
import { bdjStoreRoutes } from './routes/bdj-store';
import type { DiscActivity } from './disc-activity';
import { discRoutes } from './routes/discs';
import { encodeRoutes } from './routes/encodes';
import type { EncodeIndex } from './encodes/index-store';
import type { UploadStore } from './encodes/uploads';
import { libraryRoute } from './routes/library';
import { pairRoutes } from './routes/pair';
import type { RelayState } from './rtc/relay';
import { titleRoutes } from './routes/titles';
import type { TitleLibrary } from './routes/titles';

export interface AppOptions {
  auth: Auth;
  library: Library;
  /** Each person's BD-J saved data (spec §5). */
  bdjStore: BdjStore;
  /** Absent in tests that never touch places. */
  playbackStore?: PlaybackStore;
  /** Owner-uploaded subtitles; without it, their routes answer 404. */
  subtitleStore?: SubtitleStore;
  publicBase: string;
  /** See `AdminOptions`. */
  appUrl?: string;
  rendezvousUrl?: string;
  registrar?: CodeRegistrar;
  registrarDeadlineMs?: number;
  now?: () => number;
  /** Whether a peer is the reverse proxy, whose `X-Forwarded-For` names the client (see `trustedProxy`). Default: no peer. */
  trustProxy?: (address: string) => boolean;
  /** The title library: without it, its routes answer 404. */
  titles?: TitleLibrary;
  /** The Cloudflare relay's settings and usage (admin, and `me`). */
  relay?: RelayState;
  /** This NAS's rendezvous id, given in `me`; null (the default) without a rendezvous. */
  nasId?: string | null;
  /** How long an owner's lookup may take. Default 10 s. */
  lookupTimeoutMs?: number;
  /** The quality levels; without them (`LEVELS_BACKEND=off` or a failed GPU self-test) only the original is served. */
  levels?: LevelService;
  /** The encodes folder's index (`ENCODES_DIR`); without it the encodes routes say it is not configured. */
  encodes?: EncodeIndex;
  /** How long an encodes request waits for the first scan before 503 (default 30 s; tests shorten it). */
  encodesWaitMs?: number;
  /** The owner's resumable uploads into the encodes folder. */
  encodeUploads?: UploadStore;
  /** The parsed ISO trees, shared with the quality levels' disc sources. */
  isoTrees?: IsoTrees;
  /** Told of every disc file read, so background work can wait while someone watches. */
  activity?: DiscActivity;
  /** Fansubs from SeaDex and Anime Tosho; without them, their routes answer 404. */
  fansubs?: FansubRouteOptions;
}

/** Answers 401 to any request without a valid token (`t=` query or `Authorization: Bearer`); lets the rest through. */
export function requireToken(auth: Auth): Handler {
  return async (req, url) => {
    const token = bearerToken(req.headers.authorization) ?? url.searchParams.get('t');
    return token !== null && auth.verify(token) ? null : json(401, { error: 'unauthorized' });
  };
}

/** Every route after health: pairing and sessions open, everything else behind a token. */
export function appHandlers(opts: AppOptions): Handler[] {
  const { auth } = opts;
  return [
    pairRoutes(auth, { now: opts.now ?? Date.now, trustProxy: opts.trustProxy ?? (() => false), registrar: opts.registrar }),
    requireToken(auth),
    bdjStoreRoutes(auth, opts.bdjStore),
    ...(opts.playbackStore ? [playbackRoutes(auth, opts.playbackStore, { titles: opts.titles, library: opts.library })] : []),
    ...(opts.fansubs ? [fansubRoutes(auth, opts.fansubs, opts.titles)] : []),
    ...(opts.subtitleStore ? [subtitleRoutes(auth, opts.subtitleStore, { titles: opts.titles, library: opts.library, fansubs: opts.fansubs?.service })] : []),
    adminRoutes(auth, {
      library: opts.library, bdjStore: opts.bdjStore, publicBase: opts.publicBase, appUrl: opts.appUrl, rendezvousUrl: opts.rendezvousUrl, registrar: opts.registrar, registrarDeadlineMs: opts.registrarDeadlineMs,
      titles: opts.titles, relay: opts.relay, levels: opts.levels, now: opts.now, lookupTimeoutMs: opts.lookupTimeoutMs,
    }),
    libraryRoute(opts.library),
    ...(opts.titles ? [titleRoutes(auth, opts.titles, opts.relay, opts.nasId ?? null, opts.levels !== undefined)] : []),
    encodeRoutes(opts.auth, opts.encodes, opts.titles, opts.encodesWaitMs, opts.encodeUploads),
    discRoutes(opts.library, opts.levels && { service: opts.levels, auth }, opts.isoTrees, opts.activity),
  ];
}
