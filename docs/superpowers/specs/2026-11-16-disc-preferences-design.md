# Disc preferences: languages, country and region per person

Status: design, approved approach 2026-11-16. Roadmap item "Player settings screen" (`docs/roadmap.md`, Next).

## Why

A disc chooses its starting audio, subtitles and menu language from the player's settings (PSR16-19), and checks
the player's region (PSR20) in its First Play. Today Seikou sets these only from the browser's language
(`playerSettingsForLocale(navigator.language)` in `packages/engine/src/worker-main.ts`), only on discs whose index names
a BD-J object (`applyBdjSettings` in `player.ts`), and never lets the viewer change them; the region is libbluray's
default B for every disc. The owner has discs that open in the wrong language or with the wrong tracks (which ones is
not recorded). They want to choose these themselves, once, as a person: the same on every device they are paired on.

## Goals

- A viewer can set five disc preferences: audio language, subtitle language, menu language, country and region.
- The preferences belong to the person on the NAS and follow them to each of their paired devices.
- Every disc gets them, HDMV and BD-J alike, from the next disc open.
- **Auto** (the default for each) leaves the disc to decide wherever the disc has its own choice:
  - audio and subtitles: no preference is written, so the PSR keeps libbluray's "none" (0xffffff) and the disc starts
    as its makers set it (owner's choice A, 2026-11-16: an anime disc with an English dub must not start dubbed because
    the browser is English);
  - menu language: the browser's language (`playerSettingsForLocale`), since a menu has no "original" to fall back on;
  - country: the browser's region;
  - region: derived from the country (below), B when the country is unknown.
- A pinned value overrides Auto for that preference only.
- Encodes too (owner, 2026-11-16): a pinned audio or subtitle language picks an encode's starting track where the MKV
  has a track in that language; Auto keeps the tracks the MKV marks as default. Menu language, country and region
  have no meaning for an MKV.

## Non-goals

- Changing tracks while a disc plays: the Audio and Subtitles menus already do that, and a place's own track choice
  (resume, `place-apply.ts`) keeps winning over these defaults when a disc is resumed.
- Subtitles on or off: whether a disc shows subtitles stays the disc's call (PSR2's display flag); the preference is
  only the language it prefers.
- Parental level, audio output capability (PSR15) and other player settings libbluray has.
- Lossless or multichannel audio (deferred by the owner).

## Anti-goals

- A preference change that silently does nothing on a disc already open, with no word: the menu says it applies from
  the next disc.
- Losing the Next episode countdown setting, or failing to save anything, on a NAS that still runs the older server.
- Different behaviour on discs nobody changed a setting for, beyond the two changes stated below.

## Behaviour changes for someone who never opens the settings

1. BD-J discs no longer get the browser's language as their audio and subtitle preference (Auto now means the disc's
   default). Their menu language and country stay as today.
2. HDMV discs now get the menu language and country from the browser (today: none), and every disc gets a region
   from the browser's country instead of always B. A region-A or region-C disc that refused to play now plays.

`docs/known-issues.md`'s entry "Player settings come from the browser's locale" is rewritten to match.

## Approaches considered

- **Chosen: extend the person's existing player settings on the NAS.** `server/src/player-settings-store.ts` already
  keeps one small JSON file per person (`nextEpisodeCountdown`), served at `GET`/`PUT /api/me/player-settings` and
  read by `NasClient.playerSettings()`. The disc preferences become more fields of it.
- Per device only (localStorage): rejected, the owner wants them per person.
- A second per-person file on the NAS for disc preferences: rejected, it would duplicate the store, the routes and the
  checks for no gain.
- In each disc's place: rejected, a place is per disc; these are the person's defaults for every disc.

## Design

### Data

```ts
type LanguagePref = 'auto' | string;   // 'auto' or ISO 639-2/B letters ('jpn', 'eng', 'fre')
type CountryPref = 'auto' | string;    // 'auto' or ISO 3166-1 alpha-2, lower case ('us', 'jp')
type RegionPref = 'auto' | 'A' | 'B' | 'C';
interface DiscPreferences {
  audioLanguage: LanguagePref;
  subtitleLanguage: LanguagePref;
  menuLanguage: LanguagePref;
  country: CountryPref;
  region: RegionPref;
}
```

All default to `'auto'`. The language list offered is the 64 languages of `ISO_639_2` in
`packages/engine/src/disc/player-settings.ts`, named in the viewer's own language with `Intl.DisplayNames`; the
country list is `Intl.DisplayNames`' regions.

### Server

- `PlayerSettings` gains `discPreferences: DiscPreferences | null`: `null` while the person has never saved any (my
  call), so a device can tell "never set" from "set to Auto". `get` reads each field of a stored object, falling back
  to its default when missing or invalid, as it does for `nextEpisodeCountdown`.
- `isPlayerSettings` (today: exactly one key) accepts the new shape, and also a body with only `nextEpisodeCountdown`
  (from an older app), which keeps the stored disc preferences.
- The 4096-byte body limit stays.

### Older servers

The deployed NAS rejects a `PUT` whose body has any key but `nextEpisodeCountdown` (400). The app learns from a
`GET` whether the server knows the field (`discPreferences` present in the answer). If it does not, the app keeps the
disc preferences in this device's copy only, says so in the settings ("saved on this device until the NAS is
updated"), and never sends them in a `PUT`, so the countdown keeps saving.

### Device copy and when no NAS is paired

The app keeps the last preferences it read or saved in `localStorage`, so a disc opened from a local folder, offline,
or before the NAS answers still gets them. The copy is kept per person (my call): `bluray-web:disc-preferences:<NAS
pairing key>#<personId>` while paired, `bluray-web:disc-preferences:local` with no pairing, so after a device is
paired as someone else the last person's choices never apply. A newly paired person starts from the local copy.

Which copy wins (my call): a change made on the device is saved to the device copy at once, marked pending, and put
to the NAS; the mark clears when the NAS accepts it. While a copy is pending (an edit made offline, or during the
older-server period) it wins over the NAS's answer and is put again when the NAS next answers, as the places outbox
does. Otherwise the NAS's copy wins whenever it answers. A NAS answering `null` (never saved) gets the device's copy
put to it.

### Engine

- `protocol.ts` gains a `setDiscPreferences` command (the resolved `PlayerSettings` plus the region number), sent as
  the app loads and on every change, before any open, like `setVideoPath`.
- The worker stops deriving settings itself; `Player` keeps the latest and writes them when a disc's registers are
  made, for every disc (rename `applyBdjSettings`), so a changed preference applies from the next open.
- Region: PSR20 gets 1 (A), 2 (B) or 4 (C), as `bd_set_player_setting(BLURAY_PLAYER_SETTING_REGION_CODE)` writes it,
  for every disc, UHD included, as libbluray does (UHD discs are region-free and ignore it).
- `PlayerDeps.playerSettings` stays as the starting value until the first command (my call): the BD-J replay and the
  library check keep passing `HARNESS_SETTINGS`, which match the libbluray harness, so their comparisons don't move.
- Resolving Auto lives on the page (`src/ui/disc-preferences.ts`, pure): Auto audio and subtitles send nothing, Auto
  menu and country come from `navigator.language`, Auto region from the resolved country through a fixed table of
  ISO 3166 codes to Blu-ray regions (A: the Americas, Japan, Korea, Taiwan, Hong Kong and Southeast Asia; C: China,
  Russia, Central and South Asia, Mongolia; B: the rest), B when unknown.

### Encodes

When an encode opens with nothing resumed, the page applies a pinned audio language and subtitle language through
the same selection it uses for Up next's carry by language (`place-apply.ts`): the first MKV track in that language,
else the MKV's default. A subtitle pin picks an MKV text or PGS track in that language and turns text on; with no such
track, subtitles stay as the MKV sets them. A resumed place's own choice, a viewer's pick, and Up next's carry all win
over the pins. The ISO 639-2/B pin is matched against the MKV's language tags, which may be ISO 639-2/B, /T or BCP 47
(`fre`, `fra`, `fr`): the matcher accepts all three.

### UI

- In the player, the control bar's Settings menu (today only for Encodes, `EncodeMenus.tsx`) appears for discs too,
  and holds a "Disc preferences" group on both (on an encode, only audio and subtitle language): five pickers, each starting with "Auto (…)" naming what Auto resolves to now
  ("Auto (disc's choice)", "Auto (English)", "Auto (United States)", "Auto (A)"), and the line "Applies from the next
  disc you open."
- The same group on the landing screen's app bar (a settings button beside the theme switch), so it can be set
  before a disc is open.
- Help: `docs/playing-discs.md` gets a short section.

## Tests the builder adds

- Server store: defaults, invalid fields, an old-shape `PUT`, a full `PUT`, the size limit.
- `disc-preferences.ts`: Auto resolution, the region table edge cases (unknown country, a region-free value).
- Player: preferences written for an HDMV disc and a BD-J disc at open, a change applied at the next open and not
  to the open disc, PSR20 per region, a UHD disc's PSR20 untouched.
- Encodes: a pinned language picks the matching track at a fresh open; a resume's own track and Up next's carry win
  over it; a tag in /T or BCP 47 form matches.
- App: the older-server path keeps the countdown saving and says the preferences stay on this device.
- E2E: a synthetic disc whose First Play branches on PSR16 or PSR20 shows the pinned choice.

## Left to the builder

The menu layout within the existing menu style, the region table's exact country list, and whether the landing
screen's control is a menu or a small dialog.
