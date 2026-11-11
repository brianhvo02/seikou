import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildBdjo } from '../../../tests/helpers/bdjo-builder';
import { ParseError } from './byte-reader';
import { parseBdjo } from './bdjo-parser';

describe('parseBdjo', () => {
  it('reads what the builder wrote', () => {
    const bdjo = parseBdjo(buildBdjo({
      jars: ['00000'],
      apps: [{ controlCode: 1, orgId: 0x7fff0001, appId: 0x4001, name: 'FirstPlayXlet', baseDir: '00000', classpathExtension: '/00001', initialClass: 'bdjweb.test.FirstPlayXlet', params: ['a', 'bc'] }],
      keyInterest: 0xc0000000,
    }));
    expect(bdjo.appCache).toEqual([{ type: 1, refToName: '00000', langCode: '*.*' }]);
    expect(bdjo.accessiblePlaylists).toEqual({ accessToAllFlag: 1, autostartFirstPlaylistFlag: 0, playlists: [] });
    expect(bdjo.apps[0]).toMatchObject({ controlCode: 1, orgId: 0x7fff0001, appId: 0x4001, baseDir: '00000', classpathExtension: '/00001', initialClass: 'bdjweb.test.FirstPlayXlet', params: ['a', 'bc'], names: [{ lang: 'eng', name: 'FirstPlayXlet' }] });
    expect(bdjo.keyInterestTable >>> 0).toBe(0xc0000000);
    expect(bdjo.fileAccessInfo).toBe('.');
  });

  it('reads playlist tables', () => {
    const bdjo = parseBdjo(buildBdjo({ jars: ['00000'], accessToAll: false, playlists: ['00001', '00800'], autostartFirstPlaylist: true, apps: [] }));
    expect(bdjo.accessiblePlaylists).toEqual({ accessToAllFlag: 0, autostartFirstPlaylistFlag: 1, playlists: ['00001', '00800'] });
  });

  it('rejects other signatures and truncated files', () => {
    const bytes = buildBdjo({ jars: [], apps: [] });
    const bad = bytes.slice(); bad[0] = 0x58;
    expect(() => parseBdjo(bad)).toThrow(ParseError);
    expect(() => parseBdjo(bytes.subarray(0, 40))).toThrow(ParseError);
  });

  it.skipIf(!existsSync('fixtures/local/BDJ_DISC_A/BDMV/BDJO/00000.bdjo'))('reads BDJ_DISC_A as the findings describe', () => {
    const bdjo = parseBdjo(readFileSync('fixtures/local/BDJ_DISC_A/BDMV/BDJO/00000.bdjo'));
    expect(bdjo.version).toBe('0300');
    expect(bdjo.appCache.map((c) => c.refToName)).toEqual(['00000', '55555', '44444']);
    expect(bdjo.accessiblePlaylists).toEqual({ accessToAllFlag: 1, autostartFirstPlaylistFlag: 0, playlists: [] });
    expect(bdjo.apps.map((a) => a.initialClass)).toEqual(['com.uni.radius.xlet.MenuXlet', 'com.uni.radius.TitleBoundXlet']);
    expect(bdjo.apps[0]!.classpathExtension).toBe('/55555;/44444');
  });
});
