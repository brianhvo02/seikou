// SPDX-License-Identifier: LGPL-3.0-or-later
// Keep the owner's choices for discs, their own titles and the library gate in one file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerStore } from '@seikou/titles';

export default async function example(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'seikou-owner-'));
  try {
    // #region construct
    const store = new OwnerStore(dir); // reads and writes <dir>/owner.json
    // #endregion

    // #region gate
    console.log('gate before:', store.gate());
    // #endregion
    // #region setGate
    store.setGate('everyone');
    console.log('gate after:', store.gate());
    // #endregion
    if (store.gate() !== 'everyone') throw new Error('the gate was not kept');

    // #region createTitle
    const title = store.createTitle('series', 'Glass Orchard Chronicles', 2);
    console.log(title.id, title.name, title.seasons);
    // #endregion

    // #region updateTitle
    const renamed = store.updateTitle(title.id, { name: 'Glass Orchard', seasons: 3 });
    console.log(renamed.name, renamed.seasons);
    // #endregion
    if (renamed.name !== 'Glass Orchard' || renamed.seasons !== 3) throw new Error('the title was not updated');

    // #region setChoice
    // File a disc under the title; the fingerprint lets the choice follow the disc if it moves.
    store.setChoice('disc-1', 'FINGERPRINT-A', { kind: 'title', titleId: title.id, season: 1, disc: 1 });
    // #endregion
    // #region setDisplayName
    store.setDisplayName('disc-1', 'Season 1, disc 1');
    // #endregion
    // #region snapshot
    const snapshot = store.snapshot();
    console.log(snapshot.choices.get('disc-1'), snapshot.displayNames.get('disc-1'), snapshot.ownTitles.length);
    // #endregion
    if (snapshot.choices.get('disc-1')?.kind !== 'title' || snapshot.displayNames.get('disc-1') !== 'Season 1, disc 1') throw new Error('the snapshot is missing the choice');

    // #region choiceOrigin
    console.log(store.choiceOrigin('disc-1'), store.choiceOrigin('nobody'));
    // #endregion
    if (store.choiceOrigin('disc-1')?.kind !== 'direct' || store.choiceOrigin('nobody') !== null) throw new Error('the origin is wrong');

    // #region reattach
    // After a scan: a copy of the disc, found under another id with the same fingerprint, takes the same choice.
    store.reattach([{ id: 'disc-1', fingerprint: 'FINGERPRINT-A' }, { id: 'disc-1-copy', fingerprint: 'FINGERPRINT-A' }]);
    console.log(store.choiceOrigin('disc-1-copy'));
    // #endregion
    if (store.snapshot().choices.get('disc-1-copy')?.kind !== 'title') throw new Error('the copy did not follow the choice');

    // #region clearChoice
    store.clearChoice('disc-1'); // the copy follows the source and goes too
    store.reattach([{ id: 'disc-1-copy', fingerprint: 'FINGERPRINT-A' }]);
    // #endregion
    if (store.snapshot().choices.size !== 0) throw new Error('the choice was not cleared');

    // #region deleteTitle
    store.setChoice('disc-2', null, { kind: 'title', titleId: title.id, season: 1, disc: 2 });
    store.deleteTitle(title.id); // discs filed under it return to Unsorted
    console.log(store.snapshot().ownTitles.length, store.snapshot().choices.size);
    // #endregion
    if (store.snapshot().ownTitles.length !== 0 || store.snapshot().choices.size !== 0) throw new Error('the title was not deleted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
