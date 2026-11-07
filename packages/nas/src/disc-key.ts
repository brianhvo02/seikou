import { contentHash } from './content-hash';

const STREAM = /^BDMV\/STREAM\/([^/]+\.M2TS)$/;

export type ParsedDiscKey = { kind: 'fingerprint'; fingerprint: string } | { kind: 'disc'; discId: string };

/** The `BDMV/STREAM/*.M2TS` files among `files` (paths as the manifest gives them, upper-case), named by file name. */
export function streamsOf(files: readonly { path: string; size: number }[]): { name: string; size: number }[] {
  return files.flatMap((f) => {
    const m = STREAM.exec(f.path);
    return m ? [{ name: m[1]!, size: f.size }] : [];
  });
}

/** The key a disc's link carries: `f.<content fingerprint>`, or `d.<disc id>` when it has no streams to hash. */
export function discKeyOf(discId: string, files: readonly { path: string; size: number }[]): string {
  const hash = contentHash(streamsOf(files));
  return hash === null ? `d.${discId}` : `f.${hash}`;
}

export function parseDiscKey(key: string): ParsedDiscKey | null {
  const f = /^f\.([0-9A-F]{32})$/.exec(key);
  if (f) return { kind: 'fingerprint', fingerprint: f[1]! };
  const d = /^d\.([0-9a-f]{16})$/.exec(key);
  if (d) return { kind: 'disc', discId: d[1]! };
  return null;
}
