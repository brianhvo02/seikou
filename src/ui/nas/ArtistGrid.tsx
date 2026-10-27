import type { ReactElement } from 'react';
import { artistCount, collagePosters, type ArtistGroup } from './artist-model';
import type { NasClient } from './nas-client';
import { Poster } from './Poster';
import { nameLang } from '../name-lang';

/** An artist's round collage: up to four release covers (one fills the circle), or ♪ with none. */
export function ArtistCollage({ nas, group, className }: { nas: NasClient; group: ArtistGroup; className: string }): ReactElement {
  const posters = collagePosters(group);
  if (posters.length === 0) {
    return (
      <span className={`${className} artist-collage artist-collage-empty`} aria-hidden="true">
        ♪
      </span>
    );
  }
  return (
    <span className={`${className} artist-collage`} data-count={posters.length} aria-hidden="true">
      {posters.map((p) => (
        <Poster key={p} nas={nas} artId={p} name={group.name} size="small" className="artist-collage-cell" />
      ))}
    </span>
  );
}

interface ArtistGridProps {
  readonly nas: NasClient;
  readonly groups: readonly ArtistGroup[];
  readonly onOpen: (artistId: string) => void;
  /** The alphabet bar key each artist is the first of, by its index title's id: where a tap on that key jumps. */
  readonly jumpOf?: ReadonlyMap<string, string>;
}

/** The Music shelf (spec §3, "artists first"): a tile per artist, with its collage, name and release count. */
export function ArtistGrid({ nas, groups, onOpen, jumpOf }: ArtistGridProps): ReactElement {
  return (
    <ul className="artist-grid" data-testid="artist-grid">
      {groups.map((g) => (
        <li key={g.id}>
          <button
            type="button"
            className="artist-tile"
            data-testid="artist-tile"
            data-artist-id={g.id}
            data-name={g.name}
            data-jump={jumpOf?.get(g.index.id)}
            onClick={() => onOpen(g.id)}
          >
            <ArtistCollage nas={nas} group={g} className="artist-tile-art" />
            <span className="artist-tile-name" lang={nameLang(g.name)}>
              {g.name}
            </span>
            {g.otherName && (
              <span className="title-muted artist-tile-other" lang="ja">
                {g.otherName}
              </span>
            )}
            <span className="title-muted" data-testid="artist-count">
              {artistCount(g)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
