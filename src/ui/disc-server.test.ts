import { describe, expect, it } from 'vitest';
import { listServerDiscs, serverDiscSpec, serverLinkFromLocation } from './disc-server';

describe('serverLinkFromLocation', () => {
  it('reads ?disc=<disc API base>&token= as one served disc', () => {
    const link = serverLinkFromLocation('https://192.168.1.5:8443/?disc=https%3A%2F%2F192.168.1.5%3A8443%2Fapi%2Fdiscs%2Fabc123%2F&token=tok');
    expect(link).toEqual({ token: 'tok', disc: 'https://192.168.1.5:8443/api/discs/abc123/', api: 'https://192.168.1.5:8443/api/' });
    // the trailing slash is optional in the link; the base always ends with one, as RemoteDiscSpec.base does
    expect(serverLinkFromLocation('https://h/?disc=https%3A%2F%2Fh%2Fapi%2Fdiscs%2Fabc&token=t')?.disc).toBe('https://h/api/discs/abc/');
  });

  it('reads ?token= alone as the disc list of the server the page came from', () => {
    expect(serverLinkFromLocation('https://192.168.1.5:8443/?token=tok')).toEqual({ token: 'tok', disc: null, api: 'https://192.168.1.5:8443/api/' });
  });

  it('ignores pages without a token, and disc URLs that are not http(s) or not a disc', () => {
    expect(serverLinkFromLocation('https://app.example/')).toBeNull();
    expect(serverLinkFromLocation('https://app.example/?disc=https%3A%2F%2Fx%2Fapi%2Fdiscs%2Fa')).toBeNull();
    expect(serverLinkFromLocation('https://app.example/?disc=javascript%3Aalert(1)&token=t')).toBeNull();
    expect(serverLinkFromLocation('https://app.example/?disc=https%3A%2F%2Fx%2Fother&token=t')).toBeNull();
    expect(serverLinkFromLocation('https://app.example/?disc=https%3A%2F%2Fx%2Fdiscs%2Fa&token=t')).toBeNull(); // the old route
  });
});

describe('serverLinkFromLocation and origins', () => {
  it('accepts a disc on the page origin and ignores one elsewhere, so the token never leaves the server', () => {
    for (const path of ['/', '/probe.html']) {
      const page = `https://192.168.1.5:8443${path}?token=tok&disc=`;
      expect(serverLinkFromLocation(`${page}${encodeURIComponent('https://192.168.1.5:8443/api/discs/abc/')}`)?.disc).toBe('https://192.168.1.5:8443/api/discs/abc/');
      expect(serverLinkFromLocation(`${page}${encodeURIComponent('/api/discs/abc/')}`)?.disc).toBe('https://192.168.1.5:8443/api/discs/abc/');
      expect(serverLinkFromLocation(`${page}${encodeURIComponent('https://evil.example/api/discs/abc/')}`)).toBeNull();
      expect(serverLinkFromLocation(`${page}${encodeURIComponent('http://192.168.1.5:8443/api/discs/abc/')}`)).toBeNull();
      expect(serverLinkFromLocation(`${page}${encodeURIComponent('https://192.168.1.5:9000/api/discs/abc/')}`)).toBeNull();
    }
  });

  it('ignores a production player link to a disc server elsewhere, rather than falling back to its own list', () => {
    const href = `https://bluray.pages.dev/?disc=${encodeURIComponent('https://192.168.1.5:8443/api/discs/abc/')}&token=tok`;
    expect(serverLinkFromLocation(href)).toBeNull();
    // and the Vite dev server does not reach across to the disc server either
    expect(serverLinkFromLocation(`http://localhost:5173/?disc=${encodeURIComponent('https://192.168.1.5:8443/api/discs/abc/')}&token=tok`)).toBeNull();
  });
});

const listing = { folders: [], scanning: false, discs: [
  { id: 'a1', name: 'Disc One', path: 'r/Disc One', kind: 'folder', sizeBytes: 1 },
  { id: 'b2', name: 'Disc Two', path: 'r/Disc Two', kind: 'folder', sizeBytes: 2 },
] };

describe('listServerDiscs', () => {
  it("lists the server's discs (the NAS library listing) with their API bases, sending the token", async () => {
    const asked: Array<[string, string | null]> = [];
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      asked.push([url, new Headers(init?.headers).get('authorization')]);
      return new Response(JSON.stringify(listing));
    };
    const discs = await listServerDiscs({ token: 'tok', disc: null, api: 'https://h:8443/api/' }, fakeFetch);
    expect(asked).toEqual([['https://h:8443/api/library?path=', 'Bearer tok']]);
    expect(discs).toEqual([
      { name: 'Disc One', base: 'https://h:8443/api/discs/a1/' },
      { name: 'Disc Two', base: 'https://h:8443/api/discs/b2/' },
    ]);
  });

  it('names a linked disc from the list, keeping it when the list fails', async () => {
    const link = { token: 'tok', disc: 'https://h:8443/api/discs/b2/', api: 'https://h:8443/api/' };
    const ok = async (): Promise<Response> => new Response(JSON.stringify(listing));
    expect(await listServerDiscs(link, ok)).toEqual([{ name: 'Disc Two', base: 'https://h:8443/api/discs/b2/' }]);
    const failing = async (): Promise<Response> => new Response('no', { status: 401 });
    expect(await listServerDiscs(link, failing)).toEqual([{ name: 'b2', base: 'https://h:8443/api/discs/b2/' }]);
  });

  it('fails with the server status when the list is refused', async () => {
    const failing = async (): Promise<Response> => new Response('no', { status: 401 });
    await expect(listServerDiscs({ token: 'x', disc: null, api: 'https://h/api/' }, failing)).rejects.toThrow(/401/);
  });

  it('sends every request with a timeout, and reports one that times out as unreachable', async () => {
    let signal: AbortSignal | null | undefined;
    const timingOut = async (_url: string, init?: RequestInit): Promise<Response> => {
      signal = init?.signal;
      throw new DOMException('The operation timed out.', 'TimeoutError');
    };
    await expect(listServerDiscs({ token: 'x', disc: null, api: 'https://h/api/' }, timingOut)).rejects.toThrow(/Could not reach the disc server/);
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe('serverDiscSpec', () => {
  it("opens a served disc as the NAS's RemoteDiscSpec: its manifest, base and token", async () => {
    const manifest = { discId: 'b2', name: 'Disc Two', files: [{ path: 'BDMV/INDEX.BDMV', size: 3 }], inline: { 'BDMV/INDEX.BDMV': 'AAAA' } };
    const asked: Array<[string, string | null]> = [];
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      asked.push([url, new Headers(init?.headers).get('authorization')]);
      return new Response(JSON.stringify(manifest));
    };
    const spec = await serverDiscSpec({ name: 'Disc Two', base: 'https://h/api/discs/b2/' }, 'tok', fakeFetch);
    expect(asked).toEqual([['https://h/api/discs/b2/manifest', 'Bearer tok']]);
    expect(spec).toEqual({ kind: 'remote', base: 'https://h/api/discs/b2/', token: 'tok', manifest });
  });

  it('refuses a body that is not a manifest', async () => {
    const bad = async (): Promise<Response> => new Response(JSON.stringify({ files: 'no' }));
    await expect(serverDiscSpec({ name: 'X', base: 'https://h/api/discs/x/' }, 't', bad)).rejects.toThrow(/bad manifest/);
  });
});
