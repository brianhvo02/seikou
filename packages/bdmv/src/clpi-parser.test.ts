import { describe, expect, it } from 'vitest';
import { buildClpi } from '../../../tests/helpers/bdmv-builders';
import { ParseError } from './byte-reader';
import { findEpAfter, findEpBefore, parseClpi, stcSpnRange } from './clpi-parser';
import { CodingType } from './stream-types';

const BASE = 450_048; // multiple of 256

function clipWith(entries: Array<{ pts: number; spn: number }>): Uint8Array {
  return buildClpi({
    numSourcePackets: 500_000,
    streams: [
      { pid: 0x1011, codingType: CodingType.AVC },
      { pid: 0x1100, codingType: CodingType.LPCM },
    ],
    presentationStart: BASE,
    presentationEnd: BASE + 450_000,
    epMaps: [{ pid: 0x1011, entries }],
  });
}

describe('parseClpi', () => {
  it('parses clip info, sequences and program streams', () => {
    const clpi = parseClpi(clipWith([{ pts: BASE, spn: 0 }]));
    expect(clpi.version).toBe('0200');
    expect(clpi.numSourcePackets).toBe(500_000);
    expect(clpi.atcSequences[0].stc[0]).toEqual({ pcrPid: 0x1001, spnStcStart: 0, presentationStart: BASE, presentationEnd: BASE + 450_000 });
    expect(clpi.programs[0].streams.map((s) => [s.pid, s.codingType, s.lang])).toEqual([
      [0x1011, CodingType.AVC, ''],
      [0x1100, CodingType.LPCM, 'eng'],
    ]);
  });

  it('reconstructs EP entries from coarse/fine tables, including SPN carries past 0x20000', () => {
    const entries = [
      { pts: BASE, spn: 0 },
      { pts: BASE + 22_528, spn: 0x1fff0 },
      { pts: BASE + 45_056, spn: 0x20010 }, // crosses a 17-bit SPN boundary → new coarse entry
      { pts: BASE + 600_064, spn: 0x50000 }, // crosses a PTS coarse boundary
    ];
    const clpi = parseClpi(clipWith(entries));
    expect(clpi.epMaps).toHaveLength(1);
    expect(clpi.epMaps[0].pid).toBe(0x1011);
    expect(clpi.epMaps[0].entries).toEqual(entries);
  });

  it('truncates the low 8 bits of EP pts like real discs', () => {
    const clpi = parseClpi(clipWith([{ pts: BASE + 1000, spn: 5 }]));
    expect(clpi.epMaps[0].entries[0]).toEqual({ pts: BASE + 768, spn: 5 });
  });

  it('rejects a coarse EP entry whose fine reference runs past the fine table', () => {
    // Two coarse groups (different 17-bit SPN carries), so the first group's range ends at the second's ref.
    const bytes = clipWith([
      { pts: BASE, spn: 0 },
      { pts: BASE + 1024, spn: 0x20010 },
    ]);
    // Locate the second coarse entry: cpi start -> EP-map header -> first pid's stream address -> coarse table.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cpiStart = view.getUint32(16); // header: signature, version, sequence, program, then CPI address
    const epMapStart = cpiStart + 4 + 2; // length u32, 12+4 bits of cpi header
    const streamStart = epMapStart + view.getUint32(epMapStart + 2 + 2 + 6);
    const coarseAt = streamStart + 4 + 8; // skip fine-table address and the first 8-byte coarse entry
    // The first 18 bits of the coarse entry are ref_ep_fine_id: set them to 0x3FFFF, past the fine table.
    bytes[coarseAt] = 0xff;
    bytes[coarseAt + 1] = 0xff;
    bytes[coarseAt + 2] |= 0xfc;
    expect(() => parseClpi(bytes)).toThrow(ParseError);
  });

  it('rejects a bad signature', () => {
    const bytes = clipWith([]);
    bytes[0] = 0x00;
    expect(() => parseClpi(bytes)).toThrow(ParseError);
  });
});

describe('EP lookup', () => {
  const map = { pid: 0x1011, epStreamType: 1, entries: [{ pts: 1000, spn: 10 }, { pts: 2000, spn: 20 }, { pts: 3000, spn: 30 }] };

  it('findEpBefore returns the last entry at or before the target', () => {
    expect(findEpBefore(map, 2000)).toEqual({ pts: 2000, spn: 20 });
    expect(findEpBefore(map, 2999)).toEqual({ pts: 2000, spn: 20 });
    expect(findEpBefore(map, 99_999)).toEqual({ pts: 3000, spn: 30 });
  });

  it('findEpBefore falls back to the first entry when the target precedes all entries', () => {
    expect(findEpBefore(map, 5)).toEqual({ pts: 1000, spn: 10 });
    expect(findEpBefore({ ...map, entries: [] }, 5)).toBeUndefined();
  });

  it('findEpAfter returns the first entry strictly after the target', () => {
    expect(findEpAfter(map, 2000)).toEqual({ pts: 3000, spn: 30 });
    expect(findEpAfter(map, 0)).toEqual({ pts: 1000, spn: 10 });
    expect(findEpAfter(map, 3000)).toBeUndefined();
  });
});

describe('STC-aware EP lookup', () => {
  // One clip, two STC sequences: PTS restarts where the second sequence begins (SPN 1000).
  const map = { pid: 0x1011, epStreamType: 1, entries: [{ pts: 1000, spn: 0 }, { pts: 2000, spn: 500 }, { pts: 1000, spn: 1000 }, { pts: 2000, spn: 1500 }] };

  it('keeps lookups inside the requested STC sequence', () => {
    expect(findEpBefore(map, 1500, { startSpn: 1000, endSpn: Infinity })).toEqual({ pts: 1000, spn: 1000 });
    expect(findEpBefore(map, 1500, { startSpn: 0, endSpn: 1000 })).toEqual({ pts: 1000, spn: 0 });
    expect(findEpAfter(map, 1500, { startSpn: 0, endSpn: 1000 })).toEqual({ pts: 2000, spn: 500 });
    expect(findEpAfter(map, 2500, { startSpn: 0, endSpn: 1000 })).toBeUndefined();
  });

  it("maps a play item's stc_id to that sequence's SPN range", () => {
    const clpi = parseClpi(
      buildClpi({
        numSourcePackets: 2000,
        streams: [{ pid: 0x1011, codingType: CodingType.AVC }],
        presentationStart: 0,
        presentationEnd: 0,
        epMaps: [{ pid: 0x1011, entries: [] }],
        stcSequences: [
          { spnStcStart: 0, presentationStart: 1000, presentationEnd: 3000 },
          { spnStcStart: 1000, presentationStart: 1000, presentationEnd: 3000 },
        ],
      }),
    );
    expect(stcSpnRange(clpi, 0)).toEqual({ startSpn: 0, endSpn: 1000 });
    expect(stcSpnRange(clpi, 1)).toEqual({ startSpn: 1000, endSpn: Infinity });
    expect(stcSpnRange(clpi, 7)).toEqual({ startSpn: 0, endSpn: Infinity }); // unknown id: whole clip, like libbluray
  });
});

describe('CLPI versions and stream attributes', () => {
  const base = (): Uint8Array =>
    buildClpi({
      numSourcePackets: 64,
      streams: [{ pid: 0x1011, codingType: CodingType.AVC }, { pid: 0x1a00, codingType: 0xa0 }],
      presentationStart: 0,
      presentationEnd: 45_000,
      epMaps: [{ pid: 0x1011, entries: [] }],
    });

  it('accepts the file versions libbluray accepts (0100, 0200, 0240, 0300) and rejects others', () => {
    for (const v of ['0100', '0200', '0240', '0300', '0400']) {
      const bytes = base();
      bytes.set([...v].map((c) => c.charCodeAt(0)), 4);
      if (v === '0400') expect(() => parseClpi(bytes)).toThrow(ParseError);
      else expect(parseClpi(bytes).version).toBe(v);
    }
  });

  it('reads the language of coding type 0xa0 streams, as libbluray does', () => {
    expect(parseClpi(base()).programs[0].streams[1]).toMatchObject({ pid: 0x1a00, codingType: 0xa0, lang: 'eng' });
  });
});
