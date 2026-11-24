# ASS fidelity

Status: design, 2026-11-24 (written unattended; every decision the owner should review is marked *My call*). Roadmap
row "ASS fidelity" (Later); `docs/known-issues.md`, section "ASS subtitles".

## Why

Release MKVs now feed fansub tracks into the subtitle store, so `@seikou/ass` (a function-by-function port of libass
0.17.5) will draw many more real fansub scripts than the one corpus it was checked against. The roadmap row lists the
places where the port still knowingly differs from libass: legacy `Effect`, FriBidi across style runs, line breaking
with libunibreak, FreeType's auto-hinter, and approximations of BorderStyle 4, vertical `@font` and `\be`. This pass
closes the ones real scripts hit, in order of how often they hit, and settles what "matching libass" means for the
others.

## What libass actually does (read from 0.17.5, `4a05d81`, the harness's build)

The harness (`tools/ass-trace/Dockerfile`) builds libass with FreeType, HarfBuzz and FriBidi, without fontconfig and
without libunibreak. Before deciding anything I read what each gap is in that source:

- **`\be`** (`ass_bitmap.c` `ass_synth_blur`, `c/c_be_blur.c`): after the Gaussian, `be` passes of VSFilter's 3×3
  `[1 2 1]` box kernel on the 8-bit mask, with zero outside the bitmap, `>> 4` truncation per pass, and, for more
  than one pass, the mask scaled to 0..64 first and back after (`be_blur_pre`/`be_blur_post`). Our port folds `\be`
  into the Gaussian as a variance of 0.5 px² per pass, which is the kernel's variance but not its integer rounding:
  `\be1` (the most common typesetting tag after `\pos`) leaves a slightly different edge everywhere it is used.
- **BorderStyle 4** (`ass_render.c` `add_background`, `render_text`): a libass extension. One opaque rectangle per
  event in the back colour (`c[3]`, faded), the event's box widened by the shadow offset on each side where the offset
  is positive, clamped to the frame, put first in the event's image list (under everything, not clipped, moved with
  the event by collisions); the event's shadows are not drawn. The border is drawn as in BorderStyle 1. Ours draws no
  box at all (the shadow is already skipped).
- **Legacy `Effect`** (`ass_parse.c` `ass_apply_transition_effects`, `ass_render.c` placement and `align_lines`):
  `Banner;delay[;lefttoright]`, `Scroll up;y0;y1;delay` and `Scroll down;y0;y1;delay` move the event by
  `(now − start) / delay` script pixels, turn off collision detection, `Banner` forces WrapStyle 2 and left alignment
  with the alignment's justification, and the scrolls clip to the `y0..y1` band. Ours ignores the field.
- **Vertical `@font`** (`ass_font.c` `ass_get_glyph_outline`, `ass_shaper.c` metrics): a glyph at or above U+02F1 in
  an `@` family is advanced by the face's vertical advance and its outline is turned a quarter turn (`ass_outline_rotate_90`,
  offset by the vertical advance plus the OS/2 typo descender); HarfBuzz's `vert`/`vkna` features substitute vertical
  forms. Ours flags the glyph (`DECO_ROTATE`), approximates the advance by the font size and draws it unrotated.
- **Line breaking:** libass uses libunibreak only when the player turns on `ASS_FEATURE_WRAP_UNICODE`, which `ass.h`
  documents as "incompatible with VSFilter and disabled by default"; mpv turns it on for subtitles converted from
  other formats, not for ASS scripts. With default features, a libass built *with* libunibreak breaks an ASS script
  exactly as one built without: at spaces, with `\n`/`\N` forced. That is what the harness and our port do.
- **FriBidi across style runs:** by default (`ASS_FEATURE_WHOLE_TEXT_LAYOUT` off) libass runs the bidi algorithm and
  reorders each style run on its own, base direction LTR, and lays the runs out left to right (`ass_shaper_shape`,
  `ass_shaper_reorder`). Reordering across runs happens only with whole-text layout, which libass turns on by itself
  only for `Encoding: -1` (a libass extension, base direction auto). Our port reorders within a run (Chrome's bidi
  inside one `measureText` run), which is the default mode.
- **The auto-hinter:** libass's shaper loads glyph metrics hinted, so faces without TrueType instructions get
  FreeType's auto-hinter (about 1 px per glyph at the 256 px shaping size). Porting the auto-hinter means porting
  `autofit/` (thousands of lines of FreeType) and running it on outlines we never see (the browser rasterizes).

## Goals

1. `\be` drawn as libass draws it: the box passes ported exactly on the masks (the path every static and moving run
   takes).
2. BorderStyle 4 drawn as libass draws it (`add_background`).
3. Legacy `Effect` (`Banner`, `Scroll up`, `Scroll down`) placed, wrapped, aligned and clipped as libass does.
4. Vertical `@font` glyphs advanced and turned as libass turns them, from the face's own vertical metrics (`vhea`/
   `vmtx`, else FreeType's fallback from OS/2 or `hhea`).
5. Line breaking and bidi: confirm (by the reading above, and by a fixture) that the port already matches libass's
   default behaviour, and say so in `docs/known-issues.md` instead of listing them as gaps.
6. New committed fixtures with goldens regenerated through `npm run ass-trace:golden`, each passing `npm run test:ass`.

## Non-goals

- **The auto-hinter.** *(My call: left out — a port of FreeType's `autofit` for a difference of about 1 px across a
  short title, in fonts without TrueType hinting only, is the worst cost-to-gain in the row; it stays in
  known-issues with this reasoning.)*
- **`Encoding: -1` whole-text layout** (bidi and shaping across runs). *(My call: not ported — it is a libass-only
  extension VSFilter can't show, I know of no fansub script that uses it, and a correct port needs FriBidi's paragraph
  algorithm in TypeScript. Recorded in known-issues as the one case where libass reorders across runs.)*
- **libunibreak.** *(My call: not added to the harness and not ported — libass would not use it on an ASS script with
  default features, so adding it to the harness changes no golden and porting it would make us differ from libass.)*
- **HarfBuzz `vert`/`vkna` substitution for `@` fonts.** Our GSUB reader handles ligatures only; vertical forms
  matter mostly for CJK punctuation in fonts that carry them. *(My call: this pass turns and advances glyphs; vertical
  substitution stays a known difference unless time allows, because the committed fonts have no `vert` feature to
  test it against and no open CJK font small enough to commit.)*
- The direct GPU path's `\be`: a run whose shape changes every frame (rotating, scaling) is drawn straight onto GPU
  canvases with the canvas `blur()` filter and never read back. Running the integer box passes there would need a
  read-back per frame. *(My call: keep the Gaussian of variance 0.5 px² per pass there, as today — it is the same
  spread, the run moves every frame, and the frame budget is what that path exists for.)*

## Priority, and why

*(My call: `\be` first, then BorderStyle 4, legacy `Effect`, vertical `@font`.)* `\be1`/`\be2` is in almost every
typeset sign of an anime fansub, so its edge rounding shows on the most frames. BorderStyle 4 is cheap and libass
scripts made for mpv use it for boxed dialogue. Legacy `Effect` is rare in modern fansubs (old SSA karaoke and
credits) but is a small, self-contained port. Vertical `@font` shows in Japanese signs typeset vertically; it needs
new font-table parsing and a rotated draw, so it comes last. Line breaking and bidi need no code (above).

## Design

### `\be` (raster.ts)

- New `beBlur(mask, w, h, be)` in `raster.ts`, ported from `ass_synth_blur`'s box part, `be_blur_pre`, `be_blur_post`
  and `ass_be_blur_c` (sliding sums, `uint16` arithmetic, `>> 4`), operating in place on the run's `Uint8Array` mask.
- `buildMasks` blurs as `ass_composite_construct` does: the Gaussian from `\blur` alone (no `\be` term), then
  `beBlur`, on the fill when there is no border (or for the opaque box) and on the border always.
- The canvas padding stays computed with the `\be` variance included (the box kernel spreads one pixel per pass, but
  the truncation stops it well inside `3σ + 3`; libass's own padding stops at 5 px). The mask cache key keeps `\be`
  (through `sigma`, which still includes it) so a `\be` change never reuses a mask.
- The direct path keeps `sigma` with the `\be` term (non-goal above).

### BorderStyle 4 (raster.ts, frame.ts)

- `renderEvent` adds the `add_background` rectangle when the event's final state has `borderStyle === 4`: from the
  event box before collisions (`box.top − shiftY`), widened by `lround(shadowX × borderScaleX)` and
  `lround(shadowY × borderScaleY)` where those are positive, clamped to the frame (`frameWidth`, `frameHeight`), in
  `c[3]` with the event's fade applied (`applyFade`), drawn first and outside the clip; `drawEvent` already moves the
  whole event by `shiftY`. `renderEvent` needs the frame size, which it already takes.

### Legacy `Effect` (state.ts, layout.ts, collisions via the box)

- `RenderState` gains `scrollDirection`, `scrollShift`, `scrollY0`, `scrollY1` and the flags `EVENT_HSCROLL` (2) and
  `EVENT_VSCROLL` (4). `applyTransitionEffects(s, now)` is ported from `ass_apply_transition_effects` (the `atoi` of
  each `;` field, VSFilter's delay truncation in storage pixels through `layoutRes`) and runs where libass runs it, at
  the end of `init_render_context` (`initRenderState`).
- `alignLines` takes `HALIGN_LEFT` with the alignment's own justification for `EVENT_HSCROLL`; `layoutEvent` places
  x and y as `ass_render_event` does for the scroll flags (after `\pos`, which a scroll overrides on its axis), and
  narrows `clipY0`/`clipY1` to the scroll band for `EVENT_VSCROLL`.

### Vertical `@font` (font-tables.ts, fonts.ts, layout.ts, raster.ts)

- `font-tables.ts` reads `vhea`'s presence and `vmtx` advances, and the OS/2 `sTypoAscender`/`sTypoDescender` and
  `hhea` ascender/descender it may already read, and exposes FreeType's `TT_Get_VMetrics` choice: `vmtx` advance, else
  `|sTypoAscender − sTypoDescender|` when OS/2 is present, else `|hhea.ascender − hhea.descender|`.
- The face's per-glyph vertical advance needs the glyph id; the browser gives no glyph ids, so the port reads `cmap`
  (already parsed for coverage) to map the code point to a glyph and `vmtx` by it. A face without `vmtx` uses the one
  fallback advance for every glyph, as FreeType does.
- `layout.ts` replaces the `fontSize × 64` approximation with that advance scaled to the shaping size, and the draw
  turns the glyph a quarter turn clockwise about libass's offset (`dv = vertAdvance + typoDescender`,
  `offs = (dv, −descender)`), as `ass_outline_rotate_90` does, in `drawGlyph` and the bounding box.

### Line breaking and bidi

No code. A fixture `wrap-cjk` (CJK-free: long unspaced text in DejaVu) is not needed; `fixtures/ass/wrap` already
covers spaces. known-issues' entries are reworded to say the port matches libass's default (VSFilter-compatible)
behaviour and name the two opt-ins libass has (`ASS_FEATURE_WRAP_UNICODE`, whole-text layout / `Encoding: -1`).

## Constraints

- Every ported function keeps `LGPL-2.1-or-later AND ISC` in its file header with the libass functions named there;
  `packages/ass/NOTICE` lists the files (no new files are expected; new functions go in existing ported files).
- No new dependency.
- Goldens only through `npm run ass-trace:golden` (Docker). Existing goldens must not change (the harness is not
  modified).
- Frame budget: `\be` passes run only when a mask is built (cached afterwards); a `\be` run costs O(be × area).
  `tests/e2e/ass-subtitles.spec.ts`'s over-budget share must hold.

## Testing

- Unit tests (Vitest): `beBlur` against hand-computed results of the C kernel (one pass, several passes with
  pre/post scaling, edges); `applyTransitionEffects` parsing and the scroll placement; the BorderStyle 4 rectangle;
  vertical metrics from synthetic `vhea`/`vmtx`/OS/2 tables.
- New fixtures under `fixtures/ass/` (DejaVu only, so no new font licences): `be` (`\be1`, `\be2`, `\be5`, `\be20`
  with and without border, with `\blur`), `border-style-4` (with and without shadow, multi-line, collision-moved,
  faded), `effect` (Banner both ways, Scroll up and down, with times across the movement), `vertical`
  (`@DejaVu Sans` with Latin, Greek and Cyrillic, and a `@` family the face lacks `vmtx` for). Goldens from
  `npm run ass-trace:golden`; `npm run test:ass` (layout trace within 0.5 px and pixels within budget) must pass for
  every fixture, old and new.
- `npx playwright test tests/e2e/ass-subtitles.spec.ts` for the frame budget.
