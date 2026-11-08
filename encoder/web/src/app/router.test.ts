// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseRoute, routeHref, type Route } from './router';

const KEY = `f.${'a'.repeat(32)}`;
const ID = '0123456789abcdef';

const routes: readonly Route[] = [
  { kind: 'library' },
  { kind: 'disc', discKey: KEY },
  { kind: 'episodes', discKey: KEY, playlistId: '00800' },
  { kind: 'helper', sessionId: ID },
  { kind: 'settings' },
  { kind: 'test', jobId: 'job-1' },
  { kind: 'queue' },
  { kind: 'job', jobId: 'job-1' },
  { kind: 'queueNew', discKey: KEY, playlistId: '00800', spec: '1-3,4-6', noSubtitles: false },
  { kind: 'queueNew', discKey: KEY, playlistId: '00800', spec: '1-3,4-6', noSubtitles: true },
];

describe('router', () => {
  it('round trips every route and keeps the token', () => {
    for (const route of routes) {
      const href = routeHref(route, '?t=secret');
      const url = new URL(href, 'http://127.0.0.1');
      expect(url.searchParams.get('t')).toBe('secret');
      expect(parseRoute(url.pathname, url.search)).toEqual(route);
    }
  });

  it('keeps no other query than the token and the route own', () => {
    expect(routeHref({ kind: 'library' }, '?t=x&junk=1')).toBe('/?t=x');
    expect(routeHref({ kind: 'library' }, '')).toBe('/');
  });

  it('tells /queue/new from a job named by id', () => {
    expect(parseRoute('/queue/new', `?disc=${KEY}&playlist=00800&spec=1-2`)).toEqual({
      kind: 'queueNew',
      discKey: KEY,
      playlistId: '00800',
      spec: '1-2',
      noSubtitles: false,
    });
    expect(parseRoute('/queue/abc', '')).toEqual({ kind: 'job', jobId: 'abc' });
  });

  it('falls back to not found for paths it does not know, and for /queue/new without its query', () => {
    expect(parseRoute('/nope', '')).toEqual({ kind: 'notFound' });
    expect(parseRoute('/queue/new', '')).toEqual({ kind: 'notFound' });
    expect(parseRoute('/disc/a/b/c', '')).toEqual({ kind: 'notFound' });
    expect(parseRoute('/helper/not-hex', '')).toEqual({ kind: 'notFound' });
  });

  it('accepts a trailing slash', () => {
    expect(parseRoute('/queue/', '')).toEqual({ kind: 'queue' });
  });
});
