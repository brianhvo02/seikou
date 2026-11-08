// SPDX-License-Identifier: LGPL-3.0-or-later
import { SourceUnavailable } from '@seikou/titles/sources';
import type { CoverImage, CoverSource } from './http';

// Cover images for the page. The page runs cross-origin isolated (COEP require-corp), so it cannot show an image from
// AniList's image host, which sends no Cross-Origin-Resource-Policy header; the backend fetches the image and serves
// it from its own origin instead.

/** The largest cover the backend passes on, in bytes. */
export const MAX_COVER_BYTES = 5 * 1024 * 1024;

/** How long a cover may take, from the request to its last byte, in milliseconds. */
export const COVER_TIMEOUT_MS = 10_000;

/** The image types a cover may have; anything else (SVG, HTML) is refused. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

/** A cover the backend will not pass on: not one of the image types it accepts, or larger than `MAX_COVER_BYTES`. */
export class BadCover extends Error {
  override name = 'BadCover';
}

/** The media type of a `Content-Type` header, lower-cased and without parameters; null when there is none. */
function mediaType(header: string | null): string | null {
  const type = header?.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === '' ? null : type;
}

/** Whether `type` is one of the image types a cover may have. */
function isCoverType(type: string | null): type is string {
  return type !== null && IMAGE_TYPES.has(type);
}

/** Reads `body` whole, throwing `BadCover` as soon as it passes `max` bytes. */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new BadCover(`the cover is larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return bytes;
}

/**
 * Covers over the network: an `https:` URL only, fetched with `userAgent`, given `COVER_TIMEOUT_MS` in all and at most
 * `MAX_COVER_BYTES`. A network error, an error status or the timeout rejects with `SourceUnavailable`; another scheme,
 * a type that is not an accepted image, or a larger body rejects with `BadCover`. `signal` aborting (the page went
 * away) rejects with its reason.
 */
export function createCoverSource(fetch: typeof globalThis.fetch, userAgent: string): CoverSource {
  return {
    async get(url: string, signal: AbortSignal): Promise<CoverImage> {
      if (new URL(url).protocol !== 'https:') throw new BadCover('a cover must be an https: URL');
      const both = AbortSignal.any([signal, AbortSignal.timeout(COVER_TIMEOUT_MS)]);
      try {
        const res = await fetch(url, { signal: both, headers: { 'User-Agent': userAgent } });
        if (!res.ok || res.body === null) {
          await res.body?.cancel().catch(() => {});
          throw new SourceUnavailable(`the cover answered ${res.status}`);
        }
        const type = mediaType(res.headers.get('content-type'));
        if (!isCoverType(type)) {
          await res.body.cancel().catch(() => {});
          throw new BadCover(`the cover is ${type ?? 'of no type'}, not an image`);
        }
        const declared = Number(res.headers.get('content-length') ?? '0');
        if (declared > MAX_COVER_BYTES) {
          await res.body.cancel().catch(() => {});
          throw new BadCover(`the cover is larger than ${MAX_COVER_BYTES} bytes`);
        }
        return { contentType: type, bytes: await readCapped(res.body, MAX_COVER_BYTES) };
      } catch (e) {
        if (e instanceof BadCover || e instanceof SourceUnavailable) throw e;
        if (signal.aborted) throw signal.reason;
        throw new SourceUnavailable(`the cover could not be fetched: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
