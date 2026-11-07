import { readFileSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { appHandlers } from './app';
import { Auth } from './auth';
import { BdjStore } from './bdj-store';
import { PlaybackStore } from './playback-store';
import { SubtitleStore } from './subtitle-store';
import { ownerCode, printNasId } from './cli';
import { loadConfig } from './config';
import type { Config } from './config';
import { DiscActivity } from './disc-activity';
import { libraryFansubDiscs } from './fansubs/disc-lookup';
import { ffmpegAudioDecoder } from './fansubs/ffmpeg-decoder';
import { FetchCache } from '@seikou/fansubs/fetch-cache';
import { fixtureFansubSources } from '@seikou/fansubs/fixture-sources';
import { FansubPicks } from './fansubs/picks';
import { createSeaDex } from '@seikou/fansubs/seadex';
import type { SeaDex } from '@seikou/fansubs/seadex';
import { FansubService } from './fansubs/service';
import { FansubState } from './fansubs/state';
import { createTosho } from '@seikou/fansubs/tosho';
import type { Tosho } from '@seikou/fansubs/tosho';
import { createServer } from './http';
import type { Handler } from './http';
import { IsoTrees } from './iso';
import { levelsBackend } from './levels/backend-check';
import { Capacity, GPU_BUDGETS } from './levels/capacity';
import { probeScan } from './levels/encoder';
import { LevelService, libraryDiscSources } from './levels/level-service';
import { SegmentCache } from './levels/segment-cache';
import { Library, nextNightly } from './library';
import { RendezvousClient } from './rendezvous-client';
import { RtcPeers } from './rtc/peer';
import { RelayState, turnResponder } from './rtc/relay';
import { AddressAdvertiser } from './rtc/public-address';
import { SignallingClient } from './rtc/signalling-client';
import { listDir } from './manifest';
import { ISO_TREES } from './routes/discs';
import { trustedProxy } from './routes/pair';
import { Store } from './store';
import { createAniList } from '@seikou/titles/anilist';
import { ArtCache } from '@seikou/titles/art';
import type { FolderCover } from '@seikou/titles/catalogue';
import { createDiscogs } from '@seikou/titles/discogs';
import { findFolderCover } from './titles/folder-cover';
import { createMusicBrainz } from '@seikou/titles/musicbrainz';
import { fixtureMusicSource } from '@seikou/titles/music-sources';
import type { MusicRelease, MusicSource } from '@seikou/titles/music-sources';
import { OwnerStore } from '@seikou/titles/owner-store';
import { Pacer } from '@seikou/titles/pacer';
import { downloadRootNames, fixtureSources, loadDiscDbOrNone, releaseFolderOf, TitleService } from './titles/service';
import { lookupUserAgent } from '@seikou/titles/sources';
import type { Entry, MetadataSource } from '@seikou/titles/sources';
import { createTmdb } from '@seikou/titles/tmdb';

const SHUTDOWN_GRACE_MS = 3_000;
const STUN_URL = 'stun:stun.cloudflare.com:3478';
const DEFAULT_DISCDB_INDEX = '/app/data/discdb-index.json';

/** AniList and TMDB, or the recorded entries of `METADATA_FIXTURE` in E2E tests (ruling R3). */
function metadataSources(config: Config): { anilist: MetadataSource; tmdb: MetadataSource | null } {
  const fixture = process.env.METADATA_FIXTURE;
  if (fixture) return fixtureSources(JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, Entry[]>);
  const anilist = createAniList(fetch, new Pacer(30, 60_000));
  if (config.tmdbApiKey === null) {
    console.log('TMDB key not set: non-anime discs go to Unsorted');
    return { anilist, tmdb: null };
  }
  return { anilist, tmdb: createTmdb(fetch, new Pacer(20, 1_000), config.tmdbApiKey) };
}

/**
 * MusicBrainz (paced to one request per 1.1 s) and Discogs (only with `DISCOGS_TOKEN`), or the recorded releases of
 * `MUSIC_FIXTURE` (a JSON object of catalogue number to release) in E2E tests, with no Discogs.
 */
function musicSources(config: Config): { musicbrainz: MusicSource; discogs: MusicSource | null } {
  const fixture = process.env.MUSIC_FIXTURE;
  if (fixture) return { musicbrainz: fixtureMusicSource(JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, MusicRelease>), discogs: null };
  const musicbrainz = createMusicBrainz(fetch, new Pacer(1, 1_100), config.lookupContact);
  if (config.discogsToken === null) {
    console.log('Discogs token not set: music lookups use MusicBrainz only');
    return { musicbrainz, discogs: null };
  }
  return { musicbrainz, discogs: createDiscogs(fetch, new Pacer(50, 60_000), config.discogsToken, config.lookupContact) };
}

/**
 * SeaDex and Anime Tosho, each paced to one request per 2.5 s, or the recorded answers in the folder `FANSUB_FIXTURE`
 * names (`seadex.json`, `tosho.json`, `files/`) in E2E tests.
 */
function fansubSources(config: Config): { seadex: SeaDex; tosho: Tosho } {
  const fixture = process.env.FANSUB_FIXTURE;
  if (fixture) {
    if (!statSync(fixture, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`FANSUB_FIXTURE "${fixture}" is not a folder`);
    return fixtureFansubSources(fixture);
  }
  const userAgent = lookupUserAgent(config.lookupContact);
  const { seadexUrl, toshoFeedUrl, toshoUrl } = config.fansubs;
  return {
    seadex: createSeaDex(fetch, new Pacer(1, 2_500), userAgent, seadexUrl),
    tosho: createTosho(fetch, new Pacer(1, 2_500), userAgent, { feed: toshoFeedUrl, site: toshoUrl }),
  };
}

/** The image in a music release folder, with its size and modification time, read from the read-only mount. */
async function folderCover(dir: string): Promise<FolderCover | null> {
  const statSize = async (abs: string): Promise<number | null> => {
    try {
      const st = await stat(abs);
      return st.isFile() ? st.size : null;
    } catch {
      return null;
    }
  };
  const path = await findFolderCover(dir, listDir, statSize);
  if (path === null) return null;
  try {
    const st = await stat(path);
    return { path, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** The rendezvous client when `RENDEZVOUS_URL` is set; its key lives next to the auth data. */
function rendezvousRegistrar(config: Config): RendezvousClient | undefined {
  if (config.rendezvousUrl === undefined) return undefined;
  return new RendezvousClient(config.rendezvousUrl, rendezvousKeyFile(config));
}

/** The NAS's rendezvous key, next to the auth data. */
function rendezvousKeyFile(config: Config): string {
  return join(config.dataDir, 'rendezvous-key.json');
}

/**
 * The WebRTC route: peers on UDP `RTC_PORT` advertising the public IPv4 (STUN at start, then hourly) and
 * `RTC_LAN_ADDRESS`, and the signalling socket to the rendezvous Worker. Gives the function that stops it all.
 */
function startRtc(config: Config, rendezvousUrl: string, rendezvous: RendezvousClient, handlers: readonly Handler[], auth: Auth, relay: RelayState): () => Promise<void> {
  // A changed public address likely means the signalling socket's path died with the old one.
  const advertiser = new AddressAdvertiser({ stun: STUN_URL, lan: config.rtc.lanAddress, fixed: config.rtc.advertise, onChange: () => signalling.reconnect() });
  // STUN only: the NAS's own peer never uses the relay (see `stunOnly`); devices get TURN through `turn-request`.
  const peers = new RtcPeers({
    handlers, auth, port: config.rtc.port, advertise: () => advertiser.advertise(), iceServers: async () => [{ urls: STUN_URL }], now: Date.now,
    onRelayedBytes: (bytes) => relay.addBytes(bytes),
  });
  peers.listen().then(
    () => console.log(`WebRTC on UDP ${config.rtc.port}`),
    (err: unknown) => console.error(`WebRTC: UDP ${config.rtc.port} could not be bound`, err),
  );
  const onTurnRequest = turnResponder({
    relay, auth, credentials: () => rendezvous.turnServers(), now: Date.now,
    onServers: (sid, ips) => peers.noteTurnServers(sid, ips),
  });
  const signalling = new SignallingClient({ url: rendezvousUrl, signer: rendezvous, peers, onTurnRequest });
  signalling.start();
  void advertiser.start();
  return async () => {
    signalling.stop();
    advertiser.stop();
    await peers.closeAll();
  };
}

/**
 * The quality levels (spec §5–§6): after the encoder's self-test at start, or none (Original only) when
 * `LEVELS_BACKEND=off`, there is no GPU for `qsv`, or the self-test fails. Segments are cached under `/data/transcode`.
 */
/**
 * The GPU budgets, times `LEVELS_GPU_SCALE` when it is a positive number. Only the E2E stand-in sets it: its browsers open
 * discs side by side (phone-sized screens lease a re-encoded level), a lease lapses 2 minutes after its last read, and the
 * real budgets (about six 1080p viewings) ran out between tests.
 */
function gpuBudgets(): { h264: number; hevc: number } {
  const scale = Number(process.env.LEVELS_GPU_SCALE ?? 1);
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { h264: GPU_BUDGETS.h264 * k, hevc: GPU_BUDGETS.hevc * k };
}

async function levelService(config: Config, library: Library, isoTrees: IsoTrees): Promise<LevelService | undefined> {
  const encoder = await levelsBackend(config.levels);
  if (!encoder) return undefined;
  const { ffprobePath } = config.levels;
  return new LevelService({
    discs: libraryDiscSources(library, isoTrees),
    cache: new SegmentCache(join(config.dataDir, 'transcode'), config.levels.cacheBytes),
    capacity: new Capacity(gpuBudgets()),
    backend: encoder.backend,
    codecs: encoder.codecs,
    probe: (input, options) => probeScan(input, { ...options, binary: ffprobePath }),
    log: console.log,
  });
}

async function serve(config: Config): Promise<void> {
  const trustProxy = await trustedProxy(config.trustedProxy);
  const library = new Library(config.roots, join(config.dataDir, 'library.json'), { scanPauseMs: config.scanPauseMs });
  const auth = new Auth(new Store(config.dataDir), Date.now);
  const owner = new OwnerStore(config.dataDir);
  const titles = new TitleService({
    library,
    owner,
    dataDir: config.dataDir,
    ...metadataSources(config),
    ...musicSources(config),
    folderCover,
    locateRelease: (discId, group) => {
      const disc = library.disc(discId);
      const abs = disc ? library.locate(disc) : null;
      return disc && abs !== null ? releaseFolderOf(abs, disc.path.split('/').slice(1), group) : null;
    },
    discdb: loadDiscDbOrNone(process.env.DISCDB_INDEX || DEFAULT_DISCDB_INDEX),
    art: new ArtCache(join(config.dataDir, 'art'), fetch),
    downloadRoots: downloadRootNames(config.roots),
    titleLibrary: config.titleLibrary,
  });

  const rendezvous = rendezvousRegistrar(config);
  const relay = new RelayState(config.dataDir, Date.now);
  // the key's thumbprint, read (or made) locally: `me` gives it to pairings made before the WebRTC route
  const nasId = rendezvous ? await rendezvous.localNasId() : null;
  const isoTrees = new IsoTrees(ISO_TREES);
  const levels = await levelService(config, library, isoTrees);
  const subtitleStore = new SubtitleStore(config.dataDir, { maxFansubBytes: config.fansubs.storeBytes });
  const activity = new DiscActivity();
  const { seadex, tosho } = fansubSources(config);
  const fansubState = new FansubState(config.dataDir);
  const fansubCache = new FetchCache(join(config.dataDir, 'fansubs', 'cache'), config.fansubs.cacheBytes);
  const discs = libraryDiscSources(library, isoTrees);
  const lookup = libraryFansubDiscs(library);
  const decoder = ffmpegAudioDecoder(config.levels.ffmpegPath);
  const fansubs = new FansubService({
    store: subtitleStore, state: fansubState, seadex, tosho, cache: fansubCache, titles, discs, discKey: lookup.discKey, durationMs: lookup.durationMs,
    decoder, activity, encoding: () => (levels?.encodingNow().length ?? 0) > 0, windowEnd: config.fansubs.windowEnd, log: console.log,
  });
  const picks = new FansubPicks({ dataDir: config.dataDir, tosho, cache: fansubCache, discs, lookup, decoder, maxBytes: config.fansubs.picksBytes, log: console.log });
  // After a scan the titles are matched first, so the nightly fansub pass sees the discs filed. `FANSUB_NIGHTLY=off`
  // (only the E2E stand-in sets it) keeps the pass from attaching tracks to the fixture series while tests run at night.
  const nightly = process.env.FANSUB_NIGHTLY !== 'off';
  library.onScanned(() => {
    void titles.runNow().then(() => (nightly ? fansubs.startNightly() : undefined)).catch((err: unknown) => console.error('fansub pass failed', err));
  });
  const handlers = appHandlers({ auth, library, bdjStore: new BdjStore(config.dataDir), playbackStore: new PlaybackStore(config.dataDir), subtitleStore, publicBase: config.publicBase, appUrl: config.appUrl, ...(config.rendezvousUrl !== undefined ? { rendezvousUrl: config.rendezvousUrl } : {}), registrar: rendezvous, trustProxy, titles: { service: titles, owner }, relay, nasId, isoTrees, ...(levels ? { levels } : {}), activity, fansubs: { service: fansubs, state: fansubState, seadex, tosho, picks, lookup } });
  const server = createServer(handlers);
  const stopRtc = rendezvous && config.rendezvousUrl !== undefined ? startRtc(config, config.rendezvousUrl, rendezvous, handlers, auth, relay) : async () => {};

  const scheduleScans = (): void => {
    const run = (): void => {
      library.scan().catch((err: unknown) => console.error('library scan failed', err));
    };
    run();
    const arm = (): void => {
      setTimeout(() => {
        run();
        arm();
      }, nextNightly(new Date(), config.nightlyScanAt).getTime() - Date.now()).unref();
    };
    arm();
  };

  server.listen(config.port, () => {
    console.log(`bluray-server listening on ${config.port}; roots: ${config.roots.map((r) => `${r.name}=${r.dir}`).join(', ')}`);
    scheduleScans();
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      titles.close();
      fansubs.close();
      levels?.close();
      void stopRtc();
      server.close(() => process.exit(0));
      // Long disc streams would otherwise hold shutdown until Docker's SIGKILL.
      setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
    });
  }
}

/** `owner-code`'s arguments: nothing, or `--person <name>`; null for anything else. */
function ownerCodeArgs(args: readonly string[]): { person?: string } | null {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === '--person' && args[1]!.trim() !== '') return { person: args[1]! };
  return null;
}

const config = loadConfig(process.env);
const command = process.argv[2];
const ownerArgs = command === 'owner-code' ? ownerCodeArgs(process.argv.slice(3)) : null;
if (command === undefined) {
  await serve(config);
} else if (ownerArgs !== null) {
  const registrar = rendezvousRegistrar(config);
  await ownerCode(config.dataDir, Date.now, console.log, { publicBase: config.publicBase, appUrl: config.appUrl, rendezvousUrl: config.rendezvousUrl, registrar }, ownerArgs.person);
} else if (command === 'nas-id' && process.argv.length === 3) {
  await printNasId(rendezvousKeyFile(config));
} else {
  console.error(`unknown command "${process.argv.slice(2).join(' ')}"; usage: node server.mjs [owner-code [--person <name>] | nas-id]`);
  process.exit(2);
}
