import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseClpi } from '@seikou/bdmv/clpi-parser';
import { parseMpls } from '@seikou/bdmv/mpls-parser';
import { CodingType, isAudioCoding } from '@seikou/bdmv/stream-types';
import { rewriteClpi } from '../../server/src/levels/clpi-writer';
import { LEVELS, coreCoding, keptAudioFor, maxBudgetRate, planClip, videoAttrsFor, videoEpMap } from '../../server/src/levels/levels';
import { rewriteMpls } from '../../server/src/levels/mpls-writer';

const LOCAL = fileURLToPath(new URL('../../fixtures/local', import.meta.url)); // independent of the working directory
const LEVEL = LEVELS['h264-1080'];
const AUDIO_BPS = 640_000;

function localDiscs(): string[] {
  if (!existsSync(LOCAL)) return [];
  return readdirSync(LOCAL)
    .map((name) => join(LOCAL, name))
    .filter((dir) => existsSync(join(dir, 'BDMV', 'CLIPINF')) && existsSync(join(dir, 'BDMV', 'PLAYLIST')));
}

function files(dir: string, ext: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(ext))
    .map((f) => join(dir, f));
}

const discs = localDiscs();
/** JSON with byte arrays as lists, for comparing parsed values. */
const plain = (v: unknown): string => JSON.stringify(v, (_, x: unknown) => (x instanceof Uint8Array ? [...x] : x));

describe.skipIf(discs.length === 0)('local discs rewritten at a quality level', () => {
  for (const dir of discs) {
    const name = basename(dir);

    it(`${name}: every clip's CLPI reads back with the planned EP map, streams and sizes`, () => {
      let rewritten = 0;
      for (const path of files(join(dir, 'BDMV', 'CLIPINF'), '.clpi')) {
        const bytes = new Uint8Array(readFileSync(path));
        const before = parseClpi(bytes);
        const map = videoEpMap(before);
        if (!map || map.entries.length === 0) continue; // no video: served at original quality
        const program = before.programs[0]!;
        const video = program.streams.find((s) => s.pid === map.pid)!;
        const firstAudio = program.streams.find((s) => isAudioCoding(s.codingType));
        const audio = firstAudio ? { streamNumber: 1, pid: firstAudio.pid, coding: firstAudio.codingType } : null;
        const graphics = program.streams.filter((s) => s.codingType === CodingType.PG || s.codingType === CodingType.IG);
        const plan = planClip(before, LEVEL, AUDIO_BPS);
        const attrs = videoAttrsFor(LEVEL, video.rate);
        const after = parseClpi(
          rewriteClpi(bytes, { intervals: plan.intervals, level: LEVEL, keepPids: graphics.map((s) => s.pid), audio, videoPid: map.pid, ...attrs }),
        );

        expect(after.numSourcePackets).toBe(plan.sizeBytes / 192);
        expect(after.recordingRate).toBe(maxBudgetRate(plan.intervals));
        const afterMap = after.epMaps.find((m) => m.pid === map.pid)!;
        expect(afterMap.entries.map((e) => e.pts)).toEqual(plan.intervals.map((iv) => iv.startPts45));
        const original = new Set(map.entries.map((e) => e.pts));
        expect(afterMap.entries.every((e) => original.has(e.pts))).toBe(true);
        expect(afterMap.entries.map((e) => e.spn)).toEqual(plan.intervals.map((iv) => iv.spnStart));
        const streams = after.programs[0]!.streams;
        const kept = new Set([map.pid, ...(audio ? [audio.pid] : []), ...graphics.map((s) => s.pid)]);
        expect(streams.map((s) => s.pid)).toEqual(program.streams.filter((s) => kept.has(s.pid)).map((s) => s.pid));
        expect(streams.find((s) => s.pid === map.pid)).toMatchObject({ codingType: attrs.newCoding, format: attrs.newFormat, rate: attrs.newRate, aspect: video.aspect });
        if (audio) {
          const a = streams.find((s) => s.pid === audio.pid)!;
          expect(a.codingType).toBe(coreCoding(audio.coding));
          expect({ format: a.format, lang: a.lang }).toEqual({ format: firstAudio!.format, lang: firstAudio!.lang });
        }
        expect(plain(streams.filter((s) => s.codingType === CodingType.PG || s.codingType === CodingType.IG))).toBe(plain(graphics));
        rewritten++;
      }
      expect(rewritten).toBeGreaterThan(0);
    });

    it(`${name}: every playlist reads back with one kept audio per item and everything else unchanged`, () => {
      for (const path of files(join(dir, 'BDMV', 'PLAYLIST'), '.mpls')) {
        const bytes = new Uint8Array(readFileSync(path));
        const before = parseMpls(bytes);
        const after = parseMpls(rewriteMpls(bytes, { audioStreamNumber: 2 }, { newCoding: CodingType.AVC, newFormat: 6, newRate: 1 }));
        expect(after.playItems).toHaveLength(before.playItems.length);
        after.playItems.forEach((pi, i) => {
          const b = before.playItems[i]!;
          const kept = keptAudioFor(b, 2);
          expect(pi.stn.audio).toEqual(kept ? [{ ...b.stn.audio[kept.streamNumber - 1]!, ...coreFields(b.stn.audio[kept.streamNumber - 1]!) }] : []);
          expect(pi.stn.secondaryAudio).toEqual([]);
          expect(pi.stn.secondaryVideo).toEqual([]);
          expect(pi.stn.video.map((v) => v.codingType)).toEqual(b.stn.video.map(() => CodingType.AVC));
          expect(plain([pi.stn.pg, pi.stn.pipPg, pi.stn.ig])).toBe(plain([b.stn.pg, b.stn.pipPg, b.stn.ig]));
          expect(plain({ ...pi, stn: null })).toBe(plain({ ...b, stn: null }));
        });
        expect(plain([after.subPaths, after.marks, after.uoMask, after.playbackType])).toBe(plain([before.subPaths, before.marks, before.uoMask, before.playbackType]));
      }
    });
  }
});

/** The coding a kept stream travels as: its core, at 48 kHz when the coding changes. */
function coreFields(s: { codingType: number; rate: number }): { codingType: number; rate: number } {
  const codingType = coreCoding(s.codingType);
  return { codingType, rate: codingType === s.codingType ? s.rate : 1 };
}
