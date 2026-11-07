import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RTCPeerConnection } from 'werift';
import type { RTCDataChannel } from 'werift';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WireClient } from '@seikou/nas/rtc-wire';
import { appHandlers } from '../app';
import { Auth } from '../auth';
import { BdjStore } from '../bdj-store';
import type { Handler } from '../http';
import { Library, SETTLE_MS } from '../library';
import { Store } from '../store';
import { answerWithCandidates, isMdnsCandidate, relayAddresses, RelayTracker, RtcPeers, RtcRefused, stunOnly, wireChannelOf, withoutMdnsCandidates } from './peer';

// Every name here is made up. Each RtcPeers binds an ephemeral UDP port (0), so no run clashes with another's or the E2E's.

/**
 * A STUN server on loopback that answers every Binding request with the sender's address. werift falls back to
 * stun.l.google.com when a peer connection is given no STUN server, and `setLocalDescription` waits for that query
 * (up to the gather timeout), so without this every offer and answer here waited on a round trip over the internet,
 * and a slow one outlasted the 300 ms `unopenedMs` of the limits test.
 */
function stunServer(): Promise<Socket> {
  const socket = createSocket('udp4');
  socket.on('message', (msg, from) => {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001 || msg.readUInt32BE(4) !== 0x2112a442) return;
    const res = Buffer.alloc(32);
    res.writeUInt16BE(0x0101, 0); // Binding success
    res.writeUInt16BE(12, 2);
    msg.copy(res, 4, 4, 20); // magic cookie and transaction id
    res.writeUInt16BE(0x0020, 20); // XOR-MAPPED-ADDRESS
    res.writeUInt16BE(8, 22);
    res.writeUInt16BE(0x0001, 24); // IPv4
    res.writeUInt16BE(from.port ^ 0x2112, 26);
    const ip = from.address.split('.').reduce((n, b) => n * 256 + Number(b), 0);
    res.writeUInt32BE((ip ^ 0x2112a442) >>> 0, 28);
    socket.send(res, from.port, from.address);
  });
  return new Promise((resolve) => socket.bind(0, '127.0.0.1', () => resolve(socket)));
}

let stun: Socket;
/** The loopback STUN server, the only ICE server any peer connection here uses. */
const STUN = (): Array<{ urls: string }> => [{ urls: `stun:127.0.0.1:${stun.address().port}` }];

beforeAll(async () => {
  stun = await stunServer();
});
afterAll(() => new Promise<void>((resolve) => stun.close(() => resolve())));

const INDEX = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 37 + 11) & 0xff));

let tmp: string;
let auth: Auth;
let library: Library;
let handlers: Handler[];
const open: Array<{ close(): unknown }> = [];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'rtc-peer-'));
  const data = join(tmp, 'data');
  const disc = join(tmp, 'root', 'Starfall Wanderer Vol 1', 'BDMV');
  mkdirSync(disc, { recursive: true });
  writeFileSync(join(disc, 'index.bdmv'), INDEX);
  auth = new Auth(new Store(data), Date.now);
  library = new Library([{ name: 'drv', dir: join(tmp, 'root') }], join(data, 'library.json'), { scanPauseMs: 0, now: () => Date.now() + SETTLE_MS + 1 });
  await library.scan();
  handlers = appHandlers({ auth, library, bdjStore: new BdjStore(data), publicBase: 'https://nas.example/bluray/api/' });
});

afterEach(async () => {
  for (const o of open.splice(0).reverse()) await o.close();
  rmSync(tmp, { recursive: true, force: true });
});

function peersOn(port: number, limits?: ConstructorParameters<typeof RtcPeers>[0]['limits']): RtcPeers {
  const peers = new RtcPeers({ handlers, auth, port, advertise: () => ['127.0.0.1'], iceServers: async () => STUN(), now: Date.now, limits });
  open.push({ close: () => peers.closeAll() });
  return peers;
}

/** A device's side: an `api` channel offered to `peers` as `sid`, its candidates trickled. */
async function connect(peers: RtcPeers, sid: string): Promise<{ pc: RTCPeerConnection; dc: RTCDataChannel; answer: string; client: WireClient }> {
  const pc = new RTCPeerConnection({ iceServers: STUN(), iceUseIpv6: false });
  open.push({ close: () => pc.close() });
  const dc = pc.createDataChannel('api');
  pc.onIceCandidate.subscribe((c) => {
    if (c) peers.candidate(sid, c.toJSON());
  });
  await pc.setLocalDescription(await pc.createOffer());
  const { answer } = await peers.answer(sid, pc.localDescription!.sdp);
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  await new Promise<void>((resolve, reject) => {
    if (dc.readyState === 'open') return resolve();
    const timer = setTimeout(() => reject(new Error('channel did not open')), 10_000);
    dc.stateChanged.subscribe((s) => {
      if (s === 'open') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return { pc, dc, answer, client: new WireClient(wireChannelOf(dc)) };
}

async function deviceKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const sign = async (text: string): Promise<string> =>
    Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(text))).toString('base64url');
  return { jwk, sign };
}

/** Redeems a fresh code and starts a session over `client`: the device id and its token. */
async function sessionOver(client: WireClient): Promise<{ deviceId: string; token: string }> {
  const post = (path: string, body: unknown): Promise<Response> =>
    client.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const { jwk, sign } = await deviceKey();
  const { code } = auth.createCode({ newPerson: { name: 'Mika', owner: false } });
  const redeemed = await post('/api/pair/redeem', { code, deviceName: 'Phone', publicKeyJwk: jwk });
  expect(redeemed.status).toBe(200);
  const { deviceId } = (await redeemed.json()) as { deviceId: string };
  const { challenge } = (await (await post('/api/session/challenge', { deviceId })).json()) as { challenge: string };
  const res = await post('/api/session', { deviceId, challenge, signature: await sign(challenge) });
  expect(res.status).toBe(200);
  return { deviceId, token: ((await res.json()) as { token: string }).token };
}

async function readRange(client: WireClient, token: string, from: number, to: number): Promise<Buffer> {
  const [disc] = library.list('')!.discs;
  const res = await client.fetch(`/api/discs/${disc!.id}/files/BDMV/index.bdmv?t=${encodeURIComponent(token)}`, { headers: { Range: `bytes=${from}-${to}` } });
  expect(res.status).toBe(206);
  return Buffer.from(await res.arrayBuffer());
}

const candidateLines = (sdp: string): string[] => sdp.split(/\r?\n/).filter((l) => l.startsWith('a=candidate:'));

describe('RtcPeers', () => {
  it('serves the api channel over a real connection: a session, then a disc range byte-exact', { timeout: 30_000 }, async () => {
    const peers = peersOn(0);
    const { client } = await connect(peers, 'sid-aaaaaaaaaaaaaaaaaaa');
    const { deviceId, token } = await sessionOver(client);
    const bytes = await readRange(client, token, 1000, 250_999);
    expect(bytes.equals(INDEX.subarray(1000, 251_000))).toBe(true);
    expect(auth.devices().find((d) => d.id === deviceId)?.lastRoute).toBe('webrtc');
  });

  it('classes a session relayed when the relay candidate arrives late, notes the route and counts its earlier bytes', { timeout: 30_000 }, async () => {
    let relayed = 0;
    const peers = new RtcPeers({
      handlers, auth, port: 0, advertise: () => ['127.0.0.1'], iceServers: async () => STUN(), now: Date.now, sampleMs: 50,
      onRelayedBytes: (n) => (relayed += n),
    });
    open.push({ close: () => peers.closeAll() });
    const sid = 'sid-kkkkkkkkkkkkkkkkkkk';
    const { pc, client } = await connect(peers, sid);
    const { deviceId, token } = await sessionOver(client);
    await readRange(client, token, 0, 99_999);
    const device = () => auth.devices().find((d) => d.id === deviceId)?.lastRoute;
    expect(device()).toBe('webrtc');
    expect(relayed).toBe(0);

    // The device's address as the NAS sees it, announced as a relay candidate after the fact (as when werift
    // learnt the relayed address as prflx before the trickled candidate came).
    const local = pc.iceTransports[0]!.connection.nominated!.localCandidate;
    peers.candidate(sid, { candidate: `candidate:9 1 udp 41885439 ${local.host} ${local.port} typ relay raddr 0.0.0.0 rport 0`, sdpMid: '0' });
    expect(device()).toBe('relay');
    await expect.poll(() => relayed, { timeout: 5000 }).toBeGreaterThan(100_000);
  });

  it('classes a session relayed when the device comes from a TURN server it was handed, relay candidates hidden', { timeout: 30_000 }, async () => {
    const peers = new RtcPeers({ handlers, auth, port: 0, advertise: () => ['127.0.0.1'], iceServers: async () => STUN(), now: Date.now });
    open.push({ close: () => peers.closeAll() });
    const sid = 'sid-lllllllllllllllllll';
    const { pc, client } = await connect(peers, sid);
    const { deviceId } = await sessionOver(client);
    expect(auth.devices().find((d) => d.id === deviceId)?.lastRoute).toBe('webrtc');
    peers.noteTurnServers(sid, [pc.iceTransports[0]!.connection.nominated!.localCandidate.host]);
    expect(auth.devices().find((d) => d.id === deviceId)?.lastRoute).toBe('relay');
  });

  it('answers with only the advertised host candidates on its port', { timeout: 30_000 }, async () => {
    const peers = peersOn(0);
    const { answer } = await connect(peers, 'sid-bbbbbbbbbbbbbbbbbbb');
    const lines = candidateLines(answer);
    expect(lines).toHaveLength(1);
    // the port the mux bound, not the 0 it was asked for
    expect(peers.udpPort).toBeGreaterThan(0);
    expect(lines[0]).toMatch(new RegExp(`^a=candidate:\\S+ 1 udp \\d+ 127\\.0\\.0\\.1 ${peers.udpPort} typ host`));
    expect(answer).toContain('a=end-of-candidates');
    expect(answer).not.toMatch(/(^|[\s:])172\.(1[6-9]|2\d|3[01])\./m);
    expect(answer).not.toMatch(/(^|[\s:])100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./m);
  });

  it("answers at once when the NAS's STUN server never replies, and the connection still opens", { timeout: 30_000 }, async () => {
    // the answer's candidates are the advertised addresses, so no STUN lookup is waited for
    const silent = createSocket('udp4');
    await new Promise<void>((resolve) => silent.bind(0, '127.0.0.1', () => resolve()));
    open.push({ close: () => new Promise<void>((resolve) => silent.close(() => resolve())) });
    const peers = new RtcPeers({ handlers, auth, port: 0, advertise: () => ['127.0.0.1'], iceServers: async () => [{ urls: `stun:127.0.0.1:${silent.address().port}` }], now: Date.now });
    open.push({ close: () => peers.closeAll() });
    await peers.listen();
    const pc = new RTCPeerConnection({ iceServers: STUN(), iceUseIpv6: false });
    open.push({ close: () => pc.close() });
    pc.createDataChannel('api');
    await pc.setLocalDescription(await pc.createOffer());
    const t0 = performance.now();
    await peers.answer('sid-sssssssssssssssssss', pc.localDescription!.sdp);
    expect(performance.now() - t0).toBeLessThan(1000);
    const { client } = await connect(peers, 'sid-ttttttttttttttttttt');
    const { token } = await sessionOver(client);
    expect(await readRange(client, token, 0, 9)).toEqual(INDEX.subarray(0, 10));
  });

  it('serves two devices at once on the one UDP port', { timeout: 30_000 }, async () => {
    const peers = peersOn(0);
    const a = await connect(peers, 'sid-ccccccccccccccccccc');
    const b = await connect(peers, 'sid-ddddddddddddddddddd');
    const [sa, sb] = await Promise.all([sessionOver(a.client), sessionOver(b.client)]);
    const [ra, rb] = await Promise.all([readRange(a.client, sa.token, 0, 99_999), readRange(b.client, sb.token, 100_000, 199_999)]);
    expect(ra.equals(INDEX.subarray(0, 100_000))).toBe(true);
    expect(rb.equals(INDEX.subarray(100_000, 200_000))).toBe(true);
    expect(peers.size).toBe(2);
  });

  it('cleans a peer up when its channel closes', { timeout: 30_000 }, async () => {
    const peers = peersOn(0);
    const { dc } = await connect(peers, 'sid-eeeeeeeeeeeeeeeeeee');
    expect(peers.size).toBe(1);
    dc.close();
    await expect.poll(() => peers.size, { timeout: 5000 }).toBe(0);
  });

  it('refuses a fifth offer from one sid and a peer over the limit, and drops one whose channel never opens', { timeout: 30_000 }, async () => {
    const peers = peersOn(0, { peers: 3, unopenedMs: 300 });
    const device = new RTCPeerConnection({ iceServers: STUN(), iceUseIpv6: false });
    open.push({ close: () => device.close() });
    device.createDataChannel('api');
    await device.setLocalDescription(await device.createOffer());
    const offer = device.localDescription!.sdp;

    for (let i = 0; i < 4; i++) await peers.answer('sid-fffffffffffffffffff', offer);
    await expect(peers.answer('sid-fffffffffffffffffff', offer)).rejects.toEqual(new RtcRefused('too-many-offers'));
    expect(peers.size).toBe(1); // a new offer from a sid replaces its peer
    await peers.answer('sid-ggggggggggggggggggg', offer);
    await peers.answer('sid-hhhhhhhhhhhhhhhhhhh', offer);
    await expect(peers.answer('sid-iiiiiiiiiiiiiiiiiii', offer)).rejects.toEqual(new RtcRefused('busy'));
    await expect.poll(() => peers.size, { timeout: 5000 }).toBe(0);
    await peers.answer('sid-iiiiiiiiiiiiiiiiiii', offer);
    expect(peers.size).toBe(1);
  });
});

describe('answerWithCandidates', () => {
  const sdp = [
    'v=0',
    'o=- 1 0 IN IP4 0.0.0.0',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=candidate:1 1 udp 2130706431 172.18.0.5 47998 typ host',
    'a=candidate:2 1 udp 2130706431 100.101.102.103 47998 typ host',
    'a=candidate:3 1 udp 1694498815 203.0.113.9 51000 typ srflx raddr 172.18.0.5 rport 47998',
    'a=end-of-candidates',
    'a=sctp-port:5000',
    '',
  ].join('\r\n');

  it('replaces every candidate with the advertised addresses on the port', () => {
    const out = answerWithCandidates(sdp, ['203.0.113.9', '192.168.1.20'], 47998);
    expect(candidateLines(out)).toEqual([
      'a=candidate:1 1 udp 2130706431 203.0.113.9 47998 typ host generation 0',
      'a=candidate:2 1 udp 2130706175 192.168.1.20 47998 typ host generation 0',
    ]);
    expect(out).toContain('c=IN IP4 203.0.113.9');
    expect(out).not.toContain('172.18.');
    expect(out).not.toContain('100.101.');
    expect(out.split('a=end-of-candidates')).toHaveLength(2);
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('never advertises a Docker or Tailscale address even when told to', () => {
    const out = answerWithCandidates(sdp, ['172.20.0.2', '100.64.1.1', '192.168.1.20'], 47998);
    expect(candidateLines(out)).toEqual(['a=candidate:1 1 udp 2130706431 192.168.1.20 47998 typ host generation 0']);
  });
});

describe('mDNS candidates', () => {
  const MDNS = 'candidate:1 1 udp 2122260223 3f1c2b4a-0d7e-4c1a-9a8b-2e6f5d4c3b2a.local 54321 typ host generation 0';
  const HOST = 'candidate:2 1 udp 2122260223 192.168.1.20 54322 typ host generation 0';

  it('tells a .local (mDNS) candidate from an address one, with or without a=', () => {
    expect(isMdnsCandidate(MDNS)).toBe(true);
    expect(isMdnsCandidate(`a=${MDNS.toUpperCase()}`)).toBe(true);
    expect(isMdnsCandidate(HOST)).toBe(false);
    expect(isMdnsCandidate('candidate:3 1 udp 1 203.0.113.9 3478 typ relay raddr x.local rport 1')).toBe(false);
  });

  it('strips the .local candidate lines from an offer and keeps the rest', () => {
    const sdp = ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', `a=${MDNS}`, `a=${HOST}`, 'a=end-of-candidates', ''].join('\r\n');
    expect(withoutMdnsCandidates(sdp)).toBe(['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', `a=${HOST}`, 'a=end-of-candidates', ''].join('\r\n'));
  });

  it('never hands werift a .local candidate, in the offer or trickled', { timeout: 30_000 }, async () => {
    const remote: string[] = [];
    const added: string[] = [];
    const peers = new RtcPeers({
      handlers, auth, port: 0, advertise: () => ['127.0.0.1'], now: Date.now, iceServers: async () => STUN(),
      createPeerConnection: (config) => {
        const pc = new RTCPeerConnection(config);
        const setRemote = pc.setRemoteDescription.bind(pc);
        pc.setRemoteDescription = (d) => {
          remote.push(d.sdp ?? '');
          return setRemote(d);
        };
        const add = pc.addIceCandidate.bind(pc);
        pc.addIceCandidate = (c) => {
          added.push(c?.candidate ?? '');
          return add(c);
        };
        return pc;
      },
    });
    open.push({ close: () => peers.closeAll() });
    const device = new RTCPeerConnection({ iceServers: STUN(), iceUseIpv6: false });
    open.push({ close: () => device.close() });
    device.createDataChannel('api');
    await device.setLocalDescription(await device.createOffer());
    const offer = device.localDescription!.sdp.replace(/(m=application[^\r\n]*\r?\n)/, `$1a=${MDNS}\r\n`);
    expect(offer).toContain('.local');
    const sid = 'sid-mmmmmmmmmmmmmmmmmmm';
    await peers.answer(sid, offer);
    expect(remote).toHaveLength(1);
    expect(remote[0]).not.toContain('.local');
    peers.candidate(sid, { candidate: MDNS, sdpMid: '0', sdpMLineIndex: 0 });
    peers.candidate(sid, { candidate: HOST, sdpMid: '0', sdpMLineIndex: 0 });
    expect(added).toEqual([HOST]);
  });
});

describe('the NAS peer', () => {
  it('is built with STUN servers only, whatever it is given', { timeout: 30_000 }, async () => {
    const configs: unknown[] = [];
    const peers = new RtcPeers({
      handlers, auth, port: 0, advertise: () => ['127.0.0.1'], now: Date.now,
      iceServers: async () => [{ urls: 'stun:stun.example:3478' }, { urls: ['turn:turn.example:3478', 'stun:stun2.example:3478'], username: 'u', credential: 'c' }],
      createPeerConnection: (config) => {
        configs.push(config.iceServers);
        return new RTCPeerConnection({ ...config, iceServers: STUN() }); // the made-up servers are never asked
      },
    });
    open.push({ close: () => peers.closeAll() });
    const device = new RTCPeerConnection({ iceServers: STUN(), iceUseIpv6: false });
    open.push({ close: () => device.close() });
    device.createDataChannel('api');
    await device.setLocalDescription(await device.createOffer());
    await peers.answer('sid-jjjjjjjjjjjjjjjjjjj', device.localDescription!.sdp);
    expect(configs).toEqual([[{ urls: ['stun:stun.example:3478'] }, { urls: ['stun:stun2.example:3478'] }]]);
  });

  it('stunOnly drops TURN urls and the servers left with none', () => {
    expect(stunOnly([{ urls: 'turns:t.example:443', username: 'u', credential: 'c' }, { urls: ['STUN:s.example'] }])).toEqual([{ urls: ['STUN:s.example'] }]);
  });
});

describe('relay classification', () => {
  const offer = [
    'v=0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host generation 0',
    'a=candidate:2 1 udp 1686052607 203.0.113.4 6000 typ srflx raddr 192.168.1.20 rport 50000',
    'a=candidate:3 1 udp 41885439 198.51.100.7 50123 typ relay raddr 203.0.113.4 rport 6000 generation 0',
    'a=candidate:4 1 tcp 8331263 2001:DB8::9 443 typ relay raddr 203.0.113.4 rport 6001 tcptype passive',
    '',
  ].join('\r\n');

  it('finds the relay candidate addresses in an SDP and in trickled candidates', () => {
    expect(relayAddresses(offer)).toEqual(['198.51.100.7:50123', '2001:db8::9:443']);
    expect(relayAddresses('candidate:9 1 udp 41885439 198.51.100.8 51000 typ relay raddr 0.0.0.0 rport 0')).toEqual(['198.51.100.8:51000']);
    expect(relayAddresses('a=candidate:9 1 udp 41885439 198.51.100.8 51000 typ relay')).toEqual(['198.51.100.8:51000']);
    expect(relayAddresses('candidate:2 1 udp 1686052607 203.0.113.4 6000 typ srflx raddr 192.168.1.20 rport 50000')).toEqual([]);
    expect(relayAddresses('candidate:x typ relay')).toEqual([]);
  });

  const pair = (ip: string, port: number, type = 'prflx', bytes = 0) => ({ remoteCandidate: { type }, remoteAddr: [ip, port] as [string, number], bytesSent: bytes, bytesReceived: bytes });

  it("calls a pair relayed when its remote address is one of the device's relay candidates, even learnt as prflx", () => {
    const tracker = new RelayTracker();
    tracker.note(offer);
    expect(tracker.route(pair('198.51.100.7', 50123))).toBe('relay');
    expect(tracker.route(pair('198.51.100.7', 50124))).toBe('webrtc');
    expect(tracker.route(pair('203.0.113.4', 6000, 'srflx'))).toBe('webrtc');
    expect(tracker.route(pair('192.0.2.1', 1, 'relay'))).toBe('relay');
    expect(tracker.route(undefined)).toBe('webrtc');
  });

  it("calls a pair relayed on any port of a TURN server's address the device was handed", () => {
    const tracker = new RelayTracker();
    tracker.noteServers(['198.51.100.1', '2001:DB8::1']);
    expect(tracker.route(pair('198.51.100.1', 61000))).toBe('relay');
    expect(tracker.route(pair('2001:db8::1', 3478))).toBe('relay');
    expect(tracker.route(pair('198.51.100.2', 61000))).toBe('webrtc');
  });

  it("counts a relayed pair's bytes both ways, including those sent before a late reclassification", () => {
    const tracker = new RelayTracker();
    const p = pair('198.51.100.8', 51000, 'prflx', 1_000);
    expect(tracker.sample(p)).toBe(0); // not known as relayed yet
    p.bytesSent += 500;
    tracker.note('candidate:9 1 udp 41885439 198.51.100.8 51000 typ relay raddr 0.0.0.0 rport 0');
    expect(tracker.sample(p)).toBe(2_500);
    p.bytesReceived += 300;
    expect(tracker.sample(p)).toBe(300);
    expect(tracker.sample(p)).toBe(0);
    expect(tracker.sample(undefined)).toBe(0);
  });
});
