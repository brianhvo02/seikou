/**
 * Pairing links: `?pair=<code>`, with `nas=<the server's HTTPS API base>` (redeemed there, no
 * lookup) or `rv=<a rendezvous Worker's base URL>` (looked up and signalled through it). Pure.
 */

/** A pairing link's code and the server or Worker it names, each already checked by `allowedPairUrl`. */
export interface PairLink {
  readonly code: string;
  readonly nas?: string;
  readonly rv?: string;
  /** The parameters the link carried whose address isn't allowed: the link is not to be used then. */
  readonly dropped?: readonly ('nas' | 'rv')[];
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether `hostname` (as `URL.hostname` gives it) is this machine. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}

/**
 * `raw` as an address the app may talk to for pairing, or null: an `https:` URL with no user name or password, or, when
 * `dev` (the app itself served from a loopback origin), an `http:` URL of a loopback host. Its query and
 * fragment are dropped.
 */
export function allowedPairUrl(raw: string | null | undefined, o: { readonly dev: boolean }): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  const ok = url.protocol === 'https:' || (o.dev && url.protocol === 'http:' && isLoopbackHost(url.hostname));
  if (!ok) return null;
  url.search = '';
  url.hash = '';
  return url.href;
}

/** A `nas=` base as the client keeps it: ending in '/'. */
const withSlash = (base: string): string => (base.endsWith('/') ? base : `${base}/`);

/**
 * A Worker's base URL as two of them are compared: parsed (so the host is lower case and a default port dropped),
 * without query, fragment or trailing slashes. Something that isn't a URL is only trimmed of spaces and slashes.
 */
export function workerBase(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

/**
 * The pairing link in `url`, or null without `pair`. A `nas` or `rv` that isn't an allowed address is left out and
 * named in `dropped`, so the pair screen refuses the link rather than sending its code to the built-in Worker.
 */
export function parsePairLink(url: URL, o: { readonly dev: boolean }): PairLink | null {
  const code = url.searchParams.get('pair');
  if (code === null) return null;
  const dropped: ('nas' | 'rv')[] = [];
  const checked = (name: 'nas' | 'rv'): string | null => {
    if (!url.searchParams.has(name)) return null;
    const allowed = allowedPairUrl(url.searchParams.get(name), o);
    if (allowed === null) dropped.push(name);
    return allowed;
  };
  const nas = checked('nas');
  const rv = checked('rv');
  return {
    code,
    ...(nas === null ? {} : { nas: withSlash(nas) }),
    ...(rv === null ? {} : { rv: workerBase(rv) }),
    ...(dropped.length === 0 ? {} : { dropped }),
  };
}

/**
 * The hosts a link would have this device talk to besides the app's own Worker, for the confirmation: the `nas`
 * server's, and the `rv` Worker's unless it is the built-in one. Empty when the link names nothing else.
 */
export function foreignHosts(link: Pick<PairLink, 'nas' | 'rv'>, builtIn: string | undefined): string[] {
  const hosts: string[] = [];
  const add = (url: string): void => {
    const host = new URL(url).host;
    if (!hosts.includes(host)) hosts.push(host);
  };
  if (link.nas !== undefined) add(link.nas);
  if (link.rv !== undefined && (builtIn === undefined || workerBase(link.rv) !== workerBase(builtIn))) add(link.rv);
  return hosts;
}
