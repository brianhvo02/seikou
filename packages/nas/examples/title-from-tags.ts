// SPDX-License-Identifier: LGPL-3.0-or-later
// Find the title an encoded episode belongs to from its MKV tags.
import { titleFromTags } from '@seikou/nas';

export default async function example(): Promise<void> {
  const series = titleFromTags({ SEIKOU_TITLE: 'tmdb-tv:990002', SEASON: '2' });
  const anilist = titleFromTags({ ANILIST_ID: '990001' });
  const missingSeason = titleFromTags({ SEIKOU_TITLE: 'tmdb-tv:990002' }); // a series needs its season
  console.log(series, anilist, missingSeason);

  if (series?.source !== 'tmdb-tv' || series.season !== 2) throw new Error('the series was not read');
  if (anilist?.source !== 'anilist' || anilist.anilistId !== 990001 || missingSeason !== null) throw new Error('the tags were misread');
}
