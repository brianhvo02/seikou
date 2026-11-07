// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Readable } from 'node:stream';

export async function collect(stream: Readable): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return chunks;
}
