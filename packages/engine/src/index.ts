// SPDX-License-Identifier: LGPL-3.0-or-later
// @seikou/engine: the browser Blu-ray player engine (its worker) and the page-side controller that drives it.
// Named exports only: @seikou/pg and @seikou/ass each have their own Rect.

/** Starts the package's engine worker (no BD-J); `name` is the worker's name, `bluray-engine` or with test flags. */
export function createEngineWorker(name: string): Worker {
  // (the options stay an object literal with a literal type: Vite reads it to bundle the worker as a module)
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name });
}

export { createController, type CreateControllerOptions } from './controller/create-controller';
export { PlayerController, INITIAL_SNAPSHOT, type PlayerSnapshot, type Notice, type IndexTitles, type SubtitlesState } from './controller/player-controller';
export { PlatformSession } from './controller/platform-session';
export { walkEntries, type EntryLike, type FileEntryLike, type DirEntryLike } from './controller/entry-walk';
export {
  BDJ_STORAGE_MESSAGE,
  ENCODE_FILE,
  ENCODE_PLAYLIST_ID,
  NO_PICTURE_MESSAGE,
  type AudioTrack,
  type BdjMemoryTelemetry,
  type BdjStartup,
  type BdjTelemetry,
  type BufferRequest,
  type ChannelsLabel,
  type EncodeSpec,
  type EngineCommand,
  type EngineEvent,
  type ErrorCode,
  type FileData,
  type MenuKey,
  type NoticeCode,
  type PgTrack,
  type PlaceState,
  type PlaybackState,
  type ShaderSetData,
  type ShaderState,
  type StartPoint,
  type SubtitleChoice,
  type Telemetry,
  type TextFileInfo,
} from './protocol';
export { MEMORY_PROFILES, type MemoryProfile, type MemoryProfileName } from './memory-profile';
export { createByteSource, type DiscSpec, type RemoteDiscSpec } from './disc/disc-spec';
export { HttpTransport, type HttpTransportOptions } from './disc/http-transport';
export { RemoteSource, type RemoteSourceOptions, type RangeTransport } from './disc/remote-source';
export { openDisc, type DiscModel } from './disc/open-disc';
export { BDJ_RUNTIME, bdjUnsupportedMessage, type BdjInputProvider, type BdjProvider } from './bdj-provider';
export type {
  BackgroundStillLike,
  BdjSessionLike,
  EarlyBdjWorkerLike,
  GraphicsPlaneReaderLike,
  InputLatencyLike,
  PlayerBdjHostLike,
  StatusBlockWriterLike,
  TapReactionWatchLike,
  WorkerLike,
} from './bdj-types';
