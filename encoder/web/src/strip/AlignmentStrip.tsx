// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import type { FansubAlignment, Span } from '../api-types';
import { stripLanes } from './strip-geometry';

/** What the strip draws. Times are milliseconds of episode time. */
export interface AlignmentStripProps {
  /** Where the disc's audio holds speech (the top lane). */
  readonly speech: readonly Span[];
  /** The track's dialogue lines at the release's own timing (the bottom lane, moved by the timing). */
  readonly dialogue: readonly Span[];
  /** The timing the preview uses. */
  readonly alignment: FansubAlignment;
  /** The user's nudge in milliseconds. */
  readonly nudgeMs: number;
  /** The playhead: where the preview is now. */
  readonly atMs: number;
}

/** How much episode time the strip shows either side of the playhead. */
export const STRIP_HALF_SPAN_MS = 15_000;

/** The strip's height in CSS pixels, and where its two lanes sit in it. */
const HEIGHT = 64;
const TOP_LANE = { y: 9, h: 18 };
const BOTTOM_LANE = { y: 37, h: 18 };

/** The palette's tokens (`styles.css`), which a canvas cannot read as CSS variables without a style lookup per frame. */
const ACCENT = '#4d9bff';
const INK = '#e9eff7';
const RULE = '#253a58';

/**
 * The alignment strip: thirty seconds of the episode around the playhead, the disc's speech above and the subtitle
 * lines below, where the found timing and the nudge put them. When the two lanes' blocks sit over each other, the
 * timing is right; a nudge slides the lower lane at once.
 */
export function AlignmentStrip({ speech, dialogue, alignment, nudgeMs, atMs }: AlignmentStripProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [widthPx, setWidthPx] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidthPx(Math.floor(entry.contentRect.width));
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || widthPx === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(widthPx * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, widthPx, HEIGHT);

    const viewFromMs = atMs - STRIP_HALF_SPAN_MS;
    const viewToMs = atMs + STRIP_HALF_SPAN_MS;
    const pxPerMs = widthPx / (viewToMs - viewFromMs);

    // a tick each second, taller each five, so the eye can read how far apart two blocks are
    ctx.fillStyle = RULE;
    for (let s = Math.ceil(viewFromMs / 1000); s * 1000 <= viewToMs; s++) {
      const x = Math.round((s * 1000 - viewFromMs) * pxPerMs);
      const tall = s % 5 === 0;
      ctx.fillRect(x, tall ? 0 : HEIGHT / 2 - 3, 1, tall ? HEIGHT : 6);
    }

    const lanes = stripLanes({ speech, dialogue, alignment, nudgeMs, viewFromMs, viewToMs, widthPx });
    ctx.fillStyle = ACCENT;
    for (const r of lanes.top) ctx.fillRect(r.x, TOP_LANE.y, Math.max(1, r.width), TOP_LANE.h);
    // the lines are outlined over a faint fill, so a line sitting over speech still reads as its own block
    ctx.globalAlpha = 0.28;
    for (const r of lanes.bottom) ctx.fillRect(r.x, BOTTOM_LANE.y, Math.max(1, r.width), BOTTOM_LANE.h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    for (const r of lanes.bottom) ctx.strokeRect(r.x + 0.75, BOTTOM_LANE.y + 0.75, Math.max(0, r.width - 1.5), BOTTOM_LANE.h - 1.5);

    const mid = Math.round(widthPx / 2);
    ctx.fillStyle = INK;
    ctx.fillRect(mid - 1, 0, 2, HEIGHT);
  }, [speech, dialogue, alignment, nudgeMs, atMs, widthPx]);

  return (
    <div className="strip">
      <div className="strip-labels" aria-hidden="true">
        <span>Disc speech</span>
        <span>Subtitle lines</span>
      </div>
      <canvas
        ref={canvasRef}
        className="strip-canvas"
        role="img"
        aria-label="The disc's speech above the subtitle lines, 15 seconds either side of the playhead"
      />
    </div>
  );
}
