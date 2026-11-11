// SPDX-License-Identifier: LGPL-3.0-or-later
// Report a lost server from a RangeTransport of your own the way HttpTransport does, so the player shows the same message.
import { DiscError } from '@seikou/bdmv';
import { RemoteDiscError, type RangeTransport } from '@seikou/engine';

export default async function example(): Promise<void> {
  const transport: RangeTransport = {
    async read(path) {
      // #region construct
      // what the transport gives up with when its server stops answering
      throw new RemoteDiscError('nas-lost', 'read-failed', 'Connection to the NAS lost.', [path]);
      // #endregion
    },
    setToken() {},
  };

  try {
    await transport.read('BDMV/STREAM/00001.M2TS', 0, 6144);
  } catch (err) {
    // a RemoteDiscError is a DiscError too: code, message and paths, and `reason` for the UI
    if (!(err instanceof RemoteDiscError) || !(err instanceof DiscError)) throw err;
    console.log(err.reason, err.code, err.paths);
    if (err.reason !== 'nas-lost' || err.paths[0] !== 'BDMV/STREAM/00001.M2TS') throw new Error('unexpected error');
  }
}
