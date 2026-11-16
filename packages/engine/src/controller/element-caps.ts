// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ElementHdr } from '../protocol';

/**
 * The browser capabilities {@link elementPlayable} asks: `isTypeSupported` is the media source class's (`MediaSource`
 * or `ManagedMediaSource`), `decodingInfo` is `navigator.mediaCapabilities.decodingInfo` (missing where the browser
 * has no Media Capabilities API).
 * @internal
 */
export interface ElementCapsEnv {
  isTypeSupported(type: string): boolean;
  decodingInfo?(config: unknown): Promise<{ readonly supported: boolean }>;
}

/** The picture size, bit rate and frame rate asked about when the caller gives no size: a 1080p Blu-ray stream. */
const DEFAULT_SIZE = { width: 1920, height: 1080 };
const ASKED_BITRATE = 40_000_000;
const ASKED_FRAMERATE = 24;

/**
 * Whether the page's video element can play `codec` as fragmented MP4 through Media Source Extensions. SDR streams
 * (`hdr` null) ask `isTypeSupported` alone. An HDR stream must pass it too, then `decodingInfo` with the stream's
 * transfer function, the Rec. 2020 gamut and, with mastering metadata, `smpteSt2086`; where `decodingInfo` is missing
 * or throws, `isTypeSupported`'s answer stands.
 * @internal
 */
export async function elementPlayable(
  env: ElementCapsEnv,
  codec: string,
  hdr: ElementHdr | null,
  size: { readonly width: number; readonly height: number } = DEFAULT_SIZE,
): Promise<boolean> {
  const contentType = `video/mp4; codecs="${codec}"`;
  if (!env.isTypeSupported(contentType)) return false;
  if (!hdr || !env.decodingInfo) return true;
  try {
    const info = await env.decodingInfo({
      type: 'media-source',
      video: {
        contentType,
        width: size.width,
        height: size.height,
        bitrate: ASKED_BITRATE,
        framerate: ASKED_FRAMERATE,
        transferFunction: hdr.transfer,
        colorGamut: 'rec2020',
        ...(hdr.mastering ? { hdrMetadataType: 'smpteSt2086' } : {}),
      },
    });
    return info.supported;
  } catch {
    return true;
  }
}
