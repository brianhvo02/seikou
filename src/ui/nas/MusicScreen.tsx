import { useEffect, type ReactElement } from 'react';
import type { TitleSummary } from '@seikou/nas/nas-api';
import type { ArtistGroup } from './artist-model';
import { ArtistGrid } from './ArtistGrid';
import { ArtistPage, type MusicOwner } from './ArtistPage';
import type { NasClient } from './nas-client';

interface MusicScreenProps {
  readonly nas: NasClient;
  /** The Music shelf's artists (or those a search found), in the grid's order. */
  readonly groups: readonly ArtistGroup[];
  /** The artist page shown, or null for the grid. */
  readonly artistId: string | null;
  readonly onOpenArtist: (artistId: string) => void;
  /** Back from an artist page to the shelf. */
  readonly onBack: () => void;
  /** The open artist is no longer on the shelf (a correction moved its last release): back to the shelf. */
  readonly onArtistGone: () => void;
  readonly onOpenRelease: (title: TitleSummary) => void;
  /** The alphabet bar key each artist is the first of, by its index title's id. */
  readonly jumpOf?: ReadonlyMap<string, string>;
  /** Owners get each release's "⋯" menu. */
  readonly owner?: MusicOwner;
  /** Shown on the grid when there are no artists. */
  readonly emptyText?: string;
}

/** The Music shelf (spec §3): the artist grid, or one artist's page. */
export function MusicScreen({ nas, groups, artistId, onOpenArtist, onBack, onArtistGone, onOpenRelease, jumpOf, owner, emptyText }: MusicScreenProps): ReactElement {
  const group = artistId === null ? null : (groups.find((g) => g.id === artistId) ?? null);
  const gone = artistId !== null && group === null;
  useEffect(() => {
    if (gone) onArtistGone();
  }, [gone, onArtistGone]);
  if (artistId !== null) {
    return group ? <ArtistPage nas={nas} group={group} onBack={onBack} onOpen={onOpenRelease} owner={owner} /> : <p className="status">Loading…</p>;
  }
  if (groups.length === 0) return <p className="status">{emptyText ?? 'Nothing here yet.'}</p>;
  return <ArtistGrid nas={nas} groups={groups} onOpen={onOpenArtist} jumpOf={jumpOf} />;
}
