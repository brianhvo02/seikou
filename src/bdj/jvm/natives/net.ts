/*
 * Original code for bluray-web: java.net natives of the BD-J virtual machine. There is no network: every attempt fails
 * as it does in libbluray's harness, HotSpot on Linux with no network (docker --network none; the exception classes are
 * checked against it by tests/bdj/conformance/Net.java). A host name other than localhost is unknown, a connection to
 * an address finds no network, and localhost resolves to the loopback addresses, where nothing listens. No real network
 * access is ever made.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { Invoke } from '../interpreter';
import type { NativeResult } from '../interpreter';
import type { JArray, JObject, JValue } from '../values';
import type { NativeContext, NativeTable } from './index';
import { each, jsStr, method, none, virtual } from './util';

// HotSpot's messages on Linux with no network: glibc's gai_strerror(EAI_AGAIN) after the host name, and strerror with
// " (connect failed)" from PlainSocketImpl's connect
const UNREACHABLE = 'Network is unreachable';
const REFUSED = 'Connection refused (Connection refused)';

const isObject = (v: JValue): v is JObject => typeof v === 'object' && v !== null;
const isArray = (v: JValue): v is JArray => isObject(v) && 'data' in v;

/** getaddrinfo with no network: localhost is 127.0.0.1, then ::1 (/etc/hosts); any other name is unknown. */
function lookupAllHostAddr(ctx: NativeContext, _self: JValue, host: JValue): NativeResult {
  const jvm = ctx.jvm;
  const name = isObject(host) && !isArray(host) ? jsStr(jvm, host) : '';
  if (name.toLowerCase() !== 'localhost') return jvm.throwNew('java/net/UnknownHostException', `${name}: Temporary failure in name resolution`);
  const inetAddress = jvm.bootClass('java/net/InetAddress');
  const getByAddress = method(inetAddress, 'getByAddress(Ljava/lang/String;[B)Ljava/net/InetAddress;');
  const loopbacks = [[127, 0, 0, 1], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]];
  const result = jvm.heap.newArray(jvm.loader.arrayOf(inetAddress), loopbacks.length) as JArray;
  let i = 0;
  return each(
    loopbacks,
    (bytes) => {
      const arr = jvm.heap.newArray(jvm.loader.arrayOf(jvm.loader.primitive('B')), bytes.length) as JArray;
      (arr.data as Int8Array).set(bytes);
      return new Invoke(getByAddress, [jvm.heap.newString(name), arr], (a) => {
        (result.data as JValue[])[i++] = a ?? null;
        return undefined;
      });
    },
    () => result,
  );
}

/** Calls `k` with whether `addr` (an InetAddress) is a loopback address. */
function withLoopback(ctx: NativeContext, addr: JValue, k: (loopback: boolean) => NativeResult): NativeResult {
  if (!isObject(addr) || isArray(addr)) return k(false);
  return new Invoke(virtual(addr, ctx.jvm.bootClass('java/net/InetAddress'), 'isLoopbackAddress()Z'), [addr], (r) => k(r === 1));
}

/** 127.0.0.0/8 or ::1, from an address's bytes. */
function loopbackBytes(addr: JValue): boolean {
  if (!isArray(addr) || !(addr.data instanceof Int8Array)) return false;
  const b = addr.data;
  if (b.length === 4) return b[0] === 127;
  return b.length === 16 && b.every((x, i) => x === (i === 15 ? 1 : 0));
}

// Linux PlainSocketImpl: ECONNREFUSED is a ConnectException; ENETUNREACH is a SocketException from a blocking connect
// (no timeout) and a ConnectException from a timed one
const socketConnect = (ctx: NativeContext, _self: JValue, addr: JValue, _port: JValue, timeout: JValue): NativeResult =>
  withLoopback(ctx, addr, (loopback) =>
    loopback
      ? ctx.jvm.throwNew('java/net/ConnectException', REFUSED)
      : ctx.jvm.throwNew((timeout as number) > 0 ? 'java/net/ConnectException' : 'java/net/SocketException', `${UNREACHABLE} (connect failed)`));

// HotSpot as an ordinary user (no raw ICMP socket) pings with a TCP connect to the echo port: the loopback answers (a
// refused connection counts as reachable), any other address has no network and is not reachable. As root it would
// send ICMP and throw SocketException instead; libbluray's players do not run as root
const isReachable = (_ctx: NativeContext, _self: JValue, addr: JValue): NativeResult => (loopbackBytes(addr) ? 1 : 0);

export function registerNetNatives(natives: NativeTable): void {
  const impl = (cls: string): Record<string, (ctx: NativeContext, ...args: JValue[]) => NativeResult> => ({
    [`java/net/${cls}.getLocalHostName()Ljava/lang/String;`]: (ctx) => ctx.jvm.heap.newString('localhost'),
    [`java/net/${cls}.lookupAllHostAddr(Ljava/lang/String;)[Ljava/net/InetAddress;`]: lookupAllHostAddr,
    // no reverse lookup: InetAddress.getHostName falls back to the address's text, as on HotSpot
    [`java/net/${cls}.getHostByAddr([B)Ljava/lang/String;`]: (ctx) => ctx.jvm.throwNew('java/net/UnknownHostException'),
  });
  natives.register({
    'java/net/InetAddress.init()V': none,
    'java/net/Inet4Address.init()V': none,
    'java/net/Inet6Address.init()V': none,
    // rt-bdj.jar carries Inet6AddressImpl only, which InetAddressImplFactory picks when IPv6 is supported.
    'java/net/InetAddressImplFactory.isIPv6Supported()Z': () => 1,
    ...impl('Inet6AddressImpl'),
    ...impl('Inet4AddressImpl'),
    'java/net/Inet6AddressImpl.isReachable0([BII[BII)Z': isReachable,
    'java/net/Inet4AddressImpl.isReachable0([BI[BI)Z': isReachable,
    'java/net/PlainSocketImpl.initProto()V': none,
    'java/net/PlainSocketImpl.socketConnect(Ljava/net/InetAddress;II)V': socketConnect,
    // a socket can be made, configured and closed; it never connects, so it is never read or written
    'java/net/PlainSocketImpl.socketCreate(Z)V': none,
    'java/net/PlainSocketImpl.socketSetOption0(IZLjava/lang/Object;)V': none,
    'java/net/PlainSocketImpl.socketClose0(Z)V': none,
    'java/net/SocketInputStream.init()V': none,
    'java/net/SocketOutputStream.init()V': none,
    'java/net/SocketInputStream.socketRead0(Ljava/io/FileDescriptor;[BIII)I': (ctx) => ctx.jvm.throwNew('java/net/SocketException', 'Socket is not connected'),
    'java/net/SocketOutputStream.socketWrite0(Ljava/io/FileDescriptor;[BII)V': (ctx) => ctx.jvm.throwNew('java/net/SocketException', 'Socket is not connected'),
    'java/net/PlainDatagramSocketImpl.init()V': none,
    // the class library has no datagram sockets (no disc uses UDP); HotSpot's connect would succeed and a send fail
    'java/net/PlainDatagramSocketImpl.connect0(Ljava/net/InetAddress;I)V': (ctx) => ctx.jvm.throwNew('java/net/SocketException', UNREACHABLE),
  });
}
