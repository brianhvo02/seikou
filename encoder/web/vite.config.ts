// SPDX-License-Identifier: LGPL-3.0-or-later
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// The subtitle helper page. `npm run encoder:web:build` writes it to encoder/web/dist, which `seikou-encode serve`
// serves; `npm run encoder:web:dev` serves it with hot reload and sends /api to a running `serve` named by
// SEIKOU_ENCODE_API (the address serve printed; open the dev page with serve's token as ?t=).

const root = fileURLToPath(new URL('.', import.meta.url));

/** Seikou's engine needs SharedArrayBuffer, which requires cross-origin isolation. */
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * The isolation headers on every response, 304s too: `server.headers` reaches only full responses, and WebKit
 * refuses a worker whose revalidated script answers 304 without COEP (as in the player's own config).
 */
const isolateEveryResponse: Plugin = {
  name: 'isolate-every-response',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      for (const [name, value] of Object.entries(crossOriginIsolation)) res.setHeader(name, value);
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((_req, res, next) => {
      for (const [name, value] of Object.entries(crossOriginIsolation)) res.setHeader(name, value);
      next();
    });
  },
};

/** The running backend's origin, from SEIKOU_ENCODE_API with any path and token dropped. */
const api = process.env.SEIKOU_ENCODE_API ? new URL(process.env.SEIKOU_ENCODE_API).origin : undefined;

export default defineConfig({
  root,
  plugins: [isolateEveryResponse, react()],
  server: {
    headers: crossOriginIsolation,
    // changeOrigin: the backend accepts only its own 127.0.0.1:<port> as Host.
    proxy: api ? { '/api': { target: api, changeOrigin: true } } : undefined,
  },
  preview: { headers: crossOriginIsolation },
  worker: { format: 'es' },
  build: { outDir: fileURLToPath(new URL('./dist', import.meta.url)), emptyOutDir: true },
});
