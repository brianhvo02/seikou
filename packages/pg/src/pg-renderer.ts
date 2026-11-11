/*
 * Ported from libbluray src/libbluray/decoders/graphics_controller.c (PG rendering: _render_pg,
 * _render_pg_composition_object, _reset_pg and the PG plane overlay operations)
 * Copyright (C) 2010-2013  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { compositionObjectOp } from './composition';
import type { OverlayCmd, OverlayOp } from './overlay-plane';
import type { PgDisplaySet } from './pg-decoder';
import type { PgCompositionObject, PgPalette } from './segments';

/** What the renderer needs from its host, so it depends on neither the register file nor a canvas. */
export interface PgRendererDeps {
  /** The PG display flag (bit 31 of PSR2): when false only forced objects are drawn. */
  displayFlag(): boolean;
  /** Receives each overlay operation, in order, as the renderer produces it. */
  onOverlay(op: OverlayOp): void;
}

/**
 * The PG half of libbluray's graphics controller (BD_OVERLAY_PG). It is separate from GraphicsController
 * because PG also plays on discs without a navigator, where no IG controller exists.
 */
export class PgRenderer {
  private pgOpen = false;
  private forced = 0;

  constructor(private readonly deps: PgRendererDeps) {}

  /** The PG overlay is open (pg_open): something was drawn since the last reset. */
  get open(): boolean {
    return this.pgOpen;
  }

  /** Forced objects drawn by the last render (for telemetry). */
  get lastForced(): number {
    return this.forced;
  }

  /** GC_CTRL_PG_UPDATE with this display set (_render_pg). Returns the number of composition objects drawn. */
  render(ds: PgDisplaySet): number {
    const pcs = ds.composition;
    this.forced = 0;

    const palette = ds.palettes.get(pcs.paletteIdRef);
    if (!palette) return 0; // _render_pg(): unknown palette id

    const displayFlag = this.deps.displayFlag() ? 1 : 0;

    let drawn = 0;
    for (const cobj of pcs.compositionObjects) {
      if (cobj.forcedOnFlag || displayFlag) {
        if (this.renderCompositionObject(ds, pcs.pts, cobj, palette)) {
          drawn++;
          if (cobj.forcedOnFlag) this.forced++;
        }
      }
    }

    if (!this.pgOpen) return drawn;

    // commit changes at given pts
    this.emit('flush', pcs.pts);

    // clear plane but do not commit changes yet: the next composition (an empty one clears) commits it
    for (const cobj of pcs.compositionObjects) {
      const object = ds.objects.get(cobj.objectId);
      if (object) this.emit('wipe', -1, cobj.x, cobj.y, object.width, object.height);
    }
    this.emit('hide', 0);

    return drawn;
  }

  /** GC_CTRL_PG_RESET (_reset_pg); the caller resets its PgSegmentDecoder (graphics_processor_free). */
  reset(): void {
    if (this.pgOpen) {
      // _close_osd
      this.emit('close', -1);
      this.pgOpen = false;
    }
    this.forced = 0;
  }

  /** _render_pg_composition_object; false when the object is missing. */
  private renderCompositionObject(ds: PgDisplaySet, pts: number, cobj: PgCompositionObject, palette: PgPalette): boolean {
    const object = ds.objects.get(cobj.objectId);
    if (!object) return false; // object not found

    if (!this.pgOpen) {
      // _open_osd
      this.emit('init', -1, 0, 0, ds.composition.videoDescriptor.width, ds.composition.videoDescriptor.height);
      this.pgOpen = true;
    }

    const op = compositionObjectOp(pts, cobj, object, palette, ds.composition.paletteUpdateFlag);
    if (op) this.deps.onOverlay(op);
    return true;
  }

  private emit(cmd: OverlayCmd, pts: number, x = 0, y = 0, w = 0, h = 0): void {
    this.deps.onOverlay({ cmd, pts, x, y, w, h });
  }
}
