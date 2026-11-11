// SPDX-License-Identifier: LGPL-3.0-or-later
// @seikou/fansubs: finding fansub releases and lining their subtitles up with a disc. Everything else is internal, reached through ./*.

// The SeaDex client.
export { createSeaDex, type SeaDex, type SeaDexEntry, type SeaDexRelease } from './seadex';
// The Anime Tosho client.
export { createTosho, type Tosho, type ToshoRelease, type ToshoFile, type ToshoTrack } from './tosho';
// Ranking releases and choosing a file per episode.
export { choosePerEpisode, rankReleases, type Candidate, type EpisodeChoice } from './choose';
// Which episode a release's file holds.
export { episodeOfFile, mainFile } from './episode-files';
// Fetching and naming a track.
export { fetchTrack } from './tracks';
// Unpacking xz tracks and 7z font packs.
export { unxz, fontsIn7z, TooLargeArchive } from './archive';
// The download cache.
export { FetchCache } from './fetch-cache';
// Limiting concurrent jobs.
export { Semaphore } from './semaphore';
// How the package reads a disc's files.
export type { FansubDiscSource, FansubClipSource } from './disc-source';
// The audio decoder the host injects.
export type { AudioDecoder, AudioDecodeInput } from './audio-decoder';
// A playlist's dialogue audio, read from the disc.
export { episodeAudio, type TimeWindow, type AudioWindow } from './disc-audio';
// Which ASS events are speech.
export { dialogueIntervals } from './dialogue';
// Lining a track up with the disc's audio.
export { align, type AlignOptions } from './align';
// Shifting Dialogue lines.
export { retime } from './retime';
// A viewer's own picks within a byte budget.
export { PickStore, type PickStoreOptions, type PickFile } from './pick-store';
