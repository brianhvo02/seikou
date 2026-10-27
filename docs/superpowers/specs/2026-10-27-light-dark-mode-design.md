# Light and dark mode — Design Spec

Date: 2026-10-27
Status: done, 2026-10-27 (plan `docs/superpowers/plans/2026-10-27-light-dark-mode.md`).

## 1. Why

Seikou is dark everywhere today: the landing screen, the NAS screens and the help pages (`/help`), which the roadmap lists as an open owner decision ("help pages that are dark-only"). The owner wants a light look too, for all three moments they named: a bright room in the daytime, a phone that follows the system's light or dark setting, and reading the help pages.

Success: on a device set to light, Seikou outside the player is light without anyone touching anything; anyone can force light or dark from the top bar; the dark look is exactly what it is today.

## 2. Goals, non-goals, anti-goals

Goals:
- A light look for every screen outside the player (§4), and the help pages.
- A three-way switch, **Auto / Light / Dark**, in the top bar on every device, phones included (user). Auto follows the device's `prefers-color-scheme` (user).
- The light look is direction **A · Paper** from the mockups (user): a near-white ground with a faint blue cast, white cards, navy text, the laser blue darkened so it reads on white.

Non-goals:
- **The player stays dark** in both modes (user: considered a light player, then "let's keep it dark"): the black surround, the control bar, its menus (Audio, Subtitles, Quality, Shaders), notices, the on-screen remote and the pre-flight's overlays that sit on the player keep today's colours. Subtitles and disc menus are the disc's and never change.
- No new palette or new accent. The dark tokens keep their values.
- Posters, cover art and disc artwork are shown as they are.
- No per-person theme on the NAS: the choice belongs to the device (my call, the same as the shader set).

Anti-goals (the owner named none; these are mine):
- A flash of the wrong theme on load (dark, then light), or on navigating into help.
- Text or controls that fall below WCAG AA contrast in light (4.5:1 for text, 3:1 for control borders and focus rings), for example the dark mode's amber or light-blue text left on white.
- Any change to the dark look.

## 3. The switch and where the choice lives

- **Values:** `auto` (default for a new device), `light`, `dark`.
- **Where:** in the app bar (`.app-bar` in `LandingScreen.tsx`), beside Help, on the home screen and on every NAS screen that shows the bar; in the help pages' header (`.help-head`); anywhere else that shows the app bar's name and Help. Not in the player.
- **Look:** a compact segmented control, as in the mockup (Auto, Light, Dark). On a narrow screen it may shrink to icons (sun, moon, and a half disc for Auto) with accessible names; the builder picks the breakpoint. It is a radio group for assistive technology (`role="radiogroup"` or real radio inputs), operable by keyboard.
- **Storage:** this device only, in `localStorage` under a `bluray-web:` key (the storage prefix stays `bluray-web` on purpose, see CLAUDE.md). Every read and write is in `try`/`catch`; a missing or unreadable value means `auto`. Changes in another tab of the same origin follow through the `storage` event (my call).
- **Applying it:** the effective theme is set as `data-theme="light" | "dark"` on `<html>` before first paint, by a small inline script in `index.html` (and the help entry if it has its own HTML), so there is no flash. With `auto`, a `matchMedia('(prefers-color-scheme: light)')` listener keeps it current when the device switches. `color-scheme` follows (`light` or `dark`) so form controls, scrollbars and the browser's own UI match.
- **While a disc is open the whole page is dark** (my call): the player is a full screen of its own (`App.tsx` shows `PlayerScreen` in place of the landing screen), so the effective `data-theme`, `color-scheme` and `theme-color` go dark while it shows, whatever the switch says, and return to the switch's theme when the disc closes. This keeps a phone's browser bar, the safe areas and overscroll around the player dark, and the player's own rules need no separate scope. The switch's stored value doesn't change. Anything shown on both screens (the update prompt) takes the effective theme.
- **The service worker** serves the same `index.html`; nothing there changes. Offline works as before.

## 4. What turns light

Everything outside the player:
- The landing screen: app bar, disc hero, the folder picker and drop zone, Recent discs, the capability banner.
- NAS screens: pairing (code entry, QR, invites), the folder view, the title library (Continue watching, alphabet rail, title, series, season, music and artist screens), the pre-flight (resume prompt, level list, buffer-first ask; it is only ever shown from the landing and library screens, never over the player), the owner screens (admin, Unsorted, file differently, Hidden, relay settings, fansub panels, subtitle upload and list), the not-found screen.
- The help pages (`.help`, `--help-*` tokens).
- Dialogs and pop-overs that open from those screens (not from the player).

What stays as it is in light:
- The player (§2), and anything drawn over the playing video.
- The home screen disc's violet and cyan sheen, and the disc mark itself (my call: the mark is artwork).
- A QR code stays dark on white in both modes (it must scan).

## 5. The light palette

Light gets a second value for each of today's tokens on `:root` in `src/ui/styles.css`, under `[data-theme='light']`; the dark values stay where they are. The mockup's values are the starting point; the builder may tune any of them to meet the contrast bar in §2, and records the final values in the stylesheet's header comment:

| Token (today) | Role | Dark (today) | Light (start) |
| --- | --- | --- | --- |
| `--night` | page ground | `#0a1330` | `#f6f8fe` |
| `--night-deep` | sunken panels | `#070e26` | `#eef2fc` |
| `--deep`, `--deep-2` | cards, buttons | `#101c46`, `#18265a` | `#ffffff`, `#ffffff` |
| `--rim`, `--rim-strong` | borders | `#24356f`, `#3a4f96` | `#d5dcf0`, `#a9b5dc` |
| `--ice` | text | `#edf1ff` | `#0a1330` |
| `--mist` | secondary text | `#9eaad6` | `#4d5a86` |
| `--laser` | accent fills | `#5b8cff` | `#2f62e8` |
| `--laser-strong` | accent text and links | `#7ba3ff` | `#2453cf` |
| `--on-laser` | text on accent | `#06102e` | `#ffffff` |
| `--amber`, `--red`, `--green` | warning, error, success text | `#ffc861`, `#ff8f8f`, `#6fdc9a` | darker shades that pass 4.5:1 on `#f6f8fe` and on white (e.g. amber about `#9a6200`) |
| `--veil` | scrims | `rgba(10, 19, 48, 0.94)` | a light scrim, or kept dark where it covers video |

The token names describe the dark look (`--night`, `--ice`); renaming them to roles is left to the builder, as long as the dark values stay the same.

Hard-coded colours: `styles.css` has about 50 literal colours (`rgba(…)` tints such as the fansub marks, shadows, gradients). Each is either moved onto a token or given a light value; the player's stay as they are. The builder audits them all.

Images that assume a dark ground:
- The app bar shows the mark (`public/favicon.svg`, artwork, unchanged) beside "Seikou" as HTML text, which follows the tokens. `public/logo.svg` (white lettering) appears only in the README; it can stay as it is or get a navy-lettered twin behind `<picture>` with `prefers-color-scheme`, builder's choice. CLAUDE.md's "shown on the landing screen" for `logo.svg` is stale and is corrected with this work.
- `<meta name="theme-color">` (today `#0b0b0d`) becomes two tags with `media="(prefers-color-scheme: …)"`, and is updated by script when the switch forces a theme, so a phone's browser bar matches the page. The PWA manifest's `theme_color`/`background_color` stay dark (my call: a manifest has one value, and the app opens to whatever the device prefers within a moment).
- The TMDB logo on the admin screen, and any other third-party mark, must stay legible on white (TMDB publishes variants).

## 6. Tests and docs

- Unit: the theme store (default `auto`, read and write failures fall back to `auto`, the `storage` event, the effective theme from `auto` plus the media query, with an injected `matchMedia`).
- E2E (every project): a device in light (`page.emulateMedia({ colorScheme: 'light' })`) opens light with Auto; the switch forces dark and survives a reload; Light while the device is dark works; help follows; opening a disc in light mode makes `data-theme` and `theme-color` dark and the player looks as today (its control bar's computed background), and closing it returns to light; no flash, checked by reading `data-theme` on the first `DOMContentLoaded`.
- A contrast check over the light tokens (a unit test computing WCAG ratios for each text/ground pair the stylesheet uses) so a later tweak can't slip below the bar.
- Docs: `docs/getting-started.md` says how to switch; `docs/known-issues.md` and `docs/roadmap.md` drop "help pages that are dark-only"; CLAUDE.md's description of the look (`src/ui/styles.css`, colour tokens on `:root`) mentions the light values and `data-theme`.

## 7. Left to the builder

- The exact light values, within the contrast bar, and whether to rename tokens to roles.
- The switch's narrow-screen form and its icons.
- How the inline script and the React component share the storage key and logic (one small module imported by both, or a duplicated few lines with a test that they agree).
- The light `--veil` and shadows.
