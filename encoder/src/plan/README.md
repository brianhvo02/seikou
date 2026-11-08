# plan/: from chapter ranges to frame and sample cuts

The planner decides exactly which frames and which audio samples of which clips make up each episode, and where the episode's chapters fall. It is pure: it takes a loaded playlist and the clip probes and returns plans, touching no files.

## Concepts

- **Episode.** A run of chapters of one playlist, written as a range (`1-3`). An episode runs from its first chapter's start to the start of the chapter after its last, or to the end of the playlist. Chapters between ranges belong to no episode.
- **Segment.** A playlist can span several clips, so an episode is a list of segments, one per clip it touches: a half-open frame range of the video and, for each chosen audio stream, a half-open sample range at that stream's rate, all within that clip.
- **Audio streams by PID.** A playlist's audio streams are named by PID everywhere, because the STN table (a player's numbering), the CLPI, the PMT and the saved record can each list them in another order. `selectAudio` decides which streams an episode keeps and in what MKV order: without a saved record every main-path stream of the first play item in STN order, named after its language (`jpn` is `Japanese`, `und` is `Unknown`), the first default; with one, the episode's `metadata.audio` order, ticks, names and languages, the first kept stream default. A stream's channel count and sample rate come from the playlist's STN entry (what players go by; a clip's CLPI can disagree), its coding type from the CLPI. A playlist stream the record does not list is left out, and a record entry for a PID the playlist lacks is ignored, each with a warning.
- **BestSource track.** BestSource opens an audio stream by its position among the audio streams libavformat finds (`track=-n`), which follows the clip's PMT; the same PID can sit at another position in another clip. The planner gives each stream of each segment its `bsTrack` from that clip's PMT (`audioTrackIndex` in `disc/pmt.ts`) and fails naming the clip and PID when the PMT lacks it.
- **Clocks.** Playlist and chapter times are 45 kHz ticks; PES timestamps are 90 kHz, so a time is doubled before it is compared with a PTS. Frame and sample indexes are rounded to nearest, so the same time always gives the same index and a cut lands on the closest frame.
- **Audio origin.** Audio samples are counted from the clip's first video PTS, not from the audio's own first PTS. BestSource (called with `adjustdelay=-1`) pads or trims the audio so its sample 0 coincides with the first video frame, so counting from the video makes the video and audio cuts cover the same stretch of time and the MKV needs no audio offset.
- **Chapters in the MKV.** An episode's chapters are placed on the millisecond grid the video blocks use (`videoMs`), so a chapter never falls between two frames' timestamps.

## API

- `parseEpisodeSpec(text, chapterCount)` returns `EpisodeSpec[]` and throws `EpisodeSpecError` for a bad list.
- `selectAudio(playlist, probes, record, episodeIndex, warn?)` returns the episode's `SelectedAudio[]` (PID, name, language, default flag, coding type, channels, sample rate) in MKV order; `record` is the saved subtitle record or null.
- `planEpisodes(playlist, probes, specs, audio, pmts)` returns one `EpisodePlan` per spec: segments (each with `audioTracks`: PID, `bsTrack`, sample range per stream, in the order of `audio`), chapters, frame count, duration, and the video and per-stream audio attributes. `audio` lists the streams by PID with their sample rates (a `SelectedAudio[]` will do; empty plans no audio): samples are counted at that rate, the STN's, which is also the rate the audio guard holds the decode to, never at the CLPI's, and a play item whose STN entry gives a stream another rate is refused and `pmts` is `readPlaylistPmts(playlist)`. `firstFramePlaylistUs(playlist, plan)` is the playlist time of a plan's first frame, in microseconds.
- The helper's planner and the alignment audio use the playlist's first STN audio stream: `selectAudio(playlist, probes, null, 1)` cut to its first entry.
- `timing.ts`: `frameAt`, `sampleAt`, `framesToNs`, `frameDurationNs`, `videoMs`. Units are in the names (`*45`, `*90`, `*Ns`, `*Ms`).

## Where to look

- `episodes.ts`: the spec parser and the planner.
- `audio-streams.ts`: which audio streams an episode keeps.
- `timing.ts`: the rounding rules. Change them here only; the muxer and the scripts rely on them.
- Tests: `encoder/tests/plan/`.
