# Light and Dark Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A light look for every screen outside the player and for the help pages, chosen by an Auto / Light / Dark switch in the top bar, with the player (and the whole page while a disc is open) staying dark.

**Architecture:** One small framework-free module (`src/ui/theme.ts`) owns the choice (localStorage), the effective theme (choice + `prefers-color-scheme` + "a disc is open") and applying it to `<html>` (`data-theme`, `color-scheme`, `theme-color`). An inline script in `index.html` repeats the few lines that apply it before first paint. `styles.css` keeps today's tokens as the dark values and adds a `:root[data-theme='light']` block. A `ThemeSwitch` component sits in the app bar and the help header.

**Tech Stack:** React 19, TypeScript (strict), plain CSS custom properties, Vitest (+ jsdom for components), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-27-light-dark-mode-design.md`

## Global Constraints

- Values: `auto` (default for a new device), `light`, `dark`. Storage: this device only, `localStorage` key `bluray-web:theme`; every read and write in `try`/`catch`; a missing, unreadable or unknown value means `auto`.
- The effective theme is `dark` whenever a disc is open (`snapshot.playlists.length > 0` in `App.tsx`), whatever the switch says; the stored choice doesn't change.
- Applied as `data-theme="light" | "dark"` on `<html>`, before first paint; `color-scheme` follows; `<meta name="theme-color">` follows (dark `#0a1330`, light `#f6f8fe`).
- The dark look is unchanged: every dark token keeps today's value; the player's rules are not edited.
- Contrast in light: text ≥ 4.5:1, control borders and focus rings ≥ 3:1 (WCAG AA).
- Not themed: the player and anything over the video, the home disc's sheen and the disc mark (`favicon.svg`), posters and cover art, QR codes (dark on white in both).
- The PWA manifest's `theme_color`/`background_color` stay dark.
- Repo rules: no user-agent sniffing; `src/ui` only (nothing in `src/engine`); no real titles in tests (use Starfall Wanderer and the like).

## Review Focus

1. **Storage that throws** (Safari private mode, blocked site data): the page opens in Auto, the switch still changes the theme for the session, nothing logs an uncaught error. → Task 1 `falls back to auto when storage throws` and `a choice still applies when storage refuses the write`.
2. **The device flips light/dark while the app is open:** on Auto the page follows at once; on Light or Dark it doesn't move. → Task 1 `follows the media query only on auto`; Task 5 E2E `Auto follows the device while open`.
3. **A disc opened and closed in light mode:** dark while it plays, light again after it closes, and the switch still says Light. → Task 5 E2E `a disc is dark in light mode and light returns when it closes`.
4. **Two tabs of the app:** changing the switch in one changes the other. → Task 1 `follows another tab through the storage event`.
5. **A stored value from nowhere** (`"sepia"`, `""`): treated as Auto. → Task 1 `reads an unknown value as auto`.

---

### Task 1: Theme module

**Files:**
- Create: `src/ui/theme.ts`
- Test: `src/ui/theme.test.ts`

**Interfaces:**
- Produces:
  - `type ThemeChoice = 'auto' | 'light' | 'dark'`, `type EffectiveTheme = 'light' | 'dark'`
  - `const THEME_KEY = 'bluray-web:theme'`
  - `const THEME_COLORS: Readonly<Record<EffectiveTheme, string>> = { light: '#f6f8fe', dark: '#0a1330' }`
  - `function readThemeChoice(storage: Pick<Storage, 'getItem'> | null): ThemeChoice`
  - `function effectiveTheme(choice: ThemeChoice, prefersLight: boolean, discOpen: boolean): EffectiveTheme`
  - `function applyTheme(doc: Document, theme: EffectiveTheme): void`: sets `doc.documentElement.dataset.theme`, `doc.documentElement.style.colorScheme`, and the `content` of every `meta[name="theme-color"]` to `THEME_COLORS[theme]`.
  - `interface ThemeDeps { readonly storage: () => Storage | null; readonly matchMedia: (query: string) => MediaQueryList; readonly target: Pick<Window, 'addEventListener' | 'removeEventListener'>; readonly doc: Document }`
  - `class ThemeController { constructor(deps: ThemeDeps); subscribe(listener: () => void): () => void; getSnapshot(): { readonly choice: ThemeChoice; readonly effective: EffectiveTheme }; setChoice(choice: ThemeChoice): void; setDiscOpen(open: boolean): void; dispose(): void }`. It applies the effective theme on every change, and listens to `(prefers-color-scheme: light)` changes and the window's `storage` event for `THEME_KEY`. `subscribe`/`getSnapshot` are arrow properties (bound), and `getSnapshot` returns the same object until something changes, for `useSyncExternalStore`.
  - `function themeController(): ThemeController`: the shared instance over `window`, `document` and `localStorage` (created on first call; `storage` wraps `localStorage` access in `try`/`catch`).

- [ ] **Step 1: Write the failing tests** (`// @vitest-environment jsdom`)

```ts
it('reads an unknown value as auto', () => {
  for (const v of [null, '', 'sepia']) expect(readThemeChoice({ getItem: () => v })).toBe('auto');
  expect(readThemeChoice({ getItem: () => 'light' })).toBe('light');
});
it('falls back to auto when storage throws', () => {
  expect(readThemeChoice({ getItem: () => { throw new Error('denied'); } })).toBe('auto');
  expect(readThemeChoice(null)).toBe('auto');
});
it('derives the effective theme', () => {
  expect(effectiveTheme('auto', true, false)).toBe('light');
  expect(effectiveTheme('auto', false, false)).toBe('dark');
  expect(effectiveTheme('light', false, false)).toBe('light');
  expect(effectiveTheme('dark', true, false)).toBe('dark');
  expect(effectiveTheme('light', true, true)).toBe('dark'); // a disc is open
});
it('applies data-theme, color-scheme and theme-color', () => {
  document.head.innerHTML = '<meta name="theme-color" media="(prefers-color-scheme: light)"><meta name="theme-color" media="(prefers-color-scheme: dark)">';
  applyTheme(document, 'light');
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(document.documentElement.style.colorScheme).toBe('light');
  expect([...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content'))).toEqual(['#f6f8fe', '#f6f8fe']);
});
it('follows the media query only on auto', () => { /* fake MediaQueryList with a settable matches and a dispatched 'change'; choice auto: effective flips; after setChoice('dark'): a flip leaves it dark */ });
it('stores the choice and keeps it while a disc is open', () => { /* setChoice('light'); setDiscOpen(true) → effective dark, choice light, storage holds 'light'; setDiscOpen(false) → light */ });
it('a choice still applies when storage refuses the write', () => { /* storage whose setItem throws: setChoice('light') → getSnapshot().effective === 'light', no throw */ });
it('follows another tab through the storage event', () => { /* dispatch a StorageEvent { key: THEME_KEY, newValue: 'dark' } on target → choice dark; a different key changes nothing */ });
it('notifies subscribers and keeps the snapshot stable between changes', () => { /* same object from two getSnapshot calls; a listener runs once per change; dispose removes the listeners */ });
```

- [ ] **Step 2: Run** `npx vitest run src/ui/theme.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `src/ui/theme.ts`** to the interfaces above. `setChoice` writes `THEME_KEY` in `try`/`catch` and updates state even when the write fails.
- [ ] **Step 4: Run** `npx vitest run src/ui/theme.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the theme module: choice, effective theme, applying it`

### Task 2: Before first paint

**Files:**
- Modify: `index.html` (head)
- Test: `src/ui/theme-boot.test.ts`

**Interfaces:**
- Consumes: `THEME_KEY`, `THEME_COLORS`, `effectiveTheme` from Task 1 (the test checks the script against them).

- [ ] **Step 1: Write the failing test** (`// @vitest-environment jsdom`): read `index.html` from disk, take the text of the `<script>` with `id="theme-boot"`, and for every combination of stored value (`null`, `'auto'`, `'light'`, `'dark'`, `'sepia'`, a `localStorage` getter that throws) × `prefersLight` (true, false), run it with `new Function('window', 'document', 'localStorage', text)` against a fresh jsdom document carrying the two theme-color metas and a stub `window.matchMedia`. Assert `documentElement.dataset.theme === effectiveTheme(readThemeChoice(...), prefersLight, false)`, `style.colorScheme` the same, and both metas' `content === THEME_COLORS[theme]`. Also assert the head has exactly two `meta[name="theme-color"]`, with `media="(prefers-color-scheme: light)"` and `content="#f6f8fe"`, and `media="(prefers-color-scheme: dark)"` and `content="#0a1330"`.
- [ ] **Step 2: Run** `npx vitest run src/ui/theme-boot.test.ts`. Expected: FAIL (no `#theme-boot`).
- [ ] **Step 3: Edit `index.html`:** replace `<meta name="theme-color" content="#0b0b0d" />` with the two media metas above, and add, in the head before the stylesheet and module script, a classic inline `<script id="theme-boot">` (no `type="module"`, no imports; about ten lines) that reads `localStorage.getItem('bluray-web:theme')` in `try`/`catch`, resolves Auto with `matchMedia('(prefers-color-scheme: light)').matches`, and sets `data-theme`, `style.colorScheme` and both metas' `content`. Comment it as a copy of `effectiveTheme`/`applyTheme` in `src/ui/theme.ts`, kept in step by this test.
- [ ] **Step 4: Run** `npx vitest run src/ui/theme-boot.test.ts` and `npm run build` (Vite keeps an inline classic script as it is). Expected: PASS, and `dist/index.html` contains `id="theme-boot"`.
- [ ] **Step 5: Commit** `feat(ui): apply the theme before first paint`

### Task 3: The light palette

**Files:**
- Modify: `src/ui/styles.css` (header comment, `:root`, the literal colours listed below, the `.help` block)
- Test: `src/ui/theme-contrast.test.ts`

**Interfaces:**
- Consumes: the `data-theme` attribute from Tasks 1–2.
- Produces: new tokens (dark value = today's literal; each gets a light value): `--hover` (`#1f2f6b`, line 61), `--placeholder` (`#6f7cab`, lines 70 and 221), `--error-bg` / `--error-rim` (`#3a1530` / `#7a2a4a`, line 120), `--selected` (`#172a6e`, line 372), `--notice-bg` (`#12225c`, line 388), `--hairline` (`rgba(237, 241, 255, 0.06)`, lines 246, 269, 331, and 0.12 at 105 if the builder keeps one token with a stronger variant `--hairline-strong`), `--track` (`rgba(237, 241, 255, 0.16)`, line 335), `--glass` (`rgba(7, 14, 38, 0.6)` / `0.8`, lines 279 and 296), `--poster-fg` (`#7584bd`, line 290), and the `.drop-zone` grounds (lines 97 and 523). Lines 102–104 (the disc's sheen), 228 (the test-only touch log), 558 (the player's badges) and every rule from `.player` (line 403) through the control bar and its menus stay literal and untouched. The fansub marks' tints (lines 620–622) and `.tosho-badge` (480) get light values that keep their text at 4.5:1.

- [ ] **Step 1: Write the failing test** (Node): parse `styles.css`; collect the custom properties of the `:root { … }` block (dark) and of `:root[data-theme='light'] { … }` (light). Assert:
  - The dark values of the spec's tokens equal today's: `--night #0a1330`, `--night-deep #070e26`, `--deep #101c46`, `--deep-2 #18265a`, `--rim #24356f`, `--rim-strong #3a4f96`, `--ice #edf1ff`, `--mist #9eaad6`, `--laser #5b8cff`, `--laser-strong #7ba3ff`, `--on-laser #06102e`, `--amber #ffc861`, `--red #ff8f8f`, `--green #6fdc9a`.
  - The light block defines every token the dark block defines that the stylesheet uses outside the player (all of the above plus Task 3's new tokens and the `--help-*` ones), and sets `color-scheme: light`.
  - WCAG contrast (relative luminance, sRGB) in light, for each ground in `--night`, `--night-deep`, `--deep`, `--deep-2`: `--ice`, `--mist`, `--laser-strong`, `--amber`, `--red`, `--green`, `--placeholder` ≥ 4.5; `--rim-strong` and `--laser` ≥ 3; and `--on-laser` on `--laser` ≥ 4.5.
- [ ] **Step 2: Run** `npx vitest run src/ui/theme-contrast.test.ts`. Expected: FAIL (no light block).
- [ ] **Step 3: Edit `styles.css`:**
  - Move the literals listed under Interfaces onto the new tokens (dark values unchanged).
  - Add `:root[data-theme='light'] { … }` after `:root`, starting from the spec §5 table (`--night #f6f8fe`, `--night-deep #eef2fc`, `--deep`/`--deep-2 #ffffff`, `--rim #d5dcf0`, `--rim-strong #a9b5dc`, `--ice #0a1330`, `--mist #4d5a86`, `--laser #2f62e8`, `--laser-strong #2453cf`, `--on-laser #ffffff`, amber about `#9a6200`, darker red and green, a light `--veil`), with `color-scheme: light`, and tune any value the test rejects.
  - In `.help`, drop the literal `color-scheme: dark` (the root now sets it); its `--help-*` tokens already point at the root tokens.
  - Update the header comment: the dark values are the logo's navy; light is "Paper", set by `data-theme` on `<html>` (`src/ui/theme.ts`); the player stays dark.
- [ ] **Step 4: Run** `npx vitest run src/ui/theme-contrast.test.ts`. Expected: PASS. Then `npm run dev`, set `data-theme="light"` on `<html>` from the console, and look at home, a NAS screen with the stand-in (`npm run server:dev`), admin (the TMDB logo must read on white), pairing (QR dark on white) and `/help`; fix anything still dark-on-dark.
- [ ] **Step 5: Commit** `feat(ui): a light palette ("Paper") beside the dark one`

### Task 4: The switch, in the app bar and the help header

**Files:**
- Create: `src/ui/ThemeSwitch.tsx`
- Test: `src/ui/ThemeSwitch.test.tsx`
- Modify: `src/ui/App.tsx` (create the controller, `setDiscOpen`), `src/ui/LandingScreen.tsx:511` (beside Help), `src/ui/help/HelpScreen.tsx:53-57` (in `.help-head`), `src/ui/styles.css` (`.theme-switch`, the `.app-bar` grid areas, `.help-head` as a row)

**Interfaces:**
- Consumes: `themeController()`, `ThemeChoice` (Task 1).
- Produces: `function ThemeSwitch({ theme }: { readonly theme: ThemeController }): ReactElement`, rendering `<fieldset className="theme-switch" data-testid="theme-switch">` with a visually hidden `<legend>Theme</legend>` and three radio inputs (`name="theme"`, `data-testid="theme-auto" | "theme-light" | "theme-dark"`) labelled Auto, Light, Dark; under 600 px wide the labels become icons (sun, moon, half disc) with the words kept as accessible names.

- [ ] **Step 1: Write the failing test** (`// @vitest-environment jsdom`, `@testing-library/react`): with a `ThemeController` over fakes, the radio matching `getSnapshot().choice` is checked; clicking `theme-light` calls through so `getSnapshot().choice === 'light'` and the Light radio is checked; arrow keys move between the radios (native radio-group behaviour, so assert the inputs share `name="theme"`); the group's accessible name is "Theme".
- [ ] **Step 2: Run** `npx vitest run src/ui/ThemeSwitch.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement `ThemeSwitch`** reading the controller with `useSyncExternalStore`. In `App.tsx`, take `themeController()` once and call `theme.setDiscOpen(snapshot.playlists.length > 0)` in an effect on that value; pass the controller to `LandingScreen` and `HelpScreen` (new prop `theme: ThemeController`) and render `<ThemeSwitch>` before Help in the app bar and after the home link in `.help-head`. Not in `PlayerScreen`.
- [ ] **Step 4: Run** `npx vitest run src/ui` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the Auto / Light / Dark switch in the top bar and on the help pages`

### Task 5: End-to-end

**Files:**
- Create: `tests/e2e/theme.spec.ts`
- Modify: `playwright.config.ts:48` (add `theme` to the `mobile-chromium` `testMatch`)

**Interfaces:**
- Consumes: test ids `theme-switch`, `theme-auto`, `theme-light`, `theme-dark` (Task 4); `setFolder` and `skipWithoutH264({ realtime: false })` from `tests/e2e/support.ts`; disc `fixtures/synthetic/disc1`.

- [ ] **Step 1: Write the tests** (every project):
  - `opens light on a light device with Auto, with no dark first`: `page.emulateMedia({ colorScheme: 'light' })`; before `goto`, `page.addInitScript` records `document.documentElement.dataset.theme` at `DOMContentLoaded` into `window.__themeAtLoad`; after load both it and the live value are `light`, `theme-auto` is checked, and `meta[name="theme-color"]` contents are `#f6f8fe`.
  - `Dark survives a reload, and Light works on a dark device`: dark device; click `theme-light` → `light`; reload → still `light`; click `theme-dark` with a light device → `dark`.
  - `Auto follows the device while open`: Auto; `emulateMedia` light → `light`; dark → `dark`; with `theme-light` checked, `emulateMedia` dark leaves `light`.
  - `help follows the theme and has the switch`: light chosen; `goto('/help/nas')`; `data-theme` is `light` and `theme-switch` is visible in the help header.
  - `a disc is dark in light mode and light returns when it closes`: light chosen; open `disc1` with `setFolder`; wait for the player; `data-theme` is `dark`, theme-color `#0a1330`, `theme-switch` is not visible; close the disc (the player's close or back control, as in `playback.spec.ts`) → `data-theme` is `light` and `theme-light` is checked.
- [ ] **Step 2: Run** `npm run build && npx playwright test theme --project=chromium` and the other three projects (`E2E_PORT=<free port>` if another checkout uses 4173). Expected: PASS on all four.
- [ ] **Step 3: Commit** `test(e2e): light and dark mode`

### Task 6: Docs

**Files:**
- Modify: `docs/getting-started.md`, `docs/known-issues.md`, `docs/roadmap.md`, `CLAUDE.md`, the spec's status line.

- [ ] **Step 1: Edit:**
  - `docs/getting-started.md`: a short paragraph: the switch in the top bar (Auto follows the device, Light, Dark), kept per device, the player always dark.
  - `docs/roadmap.md`: remove the "Open owner decision: help pages that are dark-only" row.
  - `docs/known-issues.md`: anything that says the help pages are dark-only.
  - `CLAUDE.md`: in the paragraph on the look, the dark values on `:root` with the light ones under `:root[data-theme='light']`, `src/ui/theme.ts` (and the inline `#theme-boot` copy in `index.html`), dark while a disc is open; and correct "`public/logo.svg` … shown on the landing screen and the README" to "the README" (the app bar shows `favicon.svg` beside the name as text).
  - The spec: `Status: done, <date>`.
- [ ] **Step 2: Run** `npm test` and `npm run typecheck`. Expected: PASS (the help pages are built from `docs/*.md`).
- [ ] **Step 3: Commit** `docs: light and dark mode`
