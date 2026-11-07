import type { ParsedName } from './parse-name';

/**
 * Synthetic folder names and disc titles, one or more per naming style in the library (spec §3), with what the parser
 * must read from them. Every title here is made up: the repo is public, and the real listing stays in
 * fixtures/local/library-paths.txt.
 */
export const NAME_CORPUS: readonly { readonly text: string; readonly expected: Partial<ParsedName> }[] = [
  // Japanese release
  { text: '[BDMV][220629][Kumo no Ue no Tenshi][Vol.4]', expected: { candidates: ['Kumo no Ue no Tenshi'], volume: 4, disc: null, bonus: false, music: false } },
  { text: '[BDMV][アニメ][140319] 鋼の城塞 Vol.9 特典DISC', expected: { candidates: ['鋼の城塞'], volume: 9, bonus: true, music: false } },
  { text: '[BDMV][アニメ][赤い森の少女][Vol.1-Vol.12 Fin]', expected: { candidates: ['赤い森の少女'], volume: null } },
  { text: '赤い森の少女 Vol.3', expected: { candidates: ['赤い森の少女'], volume: 3 } },
  { text: '【BDMV】【210414】風車の街 第2期 Vol.1', expected: { candidates: ['風車の街'], season: 2, volume: 1 } },
  { text: '[BDMV][230118] 夜明けの約束 BOX2 Disc3', expected: { candidates: ['夜明けの約束'], box: 2, disc: 3 } },
  { text: '[BDMV] 青い港 [第13話]', expected: { candidates: ['青い港'], episodes: [13, 13] } },
  { text: '[BDMV][190925] 白銀の騎士団 第二期 第三巻 (ABCD-12345)', expected: { candidates: ['白銀の騎士団'], season: 2, volume: 3 } },
  { text: '[BDMV][250101] 雪解けの歌 初回生産限定版 DISC2', expected: { candidates: ['雪解けの歌'], disc: 2 } },

  // The user's tidy layout
  { text: 'Starfall Wanderer (星降りの旅人)', expected: { candidates: ['Starfall Wanderer', '星降りの旅人'], season: null, volume: null } },
  { text: 'Volume 2', expected: { candidates: [], volume: 2 } },
  { text: 'Season 3', expected: { candidates: [], season: 3 } },
  { text: 'Disc 7', expected: { candidates: [], disc: 7 } },
  { text: '[Bonus] Volume 3', expected: { candidates: [], volume: 3, bonus: true } },
  { text: 'Paper Lanterns (紙灯籠) (2024)', expected: { candidates: ['Paper Lanterns', '紙灯籠'], year: 2024 } },

  // Disc titles (bdmt di:name)
  { text: '月影の教室 2nd Season VOL.1', expected: { candidates: ['月影の教室'], season: 2, volume: 1 } },
  { text: '盤上の風 第8巻 DISC2', expected: { candidates: ['盤上の風'], volume: 8, disc: 2 } },
  { text: 'Silent Archive Act.2 下巻', expected: { volume: 2 } },
  { text: 'Silent Archive 上巻', expected: { candidates: ['Silent Archive'], volume: 1 } },
  { text: '星降りの旅人 2', expected: { candidates: ['星降りの旅人', '星降りの旅人 2'], volume: 2 } },
  { text: 'Orbit Patrol: The Long Watch Season 2 Disc 2', expected: { candidates: ['Orbit Patrol: The Long Watch'], season: 2, disc: 2 } },
  { text: 'IRONWOOD Blu-ray Box Season3 Disc3', expected: { candidates: ['IRONWOOD'], season: 3, disc: 3 } },

  // Scene
  { text: 'Ink.and.Iron.S05.1080p.JPN.Blu-ray.AVC.LPCM.2.0-GRP', expected: { candidates: ['Ink and Iron'], season: 5, year: null } },
  { text: 'Lantern.Road.2025.2160p.USA.UHD.Blu-ray.HEVC-GRP', expected: { candidates: ['Lantern Road'], year: 2025 } },
  { text: 'Quiet.Harbor.S02E05.1080p.Blu-ray.REMUX.AVC.FLAC.2.0-GRP', expected: { candidates: ['Quiet Harbor'], season: 2, music: false } },
  { text: 'Crimson.Gale.Fleet.Vol.3.1080p.BluRay.AVC-GRP', expected: { candidates: ['Crimson Gale Fleet'], volume: 3 } },
  { text: 'BDROM_22', expected: { candidates: [], disc: null } },

  // Loose
  { text: 'RIVERSIDE S02 VOL.2', expected: { candidates: ['RIVERSIDE'], season: 2, volume: 2 } },
  { text: 'BD', expected: { candidates: [] } },
  { text: '遠い空の色', expected: { candidates: ['遠い空の色'] } },
  { text: 'Harbor Quake 8.0', expected: { candidates: ['Harbor Quake 8.0'], volume: null } },
  { text: 'Spirit Blade Season 14 - The Long Night (266-316)', expected: { candidates: ['Spirit Blade'], season: 14, episodes: [266, 316] } },
  { text: 'Night Courier D3', expected: { candidates: ['Night Courier'], disc: 3 } },
  { text: 'Night Courier VOL_3', expected: { candidates: ['Night Courier'], volume: 3 } },
  { text: '灯台守 第2シリーズ', expected: { candidates: ['灯台守'], season: 2 } },
  { text: 'Moss Garden Box 02', expected: { candidates: ['Moss Garden'], box: 2 } },

  // Bonus discs
  { text: '潮騒の島 映像特典', expected: { candidates: ['潮騒の島'], bonus: true } },
  { text: 'Reading&Live Event', expected: { bonus: true } },

  // Music
  { text: '[2025.03.26] 架空バンド - Morning Signal [CD][FLAC+CUE+LOG+BK+BDMV][XXCL-1234~5]', expected: { candidates: ['架空バンド - Morning Signal'], music: true } },
  { text: '[2024.11.06] Paper Kite Orchestra - Blue Hours [FLAC][BDMV]', expected: { candidates: ['Paper Kite Orchestra - Blue Hours'], music: true } },

  // Full-width and mixed-script numbers (Review Focus 4)
  { text: '風車の街 第２期', expected: { candidates: ['風車の街'], season: 2 } },
  { text: 'Ｖｏｌ．３', expected: { candidates: [], volume: 3 } },
  { text: '盤上の風 ＤＩＳＣ２', expected: { candidates: ['盤上の風'], disc: 2 } },
  { text: '夜明けの約束（よあけのやくそく）　第８巻', expected: { candidates: ['夜明けの約束', 'よあけのやくそく'], volume: 8 } },

  // Review round 1: when unsure, an empty candidate or a null number, never a wrong one
  // bonus words only in brackets, as `Live Event`, or next to Bonus/特典 (ruling T3b)
  { text: 'Starlight Live!', expected: { candidates: ['Starlight Live!'], bonus: false } },
  { text: 'Event Horizon', expected: { candidates: ['Event Horizon'], bonus: false } },
  { text: 'Foo Live', expected: { candidates: ['Foo Live'], bonus: false } },
  { text: 'Foo [Live Blu-ray]', expected: { candidates: ['Foo'], bonus: true } },
  { text: 'Foo Bonus Live', expected: { candidates: ['Foo'], bonus: true } },
  { text: 'Foo Live特典', expected: { bonus: true } },
  // release tokens that are also words keep the title
  { text: 'Fin and Feather', expected: { candidates: ['Fin and Feather'] } },
  { text: 'Iso Tribe', expected: { candidates: ['Iso Tribe'] } },
  { text: 'The Box Vol.1', expected: { candidates: ['The Box'], volume: 1 } },
  { text: 'Foo.Bar.ITA.1080p.BluRay.AVC-GRP', expected: { candidates: ['Foo Bar'] } },
  { text: 'Foo Bar BD-BOX', expected: { candidates: ['Foo Bar'] } },
  // ranges name a box or series folder
  { text: 'Season 1-3', expected: { candidates: [], season: null } },
  { text: 'Foo S01-S03', expected: { candidates: ['Foo'], season: null } },
  { text: 'Foo Disc 1-3', expected: { candidates: ['Foo'], disc: null } },
  { text: 'Foo D1-D3', expected: { candidates: ['Foo'], disc: null } },
  // the scene year is the last year-like token before the release tags, 1900 to next year
  { text: 'Glass.Orchard.2049.1080p.BluRay-GRP', expected: { candidates: ['Glass Orchard 2049'], year: null } },
  { text: 'Glass.Orchard.2049.2017.1080p.BluRay-GRP', expected: { candidates: ['Glass Orchard 2049'], year: 2017 } },
  // nesting-aware groups; group tags and lone tags are not candidates
  { text: '[BDMV][Foo [Bar] Baz][Vol.2]', expected: { candidates: ['Foo'], volume: 2 } },
  { text: 'Foo (Bar (Baz)) Vol.1', expected: { candidates: ['Foo', 'Bar'], volume: 1 } },
  { text: '[GRP]', expected: { candidates: [] } },
  { text: '[SubGroup]', expected: { candidates: [] } },
  { text: '[GRP] Foo - 05 [1080p]', expected: { candidates: ['Foo'], episodes: [5, 5] } },
  { text: '[GRP][Foo Bar][Vol.1]', expected: { candidates: ['Foo Bar'], volume: 1 } },
  // generic disc labels
  { text: 'BDROM', expected: { candidates: [] } },
  { text: 'BD_VIDEO', expected: { candidates: [] } },
  { text: 'BD_ROM', expected: { candidates: [] } },
  { text: 'VIDEO_TS', expected: { candidates: [] } },
  { text: 'DISC', expected: { candidates: [], disc: null } },
  { text: 'DISC_2', expected: { candidates: [], disc: 2 } },
  { text: '01', expected: { candidates: [] } },
  // episodes, parts and cours
  { text: 'Foo S01E05', expected: { candidates: ['Foo'], season: 1, episodes: [5, 5] } },
  { text: 'Foo Season 2 Part 2', expected: { candidates: ['Foo Part 2'], season: 2 } },
  { text: 'Foo 2nd Cour', expected: { candidates: ['Foo 2nd Cour'], season: null } },
  { text: 'Foo Part 2', expected: { candidates: ['Foo Part 2'], season: null } },
  // numeric parens, all-caps labels, two volumes at once
  { text: 'Foo (1)', expected: { candidates: ['Foo'] } },
  { text: 'ABC_TITLE_3_1', expected: { candidates: ['ABC TITLE'], season: null, volume: null, disc: null, episodes: null } },
  { text: 'Silent Archive 上巻 下巻', expected: { candidates: ['Silent Archive'], volume: null } },

  // Re-review: a tag group next to a tag-word, years after a dash, bonus-only brackets, episode ranges
  { text: 'BOX [BDMV] Foo', expected: { candidates: ['Foo'] } },
  { text: 'Fin [BDMV] Foo', expected: { candidates: ['Foo'] } },
  { text: 'BD [BDMV] Foo', expected: { candidates: ['Foo'] } },
  { text: '4K [BDMV] Foo Bar', expected: { candidates: ['Foo Bar'] } },
  { text: 'ISO [BDMV]', expected: { candidates: [] } },
  { text: 'DVD (Foo)', expected: { candidates: ['Foo'] } },
  { text: 'Foo Live 2019 [BDMV]', expected: { candidates: ['Foo Live'], year: 2019, bonus: false } },
  { text: 'BD Foo Vol.2', expected: { candidates: ['BD Foo', 'Foo'], volume: 2 } },
  { text: 'Foo - 2019', expected: { candidates: ['Foo'], year: 2019, episodes: null } },
  { text: 'Foo Bar - 2020 [1080p]', expected: { candidates: ['Foo Bar'], year: 2020, episodes: null } },
  { text: 'Foo - 05', expected: { candidates: ['Foo'], episodes: [5, 5] } },
  { text: 'Foo - 7', expected: { candidates: ['Foo - 7'], episodes: null } },
  { text: '[BDMV][Live Event][Foo]', expected: { candidates: ['Foo'], bonus: true } },
  { text: '[BDMV][Event][Foo]', expected: { candidates: ['Foo'], bonus: true } },
  { text: '[BDMV][Foo][Live]', expected: { candidates: ['Foo'], bonus: true } },
  { text: '[BDMV][Foo][Bonus]', expected: { candidates: ['Foo'], bonus: true } },
  { text: '[BDMV][特典][Foo]', expected: { candidates: ['Foo'], bonus: true } },
  { text: 'Foo S01E05-E08', expected: { candidates: ['Foo'], season: 1, episodes: [5, 8] } },
  { text: 'Foo S2E05-E06', expected: { candidates: ['Foo'], season: 2, episodes: [5, 6] } },

  // Re-review 2: a leading format word is a tag only when the name has another tag (T3e); disc names have no ` - NN`
  // episode, and a single digit is never one (T3f); a reversed range is null
  { text: 'ISO Station 7', expected: { candidates: ['ISO Station 7'] } },
  { text: 'DVD Club', expected: { candidates: ['DVD Club'] } },
  { text: 'BD Wars', expected: { candidates: ['BD Wars'] } },
  { text: '4K Dreams', expected: { candidates: ['4K Dreams'] } },
  { text: 'DVD Club [BDMV]', expected: { candidates: ['DVD Club', 'Club'] } },
  { text: 'BD Wars Vol.2', expected: { candidates: ['BD Wars', 'Wars'], volume: 2 } },
  { text: '4K.Dreams.2160p.UHD.Blu-ray.HEVC-GRP', expected: { candidates: ['4K Dreams', 'Dreams'] } },
  { text: 'Foo - 1 [BDMV]', expected: { episodes: null } },
  { text: 'Foo - 05 [BDMV]', expected: { candidates: ['Foo'], episodes: null } },
  { text: 'Foo Vol.2 Bar - 05', expected: { candidates: ['Foo'], volume: 2, episodes: null } },
  { text: 'Foo Vol.2 - 05', expected: { volume: null, episodes: null } }, // could be the range Vol.2-5
  { text: 'Foo - 05 [1080p]', expected: { candidates: ['Foo'], episodes: [5, 5] } },
  { text: 'Foo S01E08-E05', expected: { candidates: ['Foo'], season: 1, episodes: null } },
  { text: 'Foo 第8話-第5話', expected: { candidates: ['Foo'], episodes: null } },
  { text: 'Foo (316-266)', expected: { candidates: ['Foo'], episodes: null } },

  // Tuning round 2 (ruling M6): Japanese years, region and language tags, scene years in brackets
  { text: '[2013年製作][BDISO]『星降りの旅人』', expected: { candidates: ['『星降りの旅人』'], year: 2013 } },
  { text: '[2013年] 星降りの旅人', expected: { candidates: ['星降りの旅人'], year: 2013 } },
  { text: '星降りの旅人 (2013年)', expected: { candidates: ['星降りの旅人'], year: 2013 } },
  { text: '星降りの旅人 2013年', expected: { candidates: ['星降りの旅人'], year: 2013 } },
  { text: '1999年の夏休み', expected: { candidates: ['1999年の夏休み'], year: null } },
  { text: '星降りの旅人 (1850年)', expected: { year: null } },
  { text: '[BDMV][Brasswick_2006][US]', expected: { candidates: ['Brasswick', 'Brasswick 2006'], year: 2006 } },
  { text: '[BDMV][Brasswick.2006][JP]', expected: { candidates: ['Brasswick', 'Brasswick 2006'], year: 2006 } },
  { text: 'Brasswick_2006', expected: { candidates: ['Brasswick', 'Brasswick 2006'], year: 2006 } },
  { text: 'Brasswick.2006', expected: { candidates: ['Brasswick', 'Brasswick 2006'], year: 2006 } },
  // round 2 review (W5): a year run into a title is part of it, and a year out of range is never cut
  { text: '星の海2020年', expected: { candidates: ['星の海2020年'], year: null } },
  { text: '未来都市2050年', expected: { candidates: ['未来都市2050年'], year: null } },
  { text: '未来都市 2050年', expected: { candidates: ['未来都市 2050年'], year: null } },
  { text: '星の海 2020年', expected: { candidates: ['星の海'], year: 2020 } },
  { text: '[BDMV][Harbor Line][Vol.2][JPN]', expected: { candidates: ['Harbor Line'], volume: 2 } },
  { text: 'Glass Orchard [UK]', expected: { candidates: ['Glass Orchard'] } },
  { text: 'Glass Orchard (HK)', expected: { candidates: ['Glass Orchard'] } },
  { text: 'Glass Orchard [EU] [TW]', expected: { candidates: ['Glass Orchard'] } },
  { text: '[KOR+ENG] Glass Orchard', expected: { candidates: ['Glass Orchard'] } },
];
