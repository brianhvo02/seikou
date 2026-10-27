import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const BASE = 'https://nas.example.com/bluray/api/';
/** The one setting with no default. */
const REQUIRED = { PUBLIC_BASE: BASE };

describe('loadConfig', () => {
  it('reads roots, data dir and port', () => {
    expect(loadConfig({ LIBRARY_ROOTS: 'media0=/library/media0, media2=/library/media2', DATA_DIR: '/d', PORT: '4192', PUBLIC_BASE: BASE })).toEqual({
      roots: [
        { name: 'media0', dir: '/library/media0' },
        { name: 'media2', dir: '/library/media2' },
      ],
      dataDir: '/d',
      port: 4192,
      nightlyScanAt: { hour: 4, minute: 0 },
      scanPauseMs: 10,
      publicBase: BASE,
      appUrl: 'https://bluray.pages.dev/',
      lookupContact: null,
      trustedProxy: null,
      tmdbApiKey: null,
      discogsToken: null,
      titleLibrary: 'owners',
      rtc: { port: 47998 },
      levels: { backend: 'qsv', cacheBytes: 50_000_000_000, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' },
      fansubs: { seadexUrl: 'https://seadex.moe', toshoFeedUrl: 'https://feed.animetosho.net', toshoUrl: 'https://animetosho.net', windowEnd: { hour: 8, minute: 0 }, storeBytes: 20_000_000_000, cacheBytes: 5_000_000_000, picksBytes: 2_000_000_000 },
    });
  });

  it('defaults to no roots, /data and port 8080 when unset', () => {
    expect(loadConfig({ PUBLIC_BASE: BASE })).toEqual({
      roots: [],
      dataDir: '/data',
      port: 8080,
      nightlyScanAt: { hour: 4, minute: 0 },
      scanPauseMs: 10,
      publicBase: BASE,
      appUrl: 'https://bluray.pages.dev/',
      lookupContact: null,
      trustedProxy: null,
      tmdbApiKey: null,
      discogsToken: null,
      titleLibrary: 'owners',
      rtc: { port: 47998 },
      levels: { backend: 'qsv', cacheBytes: 50_000_000_000, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' },
      fansubs: { seadexUrl: 'https://seadex.moe', toshoFeedUrl: 'https://feed.animetosho.net', toshoUrl: 'https://animetosho.net', windowEnd: { hour: 8, minute: 0 }, storeBytes: 20_000_000_000, cacheBytes: 5_000_000_000, picksBytes: 2_000_000_000 },
    });
  });

  it.each(['media0', '=/library/media0', 'media0=', 'media0=/a,=/b'])('rejects the malformed LIBRARY_ROOTS %j', (value) => {
    expect(() => loadConfig({ ...REQUIRED, LIBRARY_ROOTS: value })).toThrow(/LIBRARY_ROOTS entry ".*" is not name=dir/);
  });

  it('rejects duplicate root names', () => {
    expect(() => loadConfig({ ...REQUIRED, LIBRARY_ROOTS: 'media0=/a,media0=/b' })).toThrow('LIBRARY_ROOTS names "media0" twice');
  });

  it('reads TMDB_API_KEY and TITLE_LIBRARY', () => {
    expect(loadConfig({ ...REQUIRED, TMDB_API_KEY: 'k123', TITLE_LIBRARY: 'everyone' })).toMatchObject({ tmdbApiKey: 'k123', titleLibrary: 'everyone' });
    expect(loadConfig({ ...REQUIRED, TMDB_API_KEY: '', TITLE_LIBRARY: 'owners' })).toMatchObject({ tmdbApiKey: null, titleLibrary: 'owners' });
    expect(() => loadConfig({ ...REQUIRED, TITLE_LIBRARY: 'all' })).toThrow('TITLE_LIBRARY "all" is not owners or everyone');
  });

  it('reads DISCOGS_TOKEN, null when empty', () => {
    expect(loadConfig({ ...REQUIRED, DISCOGS_TOKEN: ' d-tok ' }).discogsToken).toBe('d-tok');
    expect(loadConfig({ ...REQUIRED, DISCOGS_TOKEN: '' }).discogsToken).toBeNull();
  });

  it('reads NIGHTLY_SCAN_AT and SCAN_PAUSE_MS', () => {
    const c = loadConfig({ ...REQUIRED, NIGHTLY_SCAN_AT: '3:30', SCAN_PAUSE_MS: '0' });
    expect(c.nightlyScanAt).toEqual({ hour: 3, minute: 30 });
    expect(c.scanPauseMs).toBe(0);
  });

  it.each(['', '24:00', '4', '04:60', 'ab:cd'])('rejects NIGHTLY_SCAN_AT=%j', (value) => {
    expect(() => loadConfig({ ...REQUIRED, NIGHTLY_SCAN_AT: value })).toThrow(`NIGHTLY_SCAN_AT "${value}" is not HH:MM`);
  });

  it.each(['', '-1', '1.5', 'x'])('rejects SCAN_PAUSE_MS=%j', (value) => {
    expect(() => loadConfig({ ...REQUIRED, SCAN_PAUSE_MS: value })).toThrow('is not a number of milliseconds');
  });

  it.each(['', 'abc', '80x', '-1', '1.5', '65536'])('rejects PORT=%j', (value) => {
    expect(() => loadConfig({ ...REQUIRED, PORT: value })).toThrow(`PORT "${value}" is not a port number`);
  });

  it('reads PUBLIC_BASE', () => {
    expect(loadConfig({ PUBLIC_BASE: 'http://localhost:4192/api/' }).publicBase).toBe('http://localhost:4192/api/');
  });

  it.each(['nas/api', 'ftp://nas/api/'])('rejects PUBLIC_BASE=%j', (value) => {
    expect(() => loadConfig({ PUBLIC_BASE: value })).toThrow(`PUBLIC_BASE "${value}" is not an http(s) URL`);
  });

  it('reads TRUSTED_PROXY', () => {
    expect(loadConfig({ ...REQUIRED, TRUSTED_PROXY: '172.18.0.2' }).trustedProxy).toBe('172.18.0.2');
  });

  it('trusts no proxy when TRUSTED_PROXY is unset or empty', () => {
    expect(loadConfig(REQUIRED).trustedProxy).toBeNull();
    expect(loadConfig({ ...REQUIRED, TRUSTED_PROXY: '' }).trustedProxy).toBeNull();
    expect(loadConfig({ ...REQUIRED, TRUSTED_PROXY: 'caddy' }).trustedProxy).toBe('caddy');
  });

  it.each(['a b', 'caddy,evil'])('rejects TRUSTED_PROXY=%j', (value) => {
    expect(() => loadConfig({ ...REQUIRED, TRUSTED_PROXY: value })).toThrow(`TRUSTED_PROXY "${value}" is not an IP or hostname`);
  });

  it('reads RENDEZVOUS_URL, treating unset or empty as no rendezvous', () => {
    expect(loadConfig({ ...REQUIRED, RENDEZVOUS_URL: 'https://bluray-rendezvous.example.workers.dev' }).rendezvousUrl).toBe(
      'https://bluray-rendezvous.example.workers.dev',
    );
    expect(loadConfig(REQUIRED).rendezvousUrl).toBeUndefined();
    expect(loadConfig({ ...REQUIRED, RENDEZVOUS_URL: '' }).rendezvousUrl).toBeUndefined();
  });

  it.each(['rendezvous', 'ftp://r.example/'])('rejects RENDEZVOUS_URL=%j', (value) => {
    expect(() => loadConfig({ ...REQUIRED, RENDEZVOUS_URL: value })).toThrow(`RENDEZVOUS_URL "${value}" is not an http(s) URL`);
  });

  it('parses a root group written name=dir@group', () => {
    const { roots } = loadConfig({ ...REQUIRED, LIBRARY_ROOTS: 'media0=/a,media0-dl=/b@Downloads' });
    expect(roots).toEqual([{ name: 'media0', dir: '/a' }, { name: 'media0-dl', dir: '/b', group: 'Downloads' }]);
  });

  it('rejects a group named like a root', () => {
    expect(() => loadConfig({ ...REQUIRED, LIBRARY_ROOTS: 'media0=/a,media1=/b@media0' })).toThrow('group "media0" is also a root name');
  });

  it('reads RTC_PORT, RTC_LAN_ADDRESS and RTC_ADVERTISE', () => {
    expect(loadConfig(REQUIRED).rtc).toEqual({ port: 47998 });
    expect(loadConfig({ ...REQUIRED, RTC_PORT: '47990', RTC_LAN_ADDRESS: '192.168.1.20', RTC_ADVERTISE: '127.0.0.1, 192.0.2.4' }).rtc).toEqual({
      port: 47990,
      lanAddress: '192.168.1.20',
      advertise: ['127.0.0.1', '192.0.2.4'],
    });
    expect(() => loadConfig({ ...REQUIRED, RTC_PORT: '0' })).toThrow('RTC_PORT');
    expect(() => loadConfig({ ...REQUIRED, RTC_PORT: '65535' })).toThrow('RTC_PORT');
    expect(() => loadConfig({ ...REQUIRED, RTC_LAN_ADDRESS: '172.18.0.2' })).toThrow('RTC_LAN_ADDRESS');
    expect(() => loadConfig({ ...REQUIRED, RTC_ADVERTISE: '100.100.1.1' })).toThrow('RTC_ADVERTISE');
    expect(() => loadConfig({ ...REQUIRED, RTC_LAN_ADDRESS: 'nas.local' })).toThrow('RTC_LAN_ADDRESS');
    expect(() => loadConfig({ ...REQUIRED, RTC_LAN_ADDRESS: '127.0.0.1' })).toThrow('RTC_LAN_ADDRESS');
    expect(loadConfig({ ...REQUIRED, RTC_LAN_ADDRESS: '10.0.0.8' }).rtc.lanAddress).toBe('10.0.0.8');
  });

  it('reads the quality levels’ encoder settings', () => {
    expect(loadConfig({ ...REQUIRED, LEVELS_BACKEND: 'x264', TRANSCODE_CACHE_BYTES: '1000000', FFMPEG_PATH: '/usr/lib/jellyfin-ffmpeg/ffmpeg', FFPROBE_PATH: '/usr/lib/jellyfin-ffmpeg/ffprobe' }).levels).toEqual({
      backend: 'x264',
      cacheBytes: 1_000_000,
      ffmpegPath: '/usr/lib/jellyfin-ffmpeg/ffmpeg',
      ffprobePath: '/usr/lib/jellyfin-ffmpeg/ffprobe',
    });
    expect(loadConfig({ ...REQUIRED, LEVELS_BACKEND: 'off' }).levels.backend).toBe('off');
    expect(loadConfig({ ...REQUIRED, LEVELS_BACKEND: '' }).levels.backend).toBe('qsv');
    expect(() => loadConfig({ ...REQUIRED, LEVELS_BACKEND: 'nvenc' })).toThrow('LEVELS_BACKEND "nvenc" is not qsv, x264 or off');
    expect(() => loadConfig({ ...REQUIRED, TRANSCODE_CACHE_BYTES: '50GB' })).toThrow('TRANSCODE_CACHE_BYTES');
  });

  it('reads the fansub settings', () => {
    expect(loadConfig({ ...REQUIRED, FANSUB_WINDOW_END: '07:30', FANSUB_STORE_BYTES: '100', FANSUB_CACHE_BYTES: '200', FANSUB_PICKS_BYTES: '300', SEADEX_URL: 'http://127.0.0.1:4193/seadex', TOSHO_FEED_URL: 'http://localhost:4193/feed', TOSHO_URL: 'https://tosho.example.org' }).fansubs).toEqual({
      seadexUrl: 'http://127.0.0.1:4193/seadex',
      toshoFeedUrl: 'http://localhost:4193/feed',
      toshoUrl: 'https://tosho.example.org',
      windowEnd: { hour: 7, minute: 30 },
      storeBytes: 100,
      cacheBytes: 200,
      picksBytes: 300,
    });
    expect(() => loadConfig({ ...REQUIRED, FANSUB_WINDOW_END: '25:00' })).toThrow('FANSUB_WINDOW_END');
    expect(() => loadConfig({ ...REQUIRED, FANSUB_STORE_BYTES: '20GB' })).toThrow('FANSUB_STORE_BYTES');
    expect(() => loadConfig({ ...REQUIRED, FANSUB_CACHE_BYTES: 'x' })).toThrow('FANSUB_CACHE_BYTES');
    expect(() => loadConfig({ ...REQUIRED, FANSUB_PICKS_BYTES: '2GB' })).toThrow('FANSUB_PICKS_BYTES');
  });

  it.each(['SEADEX_URL', 'TOSHO_FEED_URL', 'TOSHO_URL'])('refuses an http base for %s unless it is loopback', (name) => {
    expect(() => loadConfig({ ...REQUIRED, [name]: 'http://example.com' })).toThrow(name);
    expect(() => loadConfig({ ...REQUIRED, [name]: 'nope' })).toThrow(name);
    expect(loadConfig({ ...REQUIRED, [name]: 'http://127.0.0.1:1/x' })).toBeTruthy();
  });

  it('requires PUBLIC_BASE', () => {
    const message = "PUBLIC_BASE is not set: the server's HTTPS API base as devices reach it, e.g. https://nas.example.com/bluray/api/";
    expect(() => loadConfig({})).toThrow(message);
    expect(() => loadConfig({ PUBLIC_BASE: '' })).toThrow(message);
  });

  it('defaults APP_URL to the hosted app and keeps a trailing slash', () => {
    expect(loadConfig(REQUIRED).appUrl).toBe('https://bluray.pages.dev/');
    expect(loadConfig({ ...REQUIRED, APP_URL: '' }).appUrl).toBe('https://bluray.pages.dev/');
    expect(loadConfig({ ...REQUIRED, APP_URL: 'https://player.example.org' }).appUrl).toBe('https://player.example.org/');
    expect(loadConfig({ ...REQUIRED, APP_URL: 'https://player.example.org/app/' }).appUrl).toBe('https://player.example.org/app/');
    expect(() => loadConfig({ ...REQUIRED, APP_URL: 'nope' })).toThrow('APP_URL "nope" is not an http(s) URL');
  });

  it('refuses an APP_URL with a query or a fragment, since pairing links append ?pair= to it', () => {
    expect(() => loadConfig({ ...REQUIRED, APP_URL: 'https://player.example.org/?x=1' })).toThrow(/APP_URL .* query or fragment/);
    expect(() => loadConfig({ ...REQUIRED, APP_URL: 'https://player.example.org/#top' })).toThrow(/APP_URL .* query or fragment/);
    expect(() => loadConfig({ ...REQUIRED, APP_URL: 'https://player.example.org/?' })).toThrow(/APP_URL .* query or fragment/);
  });

  it('rejects a LOOKUP_CONTACT a header cannot carry', () => {
    for (const bad of ['mé@example.com', 'a\nb', '連絡先']) expect(() => loadConfig({ ...REQUIRED, LOOKUP_CONTACT: bad })).toThrow('LOOKUP_CONTACT must be printable ASCII');
  });

  it('reads LOOKUP_CONTACT, null when unset or empty', () => {
    expect(loadConfig(REQUIRED).lookupContact).toBeNull();
    expect(loadConfig({ ...REQUIRED, LOOKUP_CONTACT: ' ' }).lookupContact).toBeNull();
    expect(loadConfig({ ...REQUIRED, LOOKUP_CONTACT: ' me@example.com ' }).lookupContact).toBe('me@example.com');
  });
});
