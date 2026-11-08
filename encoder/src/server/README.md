# server/: the subtitle helper's local backend

The subtitle helper is a web page that runs on the user's own machine. This backend serves that page and its API from one origin on `127.0.0.1`: the disc the page plays (in `@seikou/engine`, read over HTTP exactly as Seikou reads a NAS disc), the episode plan, and the routes later parts of the helper add (titles, fansubs, alignment, the saved record). One run serves one disc, one playlist and one episode list, fixed when it starts.

## Concepts

- **Context.** `HelperContext` holds everything a run serves: the disc folder, the playlist id, the episode list as typed, the data directory, the run's token, the page's folder, the external tools (or null when they are missing) and the outside sources (SeaDex, Anime Tosho, AniList and its cover images). Tests pass recorded sources.
- **Disc key.** The disc is named by `discKeyOf(id16, manifest.files)` from `@seikou/nas/disc-key`, where `id16` is the first 16 hex digits of the SHA-256 of the disc folder's real path. A disc with streams gets its content fingerprint (`f.<hex>`), so the same disc keeps its key in another folder; the key names the saved record.
- **The NAS disc API.** The manifest (every file under BDMV and CERTIFICATE, upper-case, with the small metadata files inlined) and range reads are answered by Seikou's own NAS modules (`server/src/manifest.ts` and `server/src/ranges.ts`), so the engine's `RemoteSource` and `HttpTransport` open the disc unchanged. File paths are matched in any case.
- **Playlist time.** Episode times are microseconds from the playlist's start. An episode starts at its first frame (its first chapter's mark rounded to the nearest frame, `firstFramePlaylistUs`), the zero of the encode, the alignment and the retimed track; its length is its whole frames at the video's rate, as the encoder will cut it (the planner, `planEpisodes`, reads the start of each clip once per run for its first timestamps and its PMT, and cuts the playlist's first STN audio stream).

## Security model

The server listens on `127.0.0.1` only, so nothing else on the network can reach it. Any web page the user has open can still send requests to it, so:

- **A token per run.** Each run gets a fresh random token (`ctx.token`, made by whoever starts the server); every `/api/` request must carry it as `Authorization: Bearer <token>` or `?t=<token>` (the engine's file reads use the query, so they need no preflight). Without it: 401 `unauthorized`. Tokens are compared in constant time.
- **The Host header.** Every request, page or API, must name `127.0.0.1:<port>` or `localhost:<port>`; anything else answers 403 `bad-host`. This stops DNS rebinding, where a page re-points its own host name at 127.0.0.1 to read the answers as same-origin.
- **Paths.** A path with an empty, `.` or `..` segment (also percent-encoded), or one that decodes to a slash, backslash or NUL, answers 400 `bad-path`. Disc files are found by listing each directory under BDMV or CERTIFICATE, never by joining the request's path, and page files must resolve inside the page's folder.
- **Covers.** The page is cross-origin isolated, and AniList's image host sends no `Cross-Origin-Resource-Policy`, so the page cannot show its images; the backend passes each cover on from its own origin (`covers.ts`), fetching only URLs AniList gave it in this run's searches, kept per run by AniList id.
- **No CORS.** No answer carries `Access-Control-Allow-Origin`, so another origin cannot read the API even with the token.
- **Isolation.** Every answer carries `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin` (the engine needs `SharedArrayBuffer`); API answers carry `Cache-Control: no-store`.

## API

- `startHelperServer(ctx, port = 0)` reads the disc, listens on `127.0.0.1:<port>` and resolves to `{ url, port, close() }`; it rejects when the folder is not a Blu-ray folder or the port cannot be bound.
- `http.ts`: `HelperContext`, `HelperSources`, `Route` (`(req, res, match, ctx) => Promise<void>`, with `match` the route's pattern run on the still percent-encoded path), `RouteTable` (`[method, pattern, route]` entries), `json(res, status, body)`, `httpError(res, status, code, message?)` and `sendFile(req, res, path, size, headers)` (whole or one range).
- A route module exports its `RouteTable`; `server.ts` concatenates them in `ROUTES`. A path that matches with another method answers 405 `method-not-allowed`, no match 404 `not-found`, a route that throws 500 `internal`. Errors are JSON `{ error, message? }`.

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/session` | `{ discKey, label, playlistId, episodeSpec, toolsReady }`; `label` is the disc folder's name |
| GET | `/api/discs/<discKey>/manifest` | the NAS `DiscManifest` |
| GET, HEAD | `/api/discs/<discKey>/files/<path>` | the file, whole (200) or one `Range` (206); 416 past the end; 404 `not-found` for a missing file |
| GET | `/api/playlists` | `[{ id, duration45, clipIds }]`, every playlist of the disc |
| GET | `/api/episodes` | `{ episodes: [{ index, startUs, durationUs, chapters: [{ startUs }] }], audio: [{ pid, codingType, language }], pgCount }`; audio and PG streams of the first play item, from the playlist's STN table; 422 `bad-episode-spec` or `no-audio` |
| GET | `/api/titles/search?q=` | `{ candidates: TitleHit[] }` from AniList in its order (`alId`, `title`, `nativeTitle`, `year`, `format`, `episodes`, `poster`); `poster` is the path of the cover route below, or null; 400 `empty-query` for a blank `q` |
| GET | `/api/titles/<alId>/episodes` | `{ titles: { [episode]: title } }`, empty when AniList has none |
| GET | `/api/titles/<alId>/cover` | the show's cover image with its own content type (PNG, JPEG, GIF, WebP or AVIF), fetched from the URL a search of this run got from AniList for that id (never a URL the client sends; at most 5 MB, 10 s); 404 `not-found` when no search gave a cover for it, 502 `bad-cover` for an answer that is not such an image or is larger, 503 `source-unavailable` (`anilist`) when the image host fails |
| GET | `/api/fansubs/seadex?anilist=<id>` | `{ notes, comparison, url, releases }`: public releases in `rankReleases` order, private-tracker ones after, each with `toshoId` and `unavailable` (`null`, `private-tracker` or `not-on-tosho`) |
| GET | `/api/fansubs/search?q=` | Anime Tosho releases `[{ toshoId, title, date }]` |
| POST | `/api/fansubs/fetch?offset=` | body `{ toshoId }`; the cached release plus `match: { rows, unmatched }` against episodes 1 to N of the run's episode plan (the one `/api/episodes` answers from; its 422s too), `offset` default 0 |
| PUT | `/api/uploads/<batch>/<name>` | one raw file of an upload batch (`batch`: 16 lower-case hex digits; `name`: a plain file name); 413 `too-large` with `Connection: close` over 50 MB |
| POST | `/api/uploads/<batch>/commit?offset=` | the batch as a local release, answered as fetch is; the batch folder is removed; 422 `upload-rejected` or `bad-encoding` |
| GET | `/api/releases/<key>?offset=` | a cached release plus `match`; 404 `not-found` |
| GET | `/api/releases/<key>/fonts/<name>` | the font's bytes |
| POST | `/api/episodes/<n>/align` | body `{ release, fileId }`; `{ alignment, trackId, speech, dialogue }`: the `FansubAlignment` found by lining the file's track with the most dialogue (`trackId`) up against episode n's disc audio, the disc's speech as `{ fromMs, toMs }` spans over the whole episode (runs under 200 ms apart joined), and the track's dialogue lines at its own timing; 503 `tools-missing` without vspipe and BestSource; 404 `not-found` for an unknown episode, release or file |
| GET | `/api/episodes/<n>/subtitle?release=&file=&track=&timing=` | the track as `text/plain; charset=utf-8`, retimed with `timing` (base64url JSON of a `FansubAlignment`; absent is the track's own timing, byte for byte); 400 `bad-request` for a malformed timing |
| GET | `/api/record` | `{ record, missing }` for the run's disc and playlist: `record` is the saved subtitle record or null (never 404), `missing` lists the cached files it names that are gone, as `[{ release, files }]` by release label; an invalid file on disk answers `record: null` with `error: { code: 'record-unreadable', message }` |
| PUT | `/api/record` | body: a record; its disc key, playlist and episode spec must be the run's (409 `session-mismatch`); `savedAt` is set by the server and the stored record answered; 400 `bad-record` with `message` and the JSON `path` of the bad field; 413 `too-large` with `Connection: close` over 2 MB |
| GET, HEAD | anything else | a file of the page's folder (`/` is `index.html`), no token needed |

Episodes are numbered from 1 in the run's episode list, and their times are milliseconds from the episode's first frame. Lining up decodes the episode's audio through vspipe once (BestSource keeps its index under `<data>/bestsource`, where the encode finds it too) and keeps the last two decodes; decodes run one at a time, and a client that goes away stops a decode no other request waits for. Track ids repeat between a release's files, so the subtitle route names the file as well as the track.

There is no automatic lookup of the show from the disc: the AniList id is whatever the user searched for and picked. A failing or throttled upstream answers 503 `source-unavailable` with the failing `source` (`anilist`, `seadex` or `tosho`); an Anime Tosho release that does not exist answers 404 `not-on-tosho`. Uploads wait in `<data>/uploads/<batch>/` until commit.

A `<discKey>` other than the run's answers 404 `disc-changed`, which the engine reports as a changed disc.

## Where to look

- `server.ts`: the listener, the Host, path and token checks, routing and the page's files.
- `http.ts`: the context and route types and the answer helpers.
- `disc-routes.ts`: the session, the NAS disc API, playlists and episode times.
- `title-routes.ts`: the AniList search, episode titles and covers.
- `covers.ts`: fetching a cover (`createCoverSource`: https only, a size cap, a timeout, image types only).
- `fansub-routes.ts`: SeaDex, Anime Tosho, uploads and cached releases (one `ReleaseCache` per run, kept beside the context, `releaseCacheOf`).
- `align-routes.ts`: lining an episode up against the disc's audio, and the retimed track. The episode plan comes from `episodePlans` in `disc-routes.ts`, the same one `GET /api/episodes` answers from.
- `record-routes.ts`: reading and saving the subtitle record (`RecordStore` in `subs/record.ts` does the files).
- Tests: `encoder/tests/server/`.
