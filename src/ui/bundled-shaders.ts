/** Shader files that ship with the app, fetched only when a mode that uses them is applied. */
export interface BundledShaders {
  /** The file names (such as `Anime4K_Restore_CNN_M.glsl`) that can be loaded. */
  readonly names: ReadonlySet<string>;
  /** Fetches one bundled file's text. */
  load(name: string): Promise<string>;
}

/**
 * Anime4K's shaders (`./anime4k/shaders/`, see the README there) as build asset URLs. `no-inline` keeps even the small
 * files out of the bundle as data URLs, so nothing is downloaded until a mode is picked; the service worker caches what
 * was fetched for offline use.
 */
const ANIME4K_URLS: Readonly<Record<string, string>> = import.meta.glob<string>('./anime4k/shaders/*.glsl', {
  query: '?url&no-inline',
  import: 'default',
  eager: true,
});

/** A stalled fetch fails after this long, so the shader queue behind it is freed. */
const FETCH_TIMEOUT_MS = 15_000;

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * The bundled Anime4K shaders. `load(name)` fetches the file on first use (`fetchFn` is injectable for tests; each fetch is
 * aborted after 15 s) and rejects with a plain error for a name that is not bundled or a non-2xx answer.
 */
export function bundledAnime4k(fetchFn: (url: string, signal: AbortSignal) => Promise<Response> = (url, signal) => fetch(url, { signal })): BundledShaders {
  const urls = new Map(Object.entries(ANIME4K_URLS).map(([path, url]) => [baseName(path), url]));
  return {
    names: new Set(urls.keys()),
    async load(name) {
      const url = urls.get(name);
      if (url === undefined) throw new Error(`${name} is not bundled`);
      const response = await fetchFn(url, AbortSignal.timeout(FETCH_TIMEOUT_MS));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
  };
}
