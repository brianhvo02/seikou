import { RTCPeerConnection } from 'werift';
import type { PeerConfig, RTCDataChannel } from 'werift';
import { SIGNAL_DEVICE_LIFETIME_MS } from '../../../rendezvous/src/protocol';
import type { WireChannel } from '@seikou/nas/rtc-wire';
import type { Auth, DeviceRoute } from '../auth';
import type { Handler } from '../http';
import { serveChannel } from './dispatch';
import { neverDockerOrTailscale } from './public-address';
import { UdpMux } from './udp-mux';
import type { MuxOwner } from './udp-mux';

/** An ICE server as `RTCPeerConnection` takes it. */
export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface PeerLimits {
  /** Offers one device socket (`sid`) may make; more are refused. */
  offersPerSid: number;
  /** Peer connections at once; more are refused. */
  peers: number;
  /** A peer whose `api` channel hasn't opened this long after its offer is dropped. */
  unopenedMs: number;
}

const DEFAULT_LIMITS: PeerLimits = { offersPerSid: 4, peers: 16, unopenedMs: 30_000 };
const SAMPLE_MS = 10_000;
/** How long to wait for werift's first local candidate before answering (the answer's candidates are ours anyway). */
const GATHER_WAIT_MS = 2_000;

/** Why an offer was refused, sent back to the device as the answer's `error`. */
export class RtcRefused extends Error {
  constructor(readonly reason: 'busy' | 'too-many-offers') {
    super(reason);
    this.name = 'RtcRefused';
  }
}

export interface RtcPeersOptions {
  handlers: readonly Handler[];
  auth: Auth;
  /** The one UDP port ICE uses (47998); 0 binds one the system picks, which the answers advertise (tests). */
  port: number;
  /** The addresses the answer advertises as host candidates on `port`. */
  advertise: () => string[];
  /** The NAS's own ICE servers; only their STUN urls are used (`stunOnly`). */
  iceServers: () => Promise<RTCIceServerLike[]>;
  now: () => number;
  limits?: Partial<PeerLimits>;
  /** Bytes both ways on connections classed as relayed, since the last call (sampled every `sampleMs`). */
  onRelayedBytes?: (bytes: number) => void;
  /** How often a connection's route is checked again and its relayed bytes sampled. Default 10 s. */
  sampleMs?: number;
  /** Builds a peer connection; tests watch the config through it. */
  createPeerConnection?: (config: Partial<PeerConfig>) => RTCPeerConnection;
}

interface Peer {
  readonly sid: string;
  readonly pc: RTCPeerConnection;
  readonly owner: MuxOwner;
  timer: NodeJS.Timeout | undefined;
  sampler: NodeJS.Timeout | undefined;
  served: { close(): void } | null;
  closed: boolean;
  readonly relay: RelayTracker;
  /** The device whose session runs on this connection, once it has started one. */
  deviceId: string | null;
  route: RtcRoute;
}

type RtcRoute = Extract<DeviceRoute, 'webrtc' | 'relay'>;

/**
 * The NAS's servers with only their STUN urls. The NAS's own peer must NEVER use TURN: werift's TURN client would
 * run through the UDP mux, which routes a datagram it can't match by ICE credentials by its sender's address, and a
 * TURN server's address is shared by every allocation on it. Only the device uses the relay; the NAS answers on its
 * public candidate, and the relay reaches it there.
 */
export function stunOnly(servers: readonly RTCIceServerLike[]): RTCIceServerLike[] {
  return servers.flatMap((server) => {
    const urls = (typeof server.urls === 'string' ? [server.urls] : server.urls).filter((u) => /^stun:/i.test(u));
    return urls.length > 0 ? [{ urls }] : [];
  });
}

const CANDIDATE_ADDRESS = /^(?:a=)?candidate:\S+ \d+ \S+ \d+ (\S+) /i;

/**
 * Whether a candidate (`candidate:…`, with or without `a=`) names an mDNS host (`<uuid>.local`), as browsers hide LAN
 * addresses. The NAS can't resolve those, and werift would open a multicast socket per peer trying to, so they are
 * dropped: the device's other candidates (public, relay, or the NAS's own host candidates it checks) still connect.
 */
export function isMdnsCandidate(candidate: string): boolean {
  const m = CANDIDATE_ADDRESS.exec(candidate.trim());
  return m !== null && m[1]!.toLowerCase().endsWith('.local');
}

/** `sdp` without its mDNS (`.local`) candidate lines. */
export function withoutMdnsCandidates(sdp: string): string {
  return sdp
    .split('\n')
    .filter((line) => !(line.startsWith('a=candidate:') && isMdnsCandidate(line)))
    .join('\n');
}

/**
 * The `ip:port` of every `typ relay` candidate in an SDP or a trickled candidate string (`candidate:…`, with or
 * without `a=`), lowercased so IPv6 spellings compare.
 */
export function relayAddresses(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(?:a=)?candidate:\S+ \d+ \S+ \d+ (\S+) (\d+) typ relay(?:\s|$)/i.exec(line.trim());
    if (m) out.push(`${m[1]!.toLowerCase()}:${m[2]}`);
  }
  return out;
}

/** A werift candidate pair as the tracker reads it. */
export interface PairLike {
  readonly remoteCandidate: { readonly type: string };
  readonly remoteAddr: readonly [string, number];
  readonly bytesSent: number;
  readonly bytesReceived: number;
}

/**
 * Whether a connection runs through the relay, and its relayed bytes. werift may learn the device's relayed address
 * as `prflx` (the first check can beat the trickled relay candidate), so the remote candidate's type can't be
 * trusted: the tracker remembers every relay candidate address the device sent (offer and trickle) and calls a pair
 * relayed when its remote address is one of them. Bytes are counted per pair from werift's counters, from zero, so
 * a pair classed as relayed late has its earlier bytes counted at the next sample.
 */
export class RelayTracker {
  private readonly addresses = new Set<string>();
  private readonly servers = new Set<string>();
  private readonly counted = new WeakMap<PairLike, number>();

  /** Remembers the relay candidates in an SDP or a trickled candidate. */
  note(text: string): void {
    for (const address of relayAddresses(text)) this.addresses.add(address);
  }

  /**
   * Remembers the addresses of the TURN servers handed to this device: a pair from one of them is relayed on any
   * port, which catches a device that hides its relay candidates.
   */
  noteServers(ips: Iterable<string>): void {
    for (const ip of ips) this.servers.add(ip.toLowerCase());
  }

  route(pair: PairLike | undefined): RtcRoute {
    if (pair === undefined) return 'webrtc';
    const ip = pair.remoteAddr[0].toLowerCase();
    const port = pair.remoteAddr[1];
    return pair.remoteCandidate.type === 'relay' || this.addresses.has(`${ip}:${port}`) || this.servers.has(ip) ? 'relay' : 'webrtc';
  }

  /** The bytes both ways on `pair` since its last sample, when it is relayed; 0 otherwise. */
  sample(pair: PairLike | undefined): number {
    if (pair === undefined || this.route(pair) !== 'relay') return 0;
    const total = pair.bytesSent + pair.bytesReceived;
    const delta = total - (this.counted.get(pair) ?? 0);
    this.counted.set(pair, total);
    return Math.max(0, delta);
  }
}

/**
 * `sdp` with its candidates replaced by host candidates for `addresses` on `port` (Docker and Tailscale addresses
 * dropped), followed by end-of-candidates, and its connection lines pointing at the first address.
 */
export function answerWithCandidates(sdp: string, addresses: readonly string[], port: number): string {
  const ips = [...new Set(addresses.filter(neverDockerOrTailscale))];
  const lines = sdp.split(/\r?\n/).filter((l) => l !== '' && !l.startsWith('a=candidate:') && l !== 'a=end-of-candidates');
  const candidates = [...ips.map((ip, i) => `a=candidate:${i + 1} 1 udp ${2130706431 - i * 256} ${ip} ${port} typ host generation 0`), 'a=end-of-candidates'];
  const out: string[] = [];
  let inMedia = false;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      if (inMedia) out.push(...candidates);
      inMedia = true;
    }
    out.push(ips.length > 0 && line.startsWith('c=IN IP4 ') ? `c=IN IP4 ${ips[0]}` : line);
  }
  if (inMedia) out.push(...candidates);
  return `${out.join('\r\n')}\r\n`;
}

/** An SDP's first `a=ice-<name>` value. */
function iceAttribute(sdp: string, name: 'ufrag' | 'pwd'): string | undefined {
  return new RegExp(`^a=ice-${name}:(\\S+)`, 'm').exec(sdp)?.[1];
}

/**
 * A werift data channel as the wire sees it. `onClosed` runs once when the channel closes, whoever holds `onclose`.
 */
export function wireChannelOf(dc: RTCDataChannel, onClosed?: () => void): WireChannel {
  let onbufferedamountlow: (() => void) | null = null;
  let onmessage: ((data: string | Uint8Array) => void) | null = null;
  let onclose: (() => void) | null = null;
  let closed = false;
  const fireClose = (): void => {
    if (closed) return;
    closed = true;
    onclose?.();
    onClosed?.();
  };
  dc.bufferedAmountLow.subscribe(() => onbufferedamountlow?.());
  dc.onMessage.subscribe((m) => onmessage?.(typeof m === 'string' ? m : new Uint8Array(m.buffer, m.byteOffset, m.byteLength)));
  dc.stateChanged.subscribe((state) => {
    if (state === 'closed') fireClose();
  });
  if (dc.readyState === 'closed') queueMicrotask(fireClose);
  return {
    send(data) {
      if (dc.readyState !== 'open') throw new Error('InvalidStateError: the channel is not open');
      dc.send(typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    },
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
    get bufferedAmountLowThreshold() {
      return dc.bufferedAmountLowThreshold;
    },
    set bufferedAmountLowThreshold(value) {
      dc.bufferedAmountLowThreshold = value;
    },
    get onbufferedamountlow() {
      return onbufferedamountlow;
    },
    set onbufferedamountlow(listener) {
      onbufferedamountlow = listener;
    },
    get onmessage() {
      return onmessage;
    },
    set onmessage(listener) {
      onmessage = listener;
    },
    get onclose() {
      return onclose;
    },
    set onclose(listener) {
      onclose = listener;
    },
    close() {
      try {
        dc.close();
      } finally {
        fireClose();
      }
    },
  };
}

/**
 * The NAS's WebRTC peers: one werift `RTCPeerConnection` per device socket (`sid`), all on one UDP port, each
 * answering requests from its `api` data channel through `serveChannel`. An answer advertises only the configured
 * addresses as host candidates on that port.
 */
export class RtcPeers {
  private readonly peers = new Map<string, Peer>();
  private readonly offers = new Map<string, { count: number; since: number }>();
  /** TURN server addresses handed to each device socket, kept for its lifetime so a later offer's peer gets them. */
  private readonly turnServers = new Map<string, { ips: string[]; since: number }>();
  private readonly limits: PeerLimits;
  private muxing: Promise<UdpMux> | undefined;
  private bound: UdpMux | null = null;

  constructor(private readonly opts: RtcPeersOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
  }

  /** Peer connections open now. */
  get size(): number {
    return this.peers.size;
  }

  /** The UDP port ICE is on once the first offer opened it (the one bound when `port` is 0), else null. */
  get udpPort(): number | null {
    return this.bound?.port ?? null;
  }

  async answer(sid: string, offer: string): Promise<{ answer: string }> {
    this.countOffer(sid);
    this.admit(sid);
    const mux = await this.mux();
    const iceServers = stunOnly(await this.opts.iceServers());
    this.admit(sid); // again: another offer may have come in while this one waited
    const { port } = mux; // the bound one: `opts.port` may be 0
    const create = this.opts.createPeerConnection ?? ((config: Partial<PeerConfig>) => new RTCPeerConnection(config));
    const pc = create({
      iceServers,
      // werift refuses a range with equal ends, so it is narrowed after construction. The mux serves every
      // connection's ICE on `port`; the narrow range keeps a transport the mux doesn't serve on it too.
      icePortRange: [port, port + 1],
      iceUseIpv4: true,
      iceUseIpv6: false,
      iceUseLinkLocalAddress: false,
      // the answer's candidates are the advertised addresses (answerWithCandidates), so a server-reflexive candidate is
      // never used: no answer waits for werift's STUN lookup (it waited the whole lookup, 2 s when the server is silent)
      iceStunGatherTimeout: 0,
    });
    pc.config.icePortRange = [port, port];
    const peer: Peer = { sid, pc, owner: mux.owner(), timer: undefined, sampler: undefined, served: null, closed: false, relay: new RelayTracker(), deviceId: null, route: 'webrtc' };
    peer.relay.note(offer);
    this.pruneTurnServers();
    peer.relay.noteServers(this.turnServers.get(sid)?.ips ?? []);
    this.peers.set(sid, peer);
    peer.timer = setTimeout(() => this.drop(peer), this.limits.unopenedMs);
    peer.timer.unref();
    pc.onDataChannel.subscribe((dc) => this.channel(peer, dc));
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed') this.drop(peer);
    });
    pc.iceConnectionStateChange.subscribe(() => this.reclassify(peer)); // the nominated pair may have changed

    try {
      const gathered = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, GATHER_WAIT_MS);
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        pc.onIceCandidate.subscribe(done);
        pc.iceGatheringStateChange.subscribe((state) => state === 'complete' && done());
      });
      await peer.owner.run(async () => {
        await pc.setRemoteDescription({ type: 'offer', sdp: withoutMdnsCandidates(offer) });
        await pc.setLocalDescription(await pc.createAnswer());
      });
      const local = pc.localDescription?.sdp;
      const ufrag = local === undefined ? undefined : iceAttribute(local, 'ufrag');
      const password = local === undefined ? undefined : iceAttribute(local, 'pwd');
      const remoteUfrag = iceAttribute(offer, 'ufrag');
      if (ufrag === undefined || password === undefined) throw new Error('werift made no answer');
      if (remoteUfrag === undefined) throw new Error('the offer has no ICE ufrag');
      peer.owner.claim(ufrag, remoteUfrag, password); // a MuxConflict drops the peer below
      await gathered;
      if (peer.closed) throw new Error('the peer closed while answering');
      return { answer: answerWithCandidates(pc.localDescription!.sdp, this.opts.advertise(), port) };
    } catch (err) {
      this.drop(peer);
      throw err;
    }
  }

  /** Binds the UDP port now rather than at the first offer, so a port in use shows at start. */
  async listen(): Promise<void> {
    await this.mux();
  }

  /** The addresses of the TURN servers just handed to the device socket `sid` (`turnResponder`'s `onServers`). */
  noteTurnServers(sid: string, ips: readonly string[]): void {
    this.pruneTurnServers();
    const known = this.turnServers.get(sid)?.ips ?? [];
    this.turnServers.set(sid, { ips: [...new Set([...known, ...ips])], since: this.opts.now() });
    const peer = this.peers.get(sid);
    if (peer !== undefined) {
      peer.relay.noteServers(ips);
      this.reclassify(peer);
    }
  }

  private pruneTurnServers(): void {
    const now = this.opts.now();
    for (const [sid, entry] of this.turnServers) if (entry.since <= now - SIGNAL_DEVICE_LIFETIME_MS) this.turnServers.delete(sid);
  }

  /** A device's trickled ICE candidate; ignored without a peer for `sid`, when malformed, or for an mDNS host. */
  candidate(sid: string, c: unknown): void {
    const peer = this.peers.get(sid);
    if (peer === undefined || typeof c !== 'object' || c === null) return;
    const { candidate, sdpMid, sdpMLineIndex } = c as Record<string, unknown>;
    if (typeof candidate !== 'string' || candidate === '' || candidate.length > 1024 || isMdnsCandidate(candidate)) return;
    const init = {
      candidate,
      sdpMid: typeof sdpMid === 'string' ? sdpMid : undefined,
      sdpMLineIndex: typeof sdpMLineIndex === 'number' ? sdpMLineIndex : undefined,
    };
    peer.relay.note(candidate);
    this.reclassify(peer);
    peer.pc.addIceCandidate(init).catch(() => {
      // a candidate werift can't use is the device's problem, not the connection's
    });
  }

  /** Closes every peer and the UDP port. */
  async closeAll(): Promise<void> {
    for (const peer of [...this.peers.values()]) this.drop(peer);
    const muxing = this.muxing;
    this.muxing = undefined;
    this.bound = null;
    const mux = await muxing?.catch(() => undefined);
    await mux?.close();
  }

  /** Makes room for a new peer for `sid`: its old peer goes, and the offer is refused when the limit is reached. */
  private admit(sid: string): void {
    const previous = this.peers.get(sid);
    if (previous) this.drop(previous);
    if (this.peers.size >= this.limits.peers) throw new RtcRefused('busy');
  }

  private countOffer(sid: string): void {
    const now = this.opts.now();
    for (const [id, entry] of this.offers) if (entry.since <= now - SIGNAL_DEVICE_LIFETIME_MS) this.offers.delete(id);
    const entry = this.offers.get(sid) ?? { count: 0, since: now };
    if (entry.count >= this.limits.offersPerSid) throw new RtcRefused('too-many-offers');
    entry.count++;
    this.offers.set(sid, entry);
  }

  private mux(): Promise<UdpMux> {
    this.muxing ??= UdpMux.open(this.opts.port).then(
      (mux) => (this.bound = mux),
      (err: unknown) => {
        this.muxing = undefined;
        throw err;
      },
    );
    return this.muxing;
  }

  private channel(peer: Peer, dc: RTCDataChannel): void {
    if (dc.label !== 'api' || peer.served !== null || peer.closed) {
      dc.close();
      return;
    }
    const serve = (): void => {
      if (peer.closed || peer.served !== null) return;
      clearTimeout(peer.timer);
      const pair = this.nominated(peer);
      const channel = wireChannelOf(dc, () => this.drop(peer));
      peer.served = serveChannel(channel, this.opts.handlers, {
        auth: this.opts.auth,
        // The device's address as packets arrive from it; unknown, a bucket of its own for the pairing limits.
        remoteAddress: pair?.remoteAddr[0] ?? `webrtc:${peer.sid}`,
        now: this.opts.now,
        onSession: (deviceId) => {
          peer.deviceId = deviceId;
          this.reclassify(peer);
          this.opts.auth.noteRoute(deviceId, peer.route);
        },
      });
      peer.sampler = setInterval(() => this.sample(peer), this.opts.sampleMs ?? SAMPLE_MS);
      peer.sampler.unref();
    };
    if (dc.readyState === 'open') serve();
    else
      dc.stateChanged.subscribe((state) => {
        if (state === 'open') serve();
      });
  }

  private nominated(peer: Peer): PairLike | undefined {
    return peer.pc.iceTransports[0]?.connection.nominated;
  }

  /**
   * Classes the connection again from its nominated pair and the relay candidates known so far; when it turns out
   * relayed after its session started, the device's route is noted as `relay` then.
   */
  private reclassify(peer: Peer): void {
    if (peer.closed) return;
    const route = peer.relay.route(this.nominated(peer));
    if (route === peer.route) return;
    peer.route = route;
    if (peer.deviceId !== null) this.opts.auth.noteRoute(peer.deviceId, route);
  }

  /** Every `sampleMs`, and once as the peer goes: checks the route again and reports the relayed bytes since the last sample. */
  private sample(peer: Peer): void {
    this.reclassify(peer);
    const bytes = peer.relay.sample(this.nominated(peer));
    if (bytes > 0) this.opts.onRelayedBytes?.(bytes);
  }

  private drop(peer: Peer): void {
    if (peer.closed) return;
    if (peer.sampler !== undefined) this.sample(peer);
    peer.closed = true;
    clearTimeout(peer.timer);
    clearInterval(peer.sampler);
    if (this.peers.get(peer.sid) === peer) this.peers.delete(peer.sid);
    peer.served?.close();
    peer.pc.close().catch(() => {});
    peer.owner.close();
  }
}
