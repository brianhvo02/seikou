# disc/: reading a Blu-ray disc folder

This area turns a decrypted BDMV folder into the facts the planner needs: which playlists exist, which clips each one plays, where its chapters are, and what each clip's streams are. It reads files through `@seikou/bdmv` (the MPLS and CLPI parsers and the transport-stream demuxer, ported from libbluray) and decodes nothing.

## Concepts

- **Playlist (MPLS).** `BDMV/PLAYLIST/NNNNN.mpls` lists play items in order. A play item names a clip and an `IN_time`/`OUT_time` range of it, and says how it joins the previous item (`connection_condition`). A playlist also has marks; the ENTRY marks inside their play item's range are its chapters.
- **Clip (m2ts and CLPI).** `BDMV/STREAM/NNNNN.m2ts` is an MPEG-2 transport stream in 192-byte source packets. `BDMV/CLIPINF/NNNNN.clpi` describes it: for each stream, its PID, coding type, and a 4-bit format code and a 4-bit rate code.
- **Times.** Playlist times are 45 kHz ticks, half the 90 kHz clock PES timestamps use. Names carry the unit: `*45`, `*90`.
- **Stream codes.** The format and rate codes are small enumerations (frame size and scan type, frame rate, channel layout, sample rate). `stream-codes.ts` maps them to numbers using libbluray's tables, because the Blu-ray specification is not public.
- **PAT and PMT.** A transport stream lists its programs in the PAT (PID 0) and each program's streams, with their stream types, in a PMT (ISO/IEC 13818-1 §2.4.4.3 and §2.4.4.8). A Blu-ray clip holds one program and carries both tables from its first packets. libavformat, and so BestSource, numbers a clip's audio streams in PMT order, adding an AC-3 stream right after each TrueHD stream (the AC-3 version TrueHD carries) in a program registered as "HDMV"; `pmt.ts` reads the tables from the first 1,000 packets to work out that number for a PID.
- **PG streams.** Presentation graphics (bitmap subtitle) streams are listed in each play item's STN table with coding type 0x90. Each PES on a PG PID holds whole PG segments (segment type, 16-bit length, data), each PES with its own PTS; a display set runs from a composition segment (PCS, type 0x16) to an END segment (0x80) and is presented at the PCS's PTS. The PCS's composition_state says whether it starts an epoch (Epoch Start), repeats everything a decoder needs (Acquisition Point) or only updates the epoch before it (Normal). Matroska's `S_HDMV/PGS` stores the segments unchanged, so they are copied, never decoded.
- **First PTS.** The CLPI does not say when a stream's first sample is presented. The probe reads the start of the m2ts to find the first PES timestamp of each stream, which is what lets the planner line audio up with video.

## API

- `loadPlaylist(discDir, id)` returns a `Playlist`: items (`PlaylistItem`, with the main-path audio PIDs and their STN languages, format codes and rate codes, the main-path PG PIDs (`PG_CODING_TYPE`) and their languages, and the STC sequence the item plays), chapters (`Chapter`) and the total length. `listPlaylists(discDir)` lists every playlist with its length and clips. `bdmvRoot(dir)` accepts a disc folder or its BDMV folder. `chaptersFromMarks` is the pure chapter rule.
- `probeClip(item)` returns a `ClipProbe`: video frame size, rate, scan type and first PTS, and each audio stream's rate, channels and first PTS. Failures are `ProbeError`.
- `readPmt(m2tsPath, maxPackets = 1000)` returns a `PmtInfo` (PMT PID, streams in PMT order with PID and stream type, whether the program is "HDMV"); `readPlaylistPmts(playlist)` reads every clip's, keyed by clip id. `audioTrackIndex(pmt, pid)` is the PID's 1-based BestSource audio track number. Failures are `PmtError`, naming the clip, or the PID and the PMT's PIDs.
- `episodePgsTracks(plan, playlist, log?)` returns one `S_HDMV/PGS` track per main-path PG stream of the playlist's first play item, in STN order, named `<Language> (disc)` with the STN language, never default; empty when the playlist has none. A later play item's stream is matched by STN position when the language agrees, else by language; with none in that language `log` gets a line and the track shows nothing there. `groupDisplaySets` joins a stream's PES, in stream order, from a PCS through its END into one display set timed at the PCS's PTS (the other segments' PES carry decode timing, usually earlier); each display set is one block, at its PTS measured from the episode's first video frame (later clips placed after the frames before them, the 33-bit wrap folded). A display set belongs to the frame nearest its PTS, as the planner rounds chapter marks, and is kept when the episode plays that frame (one just before a part's first frame is clamped to it). A stream's display sets are dropped until its first Epoch Start or Acquisition Point, counted from the episode's start and again after every non-seamless join (connection_condition other than 5 or 6). It reads only from the EP entry 10 s before each clip part to the one after its end. `encode` adds the tracks unless `--no-pgs` is given.
- `discKeyOfFolder(discDir)` returns a disc's key (`f.<content fingerprint>`, or `d.<id>` with no streams) and its label (the folder's name); the helper's routes and `encode` use it to find a saved record.
- `videoRate`, `videoFormat`, `audioRate` and `audioChannels` map CLPI and STN codes and throw on a code the table lacks. The combo rate codes (12, 14: a lossless stream with a 48 kHz core) map to the lossless rate (192 and 96 kHz), the rate BestSource decodes them at.

## Where to look

- `playlist.ts`: MPLS reading, play items, chapter marks.
- `probe.ts`: the m2ts scan for first timestamps and the CLPI stream lookup.
- `pgs.ts`: the PG streams of an episode as `S_HDMV/PGS` tracks.
- `pmt.ts`: the PAT/PMT reader and the PID-to-BestSource-track rule.
- `stream-codes.ts`: the code tables.
- Tests: `encoder/tests/disc/`, run against the synthetic discs in `encoder/fixtures/`.
