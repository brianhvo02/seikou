// SPDX-License-Identifier: LGPL-3.0-or-later
// @seikou/engine: the browser Blu-ray player engine (its worker) and the page-side controller that drives it.
// Named exports only: @seikou/pg and @seikou/ass each have their own Rect. Everything else is internal, reached through ./*.

/**
 * Starts the package's engine worker (no BD-J); `name` is the worker's name, `bluray-engine` or with test flags.
 * @example ../examples/create-controller.browser.ts
 */
export function createEngineWorker(name: string): Worker {
  // (the options stay an object literal with a literal type: Vite reads it to bundle the worker as a module)
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name });
}

// Building a controller in a page.
export { createController, type CreateControllerOptions } from './controller/create-controller';
// The page-side store that drives the engine, its snapshot, and what it is built on.
export {
  PlayerController,
  type PlayerSnapshot,
  type Notice,
  type IndexTitles,
  type SubtitlesState,
  type WorkerLike,
  type AudioOutputLike,
  type VisibilityLike,
} from './controller/player-controller';
// Wake Lock and Media Session.
export { PlatformSession, type NavigatorLike } from './controller/platform-session';
// Turning dropped files and folders into a disc's entries.
export { walkEntries, type EntryLike, type FileEntryLike, type DirEntryLike } from './controller/entry-walk';
// The contract between page and worker: commands, events, telemetry and their parts.
export type {
  EngineCommand,
  EngineEvent,
  Telemetry,
  BdjTelemetry,
  BdjStartup,
  BdjMemoryTelemetry,
  StartPoint,
  PlaceState,
  BufferRequest,
  EncodeSpec,
  FileData,
  SubtitleChoice,
  ShaderSetData,
  ShaderState,
  MenuKey,
  AudioTrack,
  ChannelsLabel,
  PgTrack,
  TextFileInfo,
  PlaybackState,
  NoticeCode,
  ErrorCode,
} from './protocol';
// BD-J memory figures that telemetry reports.
export type { JvmMemoryStats } from './bdj-types';
// Which clock playback runs on.
export type { ClockMode } from './clock/master-clock';
// The memory profile names.
export type { MemoryProfileName } from './memory-profile';
// The user operations a disc can mask.
export type { UoOp } from './hdmv/uo-mask';
// A playlist's chapters.
export type { Chapter } from './nav/timeline';
// Which disc to open: local files or a server's disc.
export type { DiscSpec, RemoteDiscSpec } from './disc/disc-spec';
// Opening a disc and what it holds.
export { openDisc, type DiscModel, type PlaylistSummary } from './disc/open-disc';
// Reading a server's disc with read-ahead.
export { RemoteSource, type RemoteSourceOptions, type RangeTransport, type ChunkCache } from './disc/remote-source';
// Range requests to a server.
export { HttpTransport, type HttpTransportOptions, RemoteDiscError, type RemoteFailure } from './disc/http-transport';
