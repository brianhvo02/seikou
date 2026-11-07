import { describe, expect, it } from 'vitest';
import { buildIndex } from '../../../tests/helpers/bdmv-builders';
import { ParseError } from '@seikou/bdmv/byte-reader';
import { indexUsesBdj, parseIndex } from './index-parser';

describe('parseIndex', () => {
  it("reads AppInfoBDMV's initial output mode preference and content exist flag", () => {
    const base = { firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 1 }, titles: [] } as const;
    expect(parseIndex(buildIndex({ ...base, titles: [] })).appInfo).toEqual({ initialOutputModePreference: 0, contentExistFlag: false });
    expect(parseIndex(buildIndex({ ...base, titles: [], appInfo: { initialOutputModePreference: 1, contentExistFlag: true } })).appInfo).toEqual({
      initialOutputModePreference: 1,
      contentExistFlag: true,
    });
  });

  it('parses HDMV first play, top menu and titles', () => {
    const index = parseIndex(
      buildIndex({
        firstPlay: { kind: 'hdmv', movieObjectId: 0 },
        topMenu: { kind: 'hdmv', movieObjectId: 1 },
        titles: [
          { kind: 'hdmv', movieObjectId: 2 },
          { kind: 'hdmv', movieObjectId: 3, playbackType: 1 },
        ],
      }),
    );
    expect(index.version).toBe('0200');
    expect(index.firstPlay).toEqual({ kind: 'hdmv', playbackType: 0, movieObjectId: 0 });
    expect(index.topMenu).toEqual({ kind: 'hdmv', playbackType: 0, movieObjectId: 1 });
    expect(index.titles.map((t) => t.object)).toEqual([
      { kind: 'hdmv', playbackType: 0, movieObjectId: 2 },
      { kind: 'hdmv', playbackType: 1, movieObjectId: 3 },
    ]);
    expect(indexUsesBdj(index)).toBe(false);
  });

  it('detects BD-J objects', () => {
    const index = parseIndex(
      buildIndex({
        firstPlay: { kind: 'bdj', name: '00000' },
        topMenu: { kind: 'hdmv', movieObjectId: 0 },
        titles: [{ kind: 'bdj', name: '00001' }],
      }),
    );
    expect(index.firstPlay).toEqual({ kind: 'bdj', playbackType: 0, name: '00000' });
    expect(indexUsesBdj(index)).toBe(true);
  });

  it('rejects a bad signature', () => {
    const bytes = buildIndex({ firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [] });
    bytes[0] = 0x58;
    expect(() => parseIndex(bytes)).toThrow(ParseError);
  });

  it('rejects a truncated file', () => {
    const bytes = buildIndex({ firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [{ kind: 'hdmv', movieObjectId: 1 }] });
    expect(() => parseIndex(bytes.subarray(0, bytes.length - 4))).toThrow(ParseError);
  });

  it('keeps parsing past an object of unknown type', () => {
    const bytes = buildIndex({ firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 1 }, titles: [{ kind: 'hdmv', movieObjectId: 2 }, { kind: 'hdmv', movieObjectId: 3 }] });
    const indexesStart = new DataView(bytes.buffer).getUint32(8);
    const firstTitle = indexesStart + 4 + 12 + 12 + 2;
    bytes[firstTitle] = (bytes[firstTitle] & 0x3f) | (3 << 6); // object_type 3: not HDMV or BD-J
    const index = parseIndex(bytes);
    expect(index.titles[0].object).toEqual({ kind: 'unknown', objectType: 3 });
    expect(index.titles[1].object).toEqual({ kind: 'hdmv', playbackType: 0, movieObjectId: 3 });
  });

  it('accepts the file versions libbluray accepts (0100, 0200, 0240, 0300) and rejects others', () => {
    const make = (v: string): Uint8Array => {
      const bytes = buildIndex({ firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 1 }, titles: [] });
      bytes.set([...v].map((c) => c.charCodeAt(0)), 4);
      return bytes;
    };
    for (const v of ['0100', '0200', '0240', '0300']) expect(parseIndex(make(v)).version).toBe(v);
    expect(() => parseIndex(make('0400'))).toThrow(ParseError);
  });
});
