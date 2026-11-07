import { describe, expect, it } from 'vitest';
import { sharperPoster } from './sources';

// Every URL here is made up.

const ANILIST = 'https://s4.anilist.co/file/anilistcdn/media/anime/cover';
const TMDB = 'https://image.tmdb.org/t/p';

describe('sharperPoster', () => {
  it("moves AniList's stored cover files up a size: small to medium, medium to large", () => {
    expect(sharperPoster({ small: `${ANILIST}/small/bx990001-AbCdEf.jpg`, large: `${ANILIST}/medium/bx990001-AbCdEf.jpg` })).toEqual({
      small: `${ANILIST}/medium/bx990001-AbCdEf.jpg`,
      large: `${ANILIST}/large/bx990001-AbCdEf.jpg`,
    });
  });

  it("moves TMDB's w185 and w500 to w342 and w780", () => {
    expect(sharperPoster({ small: `${TMDB}/w185/pStarfall.jpg`, large: `${TMDB}/w500/pStarfall.jpg` })).toEqual({
      small: `${TMDB}/w342/pStarfall.jpg`,
      large: `${TMDB}/w780/pStarfall.jpg`,
    });
  });

  it('leaves a poster already at the new sizes as the same object, so a second load changes nothing', () => {
    const fresh = { small: `${ANILIST}/medium/bx990001-AbCdEf.jpg`, large: `${ANILIST}/large/bx990001-AbCdEf.jpg` };
    expect(sharperPoster(fresh)).toBe(fresh);
    const tmdb = { small: `${TMDB}/w342/pStarfall.jpg`, large: `${TMDB}/w780/pStarfall.jpg` };
    expect(sharperPoster(tmdb)).toBe(tmdb);
  });

  it('leaves other hosts, and look-alike paths elsewhere in a URL, alone', () => {
    const other = { small: 'https://example.com/cover/small/x.jpg', large: `https://example.com${TMDB.slice(8)}/w500/x.jpg` };
    expect(sharperPoster(other)).toBe(other);
  });
});
