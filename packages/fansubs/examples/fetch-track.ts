// SPDX-License-Identifier: LGPL-3.0-or-later
// Download a subtitle track through the cache and unpack it, here from a stand-in for Anime Tosho.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pacer } from '@seikou/titles';
import { createTosho, FetchCache, fetchTrack } from '@seikou/fansubs';

// A made-up ASS track, compressed with xz.
const TRACK_XZ = Buffer.from('/Td6WFoAAATm1rRGBMDaAu8EIQEcAAAAAAAAAGlwzbzgAm4BUl0ALZTIy0eJ8uvnJMnF5sIdN9v8aSQ6ASzUI5IMe99RKt2L4z8QVDAKZ49pIT1NgJw7RDkAM1K7DZcyHMQJJj36nMmg7L1D+Z/VAvccA0QOk5WMOsPj37YzBym9LoBr7GClB5EbPhvCaQHADwdQubogVU4xlsjniD/MPtRIWwBsDnRpYRul9ja8kR/WNk7O1ZqyB0qVxaJBFGYczwcVmO6TDeXKwFz8Y5CI/+LrC8Bcxp0PghCBdae60KJ06eX2HC4lOSXQfDzflGj0q5GkMbd/HTvQdG+Df9x2aNF5AlzJ/9eGtHwoGVTuW1BumOppM3O9iz3mkqVAJGz5zYhyq7/ofNH+jWD6zVv7xeVorfBFP4PU9ojPBnPOk7cF0Aj6fSfuT+pb94S1ty1ezbESpj8wsQO3ujcvsNQT88LcreBKBdPazLtrpV14HkCOmKChtzj6nKAAAACIubN42GY0vwAB9gLvBAAAC4RL87HEZ/sCAAAAAARZWg==', 'base64');

export default async function example(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'seikou-track-'));
  try {
    let downloads = 0;
    const recorded: typeof fetch = async () => {
      downloads++;
      return new Response(TRACK_XZ);
    };
    const tosho = createTosho(recorded, new Pacer(2, 1_000), 'seikou-example/1.0', { feed: 'https://feed.animetosho.net', site: 'https://animetosho.net' });
    const cache = new FetchCache(dir, 1024 * 1024);
    const track = { track: 0, language: 'eng', name: 'Full', format: 'ASS', url: 'https://storage.animetosho.net/attach/7001/track0.ass.xz', isDefault: true, forced: false };

    const ass = await fetchTrack(cache, tosho, track, {});
    await fetchTrack(cache, tosho, track, {}); // from the cache
    console.log(ass.split('\n')[0], '| downloads:', downloads);
    if (!ass.includes('The lanterns are lit.') || downloads !== 1) throw new Error('the track was not fetched once and unpacked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
