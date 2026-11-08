# subs/: subtitles for the episodes an encode cuts

Fansub releases and the user's own files supply subtitles; this area decides what belongs to which episode and keeps what the user chose. Matching and conversion are pure code; only `record.ts` touches the disk.

## Concepts

- **Release, file, track.** A release (from Anime Tosho or the user's own files) is a set of files; each file (an episode's MKV) holds subtitle tracks, each with a name and a language.
- **Episode match.** A file's episode number comes from its name (`episodeOfFile` in `@seikou/fansubs`). Releases may number on from earlier seasons, so release number `n` is disc episode `n - episodeOffset`. Extras (creditless openings, previews), unnumbered files and numbers the disc does not hold are left unmatched. When a release has a corrected file (`02v2`), the highest version is chosen and the others stay as candidates.
- **Track kind.** A track named like signs, songs, "S&S" or forced is `signs` (only on-screen text and songs); every other track is `full` (all dialogue).
- **SRT becomes ASS on arrival.** A user's own SRT is converted once to ASS, so alignment, retiming, preview and the mux handle one format. The script is 1920x1080 with one Arial `Default` style, so a missing font falls back the way players fall back for SRT. `<i>`, `<b>` and `<u>` map to ASS overrides; other tags and brace blocks are dropped.
- **Timing in the MKV.** An episode's zero is its first video frame, and the muxed times are exactly the ones the helper previewed. The preview plays the backend's retimed copy and adds the nudge in the player, so the encode runs the script through `retime` from `@seikou/fansubs` with the track's alignment (the `split` part its start in the script falls in, else `shiftMs`). That clamps the times at 0 and rounds them to centiseconds. The encode then adds `nudgeMs` in whole milliseconds, positive meaning later, and only after that applies the drop and clamp rules.
- **Encodings.** Subtitle text must be UTF-8 or UTF-16 with a BOM. Other encodings are refused with `SubtitleEncodingError` instead of guessed, because a wrong guess shows up later as garbled dialogue.

## API

- `matchRelease(files, episodeNumbers, episodeOffset)` returns `{ rows, unmatched }`: one `MatchRow` per disc episode (`fileId` the chosen file or null, `candidates` newest version first) and the files that matched nothing.
- `trackKind(name)` returns `'full'` or `'signs'`.
- `srtToAss(text)` returns an ASS script.
- `decodeSubtitleText(bytes)` returns text, or throws `SubtitleEncodingError`.
- `appDataDir(env, platform, home)` returns the app data directory (`SEIKOU_ENCODE_DATA`, else Application Support on macOS, else `$XDG_DATA_HOME`).
- `episodeSubtitleTracks(record, episodeIndex, durationMs, dataDir)` returns `EpisodeSubtitles`: the episode's ticked tracks as `S_TEXT/ASS` tracks in record order (the first is default) and the record's fonts as attachments, with RFC 8081 media types (`FONT_MEDIA_TYPES`) and the names the cached release gives them, else the pooled file names. `trackAlignment(track)` is the alignment it passes to `retime`.
- `RecordStore(dataDir)` reads, writes (atomically) and checks the saved `SubtitleRecord` at `subtitles/<discKey>/<playlist>.json`; `parseRecord(json)` validates one and throws `RecordError` with the JSON path of the first bad field; `missingFiles(record)` names the release whose cached files are gone.
- `new ReleaseCache(dataDir, { tosho, fetchCache })` with `fetchTosho(id)` (no network the second time, unless a stored track or font file is gone; `NotFoundOnTosho` for an unknown release), `addLocal(files)` (stored again when a stored track or font file is gone; `UploadRejected` names the refused file), `get(key)` and `read(relPath)`; `readCachedRelease(dataDir, key)` reads a stored release without the download clients; a `CachedRelease` holds each file's tracks (path, kind, dialogue line count) and fonts, all paths relative to the data directory.

## Where to look

- `release-match.ts`: file-to-episode matching and track kinds.
- `srt-to-ass.ts`: decoding and SRT conversion; the SRT format has no specification, so the parsing is tolerant by design (see the comment at the top).
- `episode-subtitles.ts`: the episode's subtitle tracks and fonts for the muxer.
- `encode-record.ts`: `loadEncodeRecord` loads the record for an encode (null with `--no-subtitles` or none saved) and throws `RecordMismatchError` (another playlist or episode list) or `MissingSubtitleFilesError` (cached files gone).
- `record.ts`: the record's types, validation and store (paths inside it are relative to the data directory); `app-data.ts`: where that directory is.
- `release-cache.ts`: `ReleaseCache` downloads a release's tracks and fonts (or takes the user's own files) into `releases/<key>/`, with fonts pooled by content under `fonts/`; `release.json` is written last. `fixture-anilist.ts`: recorded AniList answers and cover images (`covers/`) for tests and offline runs.
- Tests: `encoder/tests/subs/`.
