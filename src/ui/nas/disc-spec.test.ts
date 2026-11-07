import { describe, expect, it, vi } from 'vitest';
import { portFetch } from '@seikou/engine/disc/port-fetch';
import { levelQuery, nasDiscSpec } from './disc-spec';

const manifest = { discId: 'd1', name: 'Disc', files: [], inline: {} };

describe('nasDiscSpec', () => {
  it('gives an HTTPS disc no fetch port: the engine fetches it itself', () => {
    const discFetch = vi.fn<typeof fetch>();
    const { spec, release } = nasDiscSpec('https://nas.example/bluray/api/discs/d1/', 't', manifest, discFetch);
    expect(spec).toEqual({ kind: 'remote', base: 'https://nas.example/bluray/api/discs/d1/', token: 't', manifest });
    release();
  });

  it("answers a WebRTC disc's port with discFetch until released", async () => {
    const discFetch = vi.fn<typeof fetch>(async (input) => new Response(`read ${String(input)}`, { status: 206 }));
    const { spec, release } = nasDiscSpec('rtc://n/api/discs/d1/', 't', manifest, discFetch);
    expect(spec).toMatchObject({ kind: 'remote', base: 'rtc://n/api/discs/d1/', token: 't', manifest });
    expect(spec.fetchPort).toBeInstanceOf(MessagePort);
    const engineFetch = portFetch(spec.fetchPort!);
    const res = await engineFetch('rtc://n/api/discs/d1/files/BDMV/index.bdmv?t=t', { headers: { Range: 'bytes=0-3' } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('read rtc://n/api/discs/d1/files/BDMV/index.bdmv?t=t');
    expect(new Headers(discFetch.mock.calls[0]![1]!.headers).get('Range')).toBe('bytes=0-3');
    release();
    spec.fetchPort!.close();
  });
});

describe('levelQuery', () => {
  it('a level spec carries the level query and the original manifest; Original carries neither', () => {
    expect(levelQuery({ level: 'phone-720', audio: 2 })).toBe('level=phone-720&audio=2');
    expect(levelQuery({ level: 'original', audio: 2 })).toBeUndefined();
    expect(levelQuery(undefined)).toBeUndefined();
    const original = { discId: 'd1', name: 'Disc', files: [], inline: {} };
    const lv = { ...manifest, name: 'Level' };
    const { spec } = nasDiscSpec('https://nas.example/bluray/api/discs/d1/', 't', lv, vi.fn<typeof fetch>(), { at: { level: 'phone-720', audio: 2 }, original });
    expect(spec).toMatchObject({ query: 'level=phone-720&audio=2', original });
    const plain = nasDiscSpec('https://nas.example/bluray/api/discs/d1/', 't', manifest, vi.fn<typeof fetch>(), { at: { level: 'original', audio: 2 }, original });
    expect(plain.spec).not.toHaveProperty('query');
    expect(plain.spec).not.toHaveProperty('original');
  });
});
