import { describe, expect, it } from 'vitest';
import { parseDrawing } from './drawing';

const U = 64; // 26.6

describe('parseDrawing', () => {
  it('turns m and l into a closed contour in 26.6 units, with its control box', () => {
    expect(parseDrawing('m 0 0 l 100 0 100 100')).toEqual({
      commands: [['M', 0, 0], ['L', 100 * U, 0], ['L', 100 * U, 100 * U], ['Z']],
      cbox: [0, 0, 100 * U, 100 * U],
    });
  });

  it('reads cubic Béziers from b', () => {
    expect(parseDrawing('m 0 0 b 10 0 20 10 20 20').commands).toEqual([['M', 0, 0], ['C', 10 * U, 0, 20 * U, 10 * U, 20 * U, 20 * U], ['Z']]);
  });

  it('turns a closed b-spline into cubic segments as drawing_add_curve does', () => {
    const { commands } = parseDrawing('m 0 0 s 300 0 300 300 0 300 c');
    // the first segment, from the spline's control points (0,0) (300,0) (300,300) (0,300)
    expect(commands.slice(0, 2)).toEqual([['M', 16000, 3200], ['C', 19200, 6400, 19200, 12800, 16000, 16000]]);
    expect(commands.filter((c) => c[0] === 'C')).toHaveLength(4);
    const last = commands.at(-2)!;
    expect([last[5], last[6]]).toEqual([16000, 3200]); // closing c brings the spline back to its start
    expect(commands.at(-1)).toEqual(['Z']);
  });

  it('repeats implicit points of l and treats n as a move that does not close', () => {
    expect(parseDrawing('m 0 0 l 1 1 2 2').commands.map((c) => c[0])).toEqual(['M', 'L', 'L', 'Z']);
    expect(parseDrawing('m 0 0 l 10 0 n 20 20 l 30 30').commands).toEqual([['M', 0, 0], ['L', 10 * U, 0], ['L', 30 * U, 30 * U], ['Z']]);
    expect(parseDrawing('m 0 0 l 1 1 m 5 5 l 6 6').commands.map((c) => c[0])).toEqual(['M', 'L', 'Z', 'M', 'L', 'Z']);
  });

  it('rounds coordinates to 1/64 with lrint', () => {
    expect(parseDrawing('m 0.5 -1.25 l 1 1').commands[0]).toEqual(['M', 32, -80]);
  });

  it('draws nothing from garbage, an empty string, or commands before any m', () => {
    expect(parseDrawing('m x y')).toEqual({ commands: [], cbox: null });
    expect(parseDrawing('')).toEqual({ commands: [], cbox: null });
    expect(parseDrawing('l 10 10 m 0 0 l 5 5').commands.map((c) => c[0])).toEqual(['M', 'L', 'Z']);
    expect(parseDrawing('n 1 1 l 2 2')).toEqual({ commands: [], cbox: null }); // n before any m rejects the drawing
  });

  it('ignores p until three points exist', () => {
    expect(parseDrawing('m 0 0 p 1 1 l 2 2').commands.map((c) => c[0])).toEqual(['M', 'L', 'Z']);
  });
});
