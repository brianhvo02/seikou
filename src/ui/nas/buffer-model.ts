/**
 * Buffer first (spec 2026-10-18-webrtc-people-design §7): whether a NAS disc can play straight through over this
 * connection, and if not, how long to wait and how many bytes to hold ahead first.
 */

import { CACHE_DIR, SEGMENT_BYTES } from '@seikou/engine/disc/read-ahead-cache';

/** The title's average rate is raised by this margin before it is compared with the connection. */
export const RATE_MARGIN = 1.1;
/** A wait shorter than this buffers silently (a progress ring, then play); a longer one asks first. */
export const SILENT_BELOW_S = 120;
/**
 * The most the cache holds past the plan's lead. Following playback, the engine holds at most the lead plus one
 * segment ahead of the play position (its cap; a paused player or a link faster than the probe stops there), and
 * frees what playback has passed a whole segment at a time, so up to one more segment lies behind the position. The
 * plan's bytes plus this is therefore the most the cache ever holds.
 */
export const CACHE_SLACK_BYTES = 2 * SEGMENT_BYTES;
/** When the fill failed, or this device has no cache. */
export const BUFFER_FAILED_COPY = "Couldn't buffer on this device, so it will play with pauses.";

export type BufferPlan =
  | { readonly kind: 'play' }
  | { readonly kind: 'silent'; readonly waitS: number; readonly bytes: number }
  | { readonly kind: 'ask'; readonly waitS: number; readonly bytes: number }
  | { readonly kind: 'too-big'; readonly canHoldBytes: number; readonly bytes: number };

export interface BufferPlanInput {
  /** The main playlist's length and the bytes of its clips. */
  readonly durationS: number;
  readonly playlistBytes: number;
  /** This connection's throughput (the pre-flight's probe). */
  readonly connectionMbps: number;
  /** The storage this device can still give the read-ahead cache. */
  readonly quotaBytes: number;
  /** SILENT_BELOW_S, except under the ?bufferask=1 test flag (0: every wait asks). */
  readonly silentBelowS?: number;
}

/**
 * Rate = playlist bytes ÷ duration × 1.1; wait = duration × (1 − connection ÷ rate); the bytes held ahead are the wait
 * times the connection's rate. A device that can't hold them can't wait them out.
 */
export function bufferPlan({ durationS, playlistBytes, connectionMbps, quotaBytes, silentBelowS = SILENT_BELOW_S }: BufferPlanInput): BufferPlan {
  if (!(durationS > 0) || !(playlistBytes > 0)) return { kind: 'play' };
  const rateMbps = ((playlistBytes * 8) / 1e6 / durationS) * RATE_MARGIN;
  if (connectionMbps >= rateMbps) return { kind: 'play' };
  const waitS = durationS * (1 - Math.max(connectionMbps, 0) / rateMbps);
  const bytes = (waitS * Math.max(connectionMbps, 0) * 1e6) / 8;
  if (bytes + CACHE_SLACK_BYTES > quotaBytes) return { kind: 'too-big', canHoldBytes: Math.max(0, quotaBytes - CACHE_SLACK_BYTES), bytes };
  return waitS < silentBelowS ? { kind: 'silent', waitS, bytes } : { kind: 'ask', waitS, bytes };
}

/** "About {n} minutes before it can play straight through", the wait rounded up to a whole minute. */
export function waitCopy(waitS: number): string {
  const minutes = Math.ceil(waitS / 60);
  return `About ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} before it can play straight through`;
}

/** What the pre-flight says on a device that can't hold the wait (Review Focus 5). */
export function tooBigCopy(canHoldBytes: number, bytes: number): string {
  return `To play straight through, this device would need to hold ${formatGb(bytes)} ahead, and it has room for ${formatGb(canHoldBytes)}. It can play now, with pauses.`;
}

function formatGb(bytes: number): string {
  const gb = bytes / 1e9;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** What storageRoom needs of `navigator.storage`. */
export interface StorageManagerLike {
  persist(): Promise<boolean>;
  estimate(): Promise<{ readonly quota?: number; readonly usage?: number }>;
}

/**
 * The storage left for the cache: asks for persistence first (a refusal is fine), then the estimate's quota less
 * usage, plus what the read-ahead cache holds now (`reclaimable`), which opening this disc clears or reuses.
 */
export async function storageRoom(storage: StorageManagerLike | undefined, reclaimable: () => Promise<number> = async () => 0): Promise<number> {
  if (!storage) return 0;
  try {
    await storage.persist();
  } catch {
    // Persistence only keeps the browser from evicting the cache under pressure.
  }
  try {
    const { quota = 0, usage = 0 } = await storage.estimate();
    const held = await reclaimable().catch(() => 0);
    return Math.max(0, quota - Math.max(0, usage - held));
  } catch {
    return 0;
  }
}

/** The main playlist's length (its play items', 45 kHz) and the bytes of its clips, each clip once. */
export function playlistFacts(
  playItems: readonly { readonly clipId: string; readonly inTime: number; readonly outTime: number }[],
  fileSizes: ReadonlyMap<string, number>,
): { durationS: number; playlistBytes: number } {
  const durationS = playItems.reduce((sum, p) => sum + Math.max(0, p.outTime - p.inTime), 0) / 45_000;
  const clips = new Set(playItems.map((p) => p.clipId));
  let playlistBytes = 0;
  for (const id of clips) playlistBytes += fileSizes.get(`BDMV/STREAM/${id}.M2TS`) ?? 0;
  return { durationS, playlistBytes };
}

interface DirLike {
  readonly kind: string;
  getDirectoryHandle(name: string): Promise<DirLike>;
  values(): AsyncIterable<DirLike | { readonly kind: string; getFile(): Promise<{ readonly size: number }> }>;
}

/** The bytes the read-ahead cache holds on this device (all discs), from the origin's private file system. */
export async function readAheadCacheBytes(root: () => Promise<FileSystemDirectoryHandle>): Promise<number> {
  let top: DirLike;
  try {
    top = await ((await root()) as unknown as DirLike).getDirectoryHandle(CACHE_DIR);
  } catch {
    return 0;
  }
  const walk = async (dir: DirLike): Promise<number> => {
    let sum = 0;
    try {
      for await (const entry of dir.values()) {
        if (entry.kind === 'directory') sum += await walk(entry as DirLike);
        else sum += await (entry as { getFile(): Promise<{ size: number }> }).getFile().then((f) => f.size, () => 0); // one it can't read counts 0
      }
    } catch {
      // a folder removed while it was listed: what was counted stands
    }
    return sum;
  };
  return walk(top);
}

/** What watchBufferFailure needs of the PlayerController. */
export interface BufferWatchController {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { readonly buffer: { readonly stopped?: string } | null };
  readonly discOpens: number;
  showNotice(code: string, message: string): void;
}

/**
 * For the disc just opened buffering first: once its fill ends early (a failed read or write, or no cache), the
 * player says it will play with pauses (BUFFER_FAILED_COPY). Lets go when another disc opens or this one closes.
 */
export function watchBufferFailure(controller: BufferWatchController): () => void {
  const open = controller.discOpens;
  let unsubscribe: (() => void) | null = null;
  const release = (): void => {
    unsubscribe?.();
    unsubscribe = null;
  };
  unsubscribe = controller.subscribe(() => {
    if (controller.discOpens !== open) return release();
    if (!controller.getSnapshot().buffer?.stopped) return;
    release();
    controller.showNotice('buffer-failed', BUFFER_FAILED_COPY);
  });
  return release;
}
