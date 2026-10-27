import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ReactElement } from 'react';
import type { PlayerController, PlayerSnapshot } from '../player/player-controller';
import { checkCapabilities, showStorageHint } from './capabilities';
import { NasNotFound } from './nas/NasNotFound';
import { LibraryScreen, rememberedFolder } from './nas/LibraryScreen';
import { PairScreen } from './nas/PairScreen';
import type { PairLink } from './nas/pair-link';
import { TitleLibrary } from './nas/TitleLibrary';
import { NAS_MESSAGES, type NasClient } from './nas/nas-client';
import { AppLink } from './help/HelpLink';
import { useNasRoute, type NasHistory } from './nas/nas-history';
import { nasRoutePath, type NasRoute } from './nas/nas-route';
import type { PlayingRoute } from './nas/playing-route';
import { Preflight } from './nas/Preflight';
import type { NasPairing } from './nas/nas-store';
import { pairedAs } from './nas/people-model';
import { collectFromDirectoryHandle, collectFromFileList, discFromDataTransfer } from './disc-input';
import { listServerDiscs, serverDiscSpec, serverLinkFromLocation, type ServerDisc, type ServerLink } from './disc-server';
import type { RemoteDiscSpec } from '../engine/disc/disc-spec';
import { discKeyOf } from '../engine/disc/disc-key';
import { mainPlaylistId } from './nas/library-model';
import { LOCAL_DEVICE_NAME, type LaunchSettings, type PlaceSaver } from './place-saver';
import { ResumePrompt } from './nas/ResumePrompt';
import { playlistsOf, startOver } from './nas/resume-model';
import { askOrOpen, localKeyOf, recentResumeLabel, type AskOffer } from './local-resume';
import type { StartPoint } from '../engine/protocol';
import type { DiscEntry } from '../engine/disc/nas-api';
import { listRecentDiscs, reopenRecentDisc, saveRecentDisc, type RecentDisc } from './recent-discs';
import type { ThemeController } from './theme';
import { ThemeSwitch } from './ThemeSwitch';

const LIBRARY: NasRoute = { kind: 'library', shelf: null, q: '' };

/** A pick that takes longer than this to hand over its files is being copied (iOS copies every picked file first). */
const COPY_NOTICE_DELAY_MS = 1500;

/** A local disc waiting for the tap that says where it opens: Resume, or Start from beginning. */
interface PendingResume {
  readonly offer: AskOffer;
  readonly open: (start: StartPoint | undefined, launch: LaunchSettings | undefined) => void;
}

type PlayRoute = Extract<NasRoute, { kind: 'play' }>;

interface PlayLinkProps {
  readonly nas: NasClient;
  readonly places: PlaceSaver;
  readonly controller: PlayerController;
  readonly history: NasHistory;
  readonly playingRoute: PlayingRoute;
  readonly route: PlayRoute;
  readonly onLibrary: () => void;
}

/**
 * A play link opened here (a link, a reload during playback, Back or Forward onto one): its disc's pre-flight, with
 * the link's playlist and time. Play needs the tap, which starts audio.
 */
function PlayLink({ nas, places, controller, history, playingRoute, route, onLibrary }: PlayLinkProps): ReactElement {
  /** undefined while resolving; null when the NAS has no such disc; a string when the NAS couldn't be asked. */
  const [found, setFound] = useState<DiscEntry | null | string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    // The same disc again (the pre-flight swapping a `d.` key for its `f.` key) keeps its pre-flight as it is.
    nas.resolveDisc(route.discKey).then(
      (disc) => live && setFound((prev) => (typeof prev === 'object' && prev !== null && disc !== null && prev.id === disc.id ? prev : disc)),
      (err: unknown) => live && setFound(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [nas, route.discKey, attempt]);
  const back = useCallback(() => history.back(LIBRARY), [history]);
  if (found === undefined) return <p className="status">Loading…</p>;
  if (found === null) return <NasNotFound reason="missing" onLeave={onLibrary} />;
  if (typeof found === 'string') {
    return (
      <div className="error-banner" role="alert" data-testid="nas-error">
        {found}
        <p>
          <button
            type="button"
            data-testid="nas-retry"
            onClick={() => {
              setFound(undefined);
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </button>{' '}
          <button type="button" data-testid="nas-back-to-library" onClick={() => history.replace(LIBRARY)}>
            Back to the library
          </button>
        </p>
      </div>
    );
  }
  return (
    <section className="titles" data-testid="nas-play-link">
      <Preflight
        key={found.id}
        nas={nas}
        controller={controller}
        disc={found}
        playlistId={route.playlistId ?? undefined}
        startTimeS={route.timeS ?? undefined}
        resume={route.resume}
        history={history}
        playingRoute={playingRoute}
        places={places}
        onFacts={() => {}}
        onCancel={back}
      />
    </section>
  );
}

interface LandingScreenProps {
  readonly controller: PlayerController;
  readonly theme: ThemeController;
  readonly snapshot: PlayerSnapshot;
  readonly nas: NasClient;
  /** Saves the place of the disc opened here (on this device for a folder or disc-server disc). */
  readonly places: PlaceSaver;
  readonly history: NasHistory;
  /** Kept current by playback once a NAS pre-flight launches a disc. */
  readonly playingRoute: PlayingRoute;
  /** A `?pair=` link: the pair screen opens with its code filled in (after confirming a server or Worker it names). */
  readonly pairLink?: PairLink;
  /** The `?pair=` link was used (or the NAS forgotten): it isn't offered again. */
  readonly onPairLinkSpent?: () => void;
}

export function LandingScreen({ controller, theme, snapshot, nas, places, history, playingRoute, pairLink, onPairLinkSpent }: LandingScreenProps): ReactElement {
  const route = useNasRoute(history);
  /**
   * The screen a pre-flight launched its disc from, while the play route its Play pushed is shown: that screen stays
   * (with the pre-flight on it). A play route without one (a link, a reload) shows the link's own pre-flight.
   */
  const [launchedOn, setLaunchedOn] = useState<NasRoute | null>(null);
  const onLaunch = useCallback(() => setLaunchedOn(history.route()), [history]);
  useEffect(() => {
    if (route?.kind !== 'play') setLaunchedOn(null);
  }, [route?.kind]);
  const playLink = route?.kind === 'play' && launchedOn === null ? route : null;
  /** The NAS screen shown: the route, or on a pushed play route the screen it was pushed from. */
  const shown = route?.kind === 'play' && launchedOn !== null ? launchedOn : route;
  const [capabilities] = useState(() => checkCapabilities());
  const [storageHint] = useState(() => showStorageHint(capabilities.canRememberDiscs));
  const [recent, setRecent] = useState<RecentDisc[]>([]);
  /** Recent discs row id to "Resume at m:ss", for those with an unfinished place on this device. */
  const [recentResume, setRecentResume] = useState<ReadonlyMap<number, string>>(new Map());
  const [pending, setPending] = useState<PendingResume | null>(null);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // tools/disc-server: ?disc=<disc API base>&token= or ?token= (spec 2026-10-17 §4.5). Each disc's manifest is fetched
  // before its button is enabled, so the tap opens it at once (audio starts inside the tap), as the NAS pre-flight does.
  const [serverLink] = useState<ServerLink | null>(() => serverLinkFromLocation(window.location.href));
  const [serverDiscs, setServerDiscs] = useState<ServerDisc[] | null>(null);
  const [serverSpecs, setServerSpecs] = useState<ReadonlyMap<string, RemoteDiscSpec | string>>(new Map());
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverLink) return;
    let cancelled = false;
    listServerDiscs(serverLink).then(
      (discs) => {
        if (cancelled) return;
        setServerDiscs(discs);
        for (const disc of discs) {
          serverDiscSpec(disc, serverLink.token).then(
            (spec) => !cancelled && setServerSpecs((m) => new Map(m).set(disc.base, spec)),
            (err: unknown) => !cancelled && setServerSpecs((m) => new Map(m).set(disc.base, err instanceof Error ? err.message : String(err))),
          );
        }
      },
      (err: unknown) => !cancelled && setServerError(`The disc server could not be reached: ${err instanceof Error ? err.message : String(err)}`),
    );
    return () => {
      cancelled = true;
    };
  }, [serverLink]);
  /** The folder picker is open or handing over its files (the input fallback); the copy notice shows after COPY_NOTICE_DELAY_MS. */
  const [awaitingFiles, setAwaitingFiles] = useState(false);
  const [copyNotice, setCopyNotice] = useState(false);

  useEffect(() => {
    listRecentDiscs().then(setRecent, () => setRecent([]));
  }, []);

  useEffect(() => {
    let live = true;
    void Promise.all(
      recent.map(async (disc): Promise<readonly [number, string] | null> => {
        const label = await recentResumeLabel(disc.discKey, (k) => places.placesOf(k), Date.now());
        return label === null ? null : ([disc.id, label] as const);
      }),
    ).then((rows) => live && setRecentResume(new Map(rows.filter((r): r is readonly [number, string] => r !== null))));
    return () => {
      live = false;
    };
  }, [recent, places]);

  /** undefined while loading; null when this device isn't paired. */
  const [pairing, setPairing] = useState<NasPairing | null | undefined>(undefined);
  const [pairRequested, setPairRequested] = useState(pairLink !== undefined);
  /**
   * The NAS view follows the address bar: no NAS route is closed, a folder route the folder browser, any other route
   * asks `me` whether the title library is open to this device (and whether it is an owner) first. A guest while the
   * gate is closed gets the folders, with no notice. null until `me` is asked for this visit to the NAS.
   */
  const [access, setAccess] = useState<{ titles: boolean; owner: boolean } | 'checking' | null>(null);
  const browsing = route !== null;
  const needsAccess = shown !== null && shown.kind !== 'folders' && shown.kind !== 'play';
  const pairingKnown = pairing !== undefined && pairing !== null;
  useEffect(() => {
    if (!browsing) setAccess(null);
  }, [browsing]);
  useEffect(() => {
    if (!needsAccess || access !== null || !pairingKnown) return;
    setAccess('checking');
    nas.me().then(
      (me) => {
        setAccess((a) => (a === 'checking' ? { titles: me.titleLibrary, owner: me.owner } : a));
        // `me` may have brought this device's person name up to date.
        loadPairing();
      },
      // an older NAS without `me`, or any failure: the folder browser shows what is wrong, if anything
      () => setAccess((a) => (a === 'checking' ? { titles: false, owner: false } : a)),
    );
  }, [needsAccess, access, pairingKnown, nas]);
  // A guest behind the closed gate on the library's path: the folder browser's own path, so Back from a folder it
  // opens has an entry of its own to land on.
  const guestOnLibrary = route?.kind === 'library' && typeof access === 'object' && access !== null && !access.titles;
  useEffect(() => {
    if (guestOnLibrary) history.replace({ kind: 'folders', path: rememberedFolder() });
  }, [guestOnLibrary, history]);
  /** The title routes answered 404: the gate closed since `me` answered, so the folder browser, as for any guest. */
  const gateClosed = useCallback(() => setAccess({ titles: false, owner: false }), []);
  /** Ask `me` again (this device may no longer be an owner). */
  const recheckAccess = useCallback(() => setAccess(null), []);
  const closeNas = useCallback(() => history.push(null), [history]);
  const loadPairing = (): void => {
    nas.pairing().then(setPairing, () => setPairing(null));
  };
  useEffect(loadPairing, [nas]);
  // A NAS call that finds this device revoked clears the pairing: say so and show the code field again.
  useEffect(
    () =>
      nas.onUnpaired(() => {
        history.replace(null);
        setLocalError(NAS_MESSAGES.unpaired);
        loadPairing();
      }),
    [nas, history],
  );
  /** A link's not-found screen: leave its path and show the pair screen. */
  const pairFromNotFound = (): void => {
    history.replace(null);
    setPairRequested(true);
  };
  /** A paired device's not-found screen: back to the library (a guest behind the closed gate lands on the folders). */
  const libraryFromNotFound = (): void => history.replace(LIBRARY);
  /** The path of a title link whose title the NAS doesn't have (a link, not a step within the app). */
  const [missingTitle, setMissingTitle] = useState<string | null>(null);
  const routePath = route === null ? null : nasRoutePath(route);
  const titleMissing = routePath !== null && missingTitle === routePath;
  // The path the request was made for: an answer for a screen already left is dropped.
  const onTitleMissing = useCallback(
    (path: string) => setMissingTitle(history.route() !== null && nasRoutePath(history.route() as NasRoute) === path ? path : null),
    [history],
  );
  useEffect(() => {
    if (missingTitle !== null && routePath !== missingTitle) setMissingTitle(null);
  }, [missingTitle, routePath]);
  const guestOnTitleRoute =
    shown !== null && (shown.kind === 'title' || shown.kind === 'season' || shown.kind === 'extras') && typeof access === 'object' && access !== null && !access.titles;
  const forgetNas = (): void => {
    setPairRequested(false);
    onPairLinkSpent?.();
    history.replace(null);
    nas.forget().then(loadPairing, (err: unknown) => setLocalError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const cancel = (): void => setAwaitingFiles(false);
    input.addEventListener('cancel', cancel);
    return () => input.removeEventListener('cancel', cancel);
  }, []);

  useEffect(() => {
    if (!awaitingFiles) {
      setCopyNotice(false);
      return;
    }
    const timer = window.setTimeout(() => setCopyNotice(true), COPY_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [awaitingFiles]);

  const run = (task: Promise<void>): void => {
    task.catch((err: unknown) => setLocalError(err instanceof Error ? err.message : String(err)));
  };

  /**
   * Opens a local disc, after asking when this device holds an unfinished place for it: the prompt comes before the
   * open, and its buttons (taps) start audio, so Resume and Start from beginning open inside a gesture.
   */
  /** Counts the opens asked for: a call that a later one superseded (or any other open) does nothing when its read ends. */
  const openSeq = useRef(0);
  // Another open (the engine leaves idle, or the NAS route changes) drops a prompt and any read still waiting.
  const routeKey = route === null ? '' : nasRoutePath(route);
  useEffect(() => {
    if (snapshot.engineState !== 'idle') {
      openSeq.current++;
      setPending(null);
    }
  }, [snapshot.engineState]);
  useEffect(() => {
    openSeq.current++;
    setPending(null);
  }, [routeKey]);
  const openAskingFirst = async (
    discKey: string | null,
    playlists: ReturnType<typeof playlistsOf> | null,
    open: PendingResume['open'],
  ): Promise<void> => {
    const mine = ++openSeq.current;
    setPending(null);
    await askOrOpen({
      discKey, playlists, readPlaces: (k) => places.placesOf(k), isCurrent: () => openSeq.current === mine,
      ask: (offer) => setPending({ offer, open }),
      open: () => open(undefined, undefined),
    });
  };

  /** A folder's files open, and its place is saved on this device under its fingerprint. */
  const openLocal = (entries: ReadonlyArray<readonly [string, File]>, discKey: string | null = localKeyOf(entries)): Promise<void> =>
    openAskingFirst(discKey, null, (start, launch) => {
      controller.open(entries, start);
      if (discKey !== null) {
        places.begin({ discKey, discId: null, remote: false, chosen: start?.playlistId ?? null, mainPlaylistId: null, deviceName: LOCAL_DEVICE_NAME, pairing: null }, launch);
      }
    });

  const openHandle = async (handle: FileSystemDirectoryHandle): Promise<void> => {
    const entries = await collectFromDirectoryHandle(handle);
    const discKey = localKeyOf(entries);
    run(openLocal(entries, discKey));
    try {
      await saveRecentDisc(handle, Date.now(), undefined, undefined, discKey);
      setRecent(await listRecentDiscs());
    } catch {
      // The recent-discs list is a convenience; failing to update it must not block playback.
    }
  };

  const pickFolder = async (): Promise<void> => {
    let handle: FileSystemDirectoryHandle | undefined;
    try {
      handle = await window.showDirectoryPicker?.({ id: 'bluray-disc', mode: 'read' });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      throw err;
    }
    if (handle) await openHandle(handle);
  };

  const onPickFolder = (): void => {
    setLocalError(null);
    controller.startAudio(); // must happen inside the click gesture
    if (!capabilities.canPickDirectory) {
      setAwaitingFiles(true);
      inputRef.current?.click();
      return;
    }
    run(pickFolder());
  };

  const onInput = (e: ChangeEvent<HTMLInputElement>): void => {
    setAwaitingFiles(false);
    setLocalError(null);
    const files = e.target.files;
    if (files && files.length > 0) run(openLocal(collectFromFileList(files)));
    e.target.value = '';
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    setLocalError(null);
    controller.startAudio();
    const dropPending = discFromDataTransfer(e.dataTransfer); // synchronous part must run inside the event
    run(
      dropPending.then(async (dropped) => {
        if (!dropped) {
          setLocalError('Drop the disc folder itself (the folder that contains BDMV).');
          return;
        }
        if (dropped.kind === 'entries') await openLocal(dropped.entries);
        else await openHandle(dropped.handle);
      }),
    );
  };

  const onRecent = (disc: RecentDisc): void => {
    setLocalError(null);
    controller.startAudio();
    run(
      reopenRecentDisc(disc).then(async (handle) => {
        if (!handle) {
          setLocalError(`Permission to read "${disc.name}" was not granted.`);
          return;
        }
        await openHandle(handle);
      }),
    );
  };

  const onServerDisc = (spec: RemoteDiscSpec): void => {
    setLocalError(null);
    controller.startAudio(); // inside the tap, before a question about the place may come
    const discKey = discKeyOf('local', spec.manifest.files);
    // a disc-server disc's place stays on this device, as a folder's does; the server's token lasts the run, so there is no refresh
    run(
      openAskingFirst(discKey.startsWith('d.') ? null : discKey, playlistsOf(spec.manifest), (start, launch) => {
        controller.openRemote(spec, undefined, undefined, undefined, start);
        places.begin(
          { discKey, discId: null, remote: false, chosen: start?.playlistId ?? null, mainPlaylistId: mainPlaylistId(spec.manifest), deviceName: LOCAL_DEVICE_NAME, pairing: null },
          launch,
        );
      }),
    );
  };

  /** Resume at the place, or Start from beginning (its playlist from 0); either way with the place's settings. */
  const answerPending = (resume: boolean): void => {
    if (!pending) return;
    const { offer, open } = pending;
    controller.startAudio(); // inside the tap
    openSeq.current++;
    setPending(null);
    const launch: LaunchSettings = { settings: offer.place.settings, byLanguage: false };
    if (resume && offer.kind === 'ask') open(offer.start, launch);
    else open(startOver(offer.place), launch);
  };

  const error = localError ?? snapshot.error?.message ?? null;
  const nasWaiting = snapshot.engineState === 'loading' ? snapshot.notices.find((n) => n.code === 'nas-waiting') : undefined;
  const paired = pairing !== undefined && pairing !== null && !pairRequested;
  const errorPaths = localError ? [] : (snapshot.error?.paths ?? []);

  /** Which NAS panel shows: the not-found screen, the pair screen, the paired line, or none while pairings load. */
  const nasPanel = pairing === undefined ? null : pairing === null && browsing && !pairRequested ? 'not-found' : pairing === null || pairRequested ? 'pair' : 'paired';
  const pairedLine = nasPanel === 'paired' && pairing && (
    <p className="status nas-paired" data-testid="nas-paired">
      {pairedAs(pairing)}{' '}
      {!browsing && (
        <button
          type="button"
          className="primary"
          data-testid="nas-open"
          onClick={() => {
            setLocalError(null);
            history.push(LIBRARY);
          }}
        >
          Open from NAS
        </button>
      )}{' '}
      <button type="button" className="quiet" data-testid="nas-forget" onClick={forgetNas}>
        Forget this NAS
      </button>
    </p>
  );

  // On a NAS screen the disc picker shrinks into the app bar; at home it is the page's disc.
  return (
    <main className={`landing${browsing ? ' browsing' : ''}`} data-testid="landing">
      <header className="app-bar">
        <h1 className="app-name">
          <img className="app-mark" src="/favicon.svg" alt="" width={32} height={32} />
          Seikou
        </h1>
        <div
          className={`drop-zone${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          {!browsing && <div className="drop-disc" aria-hidden="true" />}
          <div className="drop-text">
            {!browsing && <h2 className="drop-title">Play a disc</h2>}
            {!browsing && <p>Drop a decrypted Blu-ray folder here: the disc folder, or the BDMV folder inside it.</p>}
            {!browsing && capabilities.core.ok && !capabilities.bdj.ok && (
              <p className="hint" data-testid="bdj-capability-hint">
                BD-J (Java) menus can't run in this browser: it lacks {capabilities.bdj.missing.join(', ')}. Discs with them open to their playlists.
              </p>
            )}
            {!browsing && storageHint && <p className="hint">On Safari, add the app to your Home Screen or Dock so your settings aren't cleared after 7 days without a visit.</p>}
            <button type="button" className={browsing ? undefined : 'primary'} data-testid="open-folder" disabled={!capabilities.core.ok} onClick={onPickFolder}>
              Open disc folder
            </button>
          </div>
          {/* webkitdirectory is rendered, not set in an effect: the input must pick folders from the moment it exists */}
          <input ref={inputRef} type="file" multiple hidden data-testid="folder-input" {...{ webkitdirectory: '' }} onChange={onInput} />
        </div>
        <div className="app-tools">
          <ThemeSwitch theme={theme} />
          <AppLink history={history} to="/help" className="help-link" testId="help-link">
            Help
          </AppLink>
        </div>
      </header>
      {!capabilities.core.ok && (
        <div className="error-banner" role="alert">
          This browser is missing: {capabilities.core.missing.join(', ')}. Use Chrome, Safari or Firefox on a computer, or Chrome on Android.
        </div>
      )}
      {pending && (
        <ResumePrompt
          place={pending.offer.place}
          changed={pending.offer.kind === 'changed'}
          resumeOnly={false}
          disabled={false}
          nowMs={Date.now()}
          onResume={() => answerPending(true)}
          onStartOver={() => answerPending(false)}
        />
      )}
      {serverLink && (
        <section className="recent server-discs" data-testid="server-discs">
          <h2>On the disc server</h2>
          {serverError && <p className="hint">{serverError}</p>}
          {serverDiscs?.length === 0 && <p className="hint">The server has no discs.</p>}
          {serverDiscs && serverDiscs.length > 0 && (
            <ul>
              {serverDiscs.map((disc) => {
                const spec = serverSpecs.get(disc.base);
                return (
                  <li key={disc.base}>
                    <button
                      type="button"
                      disabled={!capabilities.core.ok || typeof spec !== 'object'}
                      onClick={() => typeof spec === 'object' && onServerDisc(spec)}
                    >
                      {disc.name}
                    </button>
                    {typeof spec === 'string' && <p className="hint">{spec}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      {copyNotice && (
        <p className="status" role="status" data-testid="copy-notice">
          Waiting for the files… On iPhone and iPad, Safari copies the whole folder before the player can read it, so a full disc can take an hour or more from a USB drive.
        </p>
      )}
      {snapshot.engineState === 'loading' && <p className="status">Reading disc…</p>}
      {nasWaiting && (
        <p className="status" role="status" data-testid="nas-waiting">
          {nasWaiting.message}
        </p>
      )}
      {error && (
        <div className="error-banner" role="alert" data-testid="error">
          {error}
          {errorPaths.length > 0 && (
            <ul>
              {errorPaths.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {nasPanel === 'not-found' && <NasNotFound reason="unpaired" onLeave={pairFromNotFound} />}
      {nasPanel === 'pair' && (
        <PairScreen
          client={nas}
          link={pairLink}
          paired={pairing !== null}
          onLinkDropped={() => {
            // back to the paired view when this device was already paired
            setPairRequested(false);
            onPairLinkSpent?.();
          }}
          onPaired={() => {
            setPairRequested(false);
            onPairLinkSpent?.();
            setLocalError(null);
            loadPairing();
          }}
        />
      )}
      {!browsing && pairedLine}
      {paired && playLink !== null && <PlayLink nas={nas} places={places} controller={controller} history={history} playingRoute={playingRoute} route={playLink} onLibrary={libraryFromNotFound} />}
      {paired && shown !== null && playLink === null && guestOnTitleRoute && <NasNotFound reason="closed" onLeave={libraryFromNotFound} />}
      {paired && shown !== null && playLink === null && titleMissing && !guestOnTitleRoute && <NasNotFound reason="missing" onLeave={libraryFromNotFound} />}
      {paired && shown !== null && playLink === null && !guestOnTitleRoute && !titleMissing && (shown.kind === 'folders' || (typeof access === 'object' && access !== null && !access.titles)) && (
        // A guest behind the closed gate on any other route: the folders where it browsed last.
        <LibraryScreen
          nas={nas}
          controller={controller}
          history={history}
          playingRoute={playingRoute}
          places={places}
          onLaunch={onLaunch}
          path={shown.kind === 'folders' ? shown.path : rememberedFolder()}
          onClose={closeNas}
        />
      )}
      {paired && shown !== null && playLink === null && !titleMissing && shown.kind !== 'folders' && (access === null || access === 'checking') && <p className="status">Loading…</p>}
      {paired && shown !== null && playLink === null && !titleMissing && shown.kind !== 'folders' && typeof access === 'object' && access?.titles && (
        <TitleLibrary
          nas={nas}
          controller={controller}
          history={history}
          playingRoute={playingRoute}
          places={places}
          onLaunch={onLaunch}
          owner={access.owner}
          onOwnerLost={recheckAccess}
          onGateClosed={gateClosed}
          onTitleMissing={onTitleMissing}
          onClose={closeNas}
        />
      )}
      {capabilities.canRememberDiscs && recent.length > 0 && (
        <section className="recent">
          <h2>Recent discs</h2>
          <ul>
            {recent.map((disc) => (
              <li key={disc.id}>
                <button type="button" onClick={() => onRecent(disc)}>
                  {disc.name} <span className="recent-date">· {new Date(disc.openedAt).toLocaleDateString()}</span>
                  {recentResume.has(disc.id) && (
                    <span className="recent-resume" data-testid="recent-resume">
                      {' '}
                      · {recentResume.get(disc.id)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {browsing && pairedLine && <footer className="app-foot">{pairedLine}</footer>}
    </main>
  );
}
