// SPDX-License-Identifier: LGPL-3.0-or-later
// Answer requests that arrive over a data channel with a handler, then close the channel from the server's side.
import { WireClient, WireServer, type WireChannel, type WireResponse } from '@seikou/nas';

// Two ends of one in-memory data channel: what one sends, the other receives.
function channelPair(): [WireChannel, WireChannel] {
  const make = (): WireChannel => ({
    send() {},
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onbufferedamountlow: null,
    onmessage: null,
    onclose: null,
    close() {},
  });
  const a = make();
  const b = make();
  let open = true;
  const wire = (from: WireChannel, to: WireChannel): void => {
    from.send = (data) => {
      if (!open) throw new Error('the channel is closed');
      queueMicrotask(() => to.onmessage?.(data));
    };
    from.close = () => {
      if (!open) return;
      open = false;
      queueMicrotask(() => {
        a.onclose?.();
        b.onclose?.();
      });
    };
  };
  wire(a, b);
  wire(b, a);
  return [a, b];
}

export default async function example(): Promise<void> {
  const [clientEnd, serverEnd] = channelPair();
  const client = new WireClient(clientEnd);

  // #region construct
  const server = new WireServer(serverEnd, async (req): Promise<WireResponse> => {
    if (req.path !== '/bluray/api/health') return { status: 404, headers: {}, body: 'no such route' };
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' };
  });
  // #endregion

  const ok = await client.fetch('/bluray/api/health');
  const missing = await client.fetch('/bluray/api/other');
  console.log(ok.status, await ok.text(), missing.status);
  if (ok.status !== 200 || missing.status !== 404) throw new Error('the handler was not used');

  // #region close
  server.close(); // the client's pending and later requests fail
  // #endregion

  try {
    await client.fetch('/bluray/api/health');
  } catch {
    return;
  }
  throw new Error('the client still fetched after the server closed');
}
