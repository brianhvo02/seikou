// SPDX-License-Identifier: LGPL-3.0-or-later
// Read the organisation and disc IDs from the bytes of id.bdmv (built here: the synthetic discs have none).
import { parseBdid } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  // #region parse
  const bytes = new Uint8Array(60);
  bytes.set(new TextEncoder().encode('BDID0200'));
  bytes.fill(0xab, 40, 44); // org_id
  bytes.fill(0x01, 44, 60); // disc_id
  const { orgId, discId } = parseBdid(bytes);
  console.log(orgId, discId); // abababab 01010101010101010101010101010101
  // #endregion
  if (orgId !== 'abababab' || discId !== '01'.repeat(16)) throw new Error('unexpected IDs');
}
