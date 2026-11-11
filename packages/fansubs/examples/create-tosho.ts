// SPDX-License-Identifier: LGPL-3.0-or-later
// Look a release up on Anime Tosho by hash, search it and download a track, answered from recorded responses.
import { Pacer } from '@seikou/titles';
import { createTosho } from '@seikou/fansubs';

export default async function example(): Promise<void> {
  const release = {
    id: 990501, title: '[Group A] Starfall Wanderer (BD 1080p)', info_hash: 'a'.repeat(40), status: 'complete', is_seadex: true, timestamp: 1_700_000_000,
    files: [{ id: 7001, filename: '[Group A] Starfall Wanderer - 01.mkv', size: 500_000_000, attachments: [
      { type: 'subtitle', url: 'https://storage.animetosho.net/attach/7001/track0.ass.xz', info: { format: 'ASS', language_code: 'eng', name: 'Full', default: true } },
      { type: 'font', url: 'https://storage.animetosho.net/attach/7001/font.ttf' },
    ] }],
  };
  const recorded: typeof fetch = async (url) => {
    const u = new URL(String(url));
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (u.hostname === 'storage.animetosho.net') return new Response('made-up track bytes');
    if (u.searchParams.get('show') === 'torrent') return json(u.searchParams.get('btih') === 'a'.repeat(40) ? release : { error: 'not_found' });
    return json([release]);
  };
  const tosho = createTosho(recorded, new Pacer(2, 1_000), 'seikou-example/1.0', { feed: 'https://feed.animetosho.net', site: 'https://animetosho.net' });

  const found = await tosho.byHash('a'.repeat(40));
  const track = found?.files[0]?.tracks[0];
  console.log(found?.title, track?.language, track?.format, 'font pack:', tosho.fontPackUrl(7001));
  if (found?.isSeadex !== true || found.files[0]?.tracks.length !== 1 || track?.language !== 'eng') throw new Error('the release was misread');

  const results = await tosho.search('starfall wanderer');
  if (results.length !== 1 || results[0]!.files.length !== 0) throw new Error('a search result carries files');
  if ((await tosho.byHash('b'.repeat(40))) !== null) throw new Error('an unknown hash had a release');

  const bytes = await tosho.download(track!.url);
  if (bytes.toString() !== 'made-up track bytes') throw new Error('the download is wrong');
}
