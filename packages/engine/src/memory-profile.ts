export type MemoryProfileName = 'desktop' | 'constrained';

const MB = 1024 * 1024;

/** Memory limits that differ between desktop browsers and phones or tablets. */
export interface MemoryProfile {
  /** An IG sub-path clip larger than this is not preloaded. */
  readonly igPreloadLimitBytes: number;
  readonly assEventCacheBytes: number;
  readonly assLayerCacheBytes: number;
  readonly assMaskCacheBytes: number;
  /** Upper bound of the per-side supersampling of ASS text masks. */
  readonly maxTextSupersampling: number;
  /** Decoded frames held for the presenter, for a stream of this coded width. */
  readonly maxQueuedFrames: (codedWidth: number) => number;
  /** How long a tap on a BD-J menu waits for the disc to react before it counts as ignored (the responsiveness target, 5d spec §3). */
  readonly bdjTapWindowMs: number;
  /*
   * BD-J (5d spec §4.5). The constrained values are first estimates from the desktop measurement of A_NEW_ERA and
   * RENTAL_FAMILY in the Node replay (classes keep 1.3 MB, the memory mounts hold 4.4 MB, one 1080p still decodes to
   * 7.9 MB); the device measurement sets them (5d plan, Task 14).
   */
  /**
   * Class-file bytes the JVM's classes keep (code and annotations; the rest of each class file is dropped once it is
   * parsed). Going over is logged once; nothing else changes.
   */
  readonly bdjClassCacheBytes: number;
  /**
   * The BD-J file system's memory mounts (/tmp/ with libbluray's copies of the disc's JARs and the files it extracts
   * from them, /persistent/, /buda/): a write beyond this fails as on a full disk.
   */
  readonly bdjVfsCacheBytes: number;
  /**
   * Decoded BD-J background stills: a still larger than this is not shown; while a replacement decodes, the shown
   * one is dropped first if both would not fit.
   */
  readonly bdjDecodedImageBytes: number;
  /** A NAS disc's read-ahead: bytes fetched ahead of playback and kept. */
  readonly remoteReadAheadBytes: number;
  /**
   * The BD-J worker's own read-ahead of a NAS disc (ruling R20): it reads JARs and metadata files, not streams, so it
   * holds far less than the engine's playback read-ahead.
   */
  readonly bdjRemoteReadAheadBytes: number;
}

export const MEMORY_PROFILES: Readonly<Record<MemoryProfileName, MemoryProfile>> = {
  desktop: {
    igPreloadLimitBytes: 512 * MB,
    assEventCacheBytes: 128 * MB,
    assLayerCacheBytes: 128 * MB,
    assMaskCacheBytes: 64 * MB,
    maxTextSupersampling: 8,
    maxQueuedFrames: () => 8,
    bdjTapWindowMs: 200,
    bdjClassCacheBytes: 32 * MB,
    // no limit: desktop BD-J writes as much as libbluray lets it
    bdjVfsCacheBytes: Infinity,
    bdjDecodedImageBytes: 64 * MB,
    remoteReadAheadBytes: 128 * MB,
    bdjRemoteReadAheadBytes: 16 * MB,
  },
  constrained: {
    igPreloadLimitBytes: 64 * MB,
    assEventCacheBytes: 32 * MB,
    assLayerCacheBytes: 32 * MB,
    assMaskCacheBytes: 16 * MB,
    maxTextSupersampling: 4,
    maxQueuedFrames: (codedWidth) => (codedWidth >= 3840 ? 4 : 8),
    bdjTapWindowMs: 500,
    bdjClassCacheBytes: 4 * MB,
    bdjVfsCacheBytes: 64 * MB,
    // two 1920x1080 stills (7.9 MB each) while one replaces the other
    bdjDecodedImageBytes: 16 * MB,
    remoteReadAheadBytes: 48 * MB,
    bdjRemoteReadAheadBytes: 8 * MB,
  },
};
