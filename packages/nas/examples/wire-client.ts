// SPDX-License-Identifier: LGPL-3.0-or-later
// Make requests to a server on the other end of a data channel as if with fetch.
import { WireClient, WireServer, type WireChannel } from '@seikou/nas';

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
  const server = new WireServer(serverEnd, async (req) => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: `you asked for ${req.method} ${req.path}` }));

  // #region construct
  const client = new WireClient(clientEnd);
  // #endregion

  // #region fetch
  const res = await client.fetch('/bluray/api/health?probe=1');
  const text = await res.text();
  console.log(res.status, text);
  // #endregion
  if (res.status !== 200 || text !== 'you asked for GET /bluray/api/health?probe=1') throw new Error('the request did not reach the handler');

  // #region close
  client.close(new Error('done with the NAS'));
  // #endregion

  let refused = false;
  try {
    await client.fetch('/bluray/api/health');
  } catch {
    refused = true;
  }
  server.close();
  if (!refused) throw new Error('a closed client still fetched');
}
