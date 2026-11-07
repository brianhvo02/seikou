import { describe, expect, it } from 'vitest';
import { hasConcertWord, parseMusicFolder } from './music-name';

describe('parseMusicFolder', () => {
  it('reads a dated artist - title folder and strips the rip tags', () => {
    expect(parseMusicFolder('[2021.06.02] Lantern Parade - Night Lights [CD][FLAC+CUE+LOG+BK+BDMV][ZQCL-2468~9]')).toEqual({ date: '2021-06-02', artist: 'Lantern Parade', title: 'Night Lights', single: false });
  });
  it('drops edition notes and accepts en and em dashes', () => {
    expect(parseMusicFolder('[2020.01.15] 星野あおい – 3分29秒 [期間生産限定盤] [CD][FLAC+CUE+LOG+BK+BDMV][ZQCL-1000]')).toMatchObject({ artist: '星野あおい', title: '3分29秒' });
    expect(parseMusicFolder('Neon Harbor — Tidelines (2019)')).toMatchObject({ artist: 'Neon Harbor', title: 'Tidelines', date: '2019' });
  });
  it('marks a single', () => {
    expect(parseMusicFolder('Neon Harbor - Freedom (Single) Some Show OP2').single).toBe(true);
  });
  it('parses a folder with no separator', () => {
    expect(parseMusicFolder('Paper Lanterns Hall Concert 2018 [ZQCL-3000]')).toEqual({ date: null, artist: null, title: 'Paper Lanterns Hall Concert 2018', single: false });
  });
  it('reads dashed dates and keeps other parentheses', () => {
    expect(parseMusicFolder('[2018-03-07] Neon Harbor - Tidelines (Deluxe)')).toEqual({ date: '2018-03-07', artist: 'Neon Harbor', title: 'Tidelines (Deluxe)', single: false });
  });
  it('drops a trailing .iso from a release named by its ISO file', () => {
    expect(parseMusicFolder('Lantern Parade - Night Lights [ZQCL-2468].iso')).toEqual({ date: null, artist: 'Lantern Parade', title: 'Night Lights', single: false });
    expect(parseMusicFolder('Paper Lanterns Hall Concert 2018.ISO')).toMatchObject({ artist: null, title: 'Paper Lanterns Hall Concert 2018' });
  });
});

describe('hasConcertWord', () => {
  it.each(['Blue Hour TOUR 2023', 'Live at the Hall', 'Hall Concert', '十周年記念公演', 'ライブ2020', 'ツアー', 'コンサート'])('finds %s', (t) => expect(hasConcertWord(t)).toBe(true));
  it.each(['Deliver', 'Olive Garden', 'Tourmaline'])('not %s', (t) => expect(hasConcertWord(t)).toBe(false));
});
