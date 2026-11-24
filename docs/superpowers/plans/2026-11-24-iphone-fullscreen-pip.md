# Picture in Picture and video fullscreen through the element path: plan

Spec: `docs/superpowers/specs/2026-11-24-iphone-fullscreen-pip-design.md`. TDD, a commit per task.

## Task 1: engine `preferElement`

- `packages/engine/src/protocol.ts`: command `{ type: 'preferElement' }`; event
  `{ type: 'elementPreference'; outcome: 'element' | 'reopening' | 'unavailable'; reason?: ElementPreferenceReason }`.
- `packages/engine/src/player.ts`: `elementPreferred` (reset on disc open and close); `elementCoding` treats it as
  `element`; `choosePath` treats the path as `element` while it is set; the command answers and reopens with
  `restart(disc, restartPoint(s))` as `followShaders` does.
- Tests: `player-element.test.ts` (`path: 'auto'`): canvas → `reopening`, then the session is on the element at about
  the same time with no notice; already on the element → `element`; `canvas` setting, an MPEG-2 disc, shaders on, an
  element failure → `unavailable` with its reason; a later playlist on the same disc takes the element too; a new disc
  forgets it.
- Controller: `PlayerController.preferElement(): Promise<ElementPreferenceOutcome>` resolves with the next
  `elementPreference` event; `player-controller.test.ts`.

## Task 2: transport from the system's controls

- `packages/engine/src/controller/element-output.ts`: deps `presented?(): boolean` and
  `onTransport?(t: { kind: 'pause' } | { kind: 'play' } | { kind: 'seek'; timeUs: number })`; count own `play()`,
  `pause()` and `currentTime` writes; listen to `play`, `pause`, `seeking`. `VideoElementLike.addEventListener` gains
  those types.
- `player-controller.ts`: wires `presented` (standard PiP element, `webkitPresentationMode`, `webkitDisplayingFullscreen`)
  and `onTransport` to `togglePlay` / `seek`.
- Tests: `element-output.test.ts` with the fake video (own events ignored; foreign pause presented → `pause`; foreign
  play presented → element paused again and `play`; foreign seek presented → `seek` in playlist time; foreign pause
  not presented → playing again).

## Task 3: the presentation model and PiP UI

- `src/ui/video-presentation.ts` (+ test): `pipSupport`, `videoFullscreenSupport`, `isPresented`, `enterPip`,
  `exitPip`, `enterVideoFullscreen`, `exitVideoFullscreen`, `presentVideo` (the canvas-path flow with
  `ACTIVATION_MS`).
- `src/ui/capabilities.ts`: `pip`.
- `src/ui/ControlBar.tsx`: `onPictureInPicture`, `pipDisabledReason`; `PlayerScreen.tsx`: the flow, the notices
  (`pip-again`, `pip-overlays`), leaving on element stop and close.

## Task 4: native video fullscreen fallback

- `src/ui/fullscreen.ts`: kind `video`, `fullscreenKind(caps, flag)`; `?fullscreen=video` test-only; the hint hides
  when `video` is available; `PlayerScreen.tsx` uses the same flow as PiP and leaves on a menu.

## Task 5: E2E, device check, docs

- `tests/e2e/pip.spec.ts`.
- The owner's iPhone over the disc server (HTTPS, self-signed, safaridriver with `acceptInsecureCerts`).
- CLAUDE.md, `docs/known-issues.md`, `docs/roadmap.md`, `docs/playing-discs.md` / `troubleshooting.md`.
