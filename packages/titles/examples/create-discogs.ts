// SPDX-License-Identifier: LGPL-3.0-or-later
// Look a release up by catalogue number on Discogs, answered from recorded responses for a made-up release.
import { createDiscogs, Pacer } from '@seikou/titles';

export default async function example(): Promise<void> {
  const seen: string[] = [];
  const recorded: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    seen.push(String((init?.headers as Record<string, string>).Authorization));
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/database/search') {
      return json({ results: [{ id: 990501, title: 'Glass Orchard - Paper Lanterns', catno: 'ZZZZ-0001', country: 'Japan', year: '2021', format: ['Blu-ray'] }] });
    }
    return json({
      id: 990501, title: 'Paper Lanterns', released: '2021-06-00', artists: [{ id: 990601, name: 'Glass Orchard (2)' }],
      formats: [{ name: 'Blu-ray', descriptions: [] }], images: [{ type: 'primary', uri: 'https://img.example/c.jpg', uri150: 'https://img.example/c150.jpg' }],
    });
  };
  const discogs = createDiscogs(recorded, new Pacer(50, 60_000), 'made-up-token', 'admin@example.test');

  const release = await discogs.byCatalogue('ZZZZ-0001');
  console.log(release?.id, release?.artists[0]?.name, release?.date);
  // Discogs's " (2)" suffix is dropped, and a day-less date stays a month.
  if (release?.artists[0]?.name !== 'Glass Orchard' || release.date !== '2021-06' || seen[0] !== 'Discogs token=made-up-token') throw new Error('the release was misread');
}
