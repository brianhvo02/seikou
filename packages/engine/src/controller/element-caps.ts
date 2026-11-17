// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ElementCheck, ElementHdr } from '../protocol';

/**
 * The browser capabilities {@link elementCheck} asks: `isTypeSupported` is the media source class's (`MediaSource`
 * or `ManagedMediaSource`), `decodingInfo` is `navigator.mediaCapabilities.decodingInfo` (missing where the browser
 * has no Media Capabilities API).
 * @internal
 */
export interface ElementCapsEnv {
  isTypeSupported(type: string): boolean;
  decodingInfo?(config: unknown): Promise<{ readonly supported: boolean }>;
}

/** The picture size asked about when the caller gives none, and the bit rate always asked about: a 1080p Blu-ray stream. */
const DEFAULT_SIZE = { width: 1920, height: 1080 };
const ASKED_BITRATE = 40_000_000;
/** The frame rate asked about when the caller gives none. */
const ASKED_FRAMERATE = 24;

/**
 * Whether the page's video element can play `codec` as fragmented MP4 through Media Source Extensions, with what the
 * browser said (`check`). SDR streams (`hdr` null) ask `isTypeSupported` alone. An HDR stream must pass it too, then
 * `decodingInfo` with the stream's transfer function, the Rec. 2020 gamut and, with mastering metadata, `smpteSt2086`,
 * at the stream's `size` (its coded size and, when known, frame rate; 1080p at 24 fps when not given); where
 * `decodingInfo` is missing or throws, `isTypeSupported`'s answer stands.
 * @internal
 */
export async function elementCheck(
  env: ElementCapsEnv,
  codec: string,
  hdr: ElementHdr | null,
  size: { readonly width: number; readonly height: number; readonly frameRate?: number } = DEFAULT_SIZE,
): Promise<{ readonly playable: boolean; readonly check: ElementCheck }> {
  const contentType = `video/mp4; codecs="${codec}"`;
  if (!env.isTypeSupported(contentType)) return { playable: false, check: { mse: false, decodingInfo: null } };
  if (!hdr) return { playable: true, check: { mse: true, decodingInfo: null } };
  if (!env.decodingInfo) return { playable: true, check: { mse: true, decodingInfo: 'missing' } };
  try {
    const info = await env.decodingInfo({
      type: 'media-source',
      video: {
        contentType,
        width: size.width,
        height: size.height,
        bitrate: ASKED_BITRATE,
        framerate: size.frameRate ?? ASKED_FRAMERATE,
        transferFunction: hdr.transfer,
        colorGamut: 'rec2020',
        ...(hdr.mastering ? { hdrMetadataType: 'smpteSt2086' } : {}),
      },
    });
    return { playable: info.supported, check: { mse: true, decodingInfo: info.supported } };
  } catch {
    return { playable: true, check: { mse: true, decodingInfo: 'threw' } };
  }
}
