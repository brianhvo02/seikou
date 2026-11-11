import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';

const MAGIC = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const MAPPED_ADDRESS = 0x0001;
const XOR_MAPPED_ADDRESS = 0x0020;
/** Resends of the Binding request while waiting, in ms after the first (RFC 5389's doubling, cut short). */
const RESENDS_MS = [500, 1500, 3500];
const HOUR = 60 * 60_000;
/** While no public address is known, STUN is tried this often. */
const RETRY_MS = 60_000;

const octets = (ip: string): number[] => ip.split('.').map(Number);
const isDocker = ([a, b]: number[]): boolean => a === 172 && b! >= 16 && b! <= 31;
const isTailscale = ([a, b]: number[]): boolean => a === 100 && b! >= 64 && b! <= 127;

/**
 * The one rule every advertised candidate keeps: an IPv4 address outside Docker's 172.16.0.0/12 and Tailscale's
 * 100.64.0.0/10. It is all `RTC_ADVERTISE` (tests, loopback included) must pass.
 */
export function neverDockerOrTailscale(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const o = octets(ip);
  return !isDocker(o) && !isTailscale(o);
}

/**
 * Whether a STUN result or `RTC_LAN_ADDRESS` may be advertised: a public IPv4 address, or a private one in
 * 10.0.0.0/8 or 192.168.0.0/16. Never Docker's 172.16.0.0/12 or Tailscale's 100.64.0.0/10, and never loopback,
 * link-local, `0.0.0.0/8`, multicast or reserved.
 */
export function advertisable(ip: string): boolean {
  if (!neverDockerOrTailscale(ip)) return false;
  const [a, b] = octets(ip) as [number, number];
  if (a === 0 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

/** `stun:host:port` as [host, port], or null. */
function parseStunUrl(url: string): [string, number] | null {
  const m = /^stun:([^:]+):(\d{1,5})$/.exec(url);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port <= 65535 ? [m[1]!, port] : null;
}

/**
 * The IPv4 address of a Binding success response to `txid`, or null: the XOR-MAPPED-ADDRESS (RFC 8489 §14.2, the address
 * XORed with the magic cookie), else the plain MAPPED-ADDRESS (§14.1).
 */
function mappedAddress(msg: Buffer, txid: Buffer): string | null {
  if (msg.length < 20 || msg.readUInt16BE(0) !== BINDING_SUCCESS || msg.readUInt32BE(4) !== MAGIC || !msg.subarray(8, 20).equals(txid)) return null;
  const end = Math.min(msg.length, 20 + msg.readUInt16BE(2));
  let plain: string | null = null;
  for (let at = 20; at + 4 <= end; ) {
    const type = msg.readUInt16BE(at);
    const length = msg.readUInt16BE(at + 2);
    const value = at + 4;
    if (value + length > end) break;
    if ((type === XOR_MAPPED_ADDRESS || type === MAPPED_ADDRESS) && length >= 8 && msg.readUInt8(value + 1) === 0x01) {
      let raw = msg.readUInt32BE(value + 4);
      if (type === XOR_MAPPED_ADDRESS) raw = (raw ^ MAGIC) >>> 0;
      const ip = [raw >>> 24, (raw >>> 16) & 0xff, (raw >>> 8) & 0xff, raw & 0xff].join('.');
      if (type === XOR_MAPPED_ADDRESS) return ip;
      plain = ip;
    }
    at = value + ((length + 3) & ~3);
  }
  return plain;
}

/**
 * This host's public IPv4 address as the STUN server `stun` (`stun:host:port`) sees it, or null when the server
 * doesn't answer within `timeoutMs` or the URL is not a STUN URL. Sends a Binding request (RFC 8489 §6.1 and §2) over a
 * fresh UDP socket, resending on a schedule; this is the server-reflexive address of RFC 8445 §5.1.1.2.
 */
export function discoverPublicIpv4(stun: string, timeoutMs: number): Promise<string | null> {
  const server = parseStunUrl(stun);
  if (server === null) return Promise.resolve(null);
  const [host, port] = server;
  const txid = randomBytes(12);
  const request = Buffer.alloc(20);
  request.writeUInt16BE(BINDING_REQUEST, 0);
  request.writeUInt16BE(0, 2);
  request.writeUInt32BE(MAGIC, 4);
  txid.copy(request, 8);

  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const timers: NodeJS.Timeout[] = [];
    let done = false;
    const finish = (ip: string | null): void => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(ip);
    };
    const send = (): void => {
      if (!done) socket.send(request, port, host, (err) => err && finish(null));
    };
    socket.on('error', () => finish(null));
    socket.on('message', (msg) => {
      const ip = mappedAddress(msg, txid);
      if (ip !== null) finish(ip);
    });
    socket.bind(0, () => {
      send();
      for (const at of RESENDS_MS) if (at < timeoutMs) timers.push(setTimeout(send, at));
    });
    timers.push(setTimeout(() => finish(null), timeoutMs));
  });
}

/** What `AddressAdvertiser` needs: the STUN server to ask and the addresses to add or use instead. */
export interface AdvertiserOptions {
  /** `stun:host:port`. */
  stun: string;
  /** `RTC_LAN_ADDRESS`, advertised after the public address. */
  lan?: string;
  /** `RTC_ADVERTISE`: advertised as is, and nothing is discovered. */
  fixed?: readonly string[];
  /** How long one STUN lookup waits for an answer, in milliseconds; 5000 by default. */
  timeoutMs?: number;
  /** Between refreshes; an hour by default. */
  intervalMs?: number;
  /** Between tries while no public address is known; a minute by default. */
  retryMs?: number;
  /** Called when a refresh finds a public address other than the last one known. */
  onChange?: () => void;
  /** Where a refresh that got no answer, or a changed address, is reported; `console.warn` by default. */
  log?: (message: string) => void;
}

/**
 * The addresses the NAS advertises as its ICE candidates: its public IPv4 (found by STUN at start and then hourly,
 * so a changed address is picked up without a restart; every minute while none is known) and its LAN address. A
 * refresh that gets no answer keeps the last public address. Docker and Tailscale addresses are never advertised.
 */
export class AddressAdvertiser {
  private publicIp: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly opts: AdvertiserOptions) {}

  private log(message: string): void {
    (this.opts.log ?? console.warn)(message);
  }

  /** The addresses to advertise now: the fixed list, or the public address then the LAN one, each only if `advertisable`. */
  advertise(): string[] {
    if (this.opts.fixed) return this.opts.fixed.filter(neverDockerOrTailscale);
    const list = [this.publicIp, this.opts.lan].filter((ip): ip is string => ip != null && advertisable(ip));
    return [...new Set(list)];
  }

  /** Asks the STUN server for the public address once; a missing or unusable answer keeps the last one. */
  async refresh(): Promise<void> {
    if (this.opts.fixed) return;
    const ip = await discoverPublicIpv4(this.opts.stun, this.opts.timeoutMs ?? 5000);
    if (ip === null || !advertisable(ip)) {
      this.log(`STUN ${this.opts.stun} gave no usable address; keeping ${this.publicIp === null ? 'no public address' : 'the last public address'}`);
      return;
    }
    const changed = this.publicIp !== null && ip !== this.publicIp;
    this.publicIp = ip;
    if (changed) {
      this.log('the public IPv4 address changed; advertising the new one');
      this.opts.onChange?.();
    }
  }

  /** Refreshes now, then every interval (every minute while no public address is known) until `stop`. */
  async start(): Promise<void> {
    if (this.opts.fixed || this.running) return;
    this.running = true;
    await this.refresh();
    this.schedule();
  }

  /** Stops refreshing. */
  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (!this.running) return;
    const delay = this.publicIp === null ? (this.opts.retryMs ?? RETRY_MS) : (this.opts.intervalMs ?? HOUR);
    this.timer = setTimeout(() => void this.refresh().finally(() => this.schedule()), delay);
    this.timer.unref();
  }
}
