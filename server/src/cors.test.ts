import { connect } from 'node:net';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { corsHeaders } from './cors';
import { createServer } from './http';
import type { Handler } from './http';

describe('corsHeaders', () => {
  it.each(['https://bluray.pages.dev', 'https://fix-x.bluray.pages.dev', 'http://localhost:4173', 'http://localhost:5173'])(
    'echoes the allowed origin %s',
    (origin) => {
      expect(corsHeaders(origin)['Access-Control-Allow-Origin']).toBe(origin);
    },
  );

  it.each([['https://evil.pages.dev'], ['https://bluray.pages.dev.evil.com'], ['https://evil-bluray.pages.dev'], ['https://bluray-web.pages.dev'], [undefined]])(
    'gives no Allow-Origin to %s',
    (origin) => {
      expect(corsHeaders(origin)).not.toHaveProperty('Access-Control-Allow-Origin');
    },
  );

  it.each([['https://bluray.pages.dev'], ['https://evil.pages.dev'], [undefined]])('always sets Vary and CORP (%s)', (origin) => {
    const headers = corsHeaders(origin);
    expect(headers['Vary']).toBe('Origin');
    expect(headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
  });

  it('exposes ETag and Retry-After, so the player sees when a level read should retry', () => {
    const exposed = corsHeaders('https://bluray.pages.dev')['Access-Control-Expose-Headers']!.split(/,\s*/);
    expect(exposed).toEqual(expect.arrayContaining(['ETag', 'Retry-After']));
  });
});

describe('createServer', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function start(handlers: readonly Handler[] = []): Promise<string> {
    const server = createServer(handlers);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('answers GET /api/health', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/health`, { headers: { Origin: 'https://bluray.pages.dev' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://bluray.pages.dev');
    expect(res.headers.get('vary')).toBe('Origin');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('answers preflights', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/x`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:4173', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:4173');
    expect(res.headers.get('access-control-max-age')).toBe('600');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, PATCH, DELETE');
  });

  it('allows the precondition headers in a preflight, and exposes ETag', async () => {
    const base = await start();
    const pre = await fetch(`${base}/api/bdj-store/persistent/0a1b2c3d`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://bluray.pages.dev', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'if-match' },
    });
    const allowed = pre.headers.get('access-control-allow-headers')!.split(',').map((h) => h.trim().toLowerCase());
    expect(allowed).toEqual(expect.arrayContaining(['authorization', 'content-type', 'range', 'if-match', 'if-none-match', 'x-bdj-person']));
    const res = await fetch(`${base}/api/health`, { headers: { Origin: 'https://bluray.pages.dev' } });
    expect(res.headers.get('access-control-expose-headers')).toBe('ETag, Retry-After');
  });

  it('answers 404 JSON when no handler matches', async () => {
    const base = await start();
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('answers HEAD /api/health with 200 and no body', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/health`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('sets keep-alive and header timeouts above the Caddy upstream idle timeout', () => {
    const server = createServer([]);
    expect(server.keepAliveTimeout).toBe(130_000);
    expect(server.headersTimeout).toBe(131_000);
  });

  it('answers 500 when a response cannot be sent, and keeps serving', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad: Handler = async (_req, url) =>
      url.pathname === '/bad' ? { status: 200, headers: { 'X-Name': '鋼の旅団' }, body: 'x' } : null;
    const base = await start([bad]);
    const res = await fetch(`${base}/bad`, { headers: { Origin: 'https://bluray.pages.dev' } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://bluray.pages.dev');
    expect(error).toHaveBeenCalled();
    const next = await fetch(`${base}/api/health`);
    expect(next.status).toBe(200);
    error.mockRestore();
  });

  it('answers 400 JSON to an unparseable request target without logging', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = await start();
    const { port } = new URL(base);
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1', () => {
        socket.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk) => (data += chunk.toString()));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.1 400 /);
    expect(raw).toMatch(/content-type: application\/json/i);
    expect(raw).toContain('{"error":"bad request"}');
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('sets nosniff and a sandboxing CSP on every response, beside the CORS and CORP headers', async () => {
    const base = await start();
    for (const res of [
      await fetch(`${base}/api/health`, { headers: { Origin: 'https://bluray.pages.dev' } }),
      await fetch(`${base}/nope`),
      await fetch(`${base}/api/x`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:4173', 'Access-Control-Request-Method': 'GET' } }),
    ]) {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    }
  });

  it('drops the connection when a body stream ends short of its Content-Length', async () => {
    const short: Handler = async (_req, url) =>
      url.pathname === '/short'
        ? { status: 200, headers: { 'Content-Length': '10', 'Content-Type': 'application/octet-stream' }, body: Readable.from([Buffer.from('12345')]) }
        : null;
    const base = await start([short]);
    const outcome = await Promise.race([
      fetch(`${base}/short`).then((res) => res.arrayBuffer()).then(
        () => 'complete',
        () => 'aborted',
      ),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 2_000)),
    ]);
    expect(outcome).toBe('aborted');
  });

  it('sends a body stream that matches its Content-Length whole', async () => {
    const full: Handler = async (_req, url) =>
      url.pathname === '/full'
        ? { status: 200, headers: { 'Content-Length': '10' }, body: Readable.from([Buffer.from('12345'), Buffer.from('67890')]) }
        : null;
    const base = await start([full]);
    const res = await fetch(`${base}/full`);
    expect(await res.text()).toBe('1234567890');
  });
});
