/** The extension a context offers for rendering to 16-bit float textures: full float colour buffers, or half float only. */
export type FloatTargetSupport = 'float' | 'half';

/** Which extension makes RGBA16F renderable; `hasExtension` must enable it as a side effect (as getExtension does). */
export function floatTargetSupport(hasExtension: (name: string) => boolean): FloatTargetSupport | null {
  if (hasExtension('EXT_color_buffer_float')) return 'float';
  if (hasExtension('EXT_color_buffer_half_float')) return 'half';
  return null;
}

/** The WebGL extension name that `support` stands for. */
export function floatTargetExtension(support: FloatTargetSupport): string {
  return support === 'float' ? 'EXT_color_buffer_float' : 'EXT_color_buffer_half_float';
}
