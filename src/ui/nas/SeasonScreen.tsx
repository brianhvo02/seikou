import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { DiscRef, DiscSlot, EpisodeRef, FansubTitleState, PlaylistProgress, SeasonDetail, StoredSubtitle } from '../../engine/disc/nas-api';
import { FansubEpisodePanel } from './FansubEpisodePanel';
import { FansubLine } from './FansubLine';
import { episodeMark, trackChip } from './fansub-model';
import { FileDifferently, type OwnerFiling } from './FileDifferently';
import type { NasClient } from './nas-client';
import { episodeProgress } from './resume-model';
import { SubtitleList, useDiscKeys, useManifests, useStoredSubtitles } from './SubtitleList';
import { SubtitleUpload } from './SubtitleUpload';
import { languageTag, ownerListing, subtitleTarget, tagsByEpisode } from './subtitle-model';
import type { PreflightDisc } from './Preflight';
import { copiesLabel, discHeading, episodeMeta } from './title-model';
import { nameLang } from '../name-lang';

/** Opens a disc's pre-flight, at an episode's playlist when one is given. */
export type OpenDisc = (disc: PreflightDisc, playlistId?: string) => void;

const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A title's disc as the pre-flight shows it: its display name or folder name; its size comes from the manifest. */
export function preflightDisc(ref: DiscRef): PreflightDisc {
  return { id: ref.discId, name: ref.displayName ?? lastSegment(ref.folder), kind: ref.folder.toLowerCase().endsWith('.iso') ? 'iso' : 'folder', sizeBytes: null };
}

interface DiscListProps {
  readonly season: SeasonDetail;
  readonly discs: readonly DiscSlot[];
  readonly onOpen: OpenDisc;
  /** For owners: "File differently…" on each copy (ruling F3). */
  readonly owner?: OwnerFiling;
}

/**
 * Disc cards: the disc and its episodes, how many copies, then one line per copy (drive and folder) that opens it, and
 * for owners a way to file that copy differently.
 */
export function DiscList({ season, discs, onOpen, owner }: DiscListProps): ReactElement {
  return (
    <ul className="title-list">
      {discs.map((d, i) => {
        const copies = copiesLabel(d);
        return (
          <li key={`${d.label}:${i}`} className="disc-card" data-testid="disc-card">
            <div className="disc-card-head">
              <span className="title-row-name">{discHeading(season, d)}</span>
              {copies && <span className="title-muted">{copies}</span>}
            </div>
            {d.copies.map((c) => {
              const copy = (
                <button key={c.discId} type="button" className="disc-copy" data-testid="disc-copy" onClick={() => onOpen(preflightDisc(c))}>
                  <span className="disc-copy-drive">{c.root}</span>
                  <span className="disc-copy-folder" lang={nameLang(c.folder)}>
                    {c.folder}
                  </span>
                </button>
              );
              if (!owner) return copy;
              return (
                <div key={c.discId} className="disc-copy-owned">
                  {copy}
                  <FileDifferently owner={owner} disc={c} label={c.displayName ?? lastSegment(c.folder)} />
                </div>
              );
            })}
          </li>
        );
      })}
    </ul>
  );
}

interface SeasonScreenProps {
  /** For this person's progress through the title's episodes, and the languages stored for them. */
  readonly nas: Pick<NasClient, 'titleProgress' | 'subtitlesForTitle'>;
  readonly titleId: string;
  readonly seriesName: string;
  /** 'Season 2', 'Extras', … */
  readonly heading: string;
  readonly season: SeasonDetail;
  /** The title's seasons' ids: an episode upload naming none of them is listed to owners as not attached. */
  readonly seasonIds: readonly string[];
  readonly onBack: () => void;
  readonly onOpen: OpenDisc;
  /** For owners: "File differently…" on the discs (ruling F3), and uploading and managing subtitles. */
  readonly owner?: OwnerFiling;
}

type Tab = 'episodes' | 'discs';
const TABS: readonly Tab[] = ['episodes', 'discs'];

/** A season: Episodes and Discs tabs, or the discs alone when its episodes aren't known. */
export function SeasonScreen({ nas, titleId, seriesName, heading, season, seasonIds, onBack, onOpen, owner }: SeasonScreenProps): ReactElement {
  const episodes = season.episodes;
  /** Places by disc id and playlist id; null until known (or when the NAS has none to give). */
  const [progress, setProgress] = useState<Readonly<Record<string, Readonly<Record<string, PlaylistProgress>>>> | null>(null);
  useEffect(() => {
    if (!episodes) return;
    let live = true;
    nas.titleProgress(titleId).then(
      (p) => live && setProgress(p),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [nas, titleId, episodes]);
  // Stored subtitles: language tags on the episodes for everyone; the upload sheet and the list for owners.
  const { subs, error: subsError, reload } = useStoredSubtitles(nas, titleId, episodes !== null || owner !== undefined);
  const tags = useMemo(() => tagsByEpisode((subs ?? []).filter((s) => s.attached !== false), season.id), [subs, season.id]);
  const target = useMemo(() => subtitleTarget(titleId, [season], { episodes: true }), [titleId, season]);
  const manifestOf = useManifests(owner?.nas ?? null);
  const discKeys = useDiscKeys(manifestOf, target, owner !== undefined && (subs ?? []).some((s) => s.attachment.kind === 'chapter'));
  const listing = useMemo(() => (subs ? ownerListing(subs, { id: season.id, discKeys: new Set(discKeys.keys.keys()) }, new Set(seasonIds)) : null), [subs, season.id, discKeys, seasonIds]);
  // Fansubs, for owners: the run's state (the line reports it), the fansub tracks of each episode and the open panel.
  const [fansub, setFansub] = useState<FansubTitleState | null>(null);
  const [panelFor, setPanelFor] = useState<number | null>(null);
  const fansubsByEpisode = useMemo(() => {
    const byEpisode = new Map<number, StoredSubtitle[]>();
    if (!owner) return byEpisode;
    for (const s of subs ?? []) {
      if (s.source === undefined || s.attached === false || s.attachment.kind !== 'episode' || s.attachment.seasonId !== season.id) continue;
      byEpisode.set(s.attachment.episode, [...(byEpisode.get(s.attachment.episode) ?? []), s]);
    }
    return byEpisode;
  }, [subs, season.id, owner]);
  const [adding, setAdding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadPanel = useId();
  const [tab, setTab] = useState<Tab>(episodes ? 'episodes' : 'discs');
  const ids = useId();
  const tabId = (t: Tab): string => `${ids}-tab-${t}`;
  const panelId = (t: Tab): string => `${ids}-panel-${t}`;
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  /** Arrow keys, Home and End move between the tabs, selecting as they go (roving tabIndex). */
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const at = TABS.indexOf(tab);
    const next = e.key === 'ArrowRight' ? (at + 1) % TABS.length : e.key === 'ArrowLeft' ? (at + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next]!);
    tabRefs.current[TABS[next]!]?.focus();
  };

  const playEpisode = (e: EpisodeRef): void => {
    const copy = season.discs.flatMap((d) => d.copies).find((c) => c.discId === e.discId);
    const disc = copy ? preflightDisc(copy) : { id: e.discId, name: '', kind: 'folder' as const, sizeBytes: null };
    onOpen({ ...disc, name: disc.name ? `Episode ${e.number} · ${disc.name}` : `Episode ${e.number}` }, e.playlistId);
  };

  return (
    <section className="titles season-screen" data-testid="season-screen">
      <header className="season-head">
        <button type="button" className="title-back" aria-label={`Back to ${seriesName}`} onClick={onBack}>
          <span aria-hidden="true">‹</span>
        </button>
        <div className="season-head-text">
          <span className="title-muted">{seriesName}</span>
          <h2 tabIndex={-1} data-focus-heading="">
            {heading}
          </h2>
        </div>
        {owner && (
          <button type="button" className="subtitle-add" data-testid="subtitle-add" aria-expanded={adding} aria-controls={uploadPanel} disabled={uploading} onClick={() => setAdding((a) => !a)}>
            ＋ Subtitles
          </button>
        )}
      </header>
      {owner && adding && (
        <div id={uploadPanel}>
          <SubtitleUpload
            nas={owner.nas}
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
      {owner && episodes && <FansubLine nas={owner.nas} titleId={titleId} seasonId={season.id} onChanged={reload} onState={setFansub} />}
      {episodes && (
        <div className="segmented" role="tablist" aria-label="Season view">
          {TABS.map((t) => (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[t] = el;
              }}
              type="button"
              role="tab"
              id={tabId(t)}
              aria-controls={panelId(t)}
              aria-selected={tab === t}
              tabIndex={tab === t ? 0 : -1}
              className={tab === t ? 'selected' : ''}
              data-testid="season-tab"
              data-tab={t}
              onClick={() => setTab(t)}
              onKeyDown={onTabKey}
            >
              {t === 'episodes' ? 'Episodes' : 'Discs'}
            </button>
          ))}
        </div>
      )}
      {episodes && (
        <ul className="title-list" role="tabpanel" id={panelId('episodes')} aria-labelledby={tabId('episodes')} hidden={tab !== 'episodes'}>
          {episodes.map((e) => {
            const percent = episodeProgress(progress, e.discId, e.playlistId);
            const languages = tags.get(e.number) ?? [];
            const tracks = fansubsByEpisode.get(e.number) ?? [];
            const episodeKey = `${season.id}#${e.number}`;
            const mark = owner && fansub ? episodeMark(tracks, fansub.episodes[episodeKey], tracks.some((s) => s.stale === true)) : null;
            // an owner gets a button beside the row that opens the episode's fansubs; the row itself always plays
            const reviewing = owner !== undefined && (tracks.length > 0 || fansub?.episodes[episodeKey]?.status === 'not-found');
            return (
              <li key={`${e.discId}:${e.playlistId}`} className={reviewing ? 'episode-item' : undefined}>
                <button type="button" className="episode-row" data-testid="episode-row" data-number={e.number} onClick={() => playEpisode(e)}>
                  <span className="episode-number">{e.number}</span>
                  <span className="title-row-text">
                    <span className="title-row-name">
                      Episode {e.number}
                      {e.name && <span className="title-muted"> · {e.name}</span>}
                    </span>
                    <span className="title-muted">{episodeMeta(season, e)}</span>
                  </span>
                  {languages.length > 0 && (
                    <span className="episode-tags" aria-label={`Subtitles: ${languages.join(', ')}`}>
                      {[...new Set(languages.map(languageTag))].map((t) => (
                        <span key={t} className="tag" data-testid="episode-subtitle-tag">
                          {t}
                        </span>
                      ))}
                    </span>
                  )}
                  {percent !== null && (
                    <span className="episode-progress" data-testid="episode-progress" role="img" aria-label={`${percent}% watched`}>
                      <i style={{ width: `${percent}%` }} />
                    </span>
                  )}
                </button>
                {reviewing && (
                  <button type="button" className="fansub-open" data-testid="fansub-open" aria-label={`Fansubs for episode ${e.number}`} aria-expanded={panelFor === e.number} aria-controls={`${ids}-fansubs-${e.number}`} onClick={() => setPanelFor(panelFor === e.number ? null : e.number)}>
                    {tracks.map((t) => (
                      <span key={t.id} className="fansub-chip" data-testid="fansub-chip">{trackChip(t)}</span>
                    ))}
                    {mark && <span className="fansub-mark" data-testid="fansub-mark" data-tone={mark.tone}>{mark.text}</span>}
                    {!mark && tracks.length === 0 && <span className="fansub-chip">Fansubs</span>}
                  </button>
                )}
                {owner && reviewing && panelFor === e.number && (
                  <div id={`${ids}-fansubs-${e.number}`}>
                    <FansubEpisodePanel nas={owner.nas} target={target} manifestOf={manifestOf} tracks={tracks} mark={fansub?.episodes[episodeKey]} onChanged={reload} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div {...(episodes ? { role: 'tabpanel', id: panelId('discs'), 'aria-labelledby': tabId('discs'), hidden: tab !== 'discs' } : {})}>
        <DiscList season={season} discs={season.discs} onOpen={onOpen} owner={owner} />
        {season.extras.length > 0 && (
          <>
            <h3 className="title-section">Extras</h3>
            <DiscList season={{ ...season, episodes: null }} discs={season.extras} onOpen={onOpen} owner={owner} />
          </>
        )}
      </div>
      {owner && (subs || subsError) && (
        <SubtitleList nas={owner.nas} target={target} listing={listing} error={subsError} manifestOf={manifestOf} discKeys={discKeys} onChanged={reload} />
      )}
    </section>
  );
}
