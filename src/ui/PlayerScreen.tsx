import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type MouseEvent, type PointerEvent, type ReactElement } from 'react';
import type { PlayerController, PlayerSnapshot } from '../player/player-controller';
import { ControlBar } from './ControlBar';
import { badgeText, pickAt } from './nas/level-model';
import { levelSessionOf } from './nas/level-session';
import type { NasClient } from './nas/nas-client';
import type { NasHistory } from './nas/nas-history';
import type { NasRoute } from './nas/nas-route';
import type { PlaceSaver } from './place-saver';
import { LaunchSettingsApplier } from './place-apply';
import type { PlayingRoute } from './nas/playing-route';
import { RelayBadge } from './nas/RelayBadge';
import type { ShaderModel, ShaderModelState } from './shader-model';
import { collectDroppedFiles, splitPick } from '../player/drop-files';
import { checkCapabilities } from './capabilities';
import { FULLSCREEN_HINT_TEXT, evaluateFullscreenHint, markFullscreenHintDismissed, safeLocalStorage, toggleFullscreen } from './fullscreen';
import { EncodingPrompt } from './EncodingPrompt';
import { keyActionUo, keyToAction, keyWakesControls } from './keyboard';
import { toMenuSpace } from './pointer';
import { classifyTap, controlsMayIdle, controlsShown, DOUBLE_TAP_MS, idleAfterTap, beyondLongPressSlop, isHoverPointer, isMenuLongPress, LONG_PRESS_MS, menuPointerEffect, missedMenuTapShowsControls, offPicture, pairableTap, tapPoint, type PointerPoint, type Tap } from './touch';
import { PlaylistPicker } from './PlaylistPicker';
import { RemotePad } from './RemotePad';
import type { MenuKey } from '../engine/protocol';
import type { FansubPick, FansubPickRequest, LevelId, StoredSubtitle } from '../engine/disc/nas-api';
import { replacesTextSet, StoredSubtitlePicker } from './nas/stored-subtitle-pick';
import { forPlaylist, STORED_LIST_TIMEOUT_MS } from './nas/subtitle-model';
import { defaultQuery, type FansubOrigin, type ToshoTrack } from './nas/tosho-search-model';
import type { ToshoSearch } from './ToshoSearch';

const HIDE_CONTROLS_MS = 3000;
const OFFSET_NOTICE_MS = 2000;
const TAP_NOTICE_MS = 6000;
const LIBRARY: NasRoute = { kind: 'library', shelf: null, q: '' };


/** A touch held on the video over a disc menu: where and when it went down, and whether it moved or showed the controls. */
interface Press {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly downAt: number;
  moved: boolean;
  fired: boolean;
  timer: number | null;
}

interface PlayerScreenProps {
  readonly controller: PlayerController;
  readonly snapshot: PlayerSnapshot;
  readonly shaderModel: ShaderModel;
  readonly shaderState: ShaderModelState;
  /** For the "Relayed" badge of a NAS disc; absent where there is no NAS. */
  readonly nas?: NasClient;
  /** Saves the open disc's place (begun by the screen that opened it). */
  readonly places: PlaceSaver;
  /** A NAS disc's playback is in the address bar (playingRoute, once its pre-flight started it); Back closes it. */
  readonly history: NasHistory;
  readonly playingRoute: PlayingRoute;
}

/**
 * What the key handlers need to name a key's user operation (keyActionUo), from the controller's latest snapshot rather
 * than the last render, so a key pressed right after a menu opens already goes to the menu.
 */
function uoContext(controller: PlayerController): { playing: boolean; popupShown: boolean } {
  const now = controller.getSnapshot();
  return { playing: now.engineState === 'playing' || now.engineState === 'buffering', popupShown: now.menuActive && now.popupAvailable };
}

function Notice({ message, onDismiss, testId }: { message: string; onDismiss(): void; testId?: string }): ReactElement {
  return (
    <div className="notice" role="status" data-testid={testId}>
      {message}
      <button type="button" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

export function PlayerScreen({ controller, snapshot, shaderModel, shaderState, nas, places, history, playingRoute }: PlayerScreenProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [idle, setIdleState] = useState(false);
  /** Whether a hover pointer (moving over a disc menu) hid the controls, rather than the idle timer or a tap (ruling R12). */
  const [hiddenByHover, setHiddenByHover] = useState(false);
  const setIdle = (next: boolean, byHover = false): void => {
    setIdleState(next);
    setHiddenByHover(next && byHover);
  };
  const [activity, setActivity] = useState(0);
  const [pressed, setPressed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [fullscreen] = useState(() => checkCapabilities().fullscreen);
  const [hintVisible, setHintVisible] = useState(() => evaluateFullscreenHint(fullscreen));
  const playing = snapshot.engineState === 'playing';
  /** The latest pointer position waiting for the next animation frame (moves are sent at most once per frame). */
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  /** Touch state: the previous tap, the delayed single-tap timer, whether the last pointerup was touch (its synthesized click is ignored). */
  const lastTap = useRef<Tap | null>(null);
  const tapTimer = useRef<number | null>(null);
  const idleRef = useRef(idle);
  idleRef.current = idle;
  const lastUpWasTouch = useRef(false);
  /** A touch on the video over a disc menu that may become a long press (ruling R15). */
  const press = useRef<Press | null>(null);
  /** Whether the controls showed at the last render (a tap at the bottom edge of a menu shows hidden ones, ruling R12). */
  const controlsVisibleRef = useRef(true);
  /** The last touch pointerdown on the video: a tap's position comes from it (see tapPoint). */
  const touchDown = useRef<PointerPoint | null>(null);

  useEffect(
    () => () => {
      if (tapTimer.current !== null) window.clearTimeout(tapTimer.current);
      if (press.current?.timer != null) window.clearTimeout(press.current.timer);
    },
    [],
  );

  // The address bar follows a NAS disc's playlist and time (a local or disc-server disc never started playingRoute).
  const { currentPlaylistId, timeUs, engineState } = snapshot;
  useEffect(() => playingRoute.update({ currentPlaylistId, timeUs, engineState }), [playingRoute, currentPlaylistId, timeUs, engineState]);
  // Each snapshot may save the place (spec 2026-10-20 §6.2).
  const shaderSet = shaderState.selected;
  useEffect(() => places.observe(snapshot, shaderSet), [places, snapshot, shaderSet]);
  // A resumed (or carried-over) launch's settings, once the disc plays: volume, tracks and subtitle files.
  /** The place is saved before the disc closes: its registers are read while it is still open. */
  const savePlaceAndEnd = useCallback((): void => {
    void places.flushNow({ keepalive: false });
    places.end();
  }, [places]);
  // Back (or Forward) off the play route closes the NAS disc; the landing screen then shows where it went.
  useEffect(
    () =>
      history.subscribe(() => {
        if (playingRoute.discKey === null || history.route()?.kind === 'play') return;
        playingRoute.stop();
        if (nas) levelSessionOf(nas).end();
        savePlaceAndEnd();
        controller.closeDisc();
      }),
    [history, playingRoute, controller, savePlaceAndEnd, nas],
  );
  // The NAS disc's quality level (the session knows the levels, the version playing and the last switch's notice).
  const levelSession = nas ? levelSessionOf(nas) : null;
  const levelState = useSyncExternalStore(
    useCallback((fn: () => void) => (levelSession ? levelSession.subscribe(fn) : () => undefined), [levelSession]),
    () => (levelSession ? levelSession.get() : null),
  );
  const [switchFailure, setSwitchFailure] = useState<string | null>(null);
  // The engine closed the disc after a failed switch: the level's lease goes with it.
  useEffect(() => {
    if (typeof snapshot.levelSwitch === 'object') levelSession?.end();
  }, [snapshot.levelSwitch, levelSession]);
  // A failure belongs to the disc it happened on: it goes when the session ends or another disc begins.
  const levelDiscId = levelState?.discId ?? null;
  useEffect(() => setSwitchFailure(null), [levelDiscId]);
  const switchTo = (at: { level: LevelId; audio: number }): void => {
    if (!nas || !levelSession || !levelState) return;
    setSwitchFailure(null);
    Promise.all([nas.discBase(levelState.discId), nas.session()])
      .then(([base, session]) => levelSession.switchTo(at, { controller, base, token: session.token }))
      .then(() => setSwitchFailure(null))
      .catch((err: unknown) => setSwitchFailure(`Couldn't switch quality: ${err instanceof Error ? err.message : String(err)}`));
  };
  const atLevel = levelState !== null && levelState.at.level !== 'original';
  const quality = levelState
    ? {
        state: levelState,
        // from Original, the stream that plays goes on at the level (its number is the original's there)
        onPick: (level: LevelId) => switchTo(pickAt(levelState.at, level, snapshot.selectedAudio)),
        audio:
          atLevel && currentPlaylistId !== null && levelSession
            ? { tracks: levelSession.originalAudio(currentPlaylistId), current: levelState.at.audio, onPick: (n: number) => switchTo({ level: levelState.at.level, audio: n }) }
            : null,
      }
    : null;
  const levelInfo = levelState?.levels.find((l) => l.level === levelState.at.level);
  const badge = levelInfo ? badgeText(levelInfo) : null;
  const originalUnplayable = levelState?.levels.find((l) => l.level === 'original')?.reason === 'unplayable';
  const levelNotice = snapshot.levelSwitch === 'switching' ? 'Switching quality…' : typeof snapshot.levelSwitch === 'object' ? snapshot.levelSwitch.error : (switchFailure ?? levelState?.notice ?? null);
  /** The player's own close: a NAS disc's play route goes back to where Play was pressed (else the library). */
  const closeDisc = (): void => {
    const nasPlayback = playingRoute.discKey !== null;
    playingRoute.stop();
    if (nas) levelSessionOf(nas).end();
    savePlaceAndEnd();
    controller.closeDisc();
    if (nasPlayback) history.back(LIBRARY);
  };
  /** Subtitle files the user adds go to the engine, and are kept on this device for a resume here. */
  const loadSubtitleFiles = (files: readonly File[]): void => {
    void controller.loadSubtitleFiles(files);
    rememberSubtitleFiles(files);
  };
  const rememberSubtitleFiles = (files: readonly File[]): void => {
    if (replacesTextSet(files)) {
      // a local pick replaces a stored subtitle, and one still loading (picked, or re-added for a resume)
      storedPicker?.supersede();
      launchSettings.supersede();
      setStoredActive(null);
      setFansubActive(null);
    }
    places.addTextFiles(files).catch((err: unknown) => console.warn('keeping the subtitle files failed', err));
  };

  // A NAS disc's stored subtitles (piece 3), listed once per open; a local or disc-server disc has none.
  const nasDiscKey = nas ? playingRoute.discKey : null;
  const discOpens = controller.discOpens;
  const [stored, setStored] = useState<{ readonly discKey: string; readonly items: readonly StoredSubtitle[] } | null>(null);
  const [storedActive, setStoredActive] = useState<string | null>(null);
  /** The viewer's Anime Tosho pick placed last (its file, and the file and track it is), checked in the search's tracks. */
  const [fansubActive, setFansubActive] = useState<{ readonly fileName: string; readonly fileId: number; readonly track: number } | null>(null);
  useEffect(() => {
    setStored(null);
    setStoredActive(null);
    setFansubActive(null);
    if (!nas || nasDiscKey === null) return;
    let live = true;
    nas.subtitlesForDisc(nasDiscKey, { timeoutMs: STORED_LIST_TIMEOUT_MS }).then(
      (items) => {
        if (live) setStored({ discKey: nasDiscKey, items });
      },
      (err: unknown) => console.warn('listing the stored subtitles failed', err),
    );
    return () => {
      live = false;
    };
  }, [nas, nasDiscKey, discOpens]);
  const [storedPicker] = useState(() => (nas ? new StoredSubtitlePicker({ nas, controller, places, snapshot: controller.getSnapshot }) : null));
  /** A stored subtitle picked from the menu (or for Up next): checked once placed. */
  const pickStoredWith = (picker: StoredSubtitlePicker, s: StoredSubtitle): Promise<boolean> =>
    picker.pick(s).then((placed) => {
      if (placed) {
        setStoredActive(s.id);
        setFansubActive(null);
      }
      return placed;
    });
  /** An Anime Tosho track lined up and loaded as the viewer's own pick (the search, or Up next): checked once placed. */
  const pickFansubWith = (picker: StoredSubtitlePicker, req: FansubPickRequest, origin: FansubOrigin): Promise<FansubPick | null> =>
    picker.pickFansub(req, origin).then((placed) => {
      if (placed) {
        setFansubActive({ fileName: placed.fileName, fileId: req.fileId, track: req.track });
        setStoredActive(null);
      }
      return placed;
    });
  /** The menu's pick: it replaces any files still being re-added for a resume. */
  const pickStored = (s: StoredSubtitle): void => {
    launchSettings.supersede();
    if (storedPicker) void pickStoredWith(storedPicker, s);
  };
  const [launchSettings] = useState(
    () =>
      new LaunchSettingsApplier({
        controller,
        places,
        ...(nas && storedPicker
          ? { nas, pickStored: (s: StoredSubtitle) => pickStoredWith(storedPicker, s), pickFansub: (req: FansubPickRequest, origin: FansubOrigin) => pickFansubWith(storedPicker, req, origin) }
          : {}),
        onStoredSubtitle: (id: string) => {
          setStoredActive(id);
          setFansubActive(null);
        },
        onFansubPick: (pick, fansub) => {
          setFansubActive({ fileName: pick.fileName, fileId: fansub.fileId, track: fansub.track });
          setStoredActive(null);
        },
        log: (message, err) => console.warn(message, err),
      }),
  );
  useEffect(() => launchSettings.observe(snapshot), [launchSettings, snapshot]);
  const storedHere = stored && currentPlaylistId !== null ? forPlaylist(stored.items, stored.discKey, currentPlaylistId) : null;
  // checked while its file is still the text set's (Remove takes it away)
  const storedActiveId = storedHere?.find((s) => s.id === storedActive && snapshot.subtitles?.text?.files.some((f) => f.name === s.fileName))?.id ?? null;
  const storedSubtitles = storedHere ? { items: storedHere, activeId: storedActiveId, onPick: pickStored } : null;
  // A NAS disc's Anime Tosho search (spec §9), for the playlist playing: its box starts with the catalogue title's name
  // when the disc was opened from it (this person sees titles), else the disc's name.
  const about = playingRoute.about;
  const fansubHere = fansubActive && snapshot.subtitles?.text?.files.some((f) => f.name === fansubActive.fileName) ? fansubActive : null;
  const toshoSearch: ToshoSearch | null =
    nas && storedPicker && nasDiscKey !== null && currentPlaylistId !== null
      ? {
          query: defaultQuery(about?.title?.name ?? null, about?.discName ?? ''),
          search: (q) => nas.searchTosho(q, about?.title?.id),
          release: (id) => nas.toshoRelease(id, nasDiscKey, currentPlaylistId),
          pick: (releaseId: number, fileId: number, t: ToshoTrack) => {
            // the search's pick replaces any files still being re-added for a resume
            launchSettings.supersede();
            return pickFansubWith(storedPicker, { fileId, track: t.track, discKey: nasDiscKey, playlistId: currentPlaylistId }, { releaseId, trackName: t.name }).then((p) => p !== null);
          },
          active: fansubHere,
        }
      : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    controller.attachCanvas(canvas);
    const observer = new ResizeObserver(([entry]) => {
      const dpr = window.devicePixelRatio || 1;
      controller.resize(entry.contentRect.width * dpr, entry.contentRect.height * dpr);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [controller]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Any key shows the controls again, like mouse movement does, except a key that goes to a disc menu (ruling R11):
      // the bar never comes over the menu.
      const modified = e.ctrlKey || e.metaKey || e.altKey;
      const shown = controller.getSnapshot();
      const inMenu = shown.menuActive || shown.bdjMenuVisible;
      const textEntry = e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLInputElement && e.target.type !== 'range');
      if (keyWakesControls(modified || textEntry ? null : keyToAction(e.key, { menuActive: inMenu }), inMenu)) {
        setIdle(false);
        setActivity((a) => a + 1);
      }
      if (modified) return;
      const target = e.target;
      if (target instanceof HTMLTextAreaElement) return;
      if (target instanceof Element && target.closest('.audio-menu-list, .shader-dialog')) return; // an open audio or subtitle menu handles its own keys
      if (controller.getSnapshot().encodingPrompt) return; // the encoding dialog is modal
      if (target instanceof HTMLInputElement) {
        if (target.type !== 'range') return;
        // Only the volume slider keeps its native arrow-key stepping; on the seek bar arrows seek by 10 s.
        if (e.key.startsWith('Arrow') && target.dataset.role === 'volume') return;
      }
      // a BD-J menu on screen takes the arrows, Enter and digits as an HDMV menu does
      const now = controller.getSnapshot();
      const menuActive = now.menuActive || now.bdjMenuVisible;
      if (target instanceof HTMLButtonElement) {
        // A focused button keeps Space and Enter, except that while a disc menu is shown Enter is the menu's OK: after
        // clicking Pop-up or Top Menu the focus stays there, and a second click would close or restart the menu.
        // Dialogs over the player (the picker) keep Enter.
        if (e.key === ' ') return;
        if (e.key === 'Enter' && (!menuActive || target.closest('.picker-backdrop'))) return;
      }
      const action = keyToAction(e.key, { menuActive });
      if (!action) return;
      e.preventDefault();
      const op = keyActionUo(action, uoContext(controller));
      if (op && !controller.allow(op)) return;
      switch (action.type) {
        case 'togglePlay':
          controller.togglePlay();
          break;
        case 'seekBy':
          controller.seekBy(action.deltaUs);
          break;
        case 'volumeBy':
          controller.adjustVolume(action.delta);
          break;
        case 'fullscreen':
          if (fullscreen && rootRef.current) toggleFullscreen(document, rootRef.current, fullscreen);
          break;
        case 'cycleAudio':
          controller.cycleAudio();
          break;
        case 'cycleSubtitles':
          controller.cycleSubtitles();
          break;
        case 'cycleShaders':
          void shaderModel.cycle().catch((e) => console.error('shader cycle failed', e));
          break;
        case 'subtitleOffset':
          controller.shiftSubtitles(action.deltaMs);
          break;
        case 'menuKey':
          controller.menuKey(action.key, e.repeat);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller, shaderModel]);

  useEffect(() => {
    if (!pressed) return;
    // The release can land outside the player (or on a control that hid meanwhile), so listen on the window.
    const release = (): void => {
      setPressed(false);
      setActivity((a) => a + 1);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, [pressed]);

  useEffect(() => {
    // holding a control (e.g. the seek thumb), an open menu, or the remote over a disc menu keeps the controls up
    if (!controlsMayIdle({ playing, pressed, menuOpen, remoteOpen, inMenu: snapshot.menuActive || snapshot.bdjMenuVisible })) return;
    const timer = window.setTimeout(() => {
      if (!idleRef.current) setIdle(true); // controls a hover pointer already hid stay marked as hidden by it
    }, HIDE_CONTROLS_MS);
    return () => window.clearTimeout(timer);
  }, [playing, activity, pressed, menuOpen, remoteOpen, snapshot.menuActive, snapshot.bdjMenuVisible]);

  const trackNotice = snapshot.notices.find((n) => n.code === 'audio-track')?.message;
  useEffect(() => {
    if (!trackNotice) return;
    const timer = window.setTimeout(() => controller.dismissNotice('audio-track'), 3000);
    return () => window.clearTimeout(timer);
  }, [controller, trackNotice]);

  const offsetNotice = snapshot.notices.find((n) => n.code === 'subtitle-offset')?.message;
  useEffect(() => {
    if (!offsetNotice) return;
    const timer = window.setTimeout(() => controller.dismissNotice('subtitle-offset'), OFFSET_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [controller, offsetNotice]);

  const answerEncoding = useCallback((encoding: string | null) => void controller.answerEncoding(encoding), [controller]);

  /** Dropped subtitle files and fonts (or folders of them) load as the subtitle set; nothing opens in the tab. */
  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  };
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    if (snapshot.currentPlaylistId === null) return;
    // read synchronously: the item list is unusable once the event returns
    void collectDroppedFiles(e.dataTransfer.items).then((files) => {
      const { subtitles, fonts } = splitPick(files);
      if (subtitles.length || fonts.length) loadSubtitleFiles([...subtitles, ...fonts]);
    });
  };

  // The first tap a BD-J menu ignores opens the remote, with the controls it sits over, once per menu (with the notice):
  // a remote the user closes stays closed until the next menu.
  // A touch on an HDMV menu that hit no button shows the controls (ruling R13); a mouse click that missed leaves them.
  // (On a BD-J menu the ignored-tap rule below opens the remote with them.)
  const lastMenuClickPointer = useRef('mouse');
  const tapMisses = snapshot.menuTapMisses;
  const seenTapMisses = useRef(tapMisses);
  useEffect(() => {
    if (tapMisses === seenTapMisses.current) return;
    seenTapMisses.current = tapMisses;
    if (!missedMenuTapShowsControls(lastMenuClickPointer.current)) return;
    setIdle(false);
    setActivity((a) => a + 1);
  }, [tapMisses]);

  const remoteRequests = snapshot.bdjRemoteRequests;
  const seenRemoteRequests = useRef(remoteRequests);
  useEffect(() => {
    if (remoteRequests === seenRemoteRequests.current) return;
    seenRemoteRequests.current = remoteRequests;
    setRemoteOpen(true);
    setIdle(false);
    setActivity((a) => a + 1);
  }, [remoteRequests]);

  const tapNotice = snapshot.notices.find((n) => n.code === 'bdj-tap-ignored');
  useEffect(() => {
    if (!tapNotice) return;
    const timer = window.setTimeout(() => controller.dismissNotice('bdj-tap-ignored'), TAP_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [controller, tapNotice]);

  const maskedNotice = snapshot.notices.find((n) => n.code === 'uo-masked');
  useEffect(() => {
    if (!maskedNotice) return;
    const timer = window.setTimeout(() => controller.dismissNotice('uo-masked'), 3000);
    return () => window.clearTimeout(timer);
  }, [controller, maskedNotice]);

  // A BD-J title hears the mouse wherever it is over the picture (BDJ_EVENT_MOUSE), as libbluray's hosts send it.
  const onCanvasPointerMove = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (e.pointerType === 'touch') {
      const p = press.current;
      if (p && p.id === e.pointerId && !p.moved && beyondLongPressSlop(p, { x: e.clientX, y: e.clientY })) {
        p.moved = true; // a drag, not a long press
        if (p.timer !== null) window.clearTimeout(p.timer);
        p.timer = null;
      }
      return;
    }
    if (!(snapshot.menuActive || snapshot.bdjActive)) return;
    const point = toMenuSpace(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    if (!point) return;
    const first = pendingMove.current === null;
    pendingMove.current = point;
    if (!first) return;
    requestAnimationFrame(() => {
      const p = pendingMove.current;
      pendingMove.current = null;
      if (p) controller.pointer('move', p.x, p.y);
    });
  };

  /** Ends a pending long press (its timer); returns whether it had already shown the controls. */
  const endPress = (pointerId?: number): boolean => {
    const p = press.current;
    if (!p || (pointerId !== undefined && p.id !== pointerId)) return false;
    if (p.timer !== null) window.clearTimeout(p.timer);
    press.current = null;
    return p.fired;
  };

  // A touch held still over a disc menu shows the controls once LONG_PRESS_MS pass, with the finger still down, and is not
  // sent to the disc (ruling R15): the way back to the controls when every tap on the picture goes to the disc.
  // The press starts at the pointerdown's position, as a tap's position does (tapPoint).
  const onCanvasPointerDown = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (e.pointerType !== 'touch') return;
    touchDown.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    endPress();
    const now = controller.getSnapshot();
    if (!(now.menuActive || now.bdjMenuVisible)) return; // outside a menu a long touch is an ordinary tap
    const p: Press = { id: e.pointerId, x: e.clientX, y: e.clientY, downAt: performance.now(), moved: false, fired: false, timer: null };
    p.timer = window.setTimeout(() => {
      p.timer = null;
      const s = controller.getSnapshot();
      if (!isMenuLongPress({ inMenu: s.menuActive || s.bdjMenuVisible, heldMs: performance.now() - p.downAt, moved: p.moved })) return;
      p.fired = true;
      setIdle(false);
      setActivity((a) => a + 1);
    }, LONG_PRESS_MS);
    press.current = p;
  };

  const onCanvasPointerUp = (e: PointerEvent<HTMLCanvasElement>): void => {
    lastUpWasTouch.current = e.pointerType === 'touch';
    if (e.pointerType !== 'touch') return;
    // where the finger went down: iPadOS can report a touch's pointerup at (0, 0) (tapPoint)
    const at = tapPoint(touchDown.current, { id: e.pointerId, x: e.clientX, y: e.clientY });
    touchDown.current = null;
    if (endPress(e.pointerId)) {
      // the long press showed the controls: no click for the disc, and no tap to pair with
      lastTap.current = null;
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const tap: Tap = { x: at.x - rect.left, timeMs: e.timeStamp };
    // the snapshot the engine last sent: the tap is mapped with the canvas rectangle as it is now (after a rotation too)
    const now = controller.getSnapshot();
    const action = classifyTap(lastTap.current, tap, {
      width: rect.width,
      menuActive: now.menuActive,
      bdjMenuVisible: now.bdjMenuVisible,
      offPicture: offPicture(at.x, at.y, rect), // a letterbox or pillarbox band: nothing there reaches the disc
      controlsShown: controlsVisibleRef.current,
    });
    lastTap.current = pairableTap(action, tap);
    if (tapTimer.current !== null) {
      window.clearTimeout(tapTimer.current);
      tapTimer.current = null;
    }
    switch (action) {
      case 'menuClick': {
        const point = toMenuSpace(at.x, at.y, rect);
        if (point) {
          lastMenuClickPointer.current = e.pointerType;
          controller.pointer('click', point.x, point.y);
        }
        break;
      }
      case 'showControls':
        setIdle(false);
        setActivity((a) => a + 1);
        break;
      case 'seekBack':
      case 'seekForward': {
        const op = keyActionUo({ type: 'seekBy', deltaUs: 0 }, uoContext(controller));
        if (op && !controller.allow(op)) break;
        controller.seekBy(action === 'seekForward' ? 10_000_000 : -10_000_000);
        break;
      }
      case 'toggleControls': {
        // Delayed so that the first tap of a double tap doesn't flash the controls.
        tapTimer.current = window.setTimeout(() => {
          tapTimer.current = null;
          const next = idleAfterTap(idleRef.current, controller.getSnapshot().engineState);
          if (next === idleRef.current) return;
          setIdle(next);
          if (!next) setActivity((a) => a + 1);
        }, DOUBLE_TAP_MS);
        break;
      }
      case 'none':
        break;
    }
  };

  const onCanvasClick = (e: MouseEvent<HTMLCanvasElement>): void => {
    if (lastUpWasTouch.current) {
      lastUpWasTouch.current = false; // the click the browser synthesized after a tap, already handled on pointerup
      return;
    }
    const now = controller.getSnapshot();
    if (!(now.menuActive || now.bdjMenuVisible)) {
      controller.togglePlay();
      return;
    }
    const point = toMenuSpace(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    if (point) {
      lastMenuClickPointer.current = 'mouse'; // a click event from a mouse or pen (a touch's is ignored above)
      controller.pointer('click', point.x, point.y);
    }
  };

  /** A menu key from the control bar or the remote: checked against the UO mask like the keyboard. */
  const sendMenuKey = (key: MenuKey): void => {
    const op = keyActionUo({ type: 'menuKey', key }, uoContext(controller));
    if (op && !controller.allow(op)) return;
    controller.menuKey(key);
  };

  const wake = (): void => {
    setIdle(false);
    setActivity((a) => a + 1);
  };

  const isVideoTouch = (e: PointerEvent<HTMLElement>): boolean => e.pointerType === 'touch' && e.target === canvasRef.current;

  const inMenu = snapshot.menuActive || snapshot.bdjMenuVisible;
  const controlsVisible = controlsShown({ idle, playing, inMenu, hiddenByHover });
  controlsVisibleRef.current = controlsVisible;

  /**
   * A pointer move or press anywhere in the player. Over a disc menu a mouse or pen wakes the bar only at the bottom edge
   * (or over the bar it woke) and hides it at once elsewhere (ruling R9); otherwise any move wakes it, and a touch on the
   * video is left to the tap handling.
   */
  const onPlayerPointer = (e: PointerEvent<HTMLDivElement>): void => {
    if (isVideoTouch(e)) return;
    const now = controller.getSnapshot();
    const root = rootRef.current;
    if (!root || !isHoverPointer(e.pointerType) || !(now.menuActive || now.bdjMenuVisible)) {
      wake();
      return;
    }
    const bar = controlsVisible ? root.querySelector('.control-bar') : null;
    const effect = menuPointerEffect({
      y: e.clientY,
      playerBottom: root.getBoundingClientRect().bottom,
      barTop: bar ? bar.getBoundingClientRect().top : null,
      overControls: e.target instanceof Element && e.target.closest('.control-bar, .remote-pad') !== null,
      held: pressed || menuOpen || remoteOpen,
    });
    if (effect === 'wake') wake();
    else if (effect === 'hide') setIdle(true, true);
  };
  // No current playlist (first pick, failed pick) shows the picker — but not while a pick is still loading, nor while a
  // BD-J title runs (Java opens its playlists itself; the Playlists button still opens the picker).
  const showPicker = pickerOpen || (snapshot.currentPlaylistId === null && snapshot.engineState !== 'loading' && !snapshot.bdjActive);

  return (
    <div
      ref={rootRef}
      className={`player${controlsVisible ? '' : ' idle'}${inMenu ? ' in-menu' : ''}`}
      data-testid="player"
      data-state={snapshot.engineState}
      data-playlist={snapshot.currentPlaylistId ?? undefined}
      data-audio-tracks={snapshot.audioTracks.length}
      data-menu-active={snapshot.menuActive}
      data-bdj-menu={snapshot.bdjMenuVisible}
      onPointerMove={onPlayerPointer}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPointerDown={(e) => {
        setPressed(true);
        if (!isVideoTouch(e)) {
          // A touch off the video cancels a pending single tap: it would otherwise hide the controls just woken.
          if (tapTimer.current !== null) {
            window.clearTimeout(tapTimer.current);
            tapTimer.current = null;
          }
          onPlayerPointer(e);
        } // a touch on the video shows or hides the controls on its own, after the double-tap window
      }}
    >
      <canvas
        ref={canvasRef}
        className={`player-canvas${snapshot.menuActive && snapshot.pointerButton !== null ? ' over-button' : ''}`}
        data-testid="video-canvas"
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={(e) => endPress(e.pointerId)}
        onContextMenu={(e) => {
          if (press.current) e.preventDefault(); // a long press over a menu shows the controls, not the browser's menu
        }}
        onClick={onCanvasClick}
      />
      <div className="notices">
        {nas && snapshot.rtcDisc && <RelayBadge nas={nas} />}
        {badge && (
          <span className="level-badge" data-testid="level-badge">
            {badge}
            {originalUnplayable ? " (this disc's video can't play here as it is)" : ''}
          </span>
        )}
        {levelNotice && (
          <div className="notice" role="status" data-testid="level-notice">
            {levelNotice}
          </div>
        )}
        {snapshot.error && (
          <div className="error-banner" role="alert" data-testid="error">
            {snapshot.error.message}
          </div>
        )}
        {snapshot.notices.map((n) => (
          <Notice key={n.code} message={n.message} onDismiss={() => controller.dismissNotice(n.code)} />
        ))}
        {hintVisible && (
          <Notice
            message={FULLSCREEN_HINT_TEXT}
            testId="fullscreen-hint"
            onDismiss={() => {
              setHintVisible(false);
              const storage = safeLocalStorage();
              if (storage) markFullscreenHintDismissed(storage);
            }}
          />
        )}
      </div>
      {snapshot.engineState === 'buffering' && <div className="spinner" aria-label="Buffering" />}
      {showPicker && (
        <PlaylistPicker
          playlists={snapshot.playlists}
          usesBdj={snapshot.usesBdj}
          bdjSupported={snapshot.bdjSupported}
          bdjMissing={snapshot.bdjMissing}
          titles={snapshot.indexTitles?.titles}
          onPickTitle={(title) => {
            setPickerOpen(false);
            controller.playTitle(title);
          }}
          messages={[...(snapshot.error ? [snapshot.error.message] : []), ...snapshot.notices.filter((n) => n.code.startsWith('unsupported-')).map((n) => n.message)]}
          onPick={(id) => {
            setPickerOpen(false);
            controller.playPlaylist(id);
          }}
          onClose={snapshot.currentPlaylistId === null && !snapshot.bdjActive ? undefined : () => setPickerOpen(false)}
          onCloseDisc={closeDisc}
        />
      )}
      {remoteOpen && controlsVisible && (snapshot.indexTitles || snapshot.bdjActive) && <RemotePad onKey={sendMenuKey} />}
      {snapshot.encodingPrompt && <EncodingPrompt fileName={snapshot.encodingPrompt.names.join(', ')} onAnswer={answerEncoding} />}
      <ControlBar
        controller={controller}
        snapshot={snapshot}
        shaderModel={shaderModel}
        shaderState={shaderState}
        visible={controlsVisible}
        onOpenPlaylists={() => setPickerOpen(true)}
        onFullscreen={
          fullscreen
            ? () => {
                if (rootRef.current) toggleFullscreen(document, rootRef.current, fullscreen);
              }
            : undefined
        }
        onMenuKey={sendMenuKey}
        remoteOpen={remoteOpen}
        onToggleRemote={() => setRemoteOpen((o) => !o)}
        onMenuOpenChange={setMenuOpen}
        onSubtitleFiles={rememberSubtitleFiles}
        storedSubtitles={storedSubtitles}
        toshoSearch={toshoSearch}
        quality={quality}
      />
    </div>
  );
}
