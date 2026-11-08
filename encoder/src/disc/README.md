# disc/: reading a Blu-ray disc folder

This area turns a decrypted BDMV folder into the facts the planner needs: which playlists exist, which clips each one plays, where its chapters are, and what each clip's streams are. It reads files through `@seikou/bdmv` (the MPLS and CLPI parsers and the transport-stream demuxer, ported from libbluray) and decodes nothing.

## Concepts

- **Playlist (MPLS).** `BDMV/PLAYLIST/NNNNN.mpls` lists play items in order. A play item names a clip and an `IN_time`/`OUT_time` range of it, and says how it joins the previous item (`connection_condition`). A playlist also has marks; the ENTRY marks inside their play item's range are its chapters.
- **Clip (m2ts and CLPI).** `BDMV/STREAM/NNNNN.m2ts` is an MPEG-2 transport stream in 192-byte source packets. `BDMV/CLIPINF/NNNNN.clpi` describes it: for each stream, its PID, coding type, and a 4-bit format code and a 4-bit rate code.
- **Times.** Playlist times are 45 kHz ticks, half the 90 kHz clock PES timestamps use. Names carry the unit: `*45`, `*90`.
- **Stream codes.** The format and rate codes are small enumerations (frame size and scan type, frame rate, channel layout, sample rate). `stream-codes.ts` maps them to numbers using libbluray's tables, because the Blu-ray specification is not public.
- **First PTS.** The CLPI does not say when a stream's first sample is presented. The probe reads the start of the m2ts to find the first PES timestamp of each stream, which is what lets the planner line audio up with video.

## API

- `loadPlaylist(discDir, id)` returns a `Playlist`: items (`PlaylistItem`), chapters (`Chapter`) and the total length. `listPlaylists(discDir)` lists every playlist with its length and clips. `bdmvRoot(dir)` accepts a disc folder or its BDMV folder. `chaptersFromMarks` is the pure chapter rule.
- `probeClip(item)` returns a `ClipProbe`: video frame size, rate, scan type and first PTS, and each audio stream's rate, channels and first PTS. Failures are `ProbeError`.
- `discKeyOfFolder(discDir)` returns a disc's key (`f.<content fingerprint>`, or `d.<id>` with no streams) and its label (the folder's name); the helper's routes and `encode` use it to find a saved record.
- `videoRate`, `videoFormat`, `audioRate` and `audioChannels` map CLPI codes and throw on a code the table lacks.

## Where to look

- `playlist.ts`: MPLS reading, play items, chapter marks.
- `probe.ts`: the m2ts scan for first timestamps and the CLPI stream lookup.
- `stream-codes.ts`: the code tables.
- Tests: `encoder/tests/disc/`, run against the synthetic discs in `encoder/fixtures/`.
