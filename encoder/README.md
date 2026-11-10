# Encoder (`seikou-encode`)

Cuts a decrypted Blu-ray playlist into episodes and encodes them to AV1 + Opus MKVs, streaming video and audio through pipes (VapourSynth, SVT-AV1, opusenc) instead of writing intermediate files, and packages an episode MKV as a static directory for a web player.

## Requirements

- Node 22 or newer
- `brew install vapoursynth vapoursynth-bestsource svt-av1 opus-tools`

## Usage

Run from the repository root.

```sh
# List the playlists on a disc, or the chapters of one playlist
npm run seikou-encode -- plan encoder/fixtures/disc1
npm run seikou-encode -- plan encoder/fixtures/disc1 --playlist 00000

# Encode episodes (chapter ranges) from a playlist
npm run seikou-encode -- encode encoder/fixtures/disc1 --playlist 00000 --episodes "1-2,3-4" --out out

# Encode and also package each episode for the web player
npm run seikou-encode -- encode encoder/fixtures/disc1 --playlist 00000 --episodes "1-2,3-4" --out out --web web

# Package an episode MKV that is already encoded
npm run seikou-encode -- package out/episode-01.mkv --out web/episode-01

# Start the subtitle helper for a playlist and an episode list
npm run seikou-encode -- serve encoder/fixtures/disc1 --playlist 00000 --episodes "1-2,3-4"

# Start the app: disc library, episode grouping, subtitle helper, settings profiles and the encode queue
npm run seikou-encode -- app --root /path/to/discs

# Pair with Seikou's NAS (an owner code with the API address, or the pairing link), see whether it is paired, forget it
npm run seikou-encode -- nas pair --code K7QM-4XP2-R9TD --base https://nas.example/bluray/api/
npm run seikou-encode -- nas status
npm run seikou-encode -- nas unpair

# A disc on the NAS, by its key (as the app's queue prints it), and episodes sent to the NAS's Encodes library
npm run seikou-encode -- plan nas:f.0123…
npm run seikou-encode -- encode nas:f.0123… --playlist 00000 --episodes "1-2,3-4" --nas
```

`--episodes` is a comma-separated list of ascending, non-overlapping chapter ranges, one episode each. Options: `--name PATTERN` (default `episode-{n}`, `{n}` is the episode number padded to 2 digits), `--crf N` (25), `--preset N` (4), `--film-grain N` (4, SVT-AV1's film-grain synthesis level), `--svt-args "..."` (extra SVT-AV1 arguments), `--opus-bitrate N` (for every audio stream; by default 160 for mono or stereo, 320 otherwise), `--title T` (the MKV's title when the record names none for the episode), `--cache DIR` (where BestSource keeps its index files; default `bestsource/` in the data directory below), `--only LIST` (encode only some of the episodes of `--episodes`: 1-based episode numbers or ranges, such as `2,4-5`, each within the list and none twice, else exit code 2; the others are not fetched, encoded or uploaded, the saved record is still checked against the whole `--episodes` list, and each encoded episode keeps its number and its own subtitles, so `--out` holds only those files and `--nas` uploads only those, checking only their titles), `--no-subtitles` (ignore the helper's saved record: no ASS tracks, fonts, titles or names, and every audio stream goes in) and `--no-pgs` (leave the disc's PG streams out) and `--web DIR` (package each episode into `DIR/<name>/` as soon as its MKV is complete; see below).

### The NAS on the command line

`nas pair --code CODE --base URL` (or `--link URL`) pairs as the app's Settings does and prints `Paired with <host> as <person>`; `nas status` prints the same, or `Not paired`; `nas unpair` forgets the pairing here. A code or address the NAS or the encoder refuses (a typo, a used code, a code for a person who is not an owner) is exit code 2; a NAS that does not answer, 1.

`plan` and `encode` take `nas:<disc key>` for a disc on the paired NAS: the NAS's library is listed to find the disc (the listing is kept in `nas-library.json`, so only new discs' manifests are fetched), and its metadata is mirrored into the data directory as the app does. `encode` then fetches each episode's clips before encoding it (the next episode's while one encodes) and lets go of them once no later episode needs them, and of all of them when it ends, Ctrl-C included. While it works on a NAS disc it holds the data directory's queue lock (see below), so it refuses to start beside an app that runs the queue (exit code 1). `--nas` sends each episode to the NAS's Encodes library as soon as it is encoded, under `<encode id>.mkv` (`<anilistId>-<episode>` for AniList), and deletes it here once the NAS has filed it; it needs every episode's title and number saved on the app's Episodes page (exit code 2 naming the episodes that have none, or that share one) and a NAS that keeps encodes, and goes without `--web`. Without `--out` the MKVs are written to `nas-out/cli-<8 hex>/` in the data directory, removed at the end when empty. Not being paired, a NAS that no longer knows this encoder and a key the NAS has no disc for are exit code 2. A NAS that does not answer stops the command with `The NAS can't be reached.` (exit code 1; the app's queue is what waits for it), and so does a failed fetch, encode or upload; an episode whose upload failed, or was stopped with Ctrl-C, keeps its MKV, and the message (`Stopped.` for Ctrl-C) says where. `jobCli` prints a queued job as this command.

`encode` reads the record the helper saved for the disc and playlist from the data directory. It must have been saved for the same playlist and `--episodes` list, or the command stops with exit code 2 and says so (re-save it in the helper, or pass `--no-subtitles`). If the record has no entry for one of the episodes of `--episodes`, it stops the same way (exit code 2) naming the episode. If the record ticks no audio stream for an episode, it stops with exit code 2 naming the episode. If subtitle or font files the record names are gone from the data directory, it stops with exit code 1 naming the release. With no saved record it encodes without the helper's subtitle choices.

In-process use: `encodeEpisodes(options, onEvent)` is what the command runs, and a caller inside the process can steer it. Each episode is written to `<name>.mkv.partial` and renamed when complete, so a failed or aborted run never leaves a partial file and never damages an older `<name>.mkv`. `signal` (an `AbortSignal`) stops every tool of every running chain, waits for them to exit, removes the partial file and rejects with an error named `AbortError`; an already aborted signal rejects before anything starts. `onlyEpisodes` (1-based numbers from the episode list) encodes just those episodes, named as in the full list; `onlyFirstAudio` cuts only each episode's first audio stream. `onEvent` receives `progress` events (`framesDone` of `frames`, at most one a second per episode, and one at 100% when the episode is complete; `now` replaces the clock), and with `web` a `packaged` event per package or a `package-failed` one carrying the error, after which the run still stops with the error and the MKV is kept. `filmGrain` is a required option. `planRanges` (`src/plan/episodes.ts`) plans stretches of playlist time as episodes on the same frames and samples as chapter episodes, with no chapters, for short test samples. `encodePlan(options, onEvent)` encodes one such plan (or any `EpisodePlan`) into one MKV with the same pipeline, `.partial` handling and abort as an episode: `audio` lists the streams to cut, so an empty list encodes the video alone; `encodeEpisodes` calls it for each episode.

Audio: each audio stream of the episode becomes its own Opus track, decoded by BestSource and encoded by its own opusenc (160 kb/s for mono or stereo, 320 kb/s above, or `--opus-bitrate` for every stream). With a saved record the episode's audio list decides which streams go in, in what order and under what names and languages, and the first is the default; a stream of the playlist the record does not list is left out with a warning. Without one, every audio stream of the playlist goes in, in the order of the playlist's stream table, named after its language (`jpn` is `Japanese`), the first default. Before a stream is encoded its decoded channel count and sample rate are checked against what the playlist says about it; a mismatch (BestSource decoding another stream than planned) stops the episode with exit code 1 and names the PID.

What each MKV carries, in track order:

1. The video track, AV1, named and tagged with the record's video name and language (empty and `und` without a record).
2. One Opus track per audio stream (see above).
3. With a saved record, one `S_TEXT/ASS` track per subtitle track the record leaves ticked, in the record's order, named and tagged as the record says; the first is the default. Each script is retimed as the helper previewed it (the saved shift or split, then the nudge), with zero at the episode's first video frame; events that end before the episode starts or begin after it ends are dropped.
4. The disc's PG subtitle streams as `S_HDMV/PGS` tracks, one per stream of the playlist, named `<Language> (disc)`, never default; `--no-pgs` leaves them out. The record holds no PGS choices.

Besides tracks: the record's fonts are attached (`font/ttf`, `font/otf`, `font/collection`, `font/woff` or `font/woff2` by extension) when an ASS track is, named as the release lists them (a later font of another release with a name already used, ignoring case, gets a number before its extension, as `Name-2.ttf`); the MKV's title is the record's episode title, else `--title`, else none; chapters take the names saved for their playlist chapters (`<data>/chapters/<disc key>/<playlist>.json`), else the record's (a record saved before chapter names moved there), else `Chapter n`. Every MKV carries the tags Seikou's NAS reads: `SEIKOU_DISC_KEY`, `SEIKOU_PLAYLIST`, `SEIKOU_EPISODE_START_MS` (the playlist time of the episode's first frame) and `ENCODER` (`seikou-encode <version>`), and, when a title was chosen for the episode's first chapter, its title tags (`ANILIST_ID` for an AniList entry; else `SEIKOU_TITLE` and, for a series season, `SEASON`), `EPISODE`, `EPISODE_TITLE` (when it has one) and, for a title that is not AniList, `TITLE_NAME` (the show's name, when known). `encode` reads the record once and encodes exactly that. Every episode's subtitle files are read and checked before the first episode is encoded, so a missing or undecodable file stops the run at once.

Output layout:

```
out/
  episode-01.mkv
  episode-02.mkv
```

### Packaging for the web player

`package <episode.mkv> --out DIR` reads an episode MKV and writes `DIR` (replacing it only when it is empty or holds an earlier package's `episode.json`; anything else there is refused with exit 1) as a static directory a browser player can serve; `encode --web WEB` does the same for each episode into `WEB/<name>/` right after its MKV is written. Nothing is re-encoded:

```
WEB/episode-01/
  video.webm             the AV1 track and every Opus track, with chapters (WebM: no subtitles or attachments)
  subs/1-eng-full.ass    each ASS track as a script, <n>-<language>-<kind>; kind is signs for a signs-and-songs track, else full
  fonts/<file>           the MKV's font attachments
  pgs/1-jpn.sup          each disc PGS track as a .sup file, <n>-<language>
  chapters.vtt           the chapters as WebVTT cues
  episode.json           the manifest
```

`episode.json` names every file (paths relative to the directory) and what the player needs to label them:

```json
{
  "title": "Lantern Harbor - 01",
  "video": { "file": "video.webm", "width": 1920, "height": 1080 },
  "audio": [{ "index": 0, "name": "Japanese", "language": "jpn", "default": true }],
  "subtitles": [{ "file": "subs/1-eng-full.ass", "name": "English", "language": "eng", "default": true }],
  "pgs": [{ "file": "pgs/1-jpn.sup", "name": "Japanese (disc)", "language": "jpn" }],
  "fonts": ["fonts/LanternSans.ttf"],
  "chapters": "chapters.vtt"
}
```

`title` is the MKV's title, else its file name. `audio[].index` is the track's position among the WebM's audio tracks. All times count from the episode's first video frame. The directory is written under a temporary name and moved into place when complete, so a failure leaves no partial directory. `package` exits 1 on a file that is not Matroska, a truncated one, or one with no AV1 track. It also refuses what it does not read: laced blocks, an unknown-size Segment child (such as a live-streamed cluster), and a video track in another codec than AV1, which it ignores rather than remuxes (with no AV1 track beside it, the file is refused). A packaging failure during `encode --web` stops the run but keeps that episode's MKV, which `package` can then be run on.

`serve` checks the episode list against the playlist, starts the helper on 127.0.0.1 and opens a helper session on the disc, playlist and episodes it was given, and prints `Helper: http://127.0.0.1:<port>/helper/<session id>?t=<token>`, the address of the session's page with this run's secret token. It opens that address in your browser (`open` on macOS, `xdg-open` elsewhere) unless `--no-open` is given, and runs until Ctrl-C. `--port N` picks the port (default: any free one). The helper needs the built page in `encoder/web/dist` (`npm run encoder:web:build`; `SEIKOU_ENCODE_WEB_DIR` points at another folder). Without `vspipe` the helper still starts, and says line-up is unavailable.

### Subtitle helper

`serve` is how subtitles are chosen for an encode. The page it opens works through three steps for the run's disc, playlist and episodes:

1. **Release.** Search AniList for the show and pick it; nothing is guessed from the disc. SeaDex's releases for that show are listed with its notes, the best one marked; a release on a private tracker, or not on Anime Tosho, is shown but cannot be picked. Instead you can search Anime Tosho or add your own `.ass`, `.ssa` or `.srt` files and fonts (an SRT becomes ASS when it is added). Several releases can be in use at once: each one you pick joins "Releases in use" (Remove takes one out), and an episode without a file takes the matching file of each release added. The episode offset says how many episodes the release numbers before this disc's first, for a later disc or season.
2. **Episodes.** One row per disc episode with its AniList title: the release file it uses (from any release in use, grouped by release), which of that file's tracks to keep, or "No subtitles".
3. **Line up.** The first time, the helper asks whether to line the subtitles up against the disc's audio or use the release's own timing; the answer holds for the rest of that helper session (another disc, session or a reload asks again), and with the release's timing each episode can still be lined up on its own with "Line up this episode". Lined up, each episode's tracks are matched against the disc's audio (decoded by VapourSynth and BestSource, as the encode decodes it): a single shift, a split at a cut, or "Could not line up" when the episode has too little dialogue or the answer is not confident. The episode plays in Seikou's engine with the retimed track and the release's fonts, and the nudge moves the subtitles live: `[` and `]` by 42 ms, `{` and `}` by 10 ms, or the buttons. Accept, use the release's own timing, or skip the episode; Previous episode and Back return to the one before or to step 2. The browser's Back and Forward buttons move between the three steps too.

Details sets each episode's MKV title, the video, audio and subtitle tracks' names, languages and order, and the chapter titles. "Save for encoding" writes the record; opening the helper again for the same disc and playlist restores it. `encode` reads the record to put the subtitles, fonts, names, languages and chapter titles in each episode's MKV.

The page is built separately from the CLI: `npm run encoder:web:build` writes `encoder/web/dist`. Rebuild it after changing anything in `encoder/web/` or in the Seikou packages it bundles. `npm run encoder:web:dev` serves it with hot reload against a running `serve` (see [`web/README.md`](web/README.md)).

### Data directory

The encoder keeps what it learns and downloads in one directory: saved subtitle records (`subtitles/<disc key>/<playlist>.json`), the chapter names and AniList choices of the Episodes page (`chapters/<disc key>/<playlist>.json`), the app's library folders (`settings.json`), its settings profiles (`profiles.json`), its pairing with the NAS (`nas.json`, mode 0600: the NAS's address, the device it paired as and that device's private key; never a session token), the NAS's disc listing (`nas-library.json`), the NAS discs it works on (`fetch/<disc key>/`) and the episodes waiting to go to the NAS (`nas-out/<job id>/`), the encode queue (`jobs.json`, logs in `jobs/`, test samples in `tests/`, and `output/`, a place for output folders), fetched fansub tracks and fonts, and the BestSource index files (`bestsource/`, shared by `serve` and `encode` so an encode reuses the index the line-up built). It is `~/Library/Application Support/seikou-encode` on macOS and `$XDG_DATA_HOME/seikou-encode` (default `~/.local/share/seikou-encode`) elsewhere; `SEIKOU_ENCODE_DATA` names another.

### Offline mode

`SEIKOU_ENCODE_FIXTURE=<folder>` makes `serve` read SeaDex, Anime Tosho and AniList answers and AniList covers from recorded files in that folder (`seadex.json`, `tosho.json`, `anilist.json`, `files/`, `covers/`) instead of the network. It is for tests; `encoder/tests/fixtures/fansubs/` is an example with made-up titles.

Exit codes: 0 success, 1 encode or packaging failure (and for the NAS: a NAS that does not answer, a failed fetch or upload, a stop with Ctrl-C, or an app running the queue on the same data directory), 2 usage error, bad episode spec, a saved record that does not match the encode (including one with no entry for an episode) or that ticks no audio stream for an episode (and for the NAS: not paired, a refused pairing code, an unknown `nas:` key, episodes without an AniList entry and number or sharing one, a NAS without encodes), 3 required tools missing (for `serve` and `app`, the page not built).

`app [--root DIR]… [--port N] [--no-open]` starts the same backend with no helper session and opens its front page, printing `App: http://127.0.0.1:<port>/?t=<token>`. The page's disc library is every folder holding `BDMV/index.bdmv` up to four folders below the library folders: the ones saved in `settings.json` in the data directory (set from the page) and the `--root` folders of this run, which are not saved. A link that leads out of a library folder is not followed. With no saved folders and no `--root` it prints one line saying so (folders can be added in the app or with `--root DIR`). A folder that cannot be read (an unmounted drive) keeps the discs found under it in the last scan and is reported as unreadable. It needs the built page like `serve` does, and runs until Ctrl-C.

### The app's pages

The page has an app bar with Library, Queue and Settings links, and under it a line that says what is encoding (the disc, "episode n of m", the share done and the time left; it links to the job and is on every page, the helper's included).

- **Library** (`/`): while paired, three views. **By show** (the default) lists the NAS's shows as the NAS sorts them: poster, seasons and films, disc count and how many of the episodes the NAS lists are in its Encodes library, then the discs the NAS hasn't sorted ("Not sorted by the NAS yet"), which open as discs do. A show (`/shows/<title>`) lists its seasons, then its films and extras, each with its encoded count. A season (`/shows/<title>/<season>`) lists its discs, each with its playlist and episodes marked Encoded, Queued (a NAS job in this app's queue already encodes it) or To encode (for a season the NAS lists no episodes for, the episodes of each checked grouping), and a disc with episodes to encode has **Check episodes**, which opens the Episodes page for that playlist (the disc page, for a disc the NAS lists no episodes for) with a way back to the season; once marked checked there the disc shows Checked. **Queue N episodes to the NAS** stays disabled, saying why ("Check discs 2 and 3 first", a disc this app doesn't list, a checked disc whose episodes miss some the NAS lists ("Disc 3's checked episodes don't include 10 and 11: check it again", with Check episodes offered again), an entry the NAS hasn't loaded, the NAS not answering or not saying which episodes it already has, this app's queue not read yet), until every disc with episodes to encode is checked; a disc is checked once a playlist of it is and its checked groups give every episode the NAS lists on it that isn't encoded, whichever playlist the NAS lists it on (a checked play-all playlist covers episodes listed on their own playlists). It then opens the queue dialog with one encode per checked playlist, each only the episodes neither in the Encodes library nor in this app's queue, matched by title and number (a season the NAS lists no episodes for queues the groups of each checked grouping not encoded, and says no count while a disc of it is unchecked). While the NAS doesn't answer, its last listing is shown and says so, and no disc can be checked. **By folder** lists the NAS's discs (marked NAS, with a copy here listed as the copy here), **This Mac** the discs under the library folders. Unpaired, the Library is the discs under the library folders. The disc views have a filter, Rescan, and (This Mac, or unpaired) the folders themselves (add or remove one; the `--root` folders of this run are not listed there). A NAS that cannot be reached keeps its last listing, with a line saying so. A NAS disc opens like any other: its metadata and each clip's head are fetched into a mirror in the data directory, and the player reads the rest from the NAS as it plays. Lining an episode up in the helper first fetches that episode's clips whole ("Fetching from the NAS (x of y MB)"), kept until the app stops; planning reads only the clips the episodes play.
- **Disc** (`/disc/<key>`): the disc's playlists, longest first, with length, clips and chapters. "Likely main" marks the longest, and "Subtitle choices saved" a playlist the helper has a record for.
- **Episodes** (`/disc/<key>/<playlist>`): the playlist plays in the page, and its chapters are listed with their start and length. A chapter's button jumps there; "Split after" cuts an episode after a chapter and "Skip" leaves a chapter out. The grouping is the same list `--episodes` takes (`1-3,4-`), editable as text. Each chapter can be named (Avant, Opening, Part A, Part B, Ending, Part C, Preview, or any other name) and each episode given its AniList entry and number (the next episodes numbered on from it); they are saved as they change, written into the MKVs as chapter titles and tags, and an encode to the NAS needs every episode's entry. From here, "Choose subtitles" opens the helper for this grouping (`/helper/<session>`), "Queue encode" and "Encode without subtitles" open the queue dialog.
- **Queue dialog** (`/queue/new?disc=&playlist=&spec=`): the settings profile, where the episodes go (a folder, suggested under `output/` in the data directory, or the paired NAS's Encodes library, which needs every episode's AniList entry saved on the Episodes page) and "Run a test encode first".
- **Queue** (`/queue`, and `/queue/<id>` for a job): every job with its state, a bar per episode with speed and time left, the log, the equivalent command, and the output files; Cancel, Retry and Remove.
- **Test** (`/test/<id>`): a test encode's samples side by side and each profile's projected sizes (see below).
- **Settings** (`/settings`): the settings profiles, and Your NAS: pairing with Seikou's NAS (see below).

### Pairing with the NAS

The encoder reads discs from Seikou's NAS and uploads finished episodes to it through the NAS's own API, as an owner device: make an owner pairing code in Seikou's admin screen and type it on Settings with the NAS's API address (`https://…/bluray/api/`), or paste the pairing link. The encoder pairs as `Seikou encoder on <this machine's name>`, keeps the device's key in `nas.json` and signs a new session each run; a code for a person who is not an owner is refused. Settings then says which NAS it is paired with and as whom, whether the NAS answers, and whether the NAS keeps encodes (its `ENCODES_MOUNT` set). Unpair forgets the pairing on this machine only; the device stays in Seikou's admin screen until an owner removes it. See [`src/nas/`](src/nas/README.md).

### Settings profiles

A profile is a name and the encode settings: CRF, preset, film grain, extra SVT-AV1 arguments, Opus bitrate (or opusenc's default), whether the disc's PGS tracks go in, whether to also package for the web, and the file name pattern. The built-in `default` is CRF 25, preset 4, film grain 4, PGS on, no web package, `episode-{n}`, and cannot be changed or deleted. Others are made, edited and deleted on Settings and are kept in `profiles.json`. A job copies the profile's settings when it is queued, so a later edit changes only later jobs.

### Encode queue

`app` and `serve` both run an encode queue in the backend (`src/server/jobs.ts`). A job is one disc, playlist, episode list, copy of a profile's settings and output folder; jobs run one at a time, in the order they were queued, and keep running when the page is closed. The queue is kept in `jobs.json` in the data directory, and each job's log in `jobs/<id>.log`. Each job shows the `seikou-encode encode …` command that does the same (`--web` goes to `<output folder>/web`), and the command line keeps working on its own.

- **One queue per data directory.** The process that runs the queue holds `jobs.lock` in the data directory (made with O_EXCL, holding its pid), and lets it go when it stops. A second `app` on the same data directory refuses to start with one line: `Another seikou-encode app (pid N) is using the data folder <dir>.` (exit code 1). A `serve` that finds the lock taken runs without a queue: its queue routes answer 409 `queue-elsewhere`, and the page shows that message where the queue would be. A lock whose process is gone (the app was killed) is taken over.
- **Output folder.** The queue dialog suggests `output/<disc label>-<hex>/<playlist>` in the data directory, where `<hex>` is the first 8 hex digits of the disc key, so two discs whose folders share a name (`Disc 1` of two shows) get folders of their own. Any absolute folder can be chosen and is made when missing, except one inside a library folder, inside the disc, or inside the data directory other than its `output/` folder, and one that is or holds a library folder, the data directory, your home folder or the disc (400 `output-not-allowed`, naming which).
- **Two jobs, one folder.** A job is refused (409 `output-in-use`, naming the other job and suggesting another folder) when another job still in the queue, finished or not, writes to the same folder (compared by real path) with a name pattern that can make the same file names (the same pattern, or any shared name for episodes 1 to 99, ignoring case). A job for the same disc, playlist and episode list is a re-encode: it is queued, and its page says once that its files replace the earlier ones. The backend serves only a job's own files: each episode's MKV and, with the web package, the package of an episode whose packaging finished.
- **Subtitles.** Queuing a job checks the saved subtitle record against the job's playlist and episode list and refuses a mismatch, unless the job encodes without subtitles; with no record, the job encodes without them, as `encode` does. The job reads the record when it runs and remembers when that record was saved.
- **Episodes.** Each episode is encoded on its own and counts as done only once the queue saw it finish (with the web package, once packaged); a file found on disk never counts. Cancel stops every tool and removes the partial file. Retry (of a failed, interrupted or cancelled job) encodes only the episodes not done, and packages again, without encoding, an episode whose packaging failed; when the subtitle record was saved again since the job's first run, it encodes every episode, so one job never mixes two sets of subtitle choices.
- **Test encodes** go first: a running job stops after the episode in progress, the test runs, and the job resumes at its next episode. A test takes five 10-second stretches spread over the first episode (shorter ones for an episode under a minute), encodes each with one to three profiles' video settings and the first audio stream once (shared by every profile's sample), and writes each sample as WebM to `tests/<job id>/<profile>/<n>.webm` in the data directory, never to an output folder. The Test page plays a stretch's samples side by side in step and shows each profile's projected size per episode: its video bytes per second plus the shared audio's (scaled to the profile's own Opus bitrate) times the audio streams the encode would write, times the episode's length. A retry runs the whole test again; removing the job deletes its samples.
- **Restart.** A job that was running when the app stopped is marked interrupted and its `.partial` files are removed; queued jobs stay queued. Ctrl-C stops the running job the same way, waiting for its tools to exit, and says what it waits for (`Stopping: waiting for the tool chain to finish; press Ctrl-C again to quit now.`, or `packaging episode n`); a second Ctrl-C quits at once. A damaged `jobs.json` is never written over: the queue answers with an error until the file is fixed or removed.
- **A disc that moved.** A job keeps the disc folder it was queued from. When a retry finds the folder no longer holds the disc, it looks the disc up again by its key in the library (waiting for a running scan) and moves the job there, or refuses with a plain message to rescan or queue it again.
- **To the NAS.** A job whose destination is the NAS writes its MKVs to `nas-out/<job id>/` in the data directory, uploads each episode as soon as it is encoded (resumable, in 8 MiB chunks) and deletes it here once the NAS has filed it; the job is done when the NAS has every episode. Queuing it is refused when the encoder is not paired (409 `nas-not-paired`), an episode has no title and number saved on the Episodes page (`nas-needs-title`), two episodes share one (`nas-duplicate-episodes`, since the NAS keeps one file for each) or the NAS keeps no encodes (`nas-encodes-off`). On a NAS disc a job fetches each episode's clips before encoding it, the next episode's while one encodes, and lets go of them once no later episode needs them, so it never holds more than two episodes' clips. An upload the NAS does not answer (or whose encodes folder is missing) does not stop the job: the episode shows "Encoded · upload waits for the NAS", keeps its MKV, and the job goes on encoding the episodes it can without the NAS (every one on a disc here; on a NAS disc, those whose clips are fetched already, while a fetch still waits), trying the waiting uploads again, in episode order, after each episode. Once only uploads are left the job shows "Waiting for the NAS" and asks again every minute until it answers or the job is cancelled; a failed upload keeps the MKV, and Retry resumes it. Uploading an episode the NAS already has replaces it. Test encodes of NAS discs are refused (`nas-test-unsupported`).
- **Replacing subtitle choices.** When the helper's Save would replace choices saved for another episode list that a queued or interrupted encode uses, its line says that the encode will stop with a mismatch unless it is queued again.

## Where it sits in Seikou

The encoder is an application inside the Seikou repository, beside `server/` and `rendezvous/`. It reads discs through the `@seikou/bdmv` workspace package (MPLS, CLPI and the transport-stream demuxer), is type-checked by `tsconfig.encoder.json`, and its tests run as the `encoder` project of the root Vitest config. It has no `package.json` of its own; its tools (`tsx`, `vitest`, `typescript`) come from the root. Its history before the move is kept in the repository through `git subtree`.

## Reading the code

Each area of `encoder/src/` has a README with its concepts, its API and where to look:

- [`src/disc/`](src/disc/README.md): playlists, chapters and clip probes from a disc folder.
- [`src/plan/`](src/plan/README.md): chapter ranges to frame and sample cuts.
- [`src/pipeline/`](src/pipeline/README.md): VapourSynth scripts and the vspipe-to-encoder chains.
- [`src/mux/`](src/mux/README.md): IVF and Ogg Opus readers, the Matroska writer and reader.
- [`src/package/`](src/package/README.md): an episode MKV as a static web directory.
- [`src/audio/`](src/audio/README.md): an episode's audio as 16 kHz mono for subtitle alignment.
- [`src/subs/`](src/subs/README.md): the data directory, fetched releases and the saved subtitle record.
- [`src/nas/`](src/nas/README.md): pairing with Seikou's NAS and requests to it as the paired owner device.
- [`src/server/`](src/server/README.md): the app's local backend (library, disc and playlist routes, helper sessions, profiles, the encode queue and its runner), which the subtitle helper's routes are part of.
- [`web/`](web/README.md): the app's page: the library, episode grouping, settings, queue and test pages, and the subtitle helper as one of them.

The test discs are described in [`fixtures/README.md`](fixtures/README.md).

Every export has a doc comment, and code that implements a format cites the specification section it follows; `npx vitest run --project encoder encoder/tests/docs.test.ts` checks the first rule and that no comment points at planning notes.

## Tests

```sh
npx vitest run --project encoder   # or npm test for the whole repository
```

Tests that need the encoders skip themselves when `vspipe`, `SvtAv1EncApp`, `opusenc` or the BestSource plugin are missing. Set `ENCODING_TOOLS_VSPIPE`, `ENCODING_TOOLS_SVT` or `ENCODING_TOOLS_OPUSENC` to point at binaries outside `PATH`.

The helper's end-to-end check walks the whole page in installed Chrome, from the AniList search to a saved and restored record, with the recorded answers in `tests/fixtures/fansubs/` and the speech disc:

```sh
npx playwright test -c playwright.encoder.config.ts
```

It builds the page, starts `serve` on port 4195 with a temporary data directory and reads the address with its token from the output, so a running helper is never reused. Without VapourSynth and BestSource the line-up results are not checked and the test says so.

The same command also runs the app's check (`tests/e2e/app.spec.ts`): `app` on port 4197 over a temporary library of copies of the speech disc and disc1 and its own data directory. It groups the speech disc's chapters into episodes, chooses subtitles in the helper, queues the encode into a temporary folder, watches the progress line and the finished queue and the MKVs, cancels a slow job and checks that no `.partial` file is left, and runs a test encode and plays a sample. The encode runs only where VapourSynth and BestSource are present, and the test says so when it does not.

The third project, `nas` (`tests/e2e/nas.spec.ts`), checks the encoder with Seikou's NAS. Its stand-in (`tests/e2e/nas-stand-in.ts`) builds the NAS server (`npm run server:build`, every run, since it takes milliseconds) and runs it on port 4198 over a temporary copy of `fixtures/synthetic` with the speech disc beside it, an empty encodes folder and recorded metadata answers; a second `app` runs on port 4199 with no library folders and its own data directory. The test mints an owner code with `server.mjs owner-code`, pairs on Settings, opens the NAS's speech disc from the Library, names a chapter and picks a made-up AniList entry for two episodes, and queues them to the NAS; where the tools are present it waits for the job to fetch, encode and upload both, and checks that the NAS lists the show with two episodes, that `nas-out/` holds nothing and that the mirror holds no whole clip. Run it alone with `--project nas`.

## License

LGPL-3.0-or-later, like the rest of Seikou. See `LICENSE` and `COPYING` (GPL-3.0).
