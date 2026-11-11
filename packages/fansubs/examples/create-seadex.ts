// SPDX-License-Identifier: LGPL-3.0-or-later
// Ask SeaDex which releases are best for a title, answered from a recorded response for a made-up entry.
import { Pacer } from '@seikou/titles';
import { createSeaDex } from '@seikou/fansubs';

export default async function example(): Promise<void> {
  const recorded: typeof fetch = async (url) => {
    const asked = new URL(String(url)).searchParams.get('filter');
    const items = asked === 'alID=990001'
      ? [{
          alID: 990001, incomplete: false, notes: 'Group A is the best release.',
          expand: { trs: [
            { tracker: 'Nyaa', releaseGroup: 'Group A', isBest: true, dualAudio: false, tags: [], infoHash: 'A'.repeat(40), files: [{ name: 'Starfall Wanderer - 01.mkv', length: 500_000_000 }] },
            { tracker: 'PrivateTracker', releaseGroup: 'Group P', isBest: false, tags: ['Web'], infoHash: '<redacted>', files: [] },
          ] },
        }]
      : [];
    return new Response(JSON.stringify({ items }), { headers: { 'content-type': 'application/json' } });
  };
  const seadex = createSeaDex(recorded, new Pacer(2, 1_000), 'seikou-example/1.0', 'https://releases.example');

  const entry = await seadex.entry(990001);
  console.log(entry?.notes, entry?.releases.map((r) => r.group + ' ' + r.infoHash?.slice(0, 6)));
  if (entry?.releases[0]?.infoHash !== 'a'.repeat(40) || entry.releases[1]?.infoHash !== null) throw new Error('the entry was misread');
  if ((await seadex.entry(1)) !== null) throw new Error('an unknown title had an entry');
}
