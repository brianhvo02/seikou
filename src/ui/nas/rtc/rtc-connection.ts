import { relayLimitMessage } from '../relay-model';
import { NAS_LOST_MESSAGE } from '@seikou/engine/disc/http-transport';
import { WireClient } from '@seikou/nas/rtc-wire';
import type { WireChannel } from '@seikou/nas/rtc-wire';
import { iceServersOf } from '../../../../rendezvous/src/protocol';
import type { TurnRefusal } from '../../../../rendezvous/src/protocol';
import { SignallingClient } from './signalling-client';

/** Cloudflare's public STUN server: the only ICE server of the direct attempt. */
export const STUN_URL = 'stun:stun.cloudflare.com:3478';
/** How long the direct attempt may take, from the offer to the channel opening. */
export const DIRECT_TIMEOUT_MS = 8_000;
/** How long the relayed attempt may take: TURN allocation adds round trips. */
const RELAY_TIMEOUT_MS = 15_000;
/** How long the NAS may take to answer an offer or a TURN request. */
const REPLY_TIMEOUT_MS = 10_000;

/** What the person is told when neither the direct nor the relayed WebRTC attempt connects. */
export const RTC_UNREACHABLE = "Can't connect to the NAS from this network. Try another Wi-Fi or mobile data.";

export { relayLimitMessage };

/** The API base of a NAS reached over WebRTC; `NasClient` sends URLs under it through the connection. */
export const RTC_BASE = (nasId: string): string => `rtc://${nasId}/api/`;

/** The device's signalling socket on the rendezvous service at `service` (http(s) or ws(s)). */
export function signallingUrlOf(service: string, nasId: string): string {
  return `${service.trim().replace(/\/+$/, '').replace(/^http/i, 'ws')}/signal/device?nasId=${encodeURIComponent(nasId)}`;
}

/** What requests in flight (and response bodies being read) fail with when the connection closes: a fetch-like TypeError. */
export function nasLostError(): TypeError & { readonly reason: 'nas-lost' } {
  return Object.assign(new TypeError(NAS_LOST_MESSAGE), { reason: 'nas-lost' as const });
}

/** No connection to the NAS could be made. The message is the copy to show. */
export class RtcUnreachable extends Error {
  constructor(
    /** Why the relay wasn't offered, when it was asked for. */
    readonly reason?: TurnRefusal,
    /** With `limit`: the UTC date (`YYYY-MM-DD`) the allowance resets. */
    readonly resetsOn?: string,
  ) {
    super(reason === 'limit' && resetsOn ? relayLimitMessage(resetsOn) : RTC_UNREACHABLE);
  }
}

/** A paired device's proof for `turn-request`: its signature over `turnProofMessage({ sid, ts })`. */
export interface DeviceProof {
  readonly deviceId: string;
  readonly ts: number;
  readonly signature: string;
}

/** What `RtcConnection.open` needs: the NAS's id, the rendezvous service, how this device proves itself (a paired device signs, an invite holder sends its code's hash) and, for tests, replacements for the peer and the socket. */
export interface RtcOpenOptions {
  readonly nasId: string;
  /** The rendezvous service. */
  readonly signallingUrl: string;
  /** A paired device signs its TURN request on the signalling socket `sid`. */
  readonly deviceProof?: (sid: string) => Promise<DeviceProof>;
  /** An unpaired device redeeming an invite sends the code's hash instead (`codeHashOf`). */
  readonly inviteHash?: string;
  readonly createPeer?: (config: RTCConfiguration) => RTCPeerConnection;
  readonly openSocket?: (url: string) => WebSocket;
  /** The direct attempt's time limit; 8 s by default. */
  readonly timeoutMs?: number;
}

/** What `NasClient` uses of a connection; `RtcConnection` is one. */
export interface RtcLink {
  readonly fetch: typeof fetch;
  /** The selected candidate pair goes through the relay. */
  readonly relayed: boolean;
  readonly closed: boolean;
  /** Called once when the connection closes (at once if it has). */
  onClose(cb: () => void): void;
  close(): void;
}

/** The browser's data channel as the wire wants it; `onClosed` hears the channel close. */
function wireChannelOf(dc: RTCDataChannel, onClosed: () => void): WireChannel {
  dc.binaryType = 'arraybuffer';
  const channel: WireChannel = {
    send: (data) => (typeof data === 'string' ? dc.send(data) : dc.send(data as Uint8Array<ArrayBuffer>)),
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
    get bufferedAmountLowThreshold() {
      return dc.bufferedAmountLowThreshold;
    },
    set bufferedAmountLowThreshold(value: number) {
      dc.bufferedAmountLowThreshold = value;
    },
    onbufferedamountlow: null,
    onmessage: null,
    onclose: null,
    close: () => dc.close(),
  };
  dc.onmessage = (ev: MessageEvent) => {
    const { data } = ev as { data: unknown };
    if (typeof data === 'string') channel.onmessage?.(data);
    else if (data instanceof ArrayBuffer) channel.onmessage?.(new Uint8Array(data));
  };
  dc.onbufferedamountlow = () => channel.onbufferedamountlow?.();
  dc.onclose = () => {
    onClosed(); // first, so requests in flight fail as nas-lost rather than with the wire's own error
    channel.onclose?.();
  };
  return channel;
}

/** Whether the selected candidate pair's local candidate is a relay one. */
async function isRelayed(pc: RTCPeerConnection): Promise<boolean> {
  try {
    const stats = await pc.getStats();
    const all: Array<Record<string, unknown>> = [];
    stats.forEach((s: Record<string, unknown>) => all.push(s));
    const selectedId = all.find((s) => s.type === 'transport' && typeof s.selectedCandidatePairId === 'string')?.selectedCandidatePairId;
    const pair =
      all.find((s) => s.type === 'candidate-pair' && s.id === selectedId) ??
      all.find((s) => s.type === 'candidate-pair' && (s.selected === true || (s.nominated === true && s.state === 'succeeded')));
    if (!pair) return false;
    return all.some((s) => s.id === pair.localCandidateId && s.candidateType === 'relay');
  } catch {
    return false;
  }
}

/**
 * ?rtcrelayed=1 is test-only (E2E): the connection counts as relayed, so the badge can be seen without a relay. Read once
 * at load, from the address the app opened with: the NAS screens' paths leave the query behind.
 */
const COUNT_AS_RELAYED = new URLSearchParams(globalThis.location?.search ?? '').get('rtcrelayed') === '1';

/** A WebRTC connection to the NAS: requests over its `api` data channel, as `fetch`. */
export class RtcConnection implements RtcLink {
  readonly fetch: typeof fetch;
  private readonly wire: WireClient;
  private readonly listeners: Array<() => void> = [];
  private shutDown = false;
  private isRelayed = false;

  private constructor(
    private readonly pc: RTCPeerConnection,
    channel: RTCDataChannel,
  ) {
    this.wire = new WireClient(wireChannelOf(channel, () => this.shut()));
    this.fetch = this.wire.fetch;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.shut();
    };
    // It may have gone between the attempt seeing it open and these handlers.
    if (channel.readyState !== 'open' || pc.connectionState === 'failed' || pc.connectionState === 'closed') this.shut();
  }

  get relayed(): boolean {
    return this.isRelayed || COUNT_AS_RELAYED;
  }

  /**
   * Connects to the NAS `nasId`: directly first (STUN only) for up to 8 s, then, when that fails, through the relay
   * if the NAS hands out TURN servers. Rejects with RtcUnreachable.
   */
  static async open(opts: RtcOpenOptions): Promise<RtcConnection> {
    const setup = new Setup(opts);
    try {
      const { pc, channel } = await setup.run();
      const connection = new RtcConnection(pc, channel);
      connection.isRelayed = await isRelayed(pc);
      return connection;
    } catch (err) {
      throw err instanceof RtcUnreachable ? err : new RtcUnreachable();
    } finally {
      setup.dispose();
    }
  }

  get closed(): boolean {
    return this.shutDown;
  }

  onClose(cb: () => void): void {
    if (this.shutDown) queueMicrotask(cb);
    else this.listeners.push(cb);
  }

  close(): void {
    this.shut();
  }

  private shut(): void {
    if (this.shutDown) return;
    this.shutDown = true;
    this.wire.close(nasLostError());
    try {
      this.pc.close();
    } catch {
      // already closed
    }
    for (const cb of this.listeners.splice(0)) cb();
  }
}

interface Connected {
  readonly pc: RTCPeerConnection;
  readonly channel: RTCDataChannel;
}

/** One `open`: the signalling socket (reopened if it expires) and the attempts. */
class Setup {
  private signalling: SignallingClient | null = null;
  private readonly url: string;
  private readonly createPeer: (config: RTCConfiguration) => RTCPeerConnection;
  private readonly openSocket: (url: string) => WebSocket;

  constructor(private readonly opts: RtcOpenOptions) {
    this.url = signallingUrlOf(opts.signallingUrl, opts.nasId);
    this.createPeer = opts.createPeer ?? ((config) => new RTCPeerConnection(config));
    this.openSocket = opts.openSocket ?? ((url) => new WebSocket(url));
  }

  async run(): Promise<Connected> {
    const stun: RTCIceServer = { urls: STUN_URL };
    const direct = await this.attempt({ iceServers: [stun] }, this.opts.timeoutMs ?? DIRECT_TIMEOUT_MS);
    if (direct) return direct;
    const servers = await this.turnServers();
    const relayed = await this.attempt({ iceServers: [stun, ...servers], iceTransportPolicy: 'all' }, RELAY_TIMEOUT_MS);
    if (relayed) return relayed;
    throw new RtcUnreachable();
  }

  dispose(): void {
    this.signalling?.close();
    this.signalling = null;
  }

  /** The open signalling socket, or a new one when there is none or the last has closed (it lasts 60 s). */
  private async socket(): Promise<SignallingClient> {
    if (this.signalling && !this.signalling.isClosed) return this.signalling;
    this.signalling = await SignallingClient.connect(this.url, this.openSocket);
    return this.signalling;
  }

  /** One peer with `config`: offer, answer, and the channel open within `timeoutMs`; null when it doesn't connect. */
  private async attempt(config: RTCConfiguration, timeoutMs: number): Promise<Connected | null> {
    const sig = await this.socket();
    const pc = this.createPeer(config);
    const channel = pc.createDataChannel('api', { ordered: true });
    channel.binaryType = 'arraybuffer';
    // Every candidate goes to the NAS (its relay accounting needs the relay ones), once it has the offer's peer.
    const early: RTCIceCandidateInit[] = [];
    let answered = false;
    pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (!ev.candidate) return;
      const candidate = ev.candidate.toJSON();
      if (answered) sig.send({ t: 'candidate', candidate });
      else early.push(candidate);
    };
    const opened = new Promise<boolean>((resolve) => {
      channel.onopen = () => resolve(true);
      channel.onclose = () => resolve(false);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') resolve(false);
      };
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
    const givenUp = new AbortController();
    let offered = false;
    let answerSeen = false;
    const connect = async (): Promise<boolean> => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (givenUp.signal.aborted || !sig.send({ t: 'offer', sdp: offer.sdp })) return false;
      offered = true;
      let answer;
      try {
        answer = await sig.next('answer', timeoutMs, givenUp.signal);
      } catch {
        return false;
      }
      answerSeen = true;
      if (typeof answer.error === 'string') throw new RtcUnreachable(); // busy, too many offers, or the NAS failed
      if (typeof answer.sdp !== 'string') return false;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      answered = true;
      for (const candidate of early.splice(0)) sig.send({ t: 'candidate', candidate });
      return opened;
    };
    const connecting = connect();
    connecting.catch(() => {}); // after a timeout it may still fail on the closed peer; nobody waits for it then
    let ok = false;
    try {
      ok = await Promise.race([connecting, timedOut]);
    } finally {
      clearTimeout(timer);
      if (!ok) {
        // A late answer to this offer must not be taken as the answer to the next one.
        givenUp.abort();
        if (offered && !answerSeen) sig.skipNext('answer');
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        channel.onopen = channel.onclose = null;
        try {
          pc.close();
        } catch {
          // already closed
        }
      }
    }
    if (!ok) return null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    channel.onopen = channel.onclose = null;
    return { pc, channel };
  }

  /** Asks the NAS for TURN servers; rejects with RtcUnreachable (with the refusal's reason) when there are none. */
  private async turnServers(): Promise<RTCIceServer[]> {
    const { deviceProof, inviteHash } = this.opts;
    if (!deviceProof && inviteHash === undefined) throw new RtcUnreachable();
    const sig = await this.socket();
    const proof = deviceProof ? await deviceProof(sig.sid) : { inviteHash };
    if (!sig.send({ t: 'turn-request', ...proof })) throw new RtcUnreachable();
    const reply = await sig.next('turn-response', REPLY_TIMEOUT_MS);
    const servers = iceServersOf(reply.iceServers);
    if (servers && servers.length > 0) {
      return servers.map(({ urls, username, credential }) => ({
        urls: [urls].flat(),
        ...(username === undefined ? {} : { username }),
        ...(credential === undefined ? {} : { credential }),
      }));
    }
    const reason = reply.reason;
    throw new RtcUnreachable(
      reason === 'off' || reason === 'limit' || reason === 'unauthorized' || reason === 'unavailable' ? reason : undefined,
      typeof reply.resetsOn === 'string' ? reply.resetsOn : undefined,
    );
  }
}
