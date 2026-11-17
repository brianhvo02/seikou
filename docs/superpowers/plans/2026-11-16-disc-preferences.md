# Disc Preferences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each person sets audio, subtitle and menu language, country and region once, on the NAS; every disc (and an encode's starting tracks) follows them from the next open.

**Architecture:** The person's existing NAS player settings (`server/src/player-settings-store.ts`, `GET`/`PUT /api/me/player-settings`) gain `discPreferences`. The page resolves Auto (`src/ui/disc-preferences.ts`), keeps a per-person device copy with a pending mark (`src/ui/disc-preferences-store.ts`), and sends the resolved settings to the engine with a new `setDiscPreferences` command; `Player` writes PSR16-20 for every disc when its registers are made. Encodes take pinned languages through the launch-settings applier.

**Tech Stack:** TypeScript (strict), React, Vitest (+ jsdom for components), Playwright, Node server.

**Spec:** `docs/superpowers/specs/2026-11-16-disc-preferences-design.md`

## Global Constraints

- New files: `// SPDX-License-Identifier: LGPL-3.0-or-later` header. `packages/engine/src/disc/player-settings.ts` stays `LGPL-2.1-or-later` (a libbluray port).
- Change `packages/engine/src/protocol.ts` first for anything crossing the worker boundary.
- Every export has a doc comment (`npx vitest run tests/documentation.test.ts`); no planning history (task numbers) in comments.
- A new public engine function needs an example (`packages/engine/examples/`, `@example` tag) and `public-api.txt` updated if it is exported from the package root; run `npm run devsite:model` before `npm test`.
- No user-agent sniffing. No real disc or series names anywhere.
- Auto for audio and subtitles sends no preference (PSR16/17 keep libbluray's 0xffffff); Auto menu language and country come from `navigator.language`; Auto region comes from the resolved country, `B` when unknown.
- PSR20 values: A = 1, B = 2, C = 4; written for every disc, UHD included.
- Region table: A = the Americas (all of North, Central and South America and the Caribbean), `jp`, `kr`, `kp`, `tw`, `hk`, and Southeast Asia (`bn`, `kh`, `id`, `la`, `my`, `mm`, `ph`, `sg`, `th`, `tl`, `vn`); C = `cn`, `ru`, `by`, `kz`, `kg`, `tj`, `tm`, `uz`, `mn`, `af`, `bd`, `bt`, `in`, `mv`, `np`, `pk`, `lk`; B = every other country.
- Storage keys: `bluray-web:disc-preferences:<pairingKey>#<personId>` while paired, `bluray-web:disc-preferences:local` with no pairing (existing `bluray-web:` prefix kept on purpose).
- A `PUT` body with only `nextEpisodeCountdown` stays valid on the new server and keeps the stored `discPreferences`.
- The BD-J replay and library check keep `HARNESS_SETTINGS` through `PlayerDeps.playerSettings`.

## Review Focus

1. A NAS that never answers (offline, WebRTC down): the menu still opens, edits save on the device, and the next disc gets them; covered in Task 4.
2. Two people on one device in turn: the second never gets the first's pins, even for a local folder opened before the NAS answers; Task 4.
3. An encode whose MKV tags languages as `fra`/`fr` while the pin is `fre`: the pin still matches; Task 5.
4. Changing a preference while a disc plays: nothing on screen changes, the menu says "Applies from the next disc you open", and the next open uses it; Task 3 and Task 6.
5. A malformed stored file or body on the NAS (a field of the wrong type, an unknown language code): read as Auto, never a 500; Task 1.

---

### Task 1: NAS settings carry `discPreferences`

**Files:**
- Modify: `packages/nas/src/nas-api.ts` (`PlayerSettings`, near line 767)
- Modify: `server/src/player-settings-store.ts`, `server/src/routes/player-settings.ts`
- Test: `server/src/player-settings-store.test.ts`, the route's test beside it (create if absent)

**Interfaces:**
- Produces (in `@seikou/nas`'s `nas-api.ts`, exported as `@internal`):
  ```ts
  export type LanguagePref = 'auto' | string;           // 'auto' or 3 lower-case letters
  export type CountryPref = 'auto' | string;            // 'auto' or 2 lower-case letters
  export type RegionPref = 'auto' | 'A' | 'B' | 'C';
  export interface DiscPreferences { readonly audioLanguage: LanguagePref; readonly subtitleLanguage: LanguagePref; readonly menuLanguage: LanguagePref; readonly country: CountryPref; readonly region: RegionPref }
  export interface PlayerSettings { readonly nextEpisodeCountdown: boolean; readonly discPreferences: DiscPreferences | null }
  export const AUTO_DISC_PREFERENCES: DiscPreferences;   // every field 'auto'
  export function parseDiscPreferences(v: unknown): DiscPreferences | null; // null unless an object; each bad field → 'auto'
  ```
- Server: `PlayerSettingsStore.get(personId): PlayerSettings` (`discPreferences: null` when never stored), `put(personId, body: PlayerSettingsBody)` where `PlayerSettingsBody = { nextEpisodeCountdown: boolean; discPreferences?: DiscPreferences }`; `isPlayerSettingsBody(v): v is PlayerSettingsBody` replaces `isPlayerSettings`.

- [ ] **Step 1: Write failing tests** in `server/src/player-settings-store.test.ts`:
  - `get` of a person with no file → `{ nextEpisodeCountdown: false, discPreferences: null }`.
  - `put(p, { nextEpisodeCountdown: true, discPreferences: { audioLanguage: 'jpn', subtitleLanguage: 'eng', menuLanguage: 'auto', country: 'us', region: 'A' } })` then `get` returns exactly that.
  - `put(p, { nextEpisodeCountdown: false })` after the above keeps `discPreferences` unchanged.
  - A stored file `{"nextEpisodeCountdown":true,"discPreferences":{"audioLanguage":7,"region":"Z","country":"USA"}}` reads as `discPreferences` `{ audioLanguage:'auto', subtitleLanguage:'auto', menuLanguage:'auto', country:'auto', region:'auto' }`.
  - `isPlayerSettingsBody`: accepts `{nextEpisodeCountdown:true}` and the full shape; rejects an extra top-level key, `discPreferences: null`, a language `'english'`, a country `'USA'`.
  - Route: `PUT` of the old shape answers 200 with the stored `discPreferences`; a body over 4096 bytes answers 413 as before.
- [ ] **Step 2: Run** `npx vitest run server/src/player-settings-store.test.ts` — Expected: FAIL (`discPreferences` undefined).
- [ ] **Step 3: Implement** the types and `parseDiscPreferences` in `nas-api.ts` (language `^[a-z]{3}$`, country `^[a-z]{2}$`), the store and the route. The `put` reads the current file to keep `discPreferences` when the body has none.
- [ ] **Step 4: Run** the tests — Expected: PASS. Also `npx vitest run tests/public-api.test.ts` (update `packages/nas/public-api.txt` only if a root consumer imports these).
- [ ] **Step 5: Commit** `feat(server): a person's player settings carry their disc preferences`.

### Task 2: Engine writes resolved settings for every disc, region included

**Files:**
- Modify: `packages/engine/src/protocol.ts` (beside `setVideoPath`, line ~405), `packages/engine/src/disc/player-settings.ts`, `packages/engine/src/player.ts` (`applyBdjSettings` ~line 1800, command switch ~line 791), `packages/engine/src/worker-main.ts` (line 99), `packages/engine/src/controller/player-controller.ts` (beside `setVideoPath`, line ~572)
- Test: `packages/engine/src/disc/player-settings.test.ts`, `packages/engine/src/player.test.ts`
- Example: `packages/engine/examples/player-controller.browser.ts` (`#setDiscPreferences` region)

**Interfaces:**
- `PlayerSettings` (engine) gains `readonly region?: 1 | 2 | 4` (PSR20); `applyPlayerSettings` writes it with `psrSettingWrite(PSR.REGION, region)`.
- Command: `{ readonly type: 'setDiscPreferences'; readonly settings: PlayerSettings }`.
- `PlayerController.setDiscPreferences(settings: PlayerSettings): void`.
- `Player` keeps `this.playerSettings` (initially `deps.playerSettings ?? {}`), replaced by the command, applied in `newProgramRegs` for every disc (rename `applyBdjSettings` → `applyPlayerSettingsTo(regs)`).
- `worker-main.ts` no longer passes `playerSettingsForLocale(navigator.language)`; `playerSettingsForLocale` stays exported (the page uses it).

- [ ] **Step 1: Failing tests:**
  - `player-settings.test.ts`: `applyPlayerSettings(regs, { region: 1 })` → `regs.psr(PSR.REGION) === 1`; `{}` leaves PSR20 at 2.
  - `player.test.ts` "writes the disc preferences for an HDMV disc at open": `setDiscPreferences({ audioLanguage: 'jpn', region: 4 })`, then open a disc with movie objects (the `nav` harness) → navigator registers PSR16 = `strToUint32('jpn',3)`, PSR20 = 4.
  - "applies a changed preference from the next open, not to the open disc": open, then `setDiscPreferences({ menuLanguage: 'fre' })` → PSR18 unchanged; close and open again → PSR18 = `strToUint32('fre',3)`.
  - "an empty preference leaves the register at its default": `setDiscPreferences({})` → PSR16 = 0xffffff.
  - BD-J disc (existing BD-J harness in `player.test.ts`): PSR16 written from the command.
- [ ] **Step 2: Run** `npx vitest run packages/engine/src/player.test.ts -t "preference"` — Expected: FAIL.
- [ ] **Step 3: Implement** (protocol first). `reduceEvent` needs nothing.
- [ ] **Step 4: Run** the two test files, then `npx vitest run tests/bdj tests/vm-trace` — Expected: PASS, no golden changes.
- [ ] **Step 5: Commit** `feat(engine): disc preferences from the page, written for every disc with the region`.

### Task 3: Resolving Auto on the page

**Files:**
- Create: `src/ui/disc-preferences.ts`, `src/ui/disc-preferences.test.ts`

**Interfaces:**
- Consumes: `DiscPreferences`, `AUTO_DISC_PREFERENCES` (Task 1); engine `PlayerSettings` with `region` (Task 2); `playerSettingsForLocale` from `@seikou/engine/disc/player-settings`.
- Produces:
  ```ts
  export function resolveDiscPreferences(p: DiscPreferences, locale: string | undefined): PlayerSettings;
  export function regionForCountry(country: string | undefined): 1 | 2 | 4;
  export interface AutoLabels { audio: string; subtitle: string; menu: string; country: string; region: 'A' | 'B' | 'C' }
  export function autoLabels(locale: string | undefined, displayLocale: string): AutoLabels; // "disc's choice", "English", "United States", "A"
  export const PREFERENCE_LANGUAGES: readonly string[]; // the 64 ISO 639-2/B codes of player-settings.ts, sorted by display name at use
  export function languageMatches(tag: string | null | undefined, pin: string): boolean; // /B, /T and BCP 47 forms
  ```
  `ISO_639_2` in `player-settings.ts` gets exported (as `ISO_639_1_TO_2B`) for the list and the matcher; the matcher also knows the /B↔/T pairs (`fre/fra, ger/deu, chi/zho, cze/ces, dut/nld, gre/ell, ice/isl, per/fas, rum/ron, slo/slk, wel/cym, alb/sqi, arm/hye, baq/eus, bur/mya, geo/kat, mac/mkd, may/msa`).

- [ ] **Step 1: Failing tests:**
  - All Auto, locale `en-US` → `{ menuLanguage: 'eng', country: 'us', region: 1 }` (no `audioLanguage`, no `pgLanguage` keys).
  - Pins `{ audioLanguage:'jpn', subtitleLanguage:'eng', menuLanguage:'auto', country:'jp', region:'auto' }`, locale `fr-FR` → `{ audioLanguage:'jpn', pgLanguage:'eng', menuLanguage:'fre', country:'jp', region:1 }`.
  - Locale `de` (no region), all Auto → `{ menuLanguage:'ger', region:2 }`, no `country`.
  - Pinned region `'C'` with country `us` → region 4.
  - `regionForCountry`: `us`→1, `br`→1, `jp`→1, `sg`→1, `gb`→2, `au`→2, `za`→2, `cn`→4, `ru`→4, `in`→4, `undefined`→2, `zz`→2.
  - `languageMatches('fra','fre')`, `('fr','fre')`, `('fr-CA','fre')`, `('fre','fre')` true; `('eng','fre')`, `(null,'fre')` false.
  - `autoLabels('en-US','en')` → `{ audio:"disc's choice", subtitle:"disc's choice", menu:'English', country:'United States', region:'A' }`.
- [ ] **Step 2: Run** `npx vitest run src/ui/disc-preferences.test.ts` — FAIL.
- [ ] **Step 3: Implement** with `Intl.DisplayNames` for names.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(ui): disc preferences resolve Auto from the disc, the browser and the country`.

### Task 4: The person's copy, the device copy, and keeping the engine told

**Files:**
- Create: `src/ui/disc-preferences-store.ts`, `src/ui/disc-preferences-store.test.ts`
- Modify: `src/ui/nas/nas-client.ts` (`playerSettings`/`putPlayerSettings` types), `src/ui/App.tsx` (send at load, beside `setVideoPath` line 59), `src/ui/PlayerScreen.tsx` (the countdown's `putPlayerSettings` call ~line 289 sends only `nextEpisodeCountdown`)

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces:
  ```ts
  export interface DiscPreferencesDeps {
    storage: Pick<Storage, 'getItem' | 'setItem'> | null;          // localStorage, try/catch inside
    scope(): string;                                                 // 'local' or `${pairingKey}#${personId}`
    nas: { get(): Promise<PlayerSettings>; put(body: { nextEpisodeCountdown: boolean; discPreferences: DiscPreferences }): Promise<PlayerSettings> } | null;
    send(settings: EnginePlayerSettings): void;                     // controller.setDiscPreferences
    locale(): string | undefined;
  }
  export type NasState = 'synced' | 'pending' | 'device-only' | 'unpaired';
  export class DiscPreferencesStore {
    constructor(deps: DiscPreferencesDeps);
    current(): DiscPreferences;
    state(): NasState;                    // 'device-only' when the NAS's GET answered without a discPreferences key
    subscribe(fn: () => void): () => void; // for useSyncExternalStore
    load(): Promise<void>;               // device copy for the scope at once (send), then the NAS
    set(p: DiscPreferences): Promise<void>; // device copy + pending, send, then put
    rescope(): Promise<void>;            // pairing or person changed: load the new scope's copy
  }
  ```
  The device record is `{ prefs: DiscPreferences, pending: boolean }`. A scope with no record starts from the `local` record (else Auto).

- [ ] **Step 1: Failing tests** (fake storage, fake NAS):
  - "sends the device copy at once, before the NAS answers": record `{prefs:{audioLanguage:'jpn',...auto}, pending:false}`; NAS `get` never resolves → `send` called once with `audioLanguage:'jpn'`.
  - "the NAS's copy wins when nothing is pending": device jpn, NAS answers eng → `current().audioLanguage === 'eng'`, `send` called with eng, record updated.
  - "a pending edit wins over the NAS and is put again": record pending jpn, NAS answers eng → `put` called with jpn, `current()` jpn; after `put` resolves, record `pending:false`.
  - "a NAS that never saved any gets the device copy": NAS answers `discPreferences: null` → `put` with the device copy.
  - "an older NAS keeps them on the device": NAS answers `{ nextEpisodeCountdown:true }` (no key) → `state() === 'device-only'`, `set(...)` never calls `put`.
  - "an edit with the NAS down stays pending": `put` rejects → record `pending:true`, `state() === 'pending'`.
  - "another person on the device never gets the first's pins": scope A record jpn; `rescope()` to scope B with no record and an unreachable NAS → `send` with Auto audio (from the `local` record, which is Auto).
  - "storage that throws": `getItem` throws → Auto, no crash.
- [ ] **Step 2: Run** `npx vitest run src/ui/disc-preferences-store.test.ts` — FAIL.
- [ ] **Step 3: Implement**; wire one shared store in `App.tsx` (`load()` before the first open; `rescope()` when `NasStore`'s pairing changes or `NasClient.me()` reports a new person). Keep the countdown's `PUT` sending only `nextEpisodeCountdown` so it works on both servers.
- [ ] **Step 4: Run** the store tests and `npx vitest run src/ui/PlayerScreen.test.tsx src/ui/nas/nas-client.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(ui): disc preferences follow the person, with a device copy for offline and older NAS servers`.

### Task 5: Encodes start on the pinned languages

**Files:**
- Modify: `src/ui/place-apply.ts` (`LaunchSettingsApplier`), `src/ui/place-model.ts`
- Test: `src/ui/place-apply.test.ts`, `src/ui/place-model.test.ts`

**Interfaces:**
- Consumes: `DiscPreferences`, `languageMatches` (Task 3); the store's `current()` (Task 4) passed into the applier's deps as `discPreferences(): DiscPreferences`.
- Produces: `export function settingsForPins(tracks: readonly AudioTrack[], subtitleTracks: { pg: readonly PgTrack[]; text: readonly { index: number; language: string | null }[] }, prefs: DiscPreferences): { audio: number | null; subtitle: { kind: 'pg' | 'text'; index: number } | null }` in `place-model.ts`.

- [ ] **Step 1: Failing tests:**
  - `settingsForPins`: audio tracks `[jpn, eng]`, pin audio `eng` → audio index of eng; pin `fre`, tracks tagged `fra` → that track; no match → `null`.
  - Subtitle pin `eng` with an MKV text track `en` → `{kind:'text', index}`; only a PG track `eng` → `{kind:'pg'}`; none → `null`.
  - Applier: a fresh encode open (no resumed place, not Up next) with pins applies them; a resume with its own audio choice keeps the place's; an Up next launch keeps its carried language; all Auto changes nothing.
- [ ] **Step 2: Run** `npx vitest run src/ui/place-model.test.ts src/ui/place-apply.test.ts` — FAIL.
- [ ] **Step 3: Implement**: in the applier, only when `s.encodeId !== null`, no place was resumed and `!launch.byLanguage`; a subtitle pin also turns text on (text track) or PG on (PG track).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(ui): an encode starts on the person's pinned audio and subtitle languages`.

### Task 6: The menus, the landing screen, docs

**Files:**
- Create: `src/ui/DiscPreferencesGroup.tsx`, `src/ui/DiscPreferencesGroup.test.tsx` (`// @vitest-environment jsdom`)
- Modify: `src/ui/EncodeMenus.tsx` (`EncodeSettingsMenu` → shared Settings menu shown for discs too), `src/ui/ControlBar.tsx`, `src/ui/LandingScreen.tsx` (a Settings button beside `ThemeSwitch` opening the group), `docs/playing-discs.md`, `docs/known-issues.md` (rewrite "Player settings come from the browser's locale"), `docs/roadmap.md` (remove the item; add "Lossless and multichannel audio" note: deferred by the owner 2026-11-16), `CLAUDE.md` (the main-thread paragraph: preferences flow)
- Test: `tests/e2e/disc-preferences.spec.ts`

**Interfaces:**
- Consumes: the store (Task 4), `autoLabels`, `PREFERENCE_LANGUAGES` (Task 3).
- `DiscPreferencesGroup({ store, kind: 'disc' | 'encode' | 'home' })`: five `<select>`s (`data-testid` `pref-audio`, `pref-subtitle`, `pref-menu`, `pref-country`, `pref-region`; on `'encode'` only the first two), each first option `Auto (<autoLabel>)`; a line "Applies from the next disc you open." (`kind !== 'encode'`; on encode "Applies from the next episode you open."); when `state()` is `'device-only'`: "Saved on this device until the NAS is updated."

- [ ] **Step 1: Failing tests:**
  - Component: renders five selects for `'disc'`, two for `'encode'`; first option text `Auto (disc's choice)` for audio; choosing `jpn` calls `store.set` with `audioLanguage:'jpn'`; `'device-only'` shows the device-only line.
  - E2E (`chromium`, `firefox`, `webkit`; first confirm disc3's start-up stream choice reads PSR16 through `newProgramRegs` — if a disc without movie objects picks its audio elsewhere, make that path read the preferences too, as libbluray's stream selection does for every title): open `fixtures/synthetic/disc3` (audio jpn first, eng second) → the selected audio track is the Japanese one; on the landing screen set Audio language to English; open disc3 again → the selected track is English; reload the page → the select still shows English (device copy). With the NAS stand-in (run by full path pattern like `nas.spec.ts`, or skip if the NAS stand-in setup is too heavy here and cover persistence in Task 4's unit tests): a second paired device of the same person gets English.
- [ ] **Step 2: Run** `npx vitest run src/ui/DiscPreferencesGroup.test.tsx` and `npx playwright test disc-preferences --project=chromium` — FAIL.
- [ ] **Step 3: Implement**; help page text in `docs/playing-discs.md` ("Disc preferences": what each does, what Auto means, region, applies from the next disc).
- [ ] **Step 4: Run** `npm run devsite:model && npm run typecheck && npm test` and `npx playwright test disc-preferences element-path bdj-menu` — PASS.
- [ ] **Step 5: Commit** `feat(ui): Disc preferences in the player's Settings menu and on the start screen`.
