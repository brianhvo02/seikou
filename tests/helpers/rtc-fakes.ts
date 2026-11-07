/**
 * In-memory stand-ins for the browser's RTCPeerConnection, RTCDataChannel and the signalling WebSocket, with a fake
 * NAS behind them: the socket answers offers and TURN requests the way the rendezvous Worker and the NAS do, and a
 * peer that connects opens its `api` channel onto a WireServer.
 */
import { WireServer } from '@seikou/nas/rtc-wire';
import type { WireChannel, WireRequest, WireResponse } from '@seikou/nas/rtc-wire';

/** The NAS's end of a data channel. */
class NasEnd implements WireChannel {
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onbufferedamountlow: (() => void) | null = null;
  onmessage: ((data: string | Uint8Array) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(private readonly device: FakeDataChannel) {}

  send(data: string | Uint8Array): void {
    if (this.device.readyState !== 'open') throw new Error('InvalidStateError: closed');
    const copy = typeof data === 'string' ? data : data.slice();
    queueMicrotask(() => {
      if (this.device.readyState !== 'open') return;
      this.device.onmessage?.({ data: typeof copy === 'string' ? copy : copy.buffer } as MessageEvent);
    });
  }

  close(): void {
    this.device.drop();
  }
}

/** The browser's end, shaped like RTCDataChannel. */
export class FakeDataChannel {
  binaryType = 'blob';
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  nas: NasEnd | null = null;

  constructor(
    readonly label: string,
    readonly init: RTCDataChannelInit | undefined,
  ) {}

  send(data: string | ArrayBufferView): void {
    if (this.readyState !== 'open' || !this.nas) throw new Error('InvalidStateError: not open');
    const copy = typeof data === 'string' ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    const nas = this.nas;
    queueMicrotask(() => {
      if (this.readyState === 'open') nas.onmessage?.(copy);
    });
  }

  close(): void {
    this.drop();
  }

  /** Opens, handing the NAS's end to `serve`. */
  connect(serve: (channel: WireChannel) => void): void {
    this.nas = new NasEnd(this);
    serve(this.nas);
    this.readyState = 'open';
    this.onopen?.();
  }

  /** Both ends close (the NAS went away, or either side closed). */
  drop(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    const nas = this.nas;
    queueMicrotask(() => {
      nas?.onclose?.();
      this.onclose?.();
    });
  }
}

export interface FakeRtcOptions {
  /** Whether a peer with no TURN servers connects. */
  direct: boolean;
  /** Whether a peer with TURN servers connects (through the relay). */
  relay?: boolean;
  /** What a `turn-request` is answered with; by default no servers, reason `off`. */
  turn?: (request: Record<string, unknown>) => Record<string, unknown>;
  /** An offer is answered with this error instead of an answer. */
  answerError?: 'busy' | 'too-many-offers' | 'failed';
  /** A socket opened while this is set is closed with it before `hello`. */
  refuseSocket?: number;
  /** A peer that can't connect hangs instead of failing. */
  hang?: boolean;
  /** Per offer (in order), how long its answer takes; answers still go out in order, as the NAS sends them. */
  answerDelaysMs?: number[];
  /** Answers the channel's requests with a WireServer… */
  handle?: (req: WireRequest) => Promise<WireResponse>;
  /** …or takes the NAS's end of the channel itself (the server's `serveChannel`). */
  serve?: (channel: WireChannel) => void;
}

/** A NAS and rendezvous Worker in memory: hands out sockets and peers, and logs what devices send. */
export class FakeRtcWorld {
  readonly sockets: FakeSocket[] = [];
  readonly peers: FakePeer[] = [];
  /** Every message devices sent on signalling, parsed, with its socket's sid. */
  readonly sent: Array<Record<string, unknown> & { sid: string }> = [];
  private sids = 0;

  constructor(readonly opts: FakeRtcOptions) {}

  readonly openSocket = (url: string): WebSocket => {
    const socket = new FakeSocket(this, url, `sid${++this.sids}`);
    this.sockets.push(socket);
    return socket as unknown as WebSocket;
  };

  readonly createPeer = (config: RTCConfiguration): RTCPeerConnection => {
    const peer = new FakePeer(this, config);
    this.peers.push(peer);
    return peer as unknown as RTCPeerConnection;
  };
}

export class FakeSocket {
  readyState: number = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closedWith: number | null = null;
  private offers = 0;
  private answers: Promise<void> = Promise.resolve();

  constructor(
    private readonly world: FakeRtcWorld,
    readonly url: string,
    readonly sid: string,
  ) {
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
      if (world.opts.refuseSocket !== undefined) this.close(world.opts.refuseSocket);
      else this.deliver({ t: 'hello', sid });
    });
  }

  send(text: string): void {
    if (this.readyState !== 1) throw new Error('InvalidStateError: socket not open');
    const m = JSON.parse(text) as Record<string, unknown>;
    this.world.sent.push({ ...m, sid: this.sid });
    const { opts } = this.world;
    if (m.t === 'offer') {
      const answer = opts.answerError ? { t: 'answer', error: opts.answerError } : { t: 'answer', sdp: `answer-to:${String(m.sdp)}` };
      const delay = opts.answerDelaysMs?.[this.offers++] ?? 0;
      this.answers = this.answers.then(() => (delay > 0 ? new Promise((r) => setTimeout(r, delay)) : undefined)).then(() => this.deliver(answer));
    } else if (m.t === 'turn-request') {
      this.deliver({ ...(opts.turn ? opts.turn(m) : { iceServers: [], reason: 'off' }), t: 'turn-response' });
    }
  }

  /** The Worker closes the socket with `code` (4408 when it expires). */
  close(code = 1000): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.closedWith = code;
    queueMicrotask(() => this.onclose?.({ code, reason: '' } as CloseEvent));
  }

  private deliver(m: Record<string, unknown>): void {
    queueMicrotask(() => {
      if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(m) } as MessageEvent);
    });
  }
}

export class FakePeer {
  connectionState: RTCPeerConnectionState = 'new';
  onicecandidate: ((ev: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly channels: FakeDataChannel[] = [];
  closed = false;
  relayed = false;
  remoteSdp: string | undefined;

  constructor(
    private readonly world: FakeRtcWorld,
    readonly config: RTCConfiguration,
  ) {}

  get hasTurn(): boolean {
    return (this.config.iceServers ?? []).some((s) => [s.urls].flat().some((u) => /^turns?:/.test(u)));
  }

  createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
    const channel = new FakeDataChannel(label, init);
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: `offer${this.world.peers.indexOf(this) + 1}` };
  }

  async setLocalDescription(): Promise<void> {
    const candidates = ['candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host'];
    if (this.hasTurn) candidates.push('candidate:2 1 udp 41885439 198.51.100.7 60000 typ relay raddr 0.0.0.0 rport 0');
    queueMicrotask(() => {
      for (const candidate of candidates) this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate, sdpMid: '0', sdpMLineIndex: 0 }) } });
      this.onicecandidate?.({ candidate: null });
    });
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteSdp = desc.sdp;
    const { opts } = this.world;
    const connects = this.hasTurn ? (opts.relay ?? false) : opts.direct;
    queueMicrotask(() => {
      if (this.closed) return;
      if (connects) {
        this.relayed = this.hasTurn && !opts.direct;
        this.setState('connected');
        const serve = opts.serve ?? ((channel: WireChannel) => new WireServer(channel, opts.handle!));
        for (const channel of this.channels) channel.connect(serve);
      } else if (!opts.hang) {
        this.setState('failed');
      }
    });
  }

  async getStats(): Promise<RTCStatsReport> {
    const stats = new Map<string, Record<string, unknown>>([
      ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
      ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', nominated: true, state: 'succeeded' }],
      ['L', { id: 'L', type: 'local-candidate', candidateType: this.relayed ? 'relay' : 'host' }],
      ['R', { id: 'R', type: 'remote-candidate', candidateType: 'host' }],
    ]);
    return stats as unknown as RTCStatsReport;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = 'closed';
    for (const channel of this.channels) channel.drop();
  }

  /** The path is lost (Wi-Fi to cellular): ICE fails and the channel closes. */
  fail(): void {
    this.setState('failed');
    for (const channel of this.channels) channel.drop();
  }

  private setState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

/** A WireRequest's body as text. */
export async function bodyText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const part of body) text += decoder.decode(part, { stream: true });
  return text + decoder.decode();
}
