# subs/: subtitles for the episodes an encode cuts

Fansub releases and the user's own files supply subtitles; this area decides what belongs to which episode and keeps what the user chose. Matching and conversion are pure code; only `record.ts` touches the disk.

## Concepts

- **Release, file, track.** A release (from Anime Tosho or the user's own files) is a set of files; each file (an episode's MKV) holds subtitle tracks, each with a name and a language.
- **Episode match.** A file's episode number comes from its name (`episodeOfFile` in `@seikou/fansubs`). Releases may number on from earlier seasons, so release number `n` is disc episode `n - episodeOffset`. Extras (creditless openings, previews), unnumbered files and numbers the disc does not hold are left unmatched. When a release has a corrected file (`02v2`), the highest version is chosen and the others stay as candidates.
- **Track kind.** A track named like signs, songs, "S&S" or forced is `signs` (only on-screen text and songs); every other track is `full` (all dialogue).
- **SRT becomes ASS on arrival.** A user's own SRT is converted once to ASS, so alignment, retiming, preview and the mux handle one format. The script is 1920x1080 with one Arial `Default` style, so a missing font falls back the way players fall back for SRT. `<i>`, `<b>` and `<u>` map to ASS overrides; other tags and brace blocks are dropped.
- **Encodings.** Subtitle text must be UTF-8 or UTF-16 with a BOM. Other encodings are refused with `SubtitleEncodingError` instead of guessed, because a wrong guess shows up later as garbled dialogue.

## API

- `matchRelease(files, episodeNumbers, episodeOffset)` returns `{ rows, unmatched }`: one `MatchRow` per disc episode (`fileId` the chosen file or null, `candidates` newest version first) and the files that matched nothing.
- `trackKind(name)` returns `'full'` or `'signs'`.
- `srtToAss(text)` returns an ASS script.
- `decodeSubtitleText(bytes)` returns text, or throws `SubtitleEncodingError`.
- `appDataDir(env, platform, home)` returns the app data directory (`SEIKOU_ENCODE_DATA`, else Application Support on macOS, else `$XDG_DATA_HOME`).
- `RecordStore(dataDir)` reads, writes (atomically) and checks the saved `SubtitleRecord` at `subtitles/<discKey>/<playlist>.json`; `parseRecord(json)` validates one and throws `RecordError` with the JSON path of the first bad field; `missingFiles(record)` names the release whose cached files are gone.

## Where to look

- `release-match.ts`: file-to-episode matching and track kinds.
- `srt-to-ass.ts`: decoding and SRT conversion; the SRT format has no specification, so the parsing is tolerant by design (see the comment at the top).
- `record.ts`: the record's types, validation and store (paths inside it are relative to the data directory); `app-data.ts`: where that directory is.
- Tests: `encoder/tests/subs/`.
