import { addPlugins, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & {
  readonly __WB_MANIFEST: ReadonlyArray<string | { readonly url: string; readonly revision: string | null }>;
};

/** SharedArrayBuffer (the audio ring) needs cross-origin isolation, online and offline. */
const ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** A copy of `response` carrying the isolation headers. Opaque responses (status 0) cannot be rebuilt. */
function withIsolation(response: Response): Response {
  if (response.status === 0) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** How long a navigation waits for the network before the cached shell is served instead. */
const NAVIGATION_TIMEOUT_MS = 3000;

/**
 * A navigation answer that means the app can't be had from the network: a client or server error status. Opaque
 * redirects (status 0) pass through, so the browser follows them.
 */
function navigationFailed(response: Response): boolean {
  return response.status >= 400;
}

/** The precached app shell, or the network response when the shell is missing. */
async function shellOr(network: Promise<Response>): Promise<Response> {
  const shell = await matchPrecache('/index.html');
  return withIsolation(shell ?? (await network));
}

// Navigations are network-first, so a deploy shows up on the next visit. Offline, when the network answers with an
// error status, or when it takes longer than NAVIGATION_TIMEOUT_MS, they get the cached shell. Registered before the precache route so it wins for '/' too.
// The diagnostics page and the developer pages (/developers, with its own 404) are not precached and must never be answered with the player's shell.
// Disc reads from tools/disc-server (the NAS disc API under `/api/…`, byte ranges, gigabytes) match no route, so they go to the network and
// are never cached; the denylist keeps a navigation to one (opening the API in a tab) from getting the shell too.
registerRoute(
  new NavigationRoute(
    async ({ request }) => {
      const network = fetch(request);
      network.catch(() => undefined); // a late failure after the timeout is not an error
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS);
      });
      try {
        const response = await Promise.race([network, timeout]);
        // an error page from the server, a proxy or a CDN (404, 5xx) is as good as offline: the shell is cached
        if (response && !navigationFailed(response)) return withIsolation(response);
        if (response) return shellOr(Promise.resolve(response));
      } catch {
        // offline: fall through to the shell
      } finally {
        clearTimeout(timer);
      }
      return shellOr(network);
    },
    { denylist: [/^\/probe(\.html)?(\?.*)?$/, /^\/api(\/|\?|$)/, /^\/developers(\/|\?|$)/] },
  ),
);

/** The runtime cache for bundled shader files (Anime4K), which are not precached. */
const SHADER_CACHE = 'bundled-shaders';

/** Vite's name for a built asset, `<name>-<8-character hash>.glsl`, without its hash. */
function shaderKey(pathname: string): string {
  const file = pathname.slice(pathname.lastIndexOf('/') + 1);
  return file.replace(/-[\w-]{8}\.glsl$/, '.glsl');
}

// Bundled shader files are fetched only when a player picks a mode that uses them, so they are left out of the precache
// (see vite.config.ts) and kept here after their first fetch, cache first: their URLs carry a content hash. A newer
// build's copy of a file replaces the older one.
registerRoute(
  ({ url, request }) => request.method === 'GET' && url.origin === self.location.origin && /^\/assets\/[^/]+\.glsl$/.test(url.pathname),
  async ({ request, url }) => {
    const cache = await caches.open(SHADER_CACHE);
    const hit = await cache.match(request);
    if (hit) return withIsolation(hit);
    const response = await fetch(request);
    if (response.ok) {
      const key = shaderKey(url.pathname);
      for (const old of await cache.keys()) {
        if (shaderKey(new URL(old.url).pathname) === key) await cache.delete(old);
      }
      await cache.put(request, response.clone());
    }
    return withIsolation(response);
  },
);

addPlugins([{ handlerWillRespond: async ({ response }) => withIsolation(response) }]);
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('message', (event) => {
  if ((event.data as { type?: unknown } | null)?.type === 'skip-waiting') void self.skipWaiting();
});
