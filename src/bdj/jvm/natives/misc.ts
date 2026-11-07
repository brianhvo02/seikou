/*
 * Original code for bluray-web: sun.misc natives of the BD-J virtual machine (VM, Signal, Version, Perf,
 * URLClassPath).
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { Invoke } from '../interpreter';
import type { NativeResult } from '../interpreter';
import type { Jvm } from '../jvm';
import type { JThread } from '../threads';
import type { JArray, JObject } from '../values';
import type { NativeTable } from './index';
import { method, none } from './util';

/**
 * ByteBuffer.allocate(n), for sun.misc.Perf's counters; a long counter is direct, as HotSpot's are, since PerfCounter
 * views it with asLongBuffer.
 */
function allocateBuffer(jvm: Jvm, t: JThread, n: number, fill?: Int8Array): NativeResult {
  const bb = jvm.bootClass('java/nio/ByteBuffer');
  return jvm.withInit(t, bb, () =>
    new Invoke(method(bb, fill ? 'allocate(I)Ljava/nio/ByteBuffer;' : 'allocateDirect(I)Ljava/nio/ByteBuffer;'), [n], (buf) => {
      if (fill) {
        const hb = jvm.getField(buf as JObject, 'hb', '[B') as JArray;
        (hb.data as Int8Array).set(fill.subarray(0, n));
      }
      return buf;
    }),
  );
}

export function registerMiscNatives(table: NativeTable): void {
  table.register({
    'sun/misc/VM.initialize()V': none,
    'sun/misc/VM.latestUserDefinedLoader0()Ljava/lang/ClassLoader;': (ctx) => {
      const frames = ctx.thread.frames;
      for (let i = frames.length - 1; i >= 0; i--) if (frames[i]!.method.cls.loader) return frames[i]!.method.cls.loader;
      return null;
    },
    'sun/misc/Signal.findSignal(Ljava/lang/String;)I': () => -1,
    'sun/misc/Signal.handle0(IJ)J': () => 0n,
    'sun/misc/Signal.raise0(I)V': none,
    'sun/misc/NativeSignalHandler.handle0(IJ)V': none,
    'sun/misc/Version.getJvmSpecialVersion()Ljava/lang/String;': (ctx) => ctx.jvm.heap.newString(''),
    'sun/misc/Version.getJdkSpecialVersion()Ljava/lang/String;': (ctx) => ctx.jvm.heap.newString(''),
    'sun/misc/Version.getJvmVersionInfo()Z': () => 0,
    'sun/misc/Version.getJdkVersionInfo()V': none,
    'sun/misc/Perf.registerNatives()V': none,
    'sun/misc/Perf.attach(Ljava/lang/String;II)Ljava/nio/ByteBuffer;': (ctx) =>
      ctx.jvm.throwNew('java/lang/IllegalArgumentException', 'no instrumentation buffer to attach to'),
    'sun/misc/Perf.detach(Ljava/nio/ByteBuffer;)V': none,
    'sun/misc/Perf.createLong(Ljava/lang/String;IIJ)Ljava/nio/ByteBuffer;': (ctx) => allocateBuffer(ctx.jvm, ctx.thread, 8),
    'sun/misc/Perf.createByteArray(Ljava/lang/String;II[BI)Ljava/nio/ByteBuffer;': (ctx, _self, _name, _v, _u, value, max) =>
      allocateBuffer(ctx.jvm, ctx.thread, max as number, (value as JArray).data as Int8Array),
    'sun/misc/Perf.highResCounter()J': (ctx) => BigInt(Math.round(ctx.jvm.opts.nowMs() * 1e6)),
    'sun/misc/Perf.highResFrequency()J': () => 1_000_000_000n,
    'sun/misc/URLClassPath.getLookupCacheURLs(Ljava/lang/ClassLoader;)[Ljava/net/URL;': () => null,
    'sun/misc/URLClassPath.getLookupCacheForClassLoader(Ljava/lang/ClassLoader;Ljava/lang/String;)[I': () => null,
    'sun/misc/URLClassPath.knownToNotExist0(Ljava/lang/ClassLoader;Ljava/lang/String;)Z': () => 0,

  });
}
