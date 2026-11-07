import { ByteWriter } from '../../../tests/helpers/byte-writer';
import { endSegment, odsSegment, pdsSegment } from '../../../tests/helpers/ig-builders';

export { endSegment, odsSegment, pdsSegment };

// PG segment payloads as they appear in a PG PES packet: type, 16-bit length, body.

const PCS = 0x16;
const WDS = 0x17;
const STATE = { normal: 0, acquisition: 1, epochStart: 2 } as const;

function segment(type: number, body: Uint8Array): Uint8Array {
  return new ByteWriter().u8(type).u16(body.length).bytes(body).toBytes();
}

export interface PcsSpec {
  width?: number;
  height?: number;
  frameRateCode?: number;
  compositionNumber?: number;
  compositionState: 'epochStart' | 'acquisition' | 'normal';
  paletteUpdate?: boolean;
  paletteId: number;
  objects: Array<{ objectId: number; windowId: number; x: number; y: number; forced?: boolean; crop?: { x: number; y: number; w: number; h: number } }>;
}

export function pcsSegment(spec: PcsSpec): Uint8Array {
  const w = new ByteWriter()
    .u16(spec.width ?? 1920).u16(spec.height ?? 1080).bits(4, spec.frameRateCode ?? 1).bits(4, 0)
    .u16(spec.compositionNumber ?? 0).bits(2, STATE[spec.compositionState]).bits(6, 0)
    .bits(1, spec.paletteUpdate ? 1 : 0).bits(7, 0)
    .u8(spec.paletteId)
    .u8(spec.objects.length);
  for (const o of spec.objects) {
    w.u16(o.objectId).u8(o.windowId).bits(1, o.crop ? 1 : 0).bits(1, o.forced ? 1 : 0).bits(6, 0).u16(o.x).u16(o.y);
    if (o.crop) w.u16(o.crop.x).u16(o.crop.y).u16(o.crop.w).u16(o.crop.h);
  }
  return segment(PCS, w.toBytes());
}

export function wdsSegment(windows: Array<[id: number, x: number, y: number, width: number, height: number]>): Uint8Array {
  const w = new ByteWriter().u8(windows.length);
  for (const [id, x, y, width, height] of windows) w.u8(id).u16(x).u16(y).u16(width).u16(height);
  return segment(WDS, w.toBytes());
}

/** A whole display set (PCS, WDS, PDS, ODS…, END) showing one W×H object of palette index 1 at (x, y); `forced` marks it forced. */
export function subtitleSegments(opts: {
  objectId?: number; x?: number; y?: number; w?: number; h?: number; forced?: boolean;
  state?: PcsSpec['compositionState']; compositionNumber?: number;
}): Uint8Array[] {
  const { objectId = 0, x = 100, y = 900, w = 16, h = 8 } = opts;
  return [
    pcsSegment({
      compositionNumber: opts.compositionNumber,
      compositionState: opts.state ?? 'epochStart',
      paletteId: 0,
      objects: [{ objectId, windowId: 0, x, y, forced: opts.forced }],
    }),
    wdsSegment([[0, x, y, w, h]]),
    pdsSegment(0, 0, [[1, 235, 128, 128, 255]]),
    ...odsSegment(objectId, 0, w, h, Array.from({ length: h }, () => new Array<number>(w).fill(1))),
    endSegment(),
  ];
}

/** An empty display set (PCS with no objects, END): clears the subtitle. */
export function clearSegments(compositionNumber?: number): Uint8Array[] {
  return [pcsSegment({ compositionNumber, compositionState: 'normal', paletteId: 0, objects: [] }), wdsSegment([]), endSegment()];
}
