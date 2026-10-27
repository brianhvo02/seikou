import { useEffect, useState, type ReactElement } from 'react';
import type { ContinueItem } from '../../engine/disc/nas-api';
import type { NasClient } from './nas-client';
import type { NasHistory } from './nas-history';
import { Poster } from './Poster';
import { continueCard } from './resume-model';
import { nameLang } from '../name-lang';

interface ContinueRowProps {
  readonly nas: NasClient;
  readonly history: NasHistory;
}

/** The name of a card's disc, for a card whose title the NAS doesn't name (asked only for those). */
function useDiscName(nas: NasClient, item: ContinueItem): string | null {
  const [name, setName] = useState<string | null>(null);
  const needed = item.titleName === null;
  useEffect(() => {
    if (!needed) return;
    let live = true;
    nas.resolveDisc(item.discKey).then(
      (disc) => live && setName(disc?.name ?? null),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [nas, item.discKey, needed]);
  return name;
}

function ContinueCard({ nas, item, onOpen }: { readonly nas: NasClient; readonly item: ContinueItem; readonly onOpen: (item: ContinueItem) => void }): ReactElement {
  const card = continueCard(item, useDiscName(nas, item));
  return (
    <li>
      <button
        type="button"
        className="continue-card"
        data-testid="continue-card"
        data-kind={item.kind}
        data-disc-key={item.discKey}
        data-playlist={item.playlistId}
        onClick={() => onOpen(item)}
      >
        <span className="continue-art">
          <Poster nas={nas} artId={item.poster} name={card.title} size="small" className="continue-poster" />
          {card.percent !== null && (
            <span className="continue-progress" aria-hidden="true">
              <i style={{ width: `${card.percent}%` }} />
            </span>
          )}
        </span>
        <span className="continue-title" lang={nameLang(card.title)}>
          {card.title}
        </span>
        <span className="title-muted continue-line">{card.line}</span>
      </button>
    </li>
  );
}

/**
 * Continue watching (spec 2026-10-20 §6.4–6.6, mockup 1): this person's unfinished places, newest first, and the
 * episode after a finished one. A place resumes without asking; an Up next episode starts from its beginning.
 */
export function ContinueRow({ nas, history }: ContinueRowProps): ReactElement | null {
  const [items, setItems] = useState<readonly ContinueItem[]>([]);
  useEffect(() => {
    let live = true;
    // a NAS without the playback routes, or one that can't be reached, shows no row
    nas.continueWatching().then(
      (list) => live && setItems(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [nas]);
  if (items.length === 0) return null;
  const open = (item: ContinueItem): void =>
    history.push(
      item.kind === 'resume'
        ? { kind: 'play', discKey: item.discKey, playlistId: item.playlistId, timeS: Math.floor(item.timeUs / 1e6), resume: true }
        : { kind: 'play', discKey: `d.${item.discId}`, playlistId: item.playlistId, timeS: null, resume: false },
    );
  return (
    <>
      <h3 className="title-section">Continue watching</h3>
      <ul className="continue-row" data-testid="continue-row">
        {items.map((item) => (
          <ContinueCard key={`${item.discKey}/${item.playlistId}`} nas={nas} item={item} onOpen={open} />
        ))}
      </ul>
    </>
  );
}
