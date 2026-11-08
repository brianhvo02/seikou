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
```

`--episodes` is a comma-separated list of ascending, non-overlapping chapter ranges, one episode each. Options: `--name PATTERN` (default `episode-{n}`, `{n}` is the episode number padded to 2 digits), `--crf N` (25), `--preset N` (4), `--film-grain N` (4, SVT-AV1's film-grain synthesis level), `--svt-args "..."` (extra SVT-AV1 arguments), `--opus-bitrate N` (for every audio stream; by default 160 for mono or stereo, 320 otherwise), `--title T` (the MKV's title when the record names none for the episode), `--cache DIR` (where BestSource keeps its index files; default `bestsource/` in the data directory below), `--no-subtitles` (ignore the helper's saved record: no ASS tracks, fonts, titles or names, and every audio stream goes in) and `--no-pgs` (leave the disc's PG streams out) and `--web DIR` (package each episode into `DIR/<name>/` as soon as its MKV is complete; see below).

`encode` reads the record the helper saved for the disc and playlist from the data directory. It must have been saved for the same playlist and `--episodes` list, or the command stops with exit code 2 and says so (re-save it in the helper, or pass `--no-subtitles`). If the record has no entry for one of the episodes of `--episodes`, it stops the same way (exit code 2) naming the episode. If the record ticks no audio stream for an episode, it stops with exit code 2 naming the episode. If subtitle or font files the record names are gone from the data directory, it stops with exit code 1 naming the release. With no saved record it encodes without the helper's subtitle choices.

In-process use: `encodeEpisodes(options, onEvent)` is what the command runs, and a caller inside the process can steer it. Each episode is written to `<name>.mkv.partial` and renamed when complete, so a failed or aborted run never leaves a partial file and never damages an older `<name>.mkv`. `signal` (an `AbortSignal`) stops every tool of every running chain, waits for them to exit, removes the partial file and rejects with an error named `AbortError`; an already aborted signal rejects before anything starts. `onlyEpisodes` (1-based numbers from the episode list) encodes just those episodes, named as in the full list; `onlyFirstAudio` cuts only each episode's first audio stream. `onEvent` receives `progress` events (`framesDone` of `frames`, at most one a second per episode, and one at 100% when the episode is complete; `now` replaces the clock), and with `web` a `packaged` event per package or a `package-failed` one carrying the error, after which the run still stops with the error and the MKV is kept. `filmGrain` is a required option. `planRanges` (`src/plan/episodes.ts`) plans stretches of playlist time as episodes on the same frames and samples as chapter episodes, with no chapters, for short test samples. `encodePlan(options, onEvent)` encodes one such plan (or any `EpisodePlan`) into one MKV with the same pipeline, `.partial` handling and abort as an episode: `audio` lists the streams to cut, so an empty list encodes the video alone; `encodeEpisodes` calls it for each episode.

Audio: each audio stream of the episode becomes its own Opus track, decoded by BestSource and encoded by its own opusenc (160 kb/s for mono or stereo, 320 kb/s above, or `--opus-bitrate` for every stream). With a saved record the episode's audio list decides which streams go in, in what order and under what names and languages, and the first is the default; a stream of the playlist the record does not list is left out with a warning. Without one, every audio stream of the playlist goes in, in the order of the playlist's stream table, named after its language (`jpn` is `Japanese`), the first default. Before a stream is encoded its decoded channel count and sample rate are checked against what the playlist says about it; a mismatch (BestSource decoding another stream than planned) stops the episode with exit code 1 and names the PID.

What each MKV carries, in track order:

1. The video track, AV1, named and tagged with the record's video name and language (empty and `und` without a record).
2. One Opus track per audio stream (see above).
3. With a saved record, one `S_TEXT/ASS` track per subtitle track the record leaves ticked, in the record's order, named and tagged as the record says; the first is the default. Each script is retimed as the helper previewed it (the saved shift or split, then the nudge), with zero at the episode's first video frame; events that end before the episode starts or begin after it ends are dropped.
4. The disc's PG subtitle streams as `S_HDMV/PGS` tracks, one per stream of the playlist, named `<Language> (disc)`, never default; `--no-pgs` leaves them out. The record holds no PGS choices.

Besides tracks: the record's fonts are attached (`font/ttf`, `font/otf`, `font/collection`, `font/woff` or `font/woff2` by extension) when an ASS track is, named as the release lists them (a later font of another release with a name already used, ignoring case, gets a number before its extension, as `Name-2.ttf`); the MKV's title is the record's episode title, else `--title`, else none; chapters take the record's names, else `Chapter n`. `encode` reads the record once and encodes exactly that. Every episode's subtitle files are read and checked before the first episode is encoded, so a missing or undecodable file stops the run at once.

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
3. **Line up.** Each episode's tracks are lined up against the disc's audio (decoded by VapourSynth and BestSource, as the encode decodes it): a single shift, a split at a cut, or "Could not line up" when the episode has too little dialogue or the answer is not confident. The episode plays in Seikou's engine with the retimed track and the release's fonts, and the nudge moves the subtitles live: `[` and `]` by 42 ms, `{` and `}` by 10 ms, or the buttons. Accept, use the release's own timing, or skip the episode; Previous episode and Back return to the one before or to step 2. The browser's Back and Forward buttons move between the three steps too.

Details sets each episode's MKV title, the video, audio and subtitle tracks' names, languages and order, and the chapter titles. "Save for encoding" writes the record; opening the helper again for the same disc and playlist restores it. `encode` reads the record to put the subtitles, fonts, names, languages and chapter titles in each episode's MKV.

The page is built separately from the CLI: `npm run encoder:web:build` writes `encoder/web/dist`. Rebuild it after changing anything in `encoder/web/` or in the Seikou packages it bundles. `npm run encoder:web:dev` serves it with hot reload against a running `serve` (see [`web/README.md`](web/README.md)).

### Data directory

The encoder keeps what it learns and downloads in one directory: saved subtitle records (`subtitles/<disc key>/<playlist>.json`), the app's settings profiles (`profiles.json`), the encode queue (`jobs.json`, logs in `jobs/`, test samples in `tests/`, and `output/`, a place for output folders), fetched fansub tracks and fonts, and the BestSource index files (`bestsource/`, shared by `serve` and `encode` so an encode reuses the index the line-up built). It is `~/Library/Application Support/seikou-encode` on macOS and `$XDG_DATA_HOME/seikou-encode` (default `~/.local/share/seikou-encode`) elsewhere; `SEIKOU_ENCODE_DATA` names another.

### Offline mode

`SEIKOU_ENCODE_FIXTURE=<folder>` makes `serve` read SeaDex, Anime Tosho and AniList answers and AniList covers from recorded files in that folder (`seadex.json`, `tosho.json`, `anilist.json`, `files/`, `covers/`) instead of the network. It is for tests; `encoder/tests/fixtures/fansubs/` is an example with made-up titles.

Exit codes: 0 success, 1 encode or packaging failure, 2 usage error, bad episode spec, a saved record that does not match the encode (including one with no entry for an episode) or that ticks no audio stream for an episode, 3 required tools missing (for `serve` and `app`, the page not built).

`app [--root DIR]… [--port N] [--no-open]` starts the same backend with no helper session and opens its front page, printing `App: http://127.0.0.1:<port>/?t=<token>`. The page's disc library is every folder holding `BDMV/index.bdmv` up to four folders below the library folders: the ones saved in `settings.json` in the data directory (set from the page) and the `--root` folders of this run, which are not saved. A link that leads out of a library folder is not followed. With no saved folders and no `--root` it prints one line saying so (folders can be added in the app or with `--root DIR`). A folder that cannot be read (an unmounted drive) keeps the discs found under it in the last scan and is reported as unreadable. It needs the built page like `serve` does, and runs until Ctrl-C.

### Encode queue

`app` and `serve` both run an encode queue in the backend (`src/server/jobs.ts`). A job is one disc, playlist, episode list, copy of a profile's settings and output folder; jobs run one at a time, in the order they were queued, and keep running when the page is closed. The queue is kept in `jobs.json` in the data directory, and each job's log in `jobs/<id>.log`. Each job shows the `seikou-encode encode …` command that does the same (`--web` goes to `<output folder>/web`), and the command line keeps working on its own.

- **Output folder.** Any absolute folder, made when missing, except one inside a library folder, inside the disc, or inside the data directory other than its `output/` folder; the backend serves files only from the output folders of the jobs it made.
- **Subtitles.** Queuing a job checks the saved subtitle record against the job's playlist and episode list and refuses a mismatch, unless the job encodes without subtitles; with no record, the job encodes without them, as `encode` does. The job reads the record when it runs and remembers when that record was saved.
- **Episodes.** Each episode is encoded on its own and counts as done only once the queue saw it finish (with the web package, once packaged); a file found on disk never counts. Cancel stops every tool and removes the partial file. Retry (of a failed, interrupted or cancelled job) encodes only the episodes not done, and packages again, without encoding, an episode whose packaging failed; when the subtitle record was saved again since the job's first run, it encodes every episode, so one job never mixes two sets of subtitle choices.
- **Test encodes** go first: a running job stops after the episode in progress, the test runs, and the job resumes at its next episode. A test takes five 10-second stretches spread over the first episode (shorter ones for an episode under a minute), encodes each with one to three profiles' video settings and the first audio stream once (shared by every profile's sample), and writes each sample as WebM to `tests/<job id>/<profile>/<n>.webm` in the data directory, never to an output folder. The Test page plays a stretch's samples side by side in step and shows each profile's projected size per episode: its video bytes per second plus the shared audio's times the audio streams the encode would write, times the episode's length. A retry runs the whole test again; removing the job deletes its samples.
- **Restart.** A job that was running when the app stopped is marked interrupted and its `.partial` files are removed; queued jobs stay queued. Ctrl-C stops the running job the same way, waiting for its tools to exit. A damaged `jobs.json` is never written over: the queue answers with an error until the file is fixed or removed.

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
- [`src/server/`](src/server/README.md): the subtitle helper's local backend.
- [`web/`](web/README.md): the subtitle helper page.

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

## License

LGPL-3.0-or-later, like the rest of Seikou. See `LICENSE` and `COPYING` (GPL-3.0).
