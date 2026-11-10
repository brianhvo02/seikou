// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError } from '../api';
import type { AniListEntry, ChapterInfo, EpisodeTimes, LibraryDiscInfo, PlaylistDetail, TitleHit } from '../api-types';
import { Player } from '../player/Player';
import { showAt, type PlayerLike } from '../player/use-controller';
import type { AppApi } from './app-api';
import { ChapterList } from './ChapterList';
import { formatLength, NotInLibrary, ScanningLibrary } from './DiscPage';
import { EpisodeTitlePicker } from './EpisodeTitlePicker';
import { aniListIdOf, episodeRows, firstNumberFor, renumberFrom, toInfo, withTitles, type EpisodeRow } from './episode-info-model';
import { episodeLengths, episodesOf, fromSpec, normalize, toSpec, type Grouping } from './grouping';
import { SCAN_POLL_MS, useDocumentTitle } from './place';
import { Link, navigate, routeHref } from './router';
import { useInfoDraft, type InfoDraftState } from './use-info-draft';

/** What the page needs: the backend client, the engine and the playlist to group. */
export interface EpisodesPageProps {
  /** The backend client. */
  readonly api: AppApi;
  /** The library disc. */
  readonly discKey: string;
  /** Five-digit name of the playlist. */
  readonly playlistId: string;
  /** The page's engine; the player shows the playlist in it. */
  readonly controller: PlayerLike;
}

interface Loaded {
  readonly disc: LibraryDiscInfo | null;
  readonly playlist: PlaylistDetail;
}

const EMPTY: Grouping = { splits: new Set(), skipped: new Set() };

/** The grouping a page starts from: the saved record's episode list when it reads for this chapter count, else one episode of everything. */
function initialGrouping(record: PlaylistDetail['record'], chapterCount: number): Grouping {
  return (record !== null ? fromSpec(record.episodeSpec, chapterCount) : null) ?? fromSpec('1-', chapterCount) ?? EMPTY;
}

const chaptersText = (from: number, to: number): string => (from === to ? `chapter ${from}` : `chapters ${from} to ${to}`);

/** A show known only by its id and name (the saved record's), until AniList answers for it. */
const nameOnly = (alId: number, title: string): TitleHit => ({ alId, title, nativeTitle: null, year: null, format: null, episodes: null, poster: null });

/** The rows with AniList's episode titles put into those that have none, from the titles fetched so far. */
function withKnownTitles(rows: readonly EpisodeRow[], titles: Readonly<Record<number, Readonly<Record<number, string>>>>): EpisodeRow[] {
  return rows.map((r) => {
    const id = aniListIdOf(r.title);
    const known = id === null || r.title!.name !== null ? undefined : titles[id];
    return known === undefined ? r : withTitles([r], id!, known)[0]!;
  });
}

/** The quiet line that says whether the chapter names and episode titles are saved. */
function SaveLine({ state }: { readonly state: InfoDraftState }) {
  if (state.status === 'failed') {
    return (
      <p className="error info-save" role="alert">
        Chapter names and episode titles could not be read: {state.loadError}
      </p>
    );
  }
  const { save } = state;
  if (save.kind === 'failed') {
    return (
      <p className="info-save info-save-failed" role="status">
        <span className="error">Not saved: {save.message}</span>
        <button type="button" className="quiet" onClick={state.retry}>
          Retry
        </button>
      </p>
    );
  }
  return (
    <p className="info-save muted" role="status">
      {save.kind === 'saving' ? 'Saving…' : save.kind === 'saved' ? 'Saved' : 'Chapter names and episode titles save as you change them.'}
    </p>
  );
}

/**
 * The Episodes page: a playlist's chapters grouped into episodes while the playlist plays. The player and the chapter
 * list sit side by side on a wide screen (a click on a chapter shows the playlist from there), with a toggle between
 * chapters that cuts an episode, one per chapter that leaves it out, the `--episodes` text (editable, checked as it is
 * typed; a bad text keeps the last good grouping) and the episodes with their lengths. "Choose subtitles" opens the
 * helper for the grouping, "Queue encode" the queue dialog and "Encode without subtitles" the same dialog with that box ticked. When the playlist has saved subtitle choices
 * for another episode list, a warning says they won't match until the subtitles are chosen again. Each chapter has a
 * name picker and each episode its AniList entry and number (`EpisodeTitlePicker`), saved as the playlist's episode info
 * as they change (`useInfoDraft`); with none saved, the record's show is suggested, numbered from 1.
 */
export function EpisodesPage({ api, discKey, playlistId, controller }: EpisodesPageProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [scanning, setScanning] = useState(false);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<{ readonly message: string; readonly unknownDisc: boolean } | null>(null);
  const [grouping, setGrouping] = useState<Grouping>(EMPTY);
  const [text, setText] = useState('');
  const [textError, setTextError] = useState(false);
  const [busy, setBusy] = useState(false);
  const playing = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const info = useInfoDraft(api, discKey, playlistId);
  // AniList's answers for the entries on the page: entries (with their next season) and shows picked from a search
  const [entries, setEntries] = useState<Readonly<Record<number, AniListEntry | null>>>({});
  const [hits, setHits] = useState<Readonly<Record<number, TitleHit>>>({});
  const [titles, setTitles] = useState<Readonly<Record<number, Readonly<Record<number, string>>>>>({});
  const asked = useRef({ entries: new Set<number>(), titles: new Set<number>() });
  // entries picked or renumbered here whose episode titles go into the saved choices once AniList gives them
  const titlesWanted = useRef(new Set<number>());
  useDocumentTitle(loaded?.disc ? `${loaded.disc.label} · ${playlistId}` : 'Seikou encoder');

  const fail = (e: unknown): void => {
    setScanning(false);
    setError({ message: e instanceof Error ? e.message : String(e), unknownDisc: e instanceof ApiError && e.code === 'disc-changed' });
  };

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = (): void => {
      setScanning(true);
      timer = setTimeout(() => setTick((t) => t + 1), SCAN_POLL_MS);
    };
    Promise.all([api.library(), api.playlist(discKey, playlistId)]).then(
      ([library, playlist]) => {
        if (!live) return;
        const disc = library.discs.find((d) => d.key === discKey) ?? null;
        if (disc === null && library.scanning) return again();
        setScanning(false);
        const start = initialGrouping(playlist.record, playlist.chapters.length);
        setGrouping(start);
        setText(toSpec(episodesOf(start, playlist.chapters.length), playlist.chapters.length));
        setLoaded({ disc, playlist });
      },
      (e: unknown) => {
        if (!live) return;
        if (!(e instanceof ApiError && e.code === 'disc-changed')) return fail(e);
        // the disc may only be missing because the scan has not reached it yet
        api.library().then(
          (library) => {
            if (live) library.scanning ? again() : fail(e);
          },
          () => {
            if (live) fail(e);
          },
        );
      },
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, discKey, playlistId, tick]);

  const chapterCount = loaded?.playlist.chapters.length ?? 0;
  const recordShow = loaded?.playlist.record?.anilist ?? null;
  const rows = useMemo(() => {
    const starts = episodesOf(grouping, chapterCount).map((e, i) => ({ index: i + 1, first: e.from }));
    const saved = info.status === 'ready' ? { ...info.draft, savedAt: '' } : null;
    return withKnownTitles(episodeRows(starts, saved, recordShow), titles);
  }, [grouping, chapterCount, info.status, info.draft, recordShow, titles]);
  const ids = [...new Set(rows.flatMap((r) => aniListIdOf(r.title) ?? []))].sort((a, b) => a - b).join(',');

  // look up every entry on the page once: its name, cover and next season, and its episode titles
  useEffect(() => {
    if (ids === '') return;
    for (const id of ids.split(',').map(Number)) {
      if (!asked.current.entries.has(id)) {
        asked.current.entries.add(id);
        Promise.resolve()
          .then(() => api.aniListEntry(id))
          .then(
            (entry) => setEntries((m) => ({ ...m, [id]: entry })),
            () => setEntries((m) => ({ ...m, [id]: null })),
          );
      }
      if (!asked.current.titles.has(id)) {
        asked.current.titles.add(id);
        // a failed lookup leaves the titles empty; it is not worth an error on the page
        Promise.resolve()
          .then(() => api.aniListEpisodes(id))
          .then(
            (got) => setTitles((m) => ({ ...m, [id]: got })),
            () => setTitles((m) => ({ ...m, [id]: {} })),
          );
      }
    }
  }, [api, ids]);

  // titles that arrive for an entry picked here go into the saved choices
  const { update } = info;
  useEffect(() => {
    for (const id of [...titlesWanted.current]) {
      const known = titles[id];
      if (known === undefined) continue;
      titlesWanted.current.delete(id);
      update((d) => {
        const titles = Object.fromEntries(
          Object.entries(d.titles).map(([k, a]) => [k, aniListIdOf(a) === id && a.name === null ? { ...a, name: known[a.episode] ?? null } : a]),
        );
        return { ...d, titles };
      });
    }
  }, [titles, update]);

  const shown = useMemo(() => ({ discKey, playlistId }), [discKey, playlistId]);
  const ready = loaded !== null && loaded.disc !== null;
  useEffect(() => {
    if (!ready) return;
    let live = true;
    showAt(controller, api, shown, 0).catch((e: unknown) => {
      if (live) fail(e);
    });
    return () => {
      live = false;
    };
  }, [ready, controller, api, shown]);

  if (scanning) return <ScanningLibrary />;
  if (error !== null) {
    if (error.unknownDisc) return <NotInLibrary />;
    return (
      <main className="content wide">
        <p className="error" role="alert">
          {error.message}
        </p>
        <p>
          <Link to={{ kind: 'disc', discKey }}>Back to the disc</Link>
        </p>
      </main>
    );
  }
  if (loaded === null) {
    return (
      <main className="content wide">
        <p className="muted">Reading the playlist…</p>
      </main>
    );
  }
  const { disc, playlist } = loaded;
  if (disc === null) return <NotInLibrary />;

  const { chapters } = playlist;
  const count = chapters.length;
  const episodes = episodesOf(grouping, count);
  const spec = toSpec(episodes, count);
  const lengths = episodeLengths(episodes, chapters.map((c) => c.lengthMs));
  const recordCanon = playlist.record === null ? null : fromSpec(playlist.record.episodeSpec, count);
  const recordSpec = playlist.record === null ? null : recordCanon === null ? playlist.record.episodeSpec : toSpec(episodesOf(recordCanon, count), count);
  const mismatch = recordSpec !== null && recordSpec !== spec;

  const apply = (next: Grouping): void => {
    const clean = normalize(next, count);
    setGrouping(clean);
    setText(toSpec(episodesOf(clean, count), count));
    setTextError(false);
  };
  const toggle = (set: ReadonlySet<number>, n: number): Set<number> => {
    const next = new Set(set);
    if (!next.delete(n)) next.add(n);
    return next;
  };
  const type = (value: string): void => {
    setText(value);
    const parsed = fromSpec(value, count);
    if (parsed === null) {
      setTextError(true);
      return;
    }
    setTextError(false);
    setGrouping(parsed);
  };
  const seek = (c: ChapterInfo): void => {
    showAt(controller, api, shown, c.startMs * 1000).catch(fail);
  };
  const editable = info.status === 'ready';
  /** Saves `next` as the episodes' titles; every row is written, a suggestion included. */
  const saveRows = (next: readonly EpisodeRow[]): void => {
    for (const r of next) {
      const id = aniListIdOf(r.title);
      if (id !== null && r.title!.name === null && titles[id] === undefined) titlesWanted.current.add(id);
    }
    update((d) => ({ ...d, titles: toInfo(withKnownTitles(next, titles), {}, d.titles).titles }));
  };
  const nameChapter = (n: number, name: string): void => {
    update((d) => {
      const chapterNames = { ...d.chapterNames };
      if (name === '') delete chapterNames[String(n)];
      else chapterNames[String(n)] = name;
      return { chapterNames, titles: toInfo(rows, {}, d.titles).titles };
    });
  };
  const pickEntry = (i: number, hit: TitleHit): void => {
    setHits((m) => ({ ...m, [hit.alId]: hit }));
    saveRows(renumberFrom(rows, i, hit.alId, firstNumberFor(rows, i, hit.alId)));
  };
  const renumber = (i: number, episode: number): void => {
    const id = aniListIdOf(rows[i]?.title ?? null);
    if (id !== null) saveRows(renumberFrom(rows, i, id, episode));
  };
  const showOf = (id: number): TitleHit | null => entries[id] ?? hits[id] ?? (recordShow !== null && recordShow.id === id ? nameOnly(id, recordShow.title) : null);
  /** The next season to offer a row: of its own entry, else of the episode before's. */
  const sequelFor = (i: number): TitleHit | null => {
    const own = aniListIdOf(rows[i]?.title ?? null) ?? aniListIdOf(rows[i - 1]?.title ?? null);
    return own === null ? null : (entries[own]?.sequel ?? null);
  };

  const chooseSubtitles = (): void => {
    setBusy(true);
    api.createSession(discKey, playlistId, spec).then(
      (id) => navigate(routeHref({ kind: 'helper', sessionId: id }, location.search)),
      (e: unknown) => {
        setBusy(false);
        fail(e);
      },
    );
  };
  const encodeWithout = (): void => {
    navigate(routeHref({ kind: 'queueNew', discKey, playlistId, spec, noSubtitles: true }, location.search));
  };
  const queueEncode = (): void => {
    navigate(routeHref({ kind: 'queueNew', discKey, playlistId, spec, noSubtitles: false }, location.search));
  };

  const whole: EpisodeTimes = {
    index: 1,
    startUs: 0,
    durationUs: playlist.durationMs * 1000,
    chapters: chapters.map((c) => ({ startUs: c.startMs * 1000 })),
  };
  const usable = episodes.length > 0;
  let currentIndex: number | null = null;
  for (const c of chapters) if (c.startMs * 1000 <= playing.timeUs) currentIndex = c.index;

  return (
    <main className="content wide episodes-page">
      <p className="crumb">
        <Link to={{ kind: 'library' }}>Library</Link> / <Link to={{ kind: 'disc', discKey }}>{disc.label}</Link>
      </p>
      <h1 className="page-title disc-title">{disc.label}</h1>
      <p className="muted">
        Playlist <span className="num">{playlistId}</span>, <span className="num">{formatLength(playlist.durationMs)}</span>, {count}{' '}
        {count === 1 ? 'chapter' : 'chapters'}
      </p>
      <div className="episodes-layout">
        <div className="episodes-watch">
          <Player controller={controller} episode={whole} label={`Playlist ${playlistId} preview`} />
          <div className="episodes-form">
            <label className="episodes-spec-label" htmlFor="episodes-spec">
              Episodes
            </label>
            <input
              id="episodes-spec"
              className="filter episodes-spec num"
              value={text}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={textError}
              aria-describedby="episodes-spec-help"
              onChange={(e) => type(e.target.value)}
            />
            <p id="episodes-spec-help" className={textError ? 'error' : 'muted'}>
              {textError
                ? `Not an episode list for ${count} chapters. Write chapter runs such as 1-4,5-8 or 1-4,5- (the last can end open); the episodes below are the last good list.`
                : 'Chapter runs, as --episodes takes them: 1-4,5-8, or 1-4,5- to run to the last chapter.'}
            </p>
            {mismatch && (
              <p className="warn" role="status">
                Subtitle choices are saved for episodes {recordSpec}. They won't match these episodes unless the subtitles are chosen again.
              </p>
            )}
            {usable ? (
              <ol className="episode-summary" aria-label="Episodes made">
                {episodes.map((e, i) => {
                  const row = rows[i];
                  return (
                    <li key={e.from}>
                      <div className="episode-head">
                        <span className="episode-name">Episode {i + 1}</span>
                        <span className="num">{formatLength(lengths[i] ?? 0)}</span>
                        <span className="muted">{chaptersText(e.from, e.to)}</span>
                      </div>
                      {row !== undefined && (
                        <EpisodeTitlePicker
                          api={api}
                          row={row}
                          show={aniListIdOf(row.title) === null ? null : showOf(aniListIdOf(row.title)!)}
                          sequel={sequelFor(i)}
                          disabled={!editable}
                          onPick={(hit) => pickEntry(i, hit)}
                          onNumber={(n) => renumber(i, n)}
                        />
                      )}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="muted">
                {count === 0 ? 'This playlist has no chapters to group.' : 'No chapter is kept. Untick Skip on a chapter to make an episode.'}
              </p>
            )}
            {usable && <SaveLine state={info} />}
            <div className="actions">
              <button type="button" className="primary" disabled={!usable || busy} onClick={chooseSubtitles}>
                Choose subtitles
              </button>
              <button type="button" className="quiet" disabled={!usable || busy} onClick={queueEncode}>
                Queue encode
              </button>
              <button type="button" className="quiet" disabled={!usable || busy} onClick={encodeWithout}>
                Encode without subtitles
              </button>
            </div>
          </div>
        </div>
        <ChapterList
          chapters={chapters}
          grouping={normalize(grouping, count)}
          episodes={episodes}
          currentIndex={currentIndex}
          onSeek={seek}
          onToggleSplit={(n) => apply({ ...grouping, splits: toggle(grouping.splits, n) })}
          onToggleSkip={(n) => apply({ ...grouping, skipped: toggle(grouping.skipped, n) })}
          names={info.draft.chapterNames}
          namesDisabled={!editable}
          onName={nameChapter}
        />
      </div>
    </main>
  );
}
