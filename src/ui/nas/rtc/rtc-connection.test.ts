import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRtcWorld, bodyText } from '../../../../tests/helpers/rtc-fakes';
import type { FakeRtcOptions } from '../../../../tests/helpers/rtc-fakes';
import { NAS_LOST_MESSAGE } from '@seikou/engine/disc/http-transport';
import type { WireRequest, WireResponse } from '@seikou/nas/rtc-wire';
import { RTC_BASE, RTC_UNREACHABLE, RtcConnection, RtcUnreachable, STUN_URL, relayLimitMessage, signallingUrlOf } from './rtc-connection';

const NAS_ID = 'n'.repeat(43);
const TURN = [{ urls: ['turn:turn.example:3478?transport=udp'], username: 'u', credential: 'c' }];

afterEach(() => {
  vi.useRealTimers();
});

const echo = async (req: WireRequest): Promise<WireResponse> => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ method: req.method, path: req.path, body: await bodyText(req.body) }),
});

function world(opts: Partial<FakeRtcOptions> = {}): FakeRtcWorld {
  return new FakeRtcWorld({ direct: true, handle: echo, ...opts });
}

function open(w: FakeRtcWorld, extra: Partial<Parameters<typeof RtcConnection.open>[0]> = {}): Promise<RtcConnection> {
  return RtcConnection.open({
    nasId: NAS_ID,
    signallingUrl: 'https://rendezvous.example/',
    deviceProof: async (sid) => ({ deviceId: 'dev1', ts: 1, signature: `sig-${sid}` }),
    createPeer: w.createPeer,
    openSocket: w.openSocket,
    ...extra,
  });
}

describe('RtcConnection', () => {
  it('turns the rendezvous URL into the device signalling socket', () => {
    expect(signallingUrlOf('https://rendezvous.example/', NAS_ID)).toBe(`wss://rendezvous.example/signal/device?nasId=${NAS_ID}`);
    expect(signallingUrlOf('http://127.0.0.1:4191', NAS_ID)).toBe(`ws://127.0.0.1:4191/signal/device?nasId=${NAS_ID}`);
    expect(RTC_BASE(NAS_ID)).toBe(`rtc://${NAS_ID}/api/`);
  });

  it('connects directly with STUN only, sends every candidate, closes the socket, and is not relayed', async () => {
    const w = world();
    const conn = await open(w);
    expect(conn.relayed).toBe(false);
    expect(w.peers).toHaveLength(1);
    expect(w.peers[0].config.iceServers).toEqual([{ urls: STUN_URL }]);
    const [channel] = w.peers[0].channels;
    expect(channel.label).toBe('api');
    expect(channel.init).toMatchObject({ ordered: true });
    expect(channel.binaryType).toBe('arraybuffer');
    expect(w.sockets[0].url).toBe(`wss://rendezvous.example/signal/device?nasId=${NAS_ID}`);
    expect(w.sent.map((m) => m.t)).toEqual(['offer', 'candidate']);
    expect(w.sent[1].candidate).toMatchObject({ candidate: expect.stringContaining('typ host'), sdpMid: '0', sdpMLineIndex: 0 });
    expect(w.sockets[0].readyState).toBe(3);

    const res = await conn.fetch(`${RTC_BASE(NAS_ID)}pair/redeem?x=1`, { method: 'POST', body: '{"a":1}' });
    expect(await res.json()).toEqual({ method: 'POST', path: '/api/pair/redeem?x=1', body: '{"a":1}' });
    conn.close();
  });

  it('asks for TURN when the direct path fails, retries with the servers, and is relayed', async () => {
    const turn = vi.fn((_m: Record<string, unknown>) => ({ iceServers: TURN }));
    const w = world({ direct: false, relay: true, turn });
    const conn = await open(w);
    expect(conn.relayed).toBe(true);
    expect(w.peers).toHaveLength(2);
    expect(w.peers[0].closed).toBe(true);
    expect(w.peers[1].config).toEqual({ iceServers: [{ urls: STUN_URL }, ...TURN], iceTransportPolicy: 'all' });
    const request = w.sent.find((m) => m.t === 'turn-request')!;
    expect(request).toEqual({ t: 'turn-request', deviceId: 'dev1', ts: 1, signature: 'sig-sid1', sid: 'sid1' });
    // the relay candidate reaches the NAS, which counts relayed bytes by it
    const relayCandidates = w.sent.filter((m) => m.t === 'candidate' && String((m.candidate as RTCIceCandidateInit).candidate).includes('typ relay'));
    expect(relayCandidates).toHaveLength(1);
    expect(w.sent.filter((m) => m.t === 'offer').map((m) => m.sid)).toEqual(['sid1', 'sid1']);
    const res = await conn.fetch(`${RTC_BASE(NAS_ID)}health`);
    expect((await res.json()).path).toBe('/api/health');
  });

  it("sends an invite's hash when unpaired", async () => {
    const turn = vi.fn((_m: Record<string, unknown>) => ({ iceServers: TURN }));
    const w = world({ direct: false, relay: true, turn });
    await open(w, { deviceProof: undefined, inviteHash: 'ab'.repeat(32) });
    expect(turn.mock.calls[0][0]).toEqual({ t: 'turn-request', inviteHash: 'ab'.repeat(32) });
  });

  it('gives the exact copy when no relay servers come back', async () => {
    expect(RTC_UNREACHABLE).toBe("Can't connect to the NAS from this network. Try another Wi-Fi or mobile data.");
    const w = world({ direct: false, relay: true, turn: () => ({ iceServers: [], reason: 'off' }) });
    const err = await open(w).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RtcUnreachable);
    expect((err as Error).message).toBe(RTC_UNREACHABLE);
    expect(w.peers).toHaveLength(1);
    expect(w.sockets.every((s) => s.readyState === 3)).toBe(true);
  });

  it('gives the limit copy when the free allowance is used up', async () => {
    expect(relayLimitMessage('2026-11-01', 'en-US')).toBe("The relay's free allowance for this month is used up. It resets on November 1, 2026.");
    const w = world({ direct: false, relay: true, turn: () => ({ iceServers: [], reason: 'limit', resetsOn: '2026-11-01' }) });
    const err = (await open(w).catch((e: unknown) => e)) as RtcUnreachable;
    expect(err).toBeInstanceOf(RtcUnreachable);
    expect(err.reason).toBe('limit');
    expect(err.message).toBe(relayLimitMessage('2026-11-01'));
  });

  it('gives the copy when the relayed retry fails too, or without a proof or invite', async () => {
    await expect(open(world({ direct: false, relay: false, turn: () => ({ iceServers: TURN }) }))).rejects.toThrow(RTC_UNREACHABLE);
    const w = world({ direct: false });
    await expect(open(w, { deviceProof: undefined })).rejects.toThrow(RTC_UNREACHABLE);
    expect(w.sent.some((m) => m.t === 'turn-request')).toBe(false);
  });

  it('gives the copy when the NAS is offline, the Worker refuses the socket, or the NAS refuses the offer', async () => {
    for (const code of [4404, 4429, 1008]) await expect(open(world({ refuseSocket: code }))).rejects.toThrow(RTC_UNREACHABLE);
    await expect(open(world({ answerError: 'busy' }))).rejects.toThrow(RTC_UNREACHABLE);
  });

  it('gives the copy with the reason when the NAS refuses the relay as unauthorized or unavailable', async () => {
    for (const reason of ['unauthorized', 'unavailable'] as const) {
      const err = (await open(world({ direct: false, relay: true, turn: () => ({ iceServers: [], reason }) })).catch((e: unknown) => e)) as RtcUnreachable;
      expect(err).toBeInstanceOf(RtcUnreachable);
      expect(err.reason).toBe(reason);
      expect(err.message).toBe(RTC_UNREACHABLE);
    }
  });

  it("doesn't take a late answer to the first offer as the answer to the relayed one", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world({ direct: false, relay: true, turn: () => ({ iceServers: TURN }), answerDelaysMs: [9_000] });
    const opening = open(w);
    await vi.advanceTimersByTimeAsync(9_000);
    const conn = await opening;
    expect(conn.relayed).toBe(true);
    expect(w.peers[0].remoteSdp).toBeUndefined();
    expect(w.peers[1].remoteSdp).toBe('answer-to:offer2');
  });

  it('fails a response body being read as nas-lost when the path is lost', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const w = world({
      handle: async () => ({
        status: 200,
        headers: {},
        body: (async function* () {
          yield new Uint8Array([1, 2, 3]);
          await held;
        })(),
      }),
    });
    const conn = await open(w);
    const res = await conn.fetch(`${RTC_BASE(NAS_ID)}discs/x/files/a`);
    const reading = res.arrayBuffer();
    await new Promise((r) => setTimeout(r, 0));
    w.peers[0].fail();
    await expect(reading).rejects.toMatchObject({ name: 'TypeError', reason: 'nas-lost', message: NAS_LOST_MESSAGE });
    release();
  });

  it('gives up on the direct path after 8 s, then asks for TURN on a new socket when the old one expired', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world({ direct: false, relay: true, hang: true, turn: () => ({ iceServers: TURN }) });
    const opening = open(w);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(w.sent.some((m) => m.t === 'turn-request')).toBe(false);
    w.sockets[0].close(4408); // expired
    await vi.advanceTimersByTimeAsync(1);
    const conn = await opening;
    expect(conn.relayed).toBe(true);
    expect(w.sockets).toHaveLength(2);
    expect(w.sent.find((m) => m.t === 'turn-request')?.sid).toBe('sid2');
  });

  it('closes when the path is lost: requests in flight fail and listeners hear it once', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const w = world({
      handle: async () => {
        await held;
        return { status: 200, headers: {}, body: 'late' };
      },
    });
    const conn = await open(w);
    const closed = vi.fn();
    conn.onClose(closed);
    const inFlight = conn.fetch(`${RTC_BASE(NAS_ID)}library`);
    const outcome = expect(inFlight).rejects.toThrow();
    w.peers[0].fail();
    await outcome;
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(conn.closed).toBe(true);
    await expect(conn.fetch(`${RTC_BASE(NAS_ID)}library`)).rejects.toThrow();
    release();
  });
});
