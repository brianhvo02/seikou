import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createSocket } from 'node:dgram';
import type { RemoteInfo, Socket } from 'node:dgram';
import { StunProtocol, UdpTransport } from 'werift';

/**
 * Every peer connection's ICE on one UDP port. werift binds a socket per connection and refuses a port already
 * bound, so with ICE confined to one port (47998) only one connection could exist at a time. The mux owns the one
 * socket and hands each connection's ICE a virtual transport on it, routing datagrams as libdatachannel and pion do:
 * - a STUN request by its USERNAME (`<our ufrag>:<the device's ufrag>`, the form of an ICE connectivity check, RFC 8445
 *   §7.2.2), and only when its MESSAGE-INTEGRITY verifies with that connection's password; such a request is also what
 *   (re)assigns the sender's address, as a check from a new source address makes a peer-reflexive candidate (RFC 8445
 *   §7.3.1.3);
 * - a STUN response by the transaction id the request went out with;
 * - anything else (DTLS, SCTP) by the remote address assigned to a transport. A datagram from an address no live
 *   transport holds is dropped.
 *
 * werift creates its sockets through `UdpTransport.init`; `installMux` wraps it once, so a transport made while a
 * connection runs inside `MuxOwner.run` comes from that owner's mux. Anything else gets werift's own socket.
 * `UdpMux.open` checks at start that werift still goes through `UdpTransport.init`, and fails loudly if not.
 */

type Address = [string, number];

const STUN_MAGIC = 0x2112a442;
const STUN_USERNAME = 0x0006;
const STUN_MESSAGE_INTEGRITY = 0x0008;
/** A STUN transaction's route is forgotten after this (werift's checks give up well before). */
const TRANSACTION_MS = 60_000;

const owners = new AsyncLocalStorage<MuxOwner>();
let installed = false;

/** Wraps werift's `UdpTransport.init` once per process. */
function installMux(): void {
  if (installed) return;
  installed = true;
  const original = UdpTransport.init.bind(UdpTransport);
  UdpTransport.init = (async (type, options) => {
    const owner = owners.getStore();
    if (owner === undefined || type !== 'udp4') return original(type, options);
    return owner.transport() as unknown as UdpTransport;
  }) as typeof UdpTransport.init;
}

const key = (ip: string, port: number): string => `${ip}:${port}`;

/** Whether a datagram is a STUN message: the first two bits are zero and the magic cookie follows the type and length (RFC 8489 §5). */
function isStun(data: Buffer): boolean {
  return data.length >= 20 && (data[0]! & 0xc0) === 0 && data.readUInt32BE(4) === STUN_MAGIC;
}

/** A STUN message's class, from the two class bits interleaved in its type (RFC 8489 §5): 0 request, 1 indication, 2 success response, 3 error response. */
function stunClass(data: Buffer): number {
  const type = data.readUInt16BE(0);
  return ((type >> 7) & 0x2) | ((type >> 4) & 0x1);
}

/** The offset of the first attribute of `type` (RFC 8489 §14: a 4-byte type and length, the value padded to a multiple of 4), or -1 when there is none or the attributes overrun the message. */
function findAttribute(data: Buffer, type: number): number {
  const end = 20 + data.readUInt16BE(2);
  if (end > data.length) return -1;
  for (let at = 20; at + 4 <= end; ) {
    const length = data.readUInt16BE(at + 2);
    if (at + 4 + length > end) return -1;
    if (data.readUInt16BE(at) === type) return at;
    at += 4 + ((length + 3) & ~3);
  }
  return -1;
}

/** A STUN message's USERNAME attribute (RFC 8489 §14.3), or null. */
function stunUsername(data: Buffer): string | null {
  const at = findAttribute(data, STUN_USERNAME);
  return at < 0 ? null : data.toString('utf8', at + 4, at + 4 + data.readUInt16BE(at + 2));
}

/**
 * Whether the message's MESSAGE-INTEGRITY is the HMAC-SHA1 under `password` (ICE's short-term credential) of the
 * message up to that attribute, with the header's length counting through it (RFC 8489 §14.5; the short-term
 * credential's key is the password, §9.1.1).
 */
export function stunIntegrityVerifies(data: Buffer, password: string): boolean {
  const at = findAttribute(data, STUN_MESSAGE_INTEGRITY);
  if (at < 0 || data.readUInt16BE(at + 2) !== 20) return false;
  const signed = Buffer.from(data.subarray(0, at));
  signed.writeUInt16BE(at - 20 + 24, 2);
  const mac = createHmac('sha1', password).update(signed).digest();
  return timingSafeEqual(mac, data.subarray(at + 4, at + 24));
}

/** A werift transport whose datagrams go through the mux's socket. Mimics the parts of werift's `UdpTransport` that ICE uses. */
export class MuxTransport {
  readonly type = 'udp';
  closed = false;
  rinfo?: Partial<Pick<RemoteInfo, 'address' | 'port'>>;
  onData: (data: Buffer, addr: Address) => void = () => {};
  /** Remote addresses routed to this transport, forgotten when it closes. */
  readonly remotes = new Set<string>();

  constructor(
    private readonly mux: UdpMux,
    readonly owner: MuxOwner,
  ) {}

  send = async (data: Buffer, addr?: Address): Promise<void> => {
    if (this.closed || addr === undefined) return;
    await this.mux.send(this, data, addr);
  };

  /** The socket's address, as werift reads it from a transport: any IPv4 address and the mux's port. */
  get address(): { address: string; family: string; port: number } {
    return { address: '0.0.0.0', family: 'IPv4', port: this.mux.port };
  }

  get addressFamily(): 4 {
    return 4;
  }

  get host(): string {
    return '0.0.0.0';
  }

  get port(): number {
    return this.mux.port;
  }

  close = async (): Promise<void> => {
    if (this.closed) return;
    this.closed = true;
    this.mux.forget(this);
    this.owner.transports.delete(this);
  };
}

/** A claim on a USERNAME another live connection holds. */
export class MuxConflict extends Error {
  constructor() {
    super('another connection holds this ICE username');
    this.name = 'MuxConflict';
  }
}

/** One peer connection's share of the mux: the transports werift made for it, and its ICE credentials. */
export class MuxOwner {
  readonly transports = new Set<MuxTransport>();
  private claimed: string | null = null;
  /** Our ICE password (`a=ice-pwd` of our description), which the device's checks are signed with. */
  password: string | null = null;
  closed = false;

  constructor(private readonly mux: UdpMux) {}

  /** Runs `fn` so that the transports werift makes inside it belong to this owner. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return owners.run(this, fn);
  }

  /**
   * Claims the USERNAME the device's checks carry: our ufrag and password (our description's `a=ice-ufrag` and
   * `a=ice-pwd`) and the device's ufrag (its offer's). Throws `MuxConflict` when a live connection holds it.
   */
  claim(localUfrag: string, remoteUfrag: string, password: string): void {
    const username = `${localUfrag}:${remoteUfrag}`;
    this.mux.claim(this, username);
    this.claimed = username;
    this.password = password;
  }

  /** A transport for werift; a closed one once this owner is closed. */
  transport(): MuxTransport {
    const transport = new MuxTransport(this.mux, this);
    if (this.closed) transport.closed = true;
    else this.transports.add(transport);
    return transport;
  }

  /** Forgets every route to this owner's transports; werift closes them itself, this covers a missed close. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of [...this.transports]) void t.close();
    if (this.claimed !== null) this.mux.release(this, this.claimed);
  }
}

/**
 * The one UDP socket and its routing tables: owners by ICE USERNAME, transports by remote address, and outgoing STUN
 * requests by transaction id. `UdpMux.open` binds it; `owner()` makes one peer connection's share.
 */
export class UdpMux {
  private readonly byUsername = new Map<string, MuxOwner>();
  private readonly byRemote = new Map<string, MuxTransport>();
  private readonly byTransaction = new Map<string, { transport: MuxTransport; at: number }>();

  private constructor(
    private readonly socket: Socket,
    readonly port: number,
  ) {
    socket.on('message', (data, rinfo) => this.receive(data, rinfo));
    socket.on('error', (err) => console.error('rtc udp socket', err));
  }

  /**
   * Binds `port` on every IPv4 interface (0: one the system picks; `port` then reports it), after checking that
   * werift's sockets can be muxed at all.
   */
  static async open(port: number): Promise<UdpMux> {
    installMux();
    const socket = createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind({ port, exclusive: true }, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    const mux = new UdpMux(socket, socket.address().port);
    try {
      await mux.selfCheck();
    } catch (err) {
      await mux.close();
      throw err;
    }
    return mux;
  }

  /** A new owner for one peer connection. */
  owner(): MuxOwner {
    return new MuxOwner(this);
  }

  /** Closes the socket; resolves even when it is already closed. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      try {
        this.socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  /** werift's STUN protocol, made inside an owner, must get a mux transport; otherwise ICE would bind its own ports. */
  private async selfCheck(): Promise<void> {
    const probe = this.owner();
    const protocol = new StunProtocol();
    try {
      await probe.run(() => protocol.connectionMade(true));
      if (!(protocol.transport instanceof MuxTransport)) {
        await protocol.transport?.close();
        throw new Error('werift no longer creates its UDP sockets through UdpTransport.init, so WebRTC cannot share one UDP port');
      }
    } finally {
      probe.close();
    }
  }

  /** @internal */
  claim(owner: MuxOwner, username: string): void {
    const holder = this.byUsername.get(username);
    if (holder !== undefined && holder !== owner && !holder.closed) throw new MuxConflict();
    this.byUsername.set(username, owner);
  }

  /** @internal */
  release(owner: MuxOwner, username: string): void {
    if (this.byUsername.get(username) === owner) this.byUsername.delete(username);
  }

  /** @internal */
  forget(transport: MuxTransport): void {
    for (const remote of transport.remotes) if (this.byRemote.get(remote) === transport) this.byRemote.delete(remote);
    transport.remotes.clear();
    for (const [id, route] of this.byTransaction) if (route.transport === transport) this.byTransaction.delete(id);
  }

  /** @internal */
  send(transport: MuxTransport, data: Buffer, [host, port]: Address): Promise<void> {
    if (isStun(data) && stunClass(data) === 0) {
      this.pruneTransactions();
      const id = data.toString('hex', 8, 20);
      this.byTransaction.delete(id); // a resend moves to the end, keeping the map in time order
      this.byTransaction.set(id, { transport, at: Date.now() });
    }
    // Sending never takes an address from another live connection: only a verified check moves one.
    const remote = key(host, port);
    const holder = this.byRemote.get(remote);
    if (holder === undefined || holder.closed || holder.owner === transport.owner) this.assign(remote, transport);
    return new Promise((resolve, reject) => {
      this.socket.send(data, port, host, (err) => (err ? reject(err) : resolve()));
    });
  }

  private assign(remote: string, transport: MuxTransport): void {
    const holder = this.byRemote.get(remote);
    if (holder === transport) return;
    holder?.remotes.delete(remote);
    this.byRemote.set(remote, transport);
    transport.remotes.add(remote);
  }

  private receive(data: Buffer, rinfo: RemoteInfo): void {
    const remote = key(rinfo.address, rinfo.port);
    let transport: MuxTransport | undefined;
    if (isStun(data) && stunClass(data) === 0) {
      const username = stunUsername(data);
      const owner = username === null ? undefined : this.byUsername.get(username);
      if (owner === undefined || owner.closed || owner.password === null || !stunIntegrityVerifies(data, owner.password)) return;
      transport = [...owner.transports].find((t) => !t.closed);
      if (transport !== undefined) this.assign(remote, transport);
    } else if (isStun(data) && stunClass(data) >= 2) {
      transport = this.byTransaction.get(data.toString('hex', 8, 20))?.transport;
    } else {
      transport = this.byRemote.get(remote);
    }
    if (transport === undefined || transport.closed) return;
    transport.rinfo = { address: rinfo.address, port: rinfo.port };
    try {
      transport.onData(data, [rinfo.address, rinfo.port]);
    } catch (err) {
      console.error('rtc datagram', err);
    }
  }

  private pruneTransactions(): void {
    const stale = Date.now() - TRANSACTION_MS;
    for (const [id, route] of this.byTransaction) {
      if (route.at >= stale) break; // inserted in time order
      this.byTransaction.delete(id);
    }
  }
}
