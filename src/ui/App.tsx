import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import { createController } from '@seikou/engine/controller/create-controller';
import type { PlayerController } from '@seikou/engine/controller/player-controller';
import { PlatformSession } from '@seikou/engine/controller/platform-session';
import { parseHelpPath } from './help/help-pages';
import { HelpLoadBoundary } from './help/HelpLoadBoundary';
import { LandingScreen } from './LandingScreen';
import { levelSessionOf } from './nas/level-session';
import { NasClient } from './nas/nas-client';
import { getNasHistory, useNasRoute } from './nas/nas-history';
import { idbNasStore } from './nas/nas-store';
import { isLoopbackHost, parsePairLink, type PairLink } from './nas/pair-link';
import { PlayingRoute } from './nas/playing-route';
import { PlaceSaver } from './place-saver';
import { placeMinDurationUs } from './place-model';
import { idbPlaceStore } from './place-store';
import { PlayerScreen } from './PlayerScreen';
import { TOUCH_LOG, TouchLog } from './TouchLog';
import { chooseMemoryProfile } from './memory-profile';
import { bundledAnime4k } from './bundled-shaders';
import { idbShaderLibrary } from './shader-library';
import { ShaderModel } from './shader-model';
import { isWaitingWorker, reloadAction, shouldPromptUpdate } from './update-prompt';
import { themeController } from './theme';

/** The help pages load on their first visit, so the documentation stays out of the main bundle. */
const HelpScreen = lazy(() => import('./help/HelpScreen').then((m) => ({ default: m.HelpScreen })));

let sharedController: PlayerController | null = null;

function getController(): PlayerController {
  sharedController ??= createAppController();
  return sharedController;
}

function createAppController(): PlayerController {
  const params = new URLSearchParams(location.search);
  // Test-only (E2E): ?bdjfail=1, ?nonestedworkers=1, ?nodecoder=1 and ?telemetry=1 go to the engine worker as flags in
  // its name (@seikou/engine/worker-main engineWorkerTestFlags, src/engine-worker.ts): an unreadable class library, no
  // workers started from workers, no video decoder configuration supported, the BD-J plane's hash in telemetry.
  // `?telemetry=1` also makes the controller copy telemetry to `window.__blurayTelemetry`, which the E2E tests read.
  const flags = ['bdjfail', 'nonestedworkers', 'nodecoder', 'telemetry'].filter((f) => params.has(f));
  const name = flags.length > 0 ? `bluray-engine:${flags.join(',')}` : 'bluray-engine';
  return createController({
    // (the options stay an object literal with a literal type: Vite reads it to bundle the worker as a module)
    worker: () => new Worker(new URL('../engine-worker.ts', import.meta.url), { type: 'module', name }),
    profile: chooseMemoryProfile({
      search: location.search,
      coarsePointer: matchMedia('(pointer: coarse)').matches,
      maxTouchPoints: navigator.maxTouchPoints,
      platform: navigator.platform,
    }),
    exposeTelemetry: params.has('telemetry'),
  });
}

let sharedNas: NasClient | null = null;

function getNasClient(): NasClient {
  sharedNas ??= new NasClient({
    fetch: (input, init) => fetch(input, init),
    subtle: crypto.subtle,
    store: idbNasStore(),
    now: Date.now,
    rendezvousUrl: import.meta.env.VITE_RENDEZVOUS_URL as string | undefined,
  });
  return sharedNas;
}

let sharedPlaces: PlaceSaver | null = null;

function getPlaceSaver(controller: PlayerController, nas: NasClient): PlaceSaver {
  sharedPlaces ??= new PlaceSaver({
    store: idbPlaceStore(),
    nas,
    readPlace: () => controller.readPlace(),
    discOpens: () => controller.discOpens,
    nowMs: Date.now,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    // `?placemin=<seconds>` is test-only: the playlist length that makes a place, so the short synthetic discs can save places
    minDurationUs: placeMinDurationUs(window.location.search),
    levelAudio: () => {
      const s = levelSessionOf(nas).get();
      return s && s.at.level !== 'original' ? s.at.audio : null;
    },
  });
  return sharedPlaces;
}

let pairLinkTaken = false;
let takenPairLink: PairLink | undefined;

/**
 * A `?pair=<code>` link (with the `nas=` or `rv=` it may carry), taken out of the address bar (once) so a reload doesn't
 * pair again. `http:` addresses count only while the app itself is on a loopback origin, so a hosted page never pairs over plain HTTP.
 */
function takePairLink(): PairLink | undefined {
  if (pairLinkTaken) return takenPairLink;
  pairLinkTaken = true;
  const url = new URL(window.location.href);
  takenPairLink = parsePairLink(url, { dev: isLoopbackHost(url.hostname) }) ?? undefined;
  const params = ['pair', 'nas', 'rv'].filter((name) => url.searchParams.has(name));
  if (params.length > 0) {
    for (const name of params) url.searchParams.delete(name);
    window.history.replaceState(window.history.state, '', url);
  }
  return takenPairLink;
}

let sharedShaders: ShaderModel | null = null;

function getShaderModel(controller: PlayerController): ShaderModel {
  sharedShaders ??= new ShaderModel(idbShaderLibrary(), (set) => controller.setShaderSet(set), bundledAnime4k());
  return sharedShaders;
}

/** The new service worker waiting to take over after a deploy, if any. */
function useWaitingWorker(): ServiceWorker | null {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  useEffect(() => {
    const container = navigator.serviceWorker as ServiceWorkerContainer | undefined;
    if (!container) return;
    let cancelled = false;
    let registration: ServiceWorkerRegistration | null = null;
    // Only an update counts: the first install has no controller and takes over on its own.
    const track = (worker: ServiceWorker | null): void => {
      if (!worker || !container.controller) return;
      const check = (): void => {
        if (cancelled) return;
        if (isWaitingWorker(worker.state)) setWaiting(worker);
        else setWaiting((current) => (current === worker ? null : current));
      };
      check();
      worker.addEventListener('statechange', check);
    };
    const onUpdateFound = (): void => track(registration?.installing ?? null);
    void container.ready.then((reg) => {
      if (cancelled) return;
      registration = reg;
      track(reg.waiting ?? reg.installing);
      reg.addEventListener('updatefound', onUpdateFound);
    });
    return () => {
      cancelled = true;
      registration?.removeEventListener('updatefound', onUpdateFound);
    };
  }, []);
  return waiting;
}

/** A status bar saying a new version is ready, with a Reload button that activates the waiting `worker` (skip waiting, then reload when it takes control) or reloads at once if it already has. */
function UpdatePrompt({ worker }: { worker: ServiceWorker }): ReactElement {
  const reload = (): void => {
    if (reloadAction(worker.state) === 'reload') {
      window.location.reload();
      return;
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    worker.postMessage({ type: 'skip-waiting' });
  };
  return (
    <div className="update-prompt" role="status" data-testid="update-prompt">
      A new version is ready.{' '}
      <button type="button" onClick={reload}>
        Reload
      </button>
    </div>
  );
}

/**
 * The whole app: owns the shared controller, NAS client, place saver, shader model and theme, and shows one of three
 * screens. While no disc is open it shows the help pages (a `/help` address) or the landing screen; once the controller
 * reports a disc (a playlist list or an open encode) it shows the player. It also shows the update prompt when a new
 * service worker waits and the touch log when `?touchlog=1` is set.
 */
export function App(): ReactElement {
  const [controller] = useState(getController);
  const [nas] = useState(getNasClient);
  // Spent once paired (or the NAS forgotten), so the landing screen shown again after a disc closes doesn't ask again.
  const [pairLink, setPairLink] = useState(takePairLink);
  const spendPairLink = useCallback(() => setPairLink(undefined), []);
  const [history] = useState(getNasHistory);
  // Kept subscribed for the app's life, so the history sees every popstate (its direction drives focus).
  useNasRoute(history);
  const here = new URL(history.getSnapshot());
  const help = parseHelpPath(here.pathname);
  const [playingRoute] = useState(() => new PlayingRoute(history, () => performance.now()));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const theme = themeController();
  // the player, and the page with it, stay dark while a disc is open, so the player has no light values
  const discOpen = snapshot.playlists.length > 0 || snapshot.encodeId !== null;
  useEffect(() => theme.setDiscOpen(discOpen), [theme, discOpen]);
  useEffect(() => {
    const session = new PlatformSession(
      { wakeLock: navigator.wakeLock, mediaSession: navigator.mediaSession, MediaMetadata: globalThis.MediaMetadata },
      controller,
    );
    return () => session.dispose();
  }, [controller]);
  const [places] = useState(() => getPlaceSaver(controller, nas));
  useEffect(() => {
    // The place is saved as the page is hidden or goes away (over HTTPS with keepalive, which lets the request outlive the
    // page), and places waiting on this device go out whenever the NAS answers again.
    const hidden = (): void => {
      if (document.visibilityState === 'hidden') void places.flushNow({ keepalive: true });
    };
    const leaving = (): void => void places.flushNow({ keepalive: true });
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leaving);
    const offSession = nas.onSession(() => void places.drainOutbox());
    // a new pairing (another NAS or person), a forgotten one, or one the NAS revoked: what waits isn't theirs
    const offPairing = nas.onPairingChange(() => void places.pairingChanged());
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leaving);
      offSession();
      offPairing();
    };
  }, [places, nas]);
  const [shaders] = useState(() => getShaderModel(controller));
  const shaderState = useSyncExternalStore(shaders.subscribe, shaders.getSnapshot);
  useEffect(() => {
    // Without IndexedDB the menu still opens, but sets cannot be chosen that session (docs/known-issues.md).
    shaders.load().catch((e) => console.error('shader library failed to load', e));
  }, [shaders]);
  const waitingWorker = useWaitingWorker();
  return (
    <div className="app" data-testid="app">
      {TOUCH_LOG && <TouchLog />}
      {waitingWorker && shouldPromptUpdate({ waiting: true, engineState: snapshot.engineState }) && <UpdatePrompt worker={waitingWorker} />}
      {!discOpen && help !== null ? (
        <HelpLoadBoundary>
          <Suspense fallback={<p className="status">Loading…</p>}>
            <HelpScreen history={history} theme={theme} slug={help.slug} hash={here.hash} />
          </Suspense>
        </HelpLoadBoundary>
      ) : !discOpen ? (
        <LandingScreen controller={controller} theme={theme} snapshot={snapshot} nas={nas} places={places} history={history} playingRoute={playingRoute} pairLink={pairLink} onPairLinkSpent={spendPairLink} />
      ) : (
        <PlayerScreen
          controller={controller}
          snapshot={snapshot}
          shaderModel={shaders}
          shaderState={shaderState}
          nas={nas}
          places={places}
          history={history}
          playingRoute={playingRoute}
        />
      )}
    </div>
  );
}
