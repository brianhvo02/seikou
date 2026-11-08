// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { SourceUnavailable } from '@seikou/titles/sources';
import { BadCover, MAX_COVER_BYTES, createCoverSource } from '../../src/server/covers';

const COVER_URL = 'https://img.example/cover/bx1.png';
const never = new AbortController().signal;

/** A fetch answering `body` with `headers` and `status`. */
function answering(body: ConstructorParameters<typeof Response>[0], headers: Record<string, string>, status = 200) {
  return vi.fn<typeof globalThis.fetch>(async () => new Response(body, { status, headers }));
}

describe('createCoverSource', () => {
  it('passes an image on with its type and sends the User-Agent', async () => {
    const fetch = answering(new Uint8Array([1, 2, 3]), { 'content-type': 'image/png' });
    const cover = await createCoverSource(fetch, 'agent/1').get(COVER_URL, never);
    expect(cover).toEqual({ contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get('user-agent')).toBe('agent/1');
  });

  it('refuses a body that is not an image, or one over the size cap', async () => {
    await expect(createCoverSource(answering('<svg/>', { 'content-type': 'image/svg+xml' }), 'a').get(COVER_URL, never)).rejects.toBeInstanceOf(BadCover);
    await expect(createCoverSource(answering('x', { 'content-type': 'text/html' }), 'a').get(COVER_URL, never)).rejects.toBeInstanceOf(BadCover);
    const big = new Uint8Array(MAX_COVER_BYTES + 1);
    await expect(createCoverSource(answering(big, { 'content-type': 'image/jpeg' }), 'a').get(COVER_URL, never)).rejects.toBeInstanceOf(BadCover);
    // no Content-Length: the body is cut off once it passes the cap
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    await expect(createCoverSource(answering(endless, { 'content-type': 'image/jpeg' }), 'a').get(COVER_URL, never)).rejects.toBeInstanceOf(BadCover);
  });

  it('refuses a URL that is not https without asking', async () => {
    const fetch = answering('x', { 'content-type': 'image/png' });
    await expect(createCoverSource(fetch, 'a').get('http://img.example/c.png', never)).rejects.toBeInstanceOf(BadCover);
    await expect(createCoverSource(fetch, 'a').get('file:///etc/hosts', never)).rejects.toBeInstanceOf(BadCover);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turns an error status, a network failure and the timeout into SourceUnavailable', async () => {
    await expect(createCoverSource(answering('no', { 'content-type': 'text/plain' }, 404), 'a').get(COVER_URL, never)).rejects.toBeInstanceOf(SourceUnavailable);
    const failing = vi.fn<typeof globalThis.fetch>(async () => Promise.reject(new TypeError('fetch failed')));
    await expect(createCoverSource(failing, 'a').get(COVER_URL, never)).rejects.toBeInstanceOf(SourceUnavailable);
    vi.useFakeTimers();
    try {
      const hanging = vi.fn<typeof globalThis.fetch>(
        (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))),
      );
      const settled = expect(createCoverSource(hanging, 'a').get(COVER_URL, never)).rejects.toBeInstanceOf(SourceUnavailable);
      await vi.advanceTimersByTimeAsync(10_001);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});
