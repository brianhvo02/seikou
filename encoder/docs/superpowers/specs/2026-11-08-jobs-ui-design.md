# Encoder Jobs UI: Design

Date: 2026-11-08
Status: Implemented on 2026-11-08 (plan `2026-11-08-m4-jobs-ui.md`)
Parents: `2026-11-06-encoding-tools-design.md` (milestone 4: "Web UI and job runner. Disc browser, chapter grouping with a preview, encode queue, logs and progress, settings profiles (SilentAperture-style test-encode helper)") and `2026-11-07-subtitle-helper-design.md` (milestone 4 "Web UI for jobs", with the chapter-grouping preview the user asked for on 2026-11-07: "the playlist plays in `@seikou/engine` as in the helper, the chapter list shows each mark's time, a click jumps there, and the user groups chapters into episodes while watching").

## 1. Intent

Today an encode takes three commands and two copied arguments: `plan` to read chapter times, `serve <disc> --playlist --episodes` for subtitles, then `encode` with the same playlist and episode list, left running in a terminal with no progress. Milestone 4 turns the encoder into one local app: open it, pick a disc from your library, watch the playlist and group its chapters into episodes, do the subtitles in the helper you already have, choose settings, queue the encode, and watch it progress. Several discs can be queued and left to run.

## 2. Goals, non-goals, anti-goals

Goals:
- One command, `seikou-encode app` (designer's call on the name), starts the backend and opens the app; it lists the disc folders under the library roots it was given.
- A disc page lists its playlists (length, clips, chapter count) and opens one.
- Chapter grouping with a preview: the playlist plays in `@seikou/engine`; a chapter list shows each mark's time; clicking one jumps there; the user groups chapters into episodes (a split after any chapter; skip a range, as `--episodes` allows today) while watching.
- The subtitle helper opens on the chosen disc, playlist and episodes from inside the app, with no command.
- Settings profiles: named sets of encode settings (CRF, preset, film grain, extra SVT arguments, Opus bitrate, PGS on or off, `--web`), a default profile with the current defaults, editable in the app.
- A test encode: a short sample of the episodes (designer's call: five 10-second stretches spread over the first episode) encoded with one to three profiles, reporting each profile's projected size per episode and letting the user watch the samples in the browser side by side, to choose settings before a long encode (the SilentAperture method, minus the 2-pass step: our encodes are CRF).
- A queue of jobs (one job = one disc, playlist, episode list, profile, output folder), run one at a time in the backend, with per-episode progress (frames done of frames planned, speed, time left), a live log, cancel, and retry of a failed job.
- The queue survives a restart of the app: queued jobs stay queued; a job that was running is marked interrupted, its partial episode removed, and can be retried; finished episodes are not encoded again on retry (designer's call: retry skips episodes whose MKV exists and is complete).

Non-goals:
- The player (milestone 5) and delivery (milestone 6).
- Encoding several jobs at once (one SVT-AV1 instance already uses every core; designer's call).
- Quality metrics (SSIMULACRA2, VMAF) in the test encode: they need tools the encoder does not ship; the user compares by eye. A later milestone may add them.
- ISO images in the library (the encode reads clip files through BestSource; ISOs need extraction or a VapourSynth source that reads UDF; later).
- Remote use: the app stays on 127.0.0.1 with its per-run token, like the helper.
- Filtering (descale, denoise, deband): later, per the parent spec.

Anti-goals:
- A UI that hides what the CLI does: every job shows the equivalent `seikou-encode encode …` command, and the CLI keeps working on its own.
- A queue that can lose work silently: a crash or restart never leaves a half-written MKV that looks finished.
- A second copy of the helper: the jobs UI links into the existing helper pages, it does not rebuild them.

## 3. The user's flow

1. **Library.** The app opens on the discs under its roots (folders containing `BDMV/index.bdmv`, up to four levels deep, as Seikou's dev disc server finds them; designer's call), each with its folder name, playlist count, whether subtitle choices are saved for it, and its jobs. A filter box narrows the list.
2. **Disc.** The disc's playlists, longest first, with length, clip count and chapter count. The likely main playlists (long, many chapters) are marked; the user opens one.
3. **Episodes.** The playlist plays (preview, same engine and player surface as the helper's step 3). Beside it, the chapter list: number, start time, length. A click on a chapter jumps there. Between chapters the user toggles a split, and can mark a chapter "skip" (for recaps or previews before the next episode). The result is shown as episodes with their lengths, and as the `--episodes` text, editable directly. When a subtitle record exists for this playlist, its episode list is loaded; changing it warns that the saved subtitle choices will no longer match.
4. **Subtitles.** "Choose subtitles" opens the helper on this disc, playlist and episode list (the helper's three steps as they are). "Encode without subtitles" skips it.
5. **Settings and test.** Pick a profile (or edit one), optionally run a test encode with up to three profiles, watch the samples, read the projected sizes, pick.
6. **Queue.** Choose the output folder (default `<data>/output/<disc label>/<playlist>`; designer's call) and add the job. The queue page shows every job: state (queued, running, done, failed, interrupted, cancelled), per-episode progress, the log, the CLI command, and links to the output files (and the web directory with `--web`).

## 4. Constraints

- The documentation standard of the subtitle helper spec §4 applies (doc comments, format citations, no internal history in comments, READMEs per area).
- Everything in the parent spec holds: LGPL-3.0-or-later, no ffmpeg, tools as subprocesses, decrypted discs only, AV1 + Opus.
- Look: the helper's (Instrument Sans, the same palette, one accent, single column usable at 375 px except the episodes page, which may lay the player and the chapter list side by side on wide screens; designer's call).
- The app reuses the helper backend and page: one server, one Vite build, more routes and pages (designer's call). The helper's `serve` command keeps working and opens the helper directly, as today.
- Local only: 127.0.0.1, per-run token, Host check, path checks, as the helper backend does today. The library roots are given on the command line or in the app's settings file; the backend never reads outside them (and the data directory).
- The engine plays discs over the existing NAS-compatible disc routes; the disc id in the URL is the disc key, so several discs can be open over the app's life.

## 5. Architecture (designer's call where not stated above)

- **Library:** `GET /api/library` lists discs under the roots (found by a background scan at start and on demand, cached in memory; the folder's real path hashes to its key as the helper does). Disc routes take the disc key in the path (the helper's routes today assume one session disc; they become per-disc, with the session kept for `serve`).
- **Playlists and chapters:** `GET /api/discs/<key>/playlists` and `GET /api/discs/<key>/playlists/<id>` (chapters with start and length), from the existing `listPlaylists`/`loadPlaylist`.
- **Jobs:** a `JobRunner` in the backend owns the queue: `jobs.json` in the data directory (atomic writes), one job at a time, running `encodeEpisodes` in-process with an `AbortSignal` (cancel kills the tool chains, as an encode failure does) and its `onEvent` feeding progress and the log. Progress comes from the writer's video packet count against the plan's frame count, reported at most once a second; speed and time left from that. Logs are kept per job (`jobs/<id>.log`, last 2,000 lines shown). Routes: `GET /api/jobs`, `POST /api/jobs`, `POST /api/jobs/<id>/cancel`, `POST /api/jobs/<id>/retry`, `DELETE /api/jobs/<id>` (finished ones), and a server-sent events stream `GET /api/jobs/events` for live progress.
- **Partial files:** episodes are written to `<name>.mkv.partial` and renamed when complete (this was a milestone 1 backlog item); a restart removes `.partial` files of interrupted jobs; retry skips an episode whose `.mkv` exists.
- **Profiles:** `profiles.json` in the data directory; the default profile is built in and cannot be deleted; a job stores a copy of its profile's settings, so editing a profile never changes a queued job.
- **Test encode:** a job kind of its own in the same queue (so it never runs beside a real encode), encoding the sample stretches through the normal pipeline with an episode plan built from the stretches, writing to a temporary folder, packaged as WebM for the browser; the app shows the samples in `<video>` elements in a grid (AV1 WebM plays in Chrome, Firefox and Safari on Apple silicon M3/A17 Pro and newer, per the parent spec) and the projected size per episode from bytes per second of each sample.
- **Pages:** Library, Disc, Episodes (chapter grouping), Settings (profiles), Test, Queue; the helper's pages as they are, reached from Episodes.
- **Progress everywhere** (added 2026-11-08 at the user's request): the app bar on every page, the helper's included, shows the running job in one line (disc label, episode n of m, percent, time left), fed by the same event stream as the Queue page, linking to the job; it shows nothing when the queue is idle. Encoding runs in the backend, so closing or reloading a tab never stops it; a reopened page picks the progress up from the stream.

### 5.1 Calls made after the builder check (designer's calls)

- **Subtitle record and jobs.** Queuing a job checks the saved record against the job's playlist and episode list. On a mismatch the app refuses to queue and offers "Encode without subtitles" or "Open the helper". The job reads the record when it runs, as the CLI does. The job stores the record's `savedAt` from its first run; a retry whose record has changed since re-encodes every episode instead of skipping finished ones, so one job's episodes never mix two sets of subtitle choices.
- **Retry skips only this job's finished episodes,** as recorded in the job's own state, never a file it merely finds; the skipping lives in the runner, and the CLI keeps overwriting. A `--web` episode whose MKV finished but whose packaging failed is retried by packaging only.
- **Test encodes go to the front.** A test job runs at the next episode boundary of the running job: the runner finishes the episode in progress, runs the test, then resumes the job at its next episode (episodes are encoded independently, so nothing is lost). With nothing running it starts at once.
- **The helper inside the app.** The backend holds helper sessions (disc, playlist, episode list), each with an id; the helper's routes move under `/api/sessions/<id>/…` and the page takes the session id from its URL. `serve` creates one session and opens it, so it behaves as today. Two tabs on two discs work side by side.
- **Output folders.** Any absolute folder the user picks; the backend writes there and serves files only from the output folders of jobs it created (kept in `jobs.json`), never other paths.
- **Test samples** encode the video with each profile and the first audio stream once (shared across profiles; audio is not what is compared); the browser samples play with that audio. The projected size per episode is the video's bytes per second from each profile's samples, plus the audio bytes per second of the shared sample multiplied by the number of audio streams the job would encode.

## 6. Data

- `<data>/jobs.json`: `{ jobs: Job[] }`, `Job = { id, kind: 'encode' | 'test', disc: { key, label, dir }, playlist, episodeSpec, settings, outDir, state, createdAt, startedAt?, finishedAt?, episodes: { index, state, framesDone, frames, path?, error? }[], error? }`.
- `<data>/profiles.json`: `{ profiles: { id, name, settings }[] }`.
- `<data>/settings.json`: `{ roots: string[] }` (the command line's `--root` adds to it for the run).
- The subtitle record is unchanged.

## 7. What is left to the builder

- Route shapes beyond those named, error bodies, the SSE event shape.
- The pages' layout within the look; the chapter list's controls for splitting and skipping.
- How the library scan paces itself on a large NAS mount.
- Whether `encodeEpisodes` gains a progress callback or the runner wraps the writer's counts.

## 8. Milestones after this

5. Player (unchanged). 6. Delivery (unchanged).
