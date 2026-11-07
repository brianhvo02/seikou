import type { RemoteDiscSpec } from '@seikou/engine/disc/disc-spec';
import type { DiscManifest } from '@seikou/nas/nas-api';

/** The NAS server's inlining rule (server/src/manifest.ts). */
const INLINED = /^(BDMV\/(INDEX\.BDMV|MOVIEOBJECT\.BDMV|PLAYLIST\/[^/]+\.MPLS|CLIPINF\/[^/]+\.CLPI|AUXDATA\/SOUND\.BDMV|BDJO\/[^/]+\.BDJO)|CERTIFICATE\/ID\.BDMV)$/;

export const FAKE_NAS_BASE = 'https://nas.example/bluray/api/discs/d1/';

export interface FakeNas {
  readonly spec: RemoteDiscSpec;
  readonly fetch: typeof fetch;
  /** Disc paths requested through the files route, decoded, in order. */
  readonly requested: string[];
}

/** A NAS serving `files` (disc-relative paths) the way the server's files route does: 206 for a single range. */
export function fakeNas(files: ReadonlyMap<string, Uint8Array>, token = 'tok'): FakeNas {
  const byPath = new Map([...files].map(([path, bytes]) => [path.toUpperCase(), bytes]));
  const inline: Record<string, string> = {};
  for (const [path, bytes] of byPath) if (INLINED.test(path)) inline[path] = Buffer.from(bytes).toString('base64');
  const manifest: DiscManifest = {
    discId: 'd1',
    name: 'Fake disc',
    files: [...byPath].map(([path, bytes]) => ({ path, size: bytes.length })).sort((a, b) => (a.path < b.path ? -1 : 1)),
    inline,
  };
  const requested: string[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const rest = url.href.slice(FAKE_NAS_BASE.length).split('?')[0]!;
    if (!url.href.startsWith(`${FAKE_NAS_BASE}files/`)) return new Response(null, { status: 404 });
    if (url.searchParams.get('t') !== token) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const path = rest.slice('files/'.length).split('/').map(decodeURIComponent).join('/');
    requested.push(path);
    const bytes = byPath.get(path);
    if (!bytes) return Response.json({ error: 'not found' }, { status: 404 });
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range') ?? '');
    if (!range) return new Response(null, { status: 400 });
    const start = Number(range[1]);
    if (start >= bytes.length) return new Response(null, { status: 416 });
    const end = Math.min(Number(range[2]), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1), { status: 206 });
  };
  return { spec: { kind: 'remote', base: FAKE_NAS_BASE, token, manifest }, fetch: fakeFetch as typeof fetch, requested };
}
