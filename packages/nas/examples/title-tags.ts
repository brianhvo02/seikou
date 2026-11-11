// SPDX-License-Identifier: LGPL-3.0-or-later
// The tags that name a title, ready to write into an MKV; titleFromTags reads them back.
import { titleFromTags, titleTags } from '@seikou/nas';

export default async function example(): Promise<void> {
  const title = { source: 'tmdb-tv', tmdbId: 990002, season: 2 } as const;

  const tags = titleTags(title);
  console.log(tags);
  const back = titleFromTags(tags);
  if (tags.SEIKOU_TITLE !== 'tmdb-tv:990002' || tags.SEASON !== '2' || back?.source !== 'tmdb-tv' || back.season !== 2) throw new Error('the tags do not name the title');
}
