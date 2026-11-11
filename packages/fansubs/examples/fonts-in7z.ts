// SPDX-License-Identifier: LGPL-3.0-or-later
// List the fonts of a 7z font pack (a made-up one here); files that are not fonts are left out.
import { fontsIn7z } from '@seikou/fansubs';

// A 7z holding Glass-Sans.ttf, Glass-Bold.otf and notes.txt.
const PACK = 'N3q8ryccAARVFGrpwwAAAAAAAAAiAAAAAAAAALTvFYzgBa4AN10ANxvK6iVLhF69ht278EZJNdCLMXKp28/klngW9RjkaGsVlOpRqbWHase1fYB2NqP2Wx9SDnd7qAAAAIEzB64P0ePZhKCQoHdexUAYn+WgpAIp45IKjA2YGZfCnPTtsrqr0q5xZ0UaDJx8etWqba+a1dzCJlxbKWL4Umzjm2wRKUbG5ZZ+M8ezp3A+Hn8GawC/QF4s9IeBmLW9BcTeO6e77RTzNmf3fmgnQwGIxNDl53Fx9CSy8tiFPegAAAAXBj8BCYCEAAcLAQABIwMBAQVdABAAAAyAwgoBJd6R9wAA';

export default async function example(): Promise<void> {
  const fonts = await fontsIn7z(Buffer.from(PACK, 'base64'));
  console.log(fonts.map((f) => f.name + ' (' + f.data.length + ' bytes)').sort());
  if (fonts.map((f) => f.name).sort().join() !== 'Glass-Bold.otf,Glass-Sans.ttf') throw new Error('the fonts were not found');
}
