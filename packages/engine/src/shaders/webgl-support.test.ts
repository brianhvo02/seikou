import { describe, expect, it } from 'vitest';
import { floatTargetSupport } from './webgl-support';

const has = (...names: string[]) => (name: string) => names.includes(name);

describe('floatTargetSupport', () => {
  it('prefers EXT_color_buffer_float', () => {
    expect(floatTargetSupport(has('EXT_color_buffer_float', 'EXT_color_buffer_half_float'))).toBe('float');
  });
  it('falls back to half float', () => {
    expect(floatTargetSupport(has('EXT_color_buffer_half_float'))).toBe('half');
  });
  it('is null with neither', () => {
    expect(floatTargetSupport(has())).toBeNull();
  });
});
