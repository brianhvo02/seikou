import { describe, expect, it } from 'vitest';
import { parseEvent } from './events';
import { parseAss } from './parse';
import { applyMat3, isAffine, transformMatrix } from './transform';

function glyph(tags: string) {
  const track = parseAss(`[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,{${tags}}x\n`);
  const e = parseEvent(track, track.events[0]!, { frameWidth: 1920, frameHeight: 1080, storageWidth: 1920, storageHeight: 1080, fontScale: 1 }, 0)!;
  const g = e.glyphs[0]!;
  g.posX = 640 * 64;
  g.posY = 360 * 64;
  return { s: e.state, g };
}

describe('transformMatrix', () => {
  it('translates by the glyph position when nothing rotates', () => {
    const { s, g } = glyph('');
    const m = transformMatrix(s, g);
    expect(isAffine(m)).toBe(true);
    const [x, y] = applyMat3(m, 64, 0);
    expect([x / 64, y / 64]).toEqual([641, 360]);
  });

  it('rotates \\frz90 counter-clockwise on screen (y down) around the shift origin', () => {
    const { s, g } = glyph('\\frz90');
    const m = transformMatrix(s, g);
    const [x, y] = applyMat3(m, 64, 0);
    expect(x / 64).toBeCloseTo(640, 9);
    expect(y / 64).toBeCloseTo(359, 9);
  });

  it('makes \\frx non-affine', () => {
    const { s, g } = glyph('\\frx30');
    expect(isAffine(transformMatrix(s, g))).toBe(false);
  });

  it('shears with \\fax', () => {
    const { s, g } = glyph('\\fax1');
    const [x, y] = applyMat3(transformMatrix(s, g), 0, -64);
    expect([x / 64, y / 64]).toEqual([639, 359]);
  });
});
