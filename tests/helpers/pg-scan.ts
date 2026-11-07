import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileSource } from '../../src/engine/disc/file-source';
import { openDisc, streamPath } from '../../src/engine/disc/open-disc';
import { normalizeDiscPaths } from '../../src/engine/disc/paths';
import { M2tsReader } from '@seikou/bdmv/demux/m2ts-reader';
import { PgSegmentDecoder } from '@seikou/pg';
import { Timeline } from '../../src/engine/nav/timeline';
import { directoryEntries } from './file-blob';

/** Where a playlist's PG streams have something to show. */
export interface PgScan {
  readonly playlistId: string;
  readonly durationUs: number;
  /** Per PG stream number (1-based, as the STN of the first play item): the playlist times of display sets with objects. */
  readonly streams: Record<number, { readonly language: string; readonly objectTimesUs: readonly number[]; readonly errors: number }>;
}

/**
 * Decodes every PG stream of the playlist (of `discDir`) lasting `durationUs` (±1 s) with our PgSegmentDecoder and records
 * when display sets with composition objects start. Reading tens of GB takes minutes, so the result is cached next to the
 * disc (fixtures/local is not committed), keyed by playlist and clip sizes.
 */
export async function scanPg(discDir: string, durationUs: number): Promise<PgScan | null> {
  const source = new FileSource(normalizeDiscPaths(await directoryEntries(discDir)));
  const disc = await openDisc(source);
  const summary = disc.summaries.find((s) => Math.abs(s.durationUs - durationUs) <= 1_000_000);
  const mpls = summary ? disc.playlists.get(summary.id) : undefined;
  if (!summary || !mpls) return null;
  const key = `${summary.id}:${mpls.playItems.map((p) => statSync(join(discDir, 'BDMV', 'STREAM', `${p.clipId}.m2ts`)).size).join(',')}`;
  const cachePath = join(discDir, '..', `.pgscan-${discDir.split('/').filter(Boolean).pop()}.json`);
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as PgScan & { key: string };
    if (cached.key === key) return cached;
  }

  const timeline = new Timeline(mpls.playItems, mpls.marks);
  const stn = mpls.playItems[0]!.stn.pg;
  const streams: Record<number, { language: string; objectTimesUs: number[]; errors: number }> = {};
  stn.forEach((s, i) => (streams[i + 1] = { language: s.lang, objectTimesUs: [], errors: 0 }));
  for (let i = 0; i < mpls.playItems.length; i++) {
    const item = mpls.playItems[i]!;
    const byPid = new Map(item.stn.pg.flatMap((s, k) => (s.streamType === 2 ? [] : [[s.pid, { stream: k + 1, decoder: new PgSegmentDecoder() }] as const])));
    const reader = new M2tsReader({ source, path: streamPath(item.clipId), startSpn: 0, pids: new Set(byPid.keys()) });
    for (let batch = await reader.next(); batch; batch = await reader.next()) {
      for (const pes of batch) {
        const entry = byPid.get(pes.pid);
        if (!entry || pes.pts === undefined) continue;
        const set = entry.decoder.push(pes.payload, pes.pts, pes.dts ?? null);
        if (!set || set.composition.compositionObjects.length === 0) continue;
        const { us, inRange } = timeline.toPlaylistUs(i, set.pts);
        if (inRange) streams[entry.stream]?.objectTimesUs.push(us);
      }
    }
    for (const { stream, decoder } of byPid.values()) if (streams[stream]) streams[stream].errors += decoder.errors;
  }
  const scan: PgScan = { playlistId: summary.id, durationUs: summary.durationUs, streams };
  writeFileSync(cachePath, JSON.stringify({ ...scan, key }));
  return scan;
}
