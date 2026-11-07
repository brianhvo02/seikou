# plan/: from chapter ranges to frame and sample cuts

The planner decides exactly which frames and which audio samples of which clips make up each episode, and where the episode's chapters fall. It is pure: it takes a loaded playlist and the clip probes and returns plans, touching no files.

## Concepts

- **Episode.** A run of chapters of one playlist, written as a range (`1-3`). An episode runs from its first chapter's start to the start of the chapter after its last, or to the end of the playlist. Chapters between ranges belong to no episode.
- **Segment.** A playlist can span several clips, so an episode is a list of segments, one per clip it touches: a half-open frame range of the video and a half-open sample range of the audio, both within that clip.
- **Clocks.** Playlist and chapter times are 45 kHz ticks; PES timestamps are 90 kHz, so a time is doubled before it is compared with a PTS. Frame and sample indexes are rounded to nearest, so the same time always gives the same index and a cut lands on the closest frame.
- **Audio origin.** Audio samples are counted from the clip's first video PTS, not from the audio's own first PTS. BestSource (called with `adjustdelay=-1`) pads or trims the audio so its sample 0 coincides with the first video frame, so counting from the video makes the video and audio cuts cover the same stretch of time and the MKV needs no audio offset.
- **Chapters in the MKV.** An episode's chapters are placed on the millisecond grid the video blocks use (`videoMs`), so a chapter never falls between two frames' timestamps.

## API

- `parseEpisodeSpec(text, chapterCount)` returns `EpisodeSpec[]` and throws `EpisodeSpecError` for a bad list.
- `planEpisodes(playlist, probes, specs, audioPid)` returns one `EpisodePlan` per spec: segments, chapters, frame count, duration, and the video and audio attributes.
- `timing.ts`: `frameAt`, `sampleAt`, `framesToNs`, `frameDurationNs`, `videoMs`. Units are in the names (`*45`, `*90`, `*Ns`, `*Ms`).

## Where to look

- `episodes.ts`: the spec parser and the planner.
- `timing.ts`: the rounding rules. Change them here only; the muxer and the scripts rely on them.
- Tests: `encoder/tests/plan/`.
