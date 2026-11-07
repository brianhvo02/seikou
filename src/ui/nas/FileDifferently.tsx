import { useId, useState, type ReactElement } from 'react';
import type { DiscRef } from '@seikou/nas/nas-api';
import type { NasClient } from './nas-client';
import { DiscCard, type FilingDisc } from './UnsortedScreen';

/** What the owner's "File differently…" needs (ruling F3): the client, whether TMDB is searchable, and the refresh. */
export interface OwnerFiling {
  readonly nas: NasClient;
  readonly tmdb: boolean;
  /** An owner change altered the catalogue: the library fetches its titles again. */
  readonly onChanged: () => void;
}

/** A filed disc as the filing card takes it: no reason, no suggestions, alone in its folder as far as the card knows. */
export function filingDisc(ref: DiscRef): FilingDisc {
  return { discId: ref.discId, path: `${ref.root}/${ref.folder}`, discTitles: [], reason: null, suggestions: [], catalogueNumber: null, groupSize: 1 };
}

/**
 * The owner's "File differently…" on a filed or music disc (ruling F3): it opens the filing card Unsorted uses, to file
 * the disc under another title or season, move it into or out of Music, or leave it out with "Don't list".
 */
export function FileDifferently({ owner, disc, label }: { owner: OwnerFiling; disc: DiscRef; label: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <div className="owner-refile">
      <button type="button" className="title-link" data-testid="disc-refile" aria-expanded={open} aria-controls={panel} aria-label={`File ${label} differently`} onClick={() => setOpen((o) => !o)}>
        File differently…
      </button>
      {open && (
        <div id={panel}>
          <DiscCard
            nas={owner.nas}
            tmdb={owner.tmdb}
            disc={filingDisc(disc)}
            onFiled={() => {
              setOpen(false);
              owner.onChanged();
            }}
            onCreated={owner.onChanged}
          />
        </div>
      )}
    </div>
  );
}
