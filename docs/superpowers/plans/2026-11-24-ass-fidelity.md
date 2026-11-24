# ASS fidelity: plan

Spec: `docs/superpowers/specs/2026-11-24-ass-fidelity-design.md`. Each task: failing test first, then the port, then
`npx vitest run packages/ass`, the fixture's golden through `npm run ass-trace:golden`, `npm run test:ass`, commit.

## Task 1: `\be` box blur

- Files: `packages/ass/src/raster.ts` (+ `raster.test.ts`), `fixtures/ass/be/` (`be.ass`, `times.txt`),
  `tests/ass-trace/golden/be*`.
- Interface: `export function beBlur(mask: Uint8Array, w: number, h: number, be: number): void` (in place).
- Tests: one pass on a single pixel of 255 gives the `[1 2 1]²/16` stencil truncated; two passes go through the
  0..64 scaling; zero `be` leaves the mask alone; a 1-px-wide mask is left alone (the C requires width, height > 1).
- `buildMasks`: Gaussian without the `\be` term, then `beBlur` where `ass_composite_construct` calls `ass_synth_blur`.

## Task 2: BorderStyle 4

- Files: `packages/ass/src/raster.ts` (`backgroundBox`, `renderEvent`), `raster.test.ts`, `fixtures/ass/border-style-4/`.
- Interface: `export function backgroundBox(ev: FrameEvent, frame): { x, y, w, h, color } | null`.
- Tests: box from the pre-collision event box, widened by positive shadows only, clamped to the frame, null when empty,
  colour faded.

## Task 3: legacy `Effect`

- Files: `packages/ass/src/state.ts` (flags, fields, `applyTransitionEffects`), `layout.ts` (`alignLines`, placement,
  clip), `frame.ts` if needed; tests in `layout.test.ts`/a new `effect.test.ts`; `fixtures/ass/effect/`.
- Tests: parsing (`Banner;5`, `Banner;5;1`, `Scroll up;100;500;10`, swapped y0/y1, missing fields ignored, unknown
  effect ignored), delay truncation, collisions off, WrapStyle 2 for Banner, placement at a given time.

## Task 4: vertical `@font`

- Files: `packages/ass/src/font-tables.ts` (vertical metrics, glyph id from `cmap`), `fonts.ts` (expose on the face),
  `layout.ts` (advance), `raster.ts` (`drawGlyph` rotation and boxes); tests in `font-tables.test.ts`, `layout.test.ts`;
  `fixtures/ass/vertical/`.
- Tests: `vmtx` advance by glyph, OS/2 fallback, `hhea` fallback; rotated glyph's box.

## Task 5: docs

- `docs/known-issues.md` (ASS section), `docs/roadmap.md` row, `CLAUDE.md` if behaviour text changes, `packages/ass/NOTICE`
  function lists in headers, report.
