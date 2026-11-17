// SPDX-License-Identifier: LGPL-3.0-or-later
/// <reference lib="webworker" />
import type { DecodeRateRequest, DecodeRateReply } from './checks';
import { measureDecodeRate } from './decode-rate';
import { openProbeSource } from './probe-source';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<DecodeRateRequest>) => {
  let reply: DecodeRateReply;
  try {
    reply = { rate: await measureDecodeRate(openProbeSource(event.data.input), event.data.coding) };
  } catch (err) {
    reply = { error: err instanceof Error ? err.message : String(err) };
  }
  scope.postMessage(reply);
};
