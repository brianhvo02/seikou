import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FansubPick } from '@seikou/nas/nas-api';
import { PickStore, PickTooLarge } from './pick-store';

let dir: string;
let clock: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'picks-'));
  clock = 1_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const make = (maxBytes = 10_000): PickStore => new PickStore(dir, { maxBytes, now: () => clock, building: () => false });
const DAY = 86_400_000;

function pick(id: string, fileSize: number): FansubPick {
  return {
    id, pick: true, name: 'GroupA · Full', language: 'en', offsetMs: 0, fileName: `${id}.ass`, fileSize, fonts: [],
    attachment: { kind: 'chapter', discKey: 'd.1', playlistId: '00001', chapter: 0 }, uploadedAt: clock,
    source: {
      kind: 'fansub', group: 'GroupA', tracker: '', rank: 'other', toshoFileId: 1, track: 0, trackName: 'Full',
      alignment: { kind: 'original' }, linedUpOn: { discKey: 'd.1', playlistId: '00001' },
    },
  };
}
const put = (s: PickStore, id: string, size: number, fonts: Record<string, Buffer> = {}): FansubPick =>
  s.put(pick(id, size), Buffer.alloc(size, 65), new Map(Object.entries(fonts)));
const id = (n: number): string => n.toString(16).padStart(16, '0');
const pool = (): string[] => readdirSync(join(dir, 'fansubs', 'pick-fonts'));

describe('PickStore', () => {
  it('keeps one copy of a font picks share, and serves it to each', () => {
    const s = make();
    const font = Buffer.alloc(100, 7);
    const a = put(s, id(1), 10, { 'F.ttf': font });
    const b = put(s, id(2), 10, { 'G.ttf': font });
    expect(pool()).toHaveLength(1);
    expect(a.fonts[0]).toMatchObject({ name: 'F.ttf', size: 100, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(readFileSync(s.fontPath(a.id, 'F.ttf')!)).toEqual(font);
    expect(readFileSync(s.fontPath(b.id, 'G.ttf')!)).toEqual(font);
    expect(readFileSync(s.filePath(a.id)!)).toEqual(Buffer.alloc(10, 65));
    expect(s.fontPath(a.id, 'G.ttf')).toBeNull();
  });

  it('evicts the least recently used picks to stay under its budget, with the fonts only they used', () => {
    const s = make(1_000);
    put(s, id(1), 300, { 'A.ttf': Buffer.alloc(100, 1) });
    clock += DAY;
    put(s, id(2), 300);
    clock += DAY;
    // a use moves the first one up
    expect(s.filePath(id(1))).not.toBeNull();
    clock += DAY;
    put(s, id(3), 400);
    expect(s.get(id(2))).toBeNull();
    expect(existsSync(join(dir, 'fansubs', 'picks', id(2)))).toBe(false);
    expect(s.get(id(1))).not.toBeNull();
    put(s, id(4), 500);
    expect(s.get(id(1))).toBeNull();
    expect(pool()).toEqual([]);
    expect(s.get(id(3))).not.toBeNull();
    expect(s.get(id(4))).not.toBeNull();
  });

  it('never evicts a font the new pick uses', () => {
    const s = make(1_000);
    const font = Buffer.alloc(200, 3);
    put(s, id(1), 500, { 'F.ttf': font });
    clock += DAY;
    const b = put(s, id(2), 500, { 'F.ttf': font });
    expect(s.get(id(1))).toBeNull();
    expect(readFileSync(s.fontPath(b.id, 'F.ttf')!)).toEqual(font);
  });

  it('refuses a pick larger than the whole budget and keeps the others', () => {
    const s = make(1_000);
    put(s, id(1), 300);
    expect(() => put(s, id(2), 800, { 'F.ttf': Buffer.alloc(300) })).toThrow(PickTooLarge);
    expect(s.get(id(1))).not.toBeNull();
    expect(s.get(id(2))).toBeNull();
    expect(pool()).toEqual([]);
  });

  it('a fresh instance loads its picks, counts them and sweeps what nothing uses', () => {
    const first = make(1_000);
    put(first, id(1), 300, { 'F.ttf': Buffer.alloc(100, 1) });
    clock += DAY;
    put(first, id(2), 300);
    writeFileSync(join(dir, 'fansubs', 'pick-fonts', 'a'.repeat(64)), 'orphan');
    mkdirSync(join(dir, 'fansubs', 'picks', '.tmp-0000000000000009-ab'));
    const s = make(1_000);
    expect(pool()).toHaveLength(1);
    expect(readdirSync(join(dir, 'fansubs', 'picks')).sort()).toEqual([id(1), id(2)]);
    clock += DAY;
    put(s, id(3), 400);
    expect(s.get(id(1))).toBeNull();
    expect(s.get(id(2))).not.toBeNull();
  });

  it('serves a pick stored before the pool from its own fonts folder', () => {
    const legacy = { ...pick(id(5), 1), fonts: [{ name: 'Old.ttf', size: 3 }] };
    mkdirSync(join(dir, 'fansubs', 'picks', id(5), 'fonts'), { recursive: true });
    mkdirSync(join(dir, 'fansubs', 'picks', id(5), 'sub'));
    writeFileSync(join(dir, 'fansubs', 'picks', id(5), 'fonts', 'Old.ttf'), 'old');
    writeFileSync(join(dir, 'fansubs', 'picks', id(5), 'meta.json'), JSON.stringify({ subtitle: legacy, usedAt: clock }));
    const s = make();
    expect(readFileSync(s.fontPath(id(5), 'Old.ttf')!, 'utf8')).toBe('old');
  });

  it('removes picks unused for 30 days', () => {
    const s = make();
    put(s, id(1), 10, { 'F.ttf': Buffer.alloc(5) });
    clock += 31 * DAY;
    s.sweep();
    expect(s.get(id(1))).toBeNull();
    expect(pool()).toEqual([]);
  });
});
