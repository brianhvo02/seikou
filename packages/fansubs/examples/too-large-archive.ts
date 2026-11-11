// SPDX-License-Identifier: LGPL-3.0-or-later
// The error an archive or download throws when it passes its limit; the message says which limit.
import { TooLargeArchive, unxz } from '@seikou/fansubs';

// A made-up ASS track, compressed with xz.
const TRACK_XZ = '/Td6WFoAAATm1rRGBMDaAu8EIQEcAAAAAAAAAGlwzbzgAm4BUl0ALZTIy0eJ8uvnJMnF5sIdN9v8aSQ6ASzUI5IMe99RKt2L4z8QVDAKZ49pIT1NgJw7RDkAM1K7DZcyHMQJJj36nMmg7L1D+Z/VAvccA0QOk5WMOsPj37YzBym9LoBr7GClB5EbPhvCaQHADwdQubogVU4xlsjniD/MPtRIWwBsDnRpYRul9ja8kR/WNk7O1ZqyB0qVxaJBFGYczwcVmO6TDeXKwFz8Y5CI/+LrC8Bcxp0PghCBdae60KJ06eX2HC4lOSXQfDzflGj0q5GkMbd/HTvQdG+Df9x2aNF5AlzJ/9eGtHwoGVTuW1BumOppM3O9iz3mkqVAJGz5zYhyq7/ofNH+jWD6zVv7xeVorfBFP4PU9ojPBnPOk7cF0Aj6fSfuT+pb94S1ty1ezbESpj8wsQO3ujcvsNQT88LcreBKBdPazLtrpV14HkCOmKChtzj6nKAAAACIubN42GY0vwAB9gLvBAAAC4RL87HEZ/sCAAAAAARZWg==';

export default async function example(): Promise<void> {
  const mine = new TooLargeArchive('more than 10 bytes');
  console.log(mine.name + ':', mine.message);

  try {
    await unxz(Buffer.from(TRACK_XZ, 'base64'), 10);
  } catch (error) {
    if (!(error instanceof TooLargeArchive)) throw error;
    console.log('unpacking stopped at the limit:', error.message);
    return;
  }
  throw new Error('a track over the limit was unpacked');
}
