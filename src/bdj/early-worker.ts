/*
 * Original code for bluray-web: a BD-J worker started while the disc is still opening (spec §4.7), which a BdjSession
 * adopts later.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { BdjBootMessage, EarlyBdjWorkerLike, WorkerLike } from '@seikou/engine/bdj-types';
import { bootTransfer, type FromBdj, type ToBdj } from './worker-protocol';

type Held = { readonly message: MessageEvent<FromBdj> } | { readonly error: ErrorEvent };

/**
 * Wraps a worker whose boot message may go out before any session exists. Only the first boot message reaches the
 * worker (the session's own, once it adopts the worker, is the same message and is dropped). What the worker sends is
 * held until the session has asked for the boot, so it hears 'booted' after it starts waiting for it.
 */
export class EarlyBdjWorker implements EarlyBdjWorkerLike {
  onmessage: ((event: MessageEvent<FromBdj>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private bootSent = false;
  private released = false;
  private readonly held: Held[] = [];

  constructor(private readonly inner: WorkerLike) {
    inner.onmessage = (e) => this.deliver({ message: e });
    inner.onerror = (e) => this.deliver({ error: e });
  }

  /** The early boot message; false when a boot has already gone out. */
  boot(message: BdjBootMessage): boolean {
    if (this.bootSent) return false;
    this.bootSent = true;
    this.inner.postMessage(message, bootTransfer(message));
    return true;
  }

  postMessage(message: ToBdj): void {
    if (message.type === 'boot') {
      if (!this.bootSent) {
        this.bootSent = true;
        this.inner.postMessage(message, bootTransfer(message));
      }
      this.release();
      return;
    }
    this.inner.postMessage(message);
  }

  terminate(): void {
    this.held.length = 0;
    this.inner.onmessage = null;
    this.inner.onerror = null;
    this.inner.terminate();
  }

  private deliver(h: Held): void {
    if (!this.released) this.held.push(h);
    else if ('message' in h) this.onmessage?.(h.message);
    else this.onerror?.(h.error);
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    for (const h of this.held.splice(0)) {
      if ('message' in h) this.onmessage?.(h.message);
      else this.onerror?.(h.error);
    }
  }
}
