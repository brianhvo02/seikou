/** The two device classes: `desktop` (computers) and `constrained` (phones and tablets, chosen by the page from the device). */
export type MemoryProfileName = 'desktop' | 'constrained';

const MB = 1024 * 1024;

/**
 * Memory limits that differ between desktop browsers and phones or tablets.
 * @internal
 */
export interface MemoryProfile {
  /** An IG sub-path clip (menu graphics in a separate clip) larger than this many bytes is not preloaded and its menu fails to open with an error; desktop's 512 MB is libbluray's `PRELOAD_SIZE_LIMIT`. The `menu-memory` notice shows when the error is the constrained profile's. */
  readonly igPreloadLimitBytes: number;
  /** Byte budget of the ASS renderer's cache of laid-out events. */
  readonly assEventCacheBytes: number;
  /** Byte budget of its cache of drawn layers. */
  readonly assLayerCacheBytes: number;
  /** Byte budget of its cache of glyph masks. */
  readonly assMaskCacheBytes: number;
  /** Upper bound of the per-side supersampling of ASS text masks. */
  readonly maxTextSupersampling: number;
  /** Decoded frames held for the presenter, for a stream of this coded width. */
  readonly maxQueuedFrames: (codedWidth: number) => number;
  /** How long a tap on a BD-J menu waits for the disc to react before it counts as ignored, in milliseconds (the menu responsiveness target: 0.2 s on a computer, 0.5 s on a phone). */
  readonly bdjTapWindowMs: number;
  /*
   * BD-J budgets. The constrained values were first estimated from a desktop measurement of two BD-J discs in the Node
   * replay (the classes keep 1.3 MB, the memory mounts hold 4.4 MB, one 1080p still decodes to 7.9 MB). Memory measured
   * on a phone and a tablet stayed well under them, so they were kept.
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
   * The BD-J worker's own read-ahead of a NAS disc: it reads JARs and metadata files, not streams, so it holds far less
   * than the engine's playback read-ahead.
   */
  readonly bdjRemoteReadAheadBytes: number;
  /**
   * On the element path, how far the video element's buffered end may run ahead of the clock before reading waits, in
   * microseconds (a SourceBuffer holds 100–300 MB, and UHD runs at up to about 100 Mb/s).
   */
  readonly elementLeadUs: number;
  /**
   * Frames the deinterlacer's ring of plane slots holds (about 3 MB each at 1080): the detector's lookahead, the
   * neighbours, and the frames of every picture queued for presentation. Decode-ahead of an interlaced stream waits
   * for a free slot.
   */
  readonly deinterlaceRing: number;
  /**
   * Decode TrueHD and DTS-HD whole (MLP, XLL and the other DTS extensions) rather than their Dolby Digital or DTS
   * cores. Off on phones and tablets: their output is almost always stereo, where the difference can't be heard, and
   * the extra decoding costs battery.
   */
  readonly losslessAudio: boolean;
  /**
   * The largest overlay layer, in pixels, presented through the HDR overlay canvas over HDR video: a larger overlay
   * rectangle is drawn at a smaller scale and stretched (the layer, its GPU copy and the canvas's float16 buffers all
   * follow it).
   */
  readonly hdrOverlayMaxPixels: number;
}

/**
 * The limits of each profile. Desktop's BD-J file system has no cap, which is what libbluray allows.
 * @internal
 */
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
    elementLeadUs: 10_000_000,
    deinterlaceRing: 12,
    losslessAudio: true,
    hdrOverlayMaxPixels: 3840 * 2160,
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
    elementLeadUs: 4_000_000,
    // the deinterlacer itself holds about 7 (lookahead, the frame awaiting its next, the previous neighbour): 8 would
    // leave about one frame of pictures queued
    deinterlaceRing: 10,
    losslessAudio: false,
    hdrOverlayMaxPixels: 1920 * 1080,
  },
};
