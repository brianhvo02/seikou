// SPDX-License-Identifier: LGPL-3.0-or-later
// Keep a viewer's own subtitle picks within a byte budget, with fonts pooled by content.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PickStore } from '@seikou/fansubs';

type Pick = Parameters<PickStore['put']>[0];

export default async function example(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'seikou-picks-'));
  try {
    let clock = Date.parse('2026-11-01T12:00:00Z');
    const pick = (id: string): Pick => ({
      id, pick: true, name: 'Group A · Full', language: 'en', offsetMs: 0, fileName: 'track.ass', fileSize: 0, fonts: [],
      attachment: { kind: 'chapter', discKey: 'd.disc-a', playlistId: '00001', chapter: 0 }, uploadedAt: clock,
      source: { kind: 'fansub', group: 'Group A', tracker: 'Nyaa', rank: 'best', toshoFileId: 7001, track: 0, trackName: 'Full', alignment: { kind: 'original' }, linedUpOn: { discKey: 'd.disc-a', playlistId: '00001' } },
    });

    // #region construct
    const store = new PickStore(dir, { maxBytes: 1_000_000, now: () => clock, building: () => false });
    // #endregion

    // #region put
    const id = '00000000000000a1';
    const kept = store.put(pick(id), Buffer.from('[Script Info]\n'), new Map([['Glass-Sans.ttf', Buffer.from('not a real font')]]));
    console.log(kept.fileSize, kept.fonts.map((f) => f.name + ' ' + f.hash?.slice(0, 8)));
    // #endregion
    if (kept.fileSize !== 14 || kept.fonts[0]?.hash === undefined) throw new Error('the pick was not kept');

    // #region get
    console.log(store.get(id)?.subtitle.name, store.get('00000000000000ff'));
    // #endregion
    if (store.get(id)?.subtitle.name !== 'Group A · Full' || store.get('00000000000000ff') !== null) throw new Error('the pick is not found by id');

    // #region filePath
    const file = store.filePath(id);
    console.log(file && readFileSync(file, 'utf8').trim());
    // #endregion
    if (!file || readFileSync(file, 'utf8') !== '[Script Info]\n') throw new Error('the file is wrong');

    // #region fontPath
    const font = store.fontPath(id, 'Glass-Sans.ttf');
    console.log(font && readFileSync(font, 'utf8'), store.fontPath(id, 'Missing.ttf'));
    // #endregion
    if (!font || readFileSync(font, 'utf8') !== 'not a real font' || store.fontPath(id, 'Missing.ttf') !== null) throw new Error('the font is wrong');

    // #region touch
    clock += 2 * 3_600_000; // a use more than an hour later is noted, keeping the pick another 30 days
    store.touch(id);
    console.log('last used', new Date(store.get(id)!.usedAt).toISOString());
    // #endregion
    if (store.get(id)!.usedAt !== clock) throw new Error('the use was not noted');

    // #region sweep
    clock += 31 * 86_400_000; // unused for 30 days
    store.sweep();
    console.log('after the sweep:', store.get(id));
    // #endregion
    if (store.get(id) !== null) throw new Error('an old pick survived the sweep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
