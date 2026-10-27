import { useId, useMemo, useState, type ReactElement } from 'react';
import type { FansubTitleState, TitleDetail } from '../../engine/disc/nas-api';
import { FansubEpisodePanel } from './FansubEpisodePanel';
import { FansubLine } from './FansubLine';
import type { NasClient } from './nas-client';
import { Poster } from './Poster';
import type { OwnerFiling } from './FileDifferently';
import { DiscList, type OpenDisc } from './SeasonScreen';
import { SubtitleList, useDiscKeys, useManifests, useStoredSubtitles } from './SubtitleList';
import { SubtitleUpload } from './SubtitleUpload';
import { ownerListing, subtitleTarget } from './subtitle-model';
import { displayName, seasonCounts, seasonLabel, secondaryName, titleMeta } from './title-model';
import { nameLang } from '../name-lang';

interface SeriesScreenProps {
  readonly nas: NasClient;
  readonly detail: TitleDetail;
  readonly onBack: () => void;
  readonly onSeason: (seasonId: string) => void;
  /** The title's own extras (no season known). */
  readonly onExtras: () => void;
  /** A related title: a movie or side story of the series. */
  readonly onTitle: (titleId: string) => void;
  readonly onOpen: OpenDisc;
  /** For owners: "File differently…" on a movie's or music title's discs (ruling F3), and a movie's subtitles. */
  readonly owner?: OwnerFiling;
}

/** A title: banner, poster and names, then its seasons, related movies and extras; a movie or music title lists its discs. */
export function SeriesScreen({ nas, detail, onBack, onSeason, onExtras, onTitle, onOpen, owner }: SeriesScreenProps): ReactElement {
  const { title } = detail;
  const name = displayName(title);
  const native = secondaryName(title);
  const romaji = title.names.romaji !== null && title.names.romaji !== name ? title.names.romaji : null;
  const isSeries = title.kind === 'series';
  // A movie's subtitles, for owners: the upload sheet and the list (attached to a disc and chapter).
  const movieOwner = title.kind === 'movie' ? owner : undefined;
  const { subs, error: subsError, reload } = useStoredSubtitles(nas, title.id, movieOwner !== undefined);
  const target = useMemo(() => subtitleTarget(title.id, detail.seasons, { episodes: false, extras: detail.extras }), [title.id, detail.seasons, detail.extras]);
  const manifestOf = useManifests(movieOwner?.nas ?? null);
  const discKeys = useDiscKeys(manifestOf, target, movieOwner !== undefined && (subs ?? []).length > 0);
  const [fansub, setFansub] = useState<FansubTitleState | null>(null);
  const movieFansubs = useMemo(() => (subs ?? []).filter((s) => s.source !== undefined && s.attached !== false), [subs]);
  const [adding, setAdding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadPanel = useId();

  return (
    <section className="titles series-screen" data-testid="series-screen" data-title-id={title.id}>
      <div className="series-banner">
        {detail.banner !== null && <Poster nas={nas} artId={detail.banner} name={name} size="large" className="series-banner-art" />}
        <button type="button" className="title-back on-banner" aria-label="Back" onClick={onBack}>
          <span aria-hidden="true">‹</span>
        </button>
      </div>
      <div className="series-head">
        <Poster nas={nas} artId={title.poster} name={name} size="large" className="series-poster" />
        <div className="series-names">
          <h2 data-testid="series-name" tabIndex={-1} data-focus-heading="" lang={nameLang(name)}>
            {name}
          </h2>
          {romaji && <span className="title-muted">{romaji}</span>}
          {native && native !== romaji && <span className="title-muted" lang="ja">{native}</span>}
          <span className="series-meta">{titleMeta(detail)}</span>
          {movieOwner && (
            <button type="button" className="subtitle-add" data-testid="subtitle-add" aria-expanded={adding} aria-controls={uploadPanel} disabled={uploading} onClick={() => setAdding((a) => !a)}>
              ＋ Subtitles
            </button>
          )}
        </div>
      </div>
      {movieOwner && adding && (
        <div id={uploadPanel}>
          <SubtitleUpload
            nas={movieOwner.nas}
            target={target}
            manifestOf={manifestOf}
            onDone={() => {
              setAdding(false);
              reload();
            }}
            onCancel={() => setAdding(false)}
            onBusy={setUploading}
          />
        </div>
      )}
      {movieOwner && detail.seasons[0] && (
        <>
          <FansubLine nas={movieOwner.nas} titleId={title.id} seasonId={detail.seasons[0].id} onChanged={reload} onState={setFansub} />
          {(movieFansubs.length > 0 || Object.keys(fansub?.episodes ?? {}).length > 0) && (
            <FansubEpisodePanel nas={movieOwner.nas} target={target} manifestOf={manifestOf} tracks={movieFansubs} mark={Object.values(fansub?.episodes ?? {})[0]} onChanged={reload} />
          )}
        </>
      )}
      {isSeries ? (
        <ul className="title-list">
          {detail.seasons.map((s) => {
            const label = seasonLabel(s);
            return (
              <li key={s.id}>
                <button type="button" className="title-row" data-testid="season-row" data-label={label} data-season-id={s.id} onClick={() => onSeason(s.id)}>
                  <Poster nas={nas} artId={title.poster} name={name} size="small" className="title-thumb" />
                  <span className="title-row-text">
                    <span className="title-row-name">{label}</span>
                    {s.label && s.label !== label && s.label !== name && <span className="title-muted">{s.label}</span>}
                    <span className="title-muted">{seasonCounts(s)}</span>
                  </span>
                  <span className="title-chevron" aria-hidden="true">›</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        detail.seasons.map((s) => <DiscList key={s.id} season={s} discs={s.discs} onOpen={onOpen} owner={owner} />)
      )}
      {movieOwner && (subs || subsError) && (
        <SubtitleList nas={movieOwner.nas} target={target} listing={subs ? ownerListing(subs, null, new Set(detail.seasons.map((s) => s.id))) : null} error={subsError} manifestOf={manifestOf} discKeys={discKeys} onChanged={reload} />
      )}
      {detail.related.length > 0 && (
        <ul className="title-list">
          {detail.related.map((r) => (
            <li key={r.id}>
              <button type="button" className="title-row" data-testid="related-row" data-title-id={r.id} onClick={() => onTitle(r.id)}>
                <Poster nas={nas} artId={r.poster} name={displayName(r)} size="small" className="title-thumb" />
                <span className="title-row-text">
                  <span className="title-row-name" lang={nameLang(displayName(r))}>
                    {displayName(r)}
                  </span>
                  <span className="title-muted">{[r.kind === 'movie' ? 'Movie' : r.kind === 'music' ? 'Music' : 'Series', r.year].filter((x) => x !== null).join(' · ')}</span>
                </span>
                <span className="title-chevron" aria-hidden="true">›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail.extras.length > 0 && (
        <button type="button" className="title-row extras-row" data-testid="extras-row" onClick={onExtras}>
          <span className="title-row-text">
            <span className="title-row-name">Extras</span>
            <span className="title-muted">{detail.extras.length === 1 ? '1 disc' : `${detail.extras.length} discs`}</span>
          </span>
          <span className="title-chevron" aria-hidden="true">›</span>
        </button>
      )}
    </section>
  );
}
