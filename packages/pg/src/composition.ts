/*
 * Ported from libbluray src/libbluray/decoders/graphics_controller.c (_render_composition_object)
 * Copyright (C) 2010-2013  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { OverlayOp } from './overlay-plane';
import { cropRle } from './rle';
import type { PgCompositionObject, PgObject, PgPalette } from './segments';

/**
 * _render_composition_object: the overlay draw op for a composition object, cropped as its flags say.
 * null where rle_crop_object() fails (a crop of an object without an image), so nothing is drawn.
 */
export function compositionObjectOp(pts: number, cobj: PgCompositionObject, object: PgObject, palette: PgPalette, paletteUpdateFlag: boolean): OverlayOp | null {
  let img: OverlayOp['img'] = object.img.length ? object.img : undefined;
  let w = object.width;
  let h = object.height;

  if (cobj.cropFlag) {
    if (cobj.cropX || cobj.cropY || cobj.cropW !== object.width) {
      // rle_crop_object() fails without an image: "Error cropping PG object"
      if (!img) return null;
      img = cropRle(img, object.width, cobj.cropX, cobj.cropY, cobj.cropW, cobj.cropH);
    }
    w = cobj.cropW;
    h = cobj.cropH;
  }

  return {
    cmd: 'draw', pts, x: cobj.x, y: cobj.y, w, h, palette: palette.entries,
    ...(img ? { img } : {}),
    paletteUpdate: paletteUpdateFlag,
  };
}
