# Plan: HDR overlays at graphics white

Spec: `docs/superpowers/specs/2026-11-24-hdr-overlays-design.md`. TDD, one commit per task.

1. **Colour maths** — `packages/engine/src/render/hdr-overlay.ts` (+ test): `pqEotf`, `hlgDisplayLuminance`,
   `GRAPHICS_WHITE_NITS`, `DEFAULT_SDR_WHITE_NITS`, `graphicsWhiteGain`, `srgbDecode`/`srgbEncode` (extended,
   sign-preserving), `scalePremultiplied`, `clampGain`. Tests on known values.
2. **Presenter** — `packages/engine/src/render/hdr-presenter.ts` (+ test with fake GPU objects): `HdrOverlayPresenter`
   interface, `createWebGpuHdrPresenter(canvas, gpu, onLost)` answering `{ presenter } | { reason }`; WGSL shader that
   mirrors `scalePremultiplied`.
3. **Compositor** — `render/compositor.ts` (+ tests): `setHdrPresenter`, `startPlaylist`'s `element.hdr`, `present`;
   the layer canvas as drawing target in HDR overlay mode; clear the HDR canvas on leaving it.
4. **Protocol and player** — `protocol.ts` (`attachHdrCanvas`, `setDisplayHdr`, `Telemetry.hdrOverlay`),
   `player.ts` (`PlayerDeps.createHdrPresenter`, lazy creation at an HDR element session on an HDR display,
   `present()` after a paint that drew, lost device), `worker-main.ts` default deps; player tests with fakes.
5. **Controller and page** — `PlayerController.attachHdrCanvas(canvas, { gain })` (matchMedia, test flag
   `displayHdr`), its example region and `public-api` (method only, no new export), `PlayerScreen.tsx` second canvas
   and CSS, `?hdrgain=` and `?displayhdr=1` in the app; controller unit test.
6. **E2E** — `tests/e2e/hdr-overlay.spec.ts` (Chromium: the route on with `?displayhdr=1`, off without).
7. **Device check** — iPhone 17 Pro probe (done during design), and screenshots if an HTTPS origin the phone trusts is
   available.
8. **Docs** — CLAUDE.md element path paragraph and test flags, known-issues entry rewritten, roadmap row, help page
   where HDR is described; full verification (`tsc -b`, devsite model, `npm test`, build, Playwright specs touched).
