// SPDX-License-Identifier: LGPL-3.0-or-later
// Unpack an .xz subtitle track, refusing one that grows past a limit.
import { unxz, TooLargeArchive } from '@seikou/fansubs';

// A made-up ASS track, compressed with xz.
const TRACK_XZ = '/Td6WFoAAATm1rRGBMDaAu8EIQEcAAAAAAAAAGlwzbzgAm4BUl0ALZTIy0eJ8uvnJMnF5sIdN9v8aSQ6ASzUI5IMe99RKt2L4z8QVDAKZ49pIT1NgJw7RDkAM1K7DZcyHMQJJj36nMmg7L1D+Z/VAvccA0QOk5WMOsPj37YzBym9LoBr7GClB5EbPhvCaQHADwdQubogVU4xlsjniD/MPtRIWwBsDnRpYRul9ja8kR/WNk7O1ZqyB0qVxaJBFGYczwcVmO6TDeXKwFz8Y5CI/+LrC8Bcxp0PghCBdae60KJ06eX2HC4lOSXQfDzflGj0q5GkMbd/HTvQdG+Df9x2aNF5AlzJ/9eGtHwoGVTuW1BumOppM3O9iz3mkqVAJGz5zYhyq7/ofNH+jWD6zVv7xeVorfBFP4PU9ojPBnPOk7cF0Aj6fSfuT+pb94S1ty1ezbESpj8wsQO3ujcvsNQT88LcreBKBdPazLtrpV14HkCOmKChtzj6nKAAAACIubN42GY0vwAB9gLvBAAAC4RL87HEZ/sCAAAAAARZWg==';

export default async function example(): Promise<void> {
  const text = (await unxz(Buffer.from(TRACK_XZ, 'base64'), 1024 * 1024)).toString('utf8');
  console.log(text.split('\n').filter((l) => l.startsWith('Dialogue:')));
  if (!text.startsWith('[Script Info]') || !text.includes('The lanterns are lit.')) throw new Error('the track was not unpacked');

  await unxz(Buffer.from(TRACK_XZ, 'base64'), 100).then(
    () => {
      throw new Error('the limit was ignored');
    },
    (error: unknown) => {
      if (!(error instanceof TooLargeArchive)) throw error;
      console.log('refused:', error.message);
    },
  );
}
