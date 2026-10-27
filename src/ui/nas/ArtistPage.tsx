import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { TitleDetail, TitleSummary } from '../../engine/disc/nas-api';
import { artistCount, artistSections, releaseName, releaseYear, type ArtistGroup } from './artist-model';
import { ArtistCollage } from './ArtistGrid';
import type { NasClient } from './nas-client';
import { MusicRefile, MusicReleaseMenu, RenameForm, SetArtistForm, type ReleaseAction } from './MusicReleaseMenu';
import { Poster } from './Poster';
import { nameLang } from '../name-lang';

export interface MusicOwner {
  readonly tmdb: boolean;
  /** The names the Set artist picker suggests. */
  readonly artists: readonly string[];
  /** A correction changed the catalogue: the library fetches its titles again. */
  readonly onChanged: () => void;
  readonly loadDetail: (id: string) => Promise<TitleDetail>;
}

interface ArtistPageProps {
  readonly nas: NasClient;
  readonly group: ArtistGroup;
  readonly onBack: () => void;
  /** Opens a release: the pre-flight of its one disc, or its title page when it has more (spec call C5). */
  readonly onOpen: (title: TitleSummary) => void;
  /** Owners get the "⋯" menu on every release. */
  readonly owner?: MusicOwner;
}

const SECTIONS = [
  { id: 'concerts', label: 'Concerts' },
  { id: 'albums', label: 'Albums & singles' },
  { id: 'other', label: 'Other' },
] as const;

/** An artist's page (spec §3): the name, the other-script name, the count, then the releases in sections. */
export function ArtistPage({ nas, group, onBack, onOpen, owner }: ArtistPageProps): ReactElement {
  const sections = artistSections(group);
  const [editing, setEditing] = useState<{ id: string; action: ReleaseAction } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** After a form is saved or cancelled, focus goes back to that release's "⋯" button. */
  const focusMenu = useRef<string | null>(null);
  const pageRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusMenu.current === null) return;
    const el = pageRef.current?.querySelector<HTMLElement>(`[data-menu-id="${CSS.escape(focusMenu.current)}"]`);
    if (!el) return;
    focusMenu.current = null;
    el.focus();
  });
  const closeForm = (id: string, changed: boolean): void => {
    focusMenu.current = id;
    setEditing(null);
    if (changed) owner?.onChanged();
  };

  const form = (t: TitleSummary): ReactElement | null => {
    if (!owner || editing === null || editing.id !== t.id) return null;
    const done = { onDone: () => closeForm(t.id, true), onCancel: () => closeForm(t.id, false) };
    return (
      <div className="music-owner-panel" data-testid="music-owner-panel" data-title-id={t.id}>
        <h4 className="music-owner-heading">{releaseName(t)}</h4>
        {editing.action === 'rename' && <RenameForm nas={nas} title={t} {...done} />}
        {editing.action === 'artist' && <SetArtistForm nas={nas} title={t} artists={owner.artists} {...done} />}
        {editing.action === 'refile' && (
          <>
            <MusicRefile nas={nas} tmdb={owner.tmdb} title={t} loadDetail={owner.loadDetail} onChanged={() => closeForm(t.id, true)} />
            <button type="button" className="title-link" onClick={done.onCancel}>
              Cancel
            </button>
          </>
        )}
      </div>
    );
  };

  return (
    <section className="titles artist-page" data-testid="artist-page" data-artist-id={group.id} ref={pageRef}>
      <button type="button" className="title-back" aria-label="Back to Music" onClick={onBack}>
        <span aria-hidden="true">‹</span>
      </button>
      <div className="artist-head">
        <ArtistCollage nas={nas} group={group} className="artist-head-art" />
        <div className="series-names">
          <h2 data-testid="artist-name" tabIndex={-1} data-focus-heading="" lang={nameLang(group.name)}>
            {group.name}
          </h2>
          {group.otherName && (
            <span className="title-muted" lang="ja" data-testid="artist-other-name">
              {group.otherName}
            </span>
          )}
          <span className="series-meta">{artistCount(group)}</span>
        </div>
      </div>
      {error && (
        <p className="owner-message" role="alert">
          {error}
        </p>
      )}
      {SECTIONS.map(({ id, label }) => {
        const releases = sections[id];
        if (releases.length === 0) return null;
        const open = releases.find((t) => t.id === editing?.id);
        return (
          <div key={id} className="artist-section" data-testid="artist-section" data-section={id}>
            <h3 className="title-section">{label}</h3>
            <ul className="title-grid music-release-grid">
              {releases.map((t) => (
                <ReleaseCard
                  key={t.id}
                  nas={nas}
                  title={t}
                  onOpen={onOpen}
                  menu={
                    owner ? (
                      <MusicReleaseMenu
                        nas={nas}
                        title={t}
                        onAction={(action) => {
                          setError(null);
                          setEditing({ id: t.id, action });
                        }}
                        onChanged={owner.onChanged}
                        onError={setError}
                      />
                    ) : null
                  }
                />
              ))}
            </ul>
            {open && form(open)}
          </div>
        );
      })}
    </section>
  );
}

function ReleaseCard({ nas, title, onOpen, menu }: { nas: NasClient; title: TitleSummary; onOpen: (t: TitleSummary) => void; menu: ReactElement | null }): ReactElement {
  const name = releaseName(title);
  const year = releaseYear(title);
  return (
    <li className="music-release" data-testid="music-release" data-title-id={title.id} data-name={name}>
      <button type="button" className="title-card" data-title-id={title.id} onClick={() => onOpen(title)}>
        <Poster nas={nas} artId={title.poster} name={name} size="large" className="title-poster music-cover" />
        <span className="title-card-name music-release-name" lang={nameLang(name)}>
          {name}
        </span>
        {year && <span className="title-muted">{year}</span>}
      </button>
      {menu}
    </li>
  );
}
