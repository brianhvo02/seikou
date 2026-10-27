# Permalinks, resume and Continue watching, and the NAS subtitle store

Date: 2026-10-20. Status: done and deployed. Piece 1 (links) merged 2026-10-21 (0a46717), piece 2 (resume) 2026-10-21 (c0af3e4), piece 3 (the subtitle store, eac8d74) pushed 2026-10-22; site and NAS deployed at 32dd53e on 2026-10-22. Resume passed the real-iPhone check (`live-check.ts --places`).

Decisions marked **(user)** are the user's. Those marked **(my call)** were made while writing this and can be overridden; the builder may revisit anything marked (builder).

## 1. Intent

Two moments drive this (user):

1. **Sending a link.** You're looking at a series, a season, an episode or a disc on the NAS, or watching one, and you want to send it to someone paired with your NAS. The address bar should already hold a link that opens exactly there.
2. **Coming back.** You stopped watching, on this device or another, and want to carry on at the exact moment with everything as you left it, without having saved anything. A **Continue watching** row in the title library gets you there.

A third piece came out of the second: subtitles a user adds today live only in that tab's memory. They become a **subtitle store on the NAS**: owners upload files (with fonts) attached to an episode or to a disc and chapter, and everyone paired can use them.

## 2. Goals

- **Paths in the address bar** for every NAS library screen and for playback, using stable ids, never folder names (user). Back and forward in the browser move between screens.
- **Unpaired visitors** who open a link get a not-found screen telling them to ask the NAS owner for an invite (user).
- **Resume at the exact moment** with all state (user): disc, title, playlist, time, audio and PG subtitle choice, text subtitles and their offsets, shader set, volume, angle, and the player-status registers (PSRs). GPRs too, for HDMV discs (§6.3).
- **Saved on the NAS per person** for NAS discs, so stopping on one device and picking up on another works (user). Saved on the device for discs opened from a local folder or the development disc server (user).
- **Continue watching** row in the title library (user), newest first, with progress and what's left (mockup 1 in §9).
- **Resume or start from beginning**: opening something with a saved place asks; "Start from beginning" keeps the settings and plays from 0:00 (user, mockup 2). A tap on a Continue watching card resumes without asking (my call).
- **Finished items drop off** Continue watching when they reach their end (user; §6.5 defines "end"). For a series episode, the card moves on to **Up next**, the following episode, even when it is on another disc (user; §6.6).
- **Subtitle store on the NAS** (user): only owners upload (user); everyone paired sees and uses (user); each upload is attached to an episode, or to a disc and chapter, carries its fonts, and has a default timing offset (user, mockup 3). The viewer's own offset adjustments are saved with their place (user).

## 3. Non-goals

- A watch-history list beyond Continue watching, ratings, user lists, AniList account sync. (They stay out, as in the title-library spec.)
- Restoring a BD-J title's Java state. It is not possible (§6.3); the user chose the exact moment over the disc's menus for BD-J discs (user).
- A faithful snapshot of the HDMV VM, navigator and graphics controller (§6.3).
- Linking to a disc opened from a local folder. Links are NAS-only (my call): a local folder means nothing on another device.
- Links that name the NAS. A device pairs with one NAS at a time (`NasStore`), so a link resolves against the paired one (my call).
- Uploading subtitles from non-owner devices.

## 4. Anti-goals

- **A link that breaks when a disc is moved or renamed.** That is why links never use folder names or the path-derived disc id (§5.2).
- **Resuming into the wrong place silently.** If the saved disc or playlist no longer matches, say so and offer to start from the beginning, never guess.
- **One person's place or settings leaking to another.** Saved places are per person, readable only with that person's token; a shared link carries only the position, never the sender's tracks or offsets (my call).
- **The library or playback waiting on the save.** Saving is fire-and-forget with retries; a NAS that is slow or offline never blocks playback or the UI.
- **Losing more than a few seconds** of position on a sudden close.

## 5. Links

### 5.1 Paths

All under `/nas/` (my call). Ids are URL-encoded path segments.

| Screen | Path |
|---|---|
| Library | `/nas` |
| Shelf | `/nas?shelf=series\|movie\|music` |
| Search | `/nas?q=<text>` |
| Title | `/nas/title/<titleId>` |
| Season | `/nas/title/<titleId>/season/<seasonKey>`, where `seasonKey` is the part of the catalogue's season id after `#` (`s2`, `discs`, `season`); `/nas/title/<titleId>/extras` for the title's own extras |
| Folder browser | `/nas/folders/<path>` |
| Owner screens | `/nas/unsorted`, `/nas/hidden`, `/nas/settings` |
| Playing | `/nas/play/<discKey>?pl=<playlistId>&t=<seconds>` |

- Seasons use the catalogue's season id, not a season number (my call): a series whose prequel chain is still loading is provisional, and its season numbers can appear or change as relations load, while the ids are stable.
- `titleId` is the catalogue's title id (an AniList or TMDB entry, or the owner's own title id), which survives rescans.
- `discKey` is `f.<fingerprint>` when the disc has a content fingerprint (`evidence.fingerprint`, TheDiscDB's ContentHash), else `d.<discId>`. The fingerprint survives a move or rename; the disc id (`server/src/disc-id.ts`, a hash of the path and `index.bdmv`'s identity) does not. Two copies of one disc share a fingerprint, so a link opens whichever copy the NAS picks (§7.1).
- While a disc plays, the path is updated with `history.replaceState` at most every 5 s and on pause or seek (my call), so the address bar is always a link to "here, now". Opening a screen uses `pushState`; Back returns to the previous screen.
- The landing page (`/`) stays as it is. `?pair=` links keep working and are still removed after reading.

### 5.2 Opening a link

- **Paired, title or disc found:** the app opens straight onto that screen. A `/nas/play/…` link opens the disc at that playlist and time, with the receiver's own saved settings for that disc if they have any, else defaults. It does not show the resume prompt.
- **Not paired:** a not-found screen: "This link is for a NAS this device isn't paired with. Ask its owner to send you an invite." with a button to the pairing screen (user).
- **Paired, and the NAS doesn't have it** (a disc key or title it can't resolve, opened from a link rather than an in-app step): the same screen with its own wording, "This NAS doesn't have what this link points to. It may have been removed or renamed, or the link may be for another NAS.", and a "Back to the library" button (user asked for separate wording for this case, 2026-10-21; the words are my call; "Your NAS" became "This NAS" on 2026-10-27, since a guest's NAS isn't theirs).
- **A guest behind the closed title gate opening a title, season or extras link:** the same screen, "The NAS owner hasn't opened the title library to this device, so this link can't open here. You can still browse the NAS by folder.", with a "Browse by folder" button (my call). Play links still open for a guest: disc routes are open to every paired device and the gate covers only the title library, so a guest can already play that disc from the folder view (my call, made while building piece 1; the user confirmed it on 2026-10-27).
- **The disc moved:** a fingerprint key still resolves. A `d.` key whose disc id is gone gives the not-found screen.

### 5.3 Hosting

Deep paths must load `index.html`. Cloudflare Pages does this when the build has no top-level `404.html` (it has none today); Vite dev and preview do it by default. The disc server (`tools/disc-server/`) and the service worker's navigation route must be checked and taught to fall back (builder). COOP/COEP headers must apply to those paths too (`public/_headers` uses `/*`, so they do).

## 6. Resume

### 6.1 What is saved (the "place")

A place is per person, per disc **and playlist** (keyed by `discKey` + playlist id), so each episode on a disc has its own place and progress bar (my call, following mockups 1 and 3). The disc's settings (tracks, text subtitles and offsets, shader, volume) are also kept per disc as the defaults for that disc's other playlists, so starting episode 4 uses what you chose for episode 3.

A place holds:

- Disc: `discKey`, the disc id it was saved from, title number (PSR4), playlist id, play item, time in the playlist (µs), chapter (for display), angle.
- Tracks: primary audio stream (PSR1), PG stream and display flag (PSR2), text subtitles on or off, text scale.
- Text subtitles: which stored subtitles (§7) were active, with each one's placement and the viewer's offset. Local files the user added on this device (not uploaded) are remembered on this device only, keyed by file name and size (my call).
- Shader set id (`shader-selected`), volume and mute (user: "all state").
- Registers: all 128 PSRs and, for HDMV discs, all 4096 GPRs (§6.3). Player-setting PSRs (13, 15–21, 23–31, 48–61: languages, parental level, region, capabilities) are saved for reference but never restored (my call): they are this device's settings, and the device's current values always apply.
- Bookkeeping: `updatedAt`, `deviceName`, the playlist's duration, `finished` (§6.5), and for Continue watching the title id, season and episode number when the catalogue knows them.

### 6.2 When it is saved

**Which playback makes a place** (my call): a playlist the catalogue knows as an episode or the disc's main title, or any playlist of 5 minutes or more (the same threshold as the text set's episode starts). Menu backgrounds, warnings and trailers are shorter and never create or overwrite a place. Stopping while a menu shows keeps the last qualifying place as it was. A playlist chosen by the disc's menu program counts the same as one chosen by the user. Extras of 5 minutes or more get their own places.

Every 10 s while playing, and at once on pause, seek, track change, offset change, playlist change, `visibilitychange` to hidden and `pagehide` (my call). On `pagehide` it uses `fetch(..., { keepalive: true })` so the last write survives the tab closing. Each save is also written to IndexedDB on the device first and sent from there, so a place reached over the WebRTC route (which has no keepalive request and closes with the tab) or while the NAS is unreachable is sent at the next connection (my call; anti-goal of §4). The last write wins; writes carry `updatedAt` from the device, and the server keeps the newer (my call; see §8 for clock skew).

### 6.3 How it is restored

Through a new engine command (or an `open` option; builder) that takes the saved place.

- **No navigator (picker playback):** open the disc, play the playlist at the play item and time, apply audio, PG, text and offsets. Straightforward with today's internals (`playPlaylist(id, at)` exists inside `Player`; the protocol does not expose a start time yet).
- **HDMV discs:** open the disc without First Play, bulk-write the saved GPRs and PSRs into the `RegisterFile` (it has no bulk API yet; add one), start title PSR4 through `Navigator.startTitle`, and open the playlist at the saved item and time through the same restore path the VM's RESUME uses (`navigator.ts` PSR `restore` sequence). This brings back the program's variables and the playback position. It is not a snapshot of the VM's program counter or the IG menu page; a disc whose menu program tracks its own state unusually may behave a little differently after a resume. That is accepted; a full snapshot is a non-goal. If the title won't start at that playlist (the program jumps elsewhere), fall back to playing the playlist directly, without the navigator, and log it.
- **BD-J discs:** play the playlist directly at the exact moment, with the navigator and BD-J off (user). The Menu / Top Menu buttons boot the disc's BD-J title fresh, as opening the disc does today. Whatever the disc saved for itself through 5e's per-person store is still there when it boots. Registers are restored only for the PSRs that affect playback (audio, PG, angle); GPRs are not restored (nothing reads them without the JVM).
- **Mismatch:** if the disc's playlists no longer match the saved place (the disc changed, the playlist is missing, the time is past its end), say so and offer "Start from beginning".

### 6.4 Where it is stored

- **NAS discs:** on the NAS, per person, under `/data/users/<personId>/playback/` (beside 5e's `bdj/`), one small JSON file per disc (`<discKey>.json`, holding the disc's defaults and its playlists' places), written atomically with `server/src/atomic-json.ts`. Routes (token required, the token's own person only): `GET /api/me/playback` (the Continue watching list: unfinished places, newest first, capped at 50), `GET /api/me/playback/<discKey>`, `PUT /api/me/playback/<discKey>/<playlistId>`, `DELETE /api/me/playback/<discKey>[/<playlistId>]`. A per-person cap (my call: 500 places, oldest finished ones pruned first). The owner's existing "clear saved data" for a person also clears this.
- **Local folder and disc-server discs:** IndexedDB on the device (a new store in `ui/db.ts`), keyed by the disc's content fingerprint computed in the browser (`engine/disc/content-hash.ts`) so a re-picked folder finds its place. They show as a resume prompt when reopened and on the landing page's Recent discs (my call: they don't appear in the NAS's Continue watching row, which is per person on the NAS).

### 6.5 Finished

A place is finished when the engine reaches the end of the playlist (`ended`), or when playback passes the start of the playlist's last chapter and that chapter starts in the final 10% of the playlist, or passes 95% when there are no chapters (my call: no credits detection exists anywhere; this is the simplest rule that catches end credits on most discs). A finished place stays stored (so its settings are reused next time) but drops off Continue watching and opens from the beginning without a prompt. A place near its start, before min(30 s, 5% of the playlist), is not offered either (my call: "Resume at 0:04" is no choice): opening its playlist asks nothing and plays it from the beginning with the place's settings (a disc opened without a playlist passes over it and opens as usual), and the NAS leaves it off Continue watching (where it holds back no Up next card).

Places follow the playlist that played. The catalogue's `EpisodeRef` points at each episode's own playlist; a play-all playlist is one place of its own (my call), finished by the same rule.

### 6.6 Up next

When a series episode's place becomes finished, Continue watching shows the next episode in its place (user), worked out on the NAS in `GET /api/me/playback` from the live catalogue:

- the next episode by number in the same season; after the season's last episode, the first episode of the next season (by the catalogue's season order); the next episode's `EpisodeRef` gives its disc and playlist, on whichever disc that is (user: even on another disc);
- if the next episode isn't known (the season's episode list is null, or the catalogue no longer has the title), or the finished episode was the series' last, the series drops off the row (my call);
- the card reads "Up next · S1 · Episode 4" with no progress bar, and a tap opens that episode from the beginning, with no prompt (my call);
- it carries the previous episode's audio and subtitle choices by language, the stored subtitles for that episode in the same language, and the shader set and volume (my call: track numbers differ between discs, languages don't);
- once the user starts that episode, its own place replaces the Up next card; starting any other episode of the series does too;
- movies and music have no Up next: they drop off when finished.

## 7. Subtitle store

### 7.1 On the NAS

- Stored under `/data/subtitles/<subtitleId>/`: the subtitle file (SRT or ASS), its fonts, and `meta.json`: the attachment, language (BCP 47), a name, default offset in ms, the uploader's person id and `uploadedAt`.
- **Attachment** (user): an episode, or a disc and chapter. An episode attachment is fixed at upload time to what the catalogue says that episode is then: the disc's `discKey` and the episode's playlist id, with the title, season id and episode number kept for display (my call: episode lists are guesses that can change after a rescan, and a subtitle must never move to another episode silently). If the disc or playlist no longer resolves, the owner sees the upload marked "not attached" and can re-attach it; viewers don't see it. A disc and chapter attachment is a `discKey`, playlist id and chapter number, placing the file at that chapter's start. One file per attachment; several files can share one (several languages).
- Limits (my call): 5 MB per subtitle file, 50 MB of fonts per upload, 2 GB in all, enforced as the body streams in (like `routes/bdj-store.ts`'s `readBody`).
- Routes: listing for a title, season or disc (any paired device that can see the title library, so the gate applies), file and font downloads (any paired device that can see the title library, so the gate applies to them too: stricter than listing alone needs, on purpose, since a guest behind a closed gate can't list them either; my call), and upload, edit (name, language, offset, attachment) and delete (owners only, the `routes/admin.ts` gate).
- **The library mounts stay read-only**: everything is written under `/data`.

### 7.2 In the app

- **Owners** get "＋ Subtitles" on the season page and on a movie's page (mockup 3): pick the file and its fonts, choose what it is for, a language and a name, and a default offset.
- **Everyone** sees language tags on episodes that have stored subtitles, and picks them in the player's Subtitles menu alongside the disc's PG streams and any local files. Picking one fetches it and its fonts and adds it to the engine's text set at its attachment's place.
- **Offsets:** the upload's default offset applies first; the viewer's adjustment (the existing ± controls) is saved in their place (§6.1), not on the upload (user).
- Local, not-uploaded SRT/ASS files keep working as today, with the device-only memory of §6.1.

## 8. Constraints

- `src/engine/` stays free of React and of `src/ui/`; new engine behaviour (open at a place, bulk registers, a place snapshot event) goes through `src/engine/protocol.ts` first.
- The NAS server has no native dependencies and writes only `/data` (CLAUDE.md).
- The repo is public: tests and fixtures use made-up titles (Starfall Wanderer and similar).
- Device clocks differ. "Newest wins" uses the device's `updatedAt`; a device whose clock is far off could win wrongly. The server may stamp its own receive time as well (builder).
- `docs/superpowers/specs/2026-10-17-nas-library-titles-design.md` §4 lists "continue watching" as a non-goal. That entry was not marked as the user's decision; this spec supersedes it, and the titles spec should be updated to say so.
- BD-J 5e (`spec/bdj-5e`) owns `/data/users/<personId>/bdj/` and the disc's own saved data. This spec must not change that store; it adds a sibling folder.

## 9. Mockups

The user approved three rough phone mockups (in the brainstorming session, 2026-10-20):

1. **Library:** a Continue watching row above Recently added: a wide art card per item with a progress bar along its bottom edge, the title, and "S1 · Episode 3 · 9 min left" or "Movie · 1 h 31 min left".
2. **Resume prompt:** on opening something with a saved, unfinished place: "Pick up where you left off?", a line with the time, the device and when ("Stopped at 14:32 of 23:40 on your iPad, yesterday"), the audio, subtitle (with offset) and shader in use, then **Resume at 14:32** (primary) and **Start from beginning**.
3. **Season page:** the Episodes / Discs toggle with an owner-only "＋ Subtitles" button; episode rows with language tags for stored subtitles and a progress bar on the one in progress; the upload sheet with Files (and attached fonts), For (episode, or a disc and chapter), Language and Name, Default offset, and Upload.

The address bar in each mockup used readable slugs; the user then chose stable ids (§5.1).

## 10. Left to the builder

- Router: a small hand-written history router or a library. The app has no router today and keeps dependencies few.
- Whether opening at a place is a new command or an option on `open`.
- Whether the engine emits a place snapshot event on a timer or the UI asks for one.
- The disc server's and service worker's deep-path fallback (§5.3).
- Folder-browser paths for names with slashes or odd characters.
- Test plan; the NAS E2E (`tests/e2e/nas.spec.ts`) and its stand-in server are the natural home for the link, resume and subtitle-store tests.
