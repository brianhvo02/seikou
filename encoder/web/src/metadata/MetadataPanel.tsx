// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { HelperApi } from '../api';
import type { EpisodeInfo, EpisodesAnswer, RecordAudio, SessionInfo } from '../api-types';
import type { HelperAction, HelperState } from '../helper-model';
import { clock } from '../steps/lineup-model';
import {
  defaultChapterName,
  firstChapters,
  languageCode,
  languageName,
  move,
  withChapterNames,
  withUserEdit,
  type EpisodeDraft,
  type TrackDraft,
} from './metadata-model';

/** What the Details sheet needs. */
export interface MetadataPanelProps {
  /** The page's state; the sheet reads and edits its metadata draft. */
  readonly state: HelperState;
  /** Applies an action to the page's state; every edit but a chapter name is sent as `setMetadata`. */
  readonly dispatch: Dispatch<HelperAction>;
  /** The run's episodes, for the chapter start times. */
  readonly episodes: EpisodesAnswer;
  /** The backend client, which saves chapter names to the episode info. */
  readonly api: HelperApi;
  /** The run: its disc and playlist name the episode info, its episode list maps chapter fields onto playlist chapters. */
  readonly session: SessionInfo;
  /** The episode info as loaded or last saved; null when none is saved. */
  readonly info: EpisodeInfo | null;
  /** True when the episode info could not be loaded: chapter names are then shown but cannot be changed. */
  readonly infoFailed: boolean;
  /** Called with the episode info as stored after each save of chapter names. */
  readonly onInfo: (info: EpisodeInfo) => void;
  /** Closes the sheet (the Close button, Escape, or a click outside it). */
  readonly onClose: () => void;
}

/** Whether two name maps hold the same names for the same chapters. */
function sameNames(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** What a language field shows beside its code. */
function languageNote(code: string): string {
  if (code === 'und') return 'Undetermined';
  if (code.length < 3) return 'Three letters';
  return languageName(code) || 'Unknown code';
}

/**
 * A three-letter language code with the language's name beside it. Only letters are kept, in lowercase; leaving the
 * field turns anything that is not three letters into `und`.
 */
function LanguageField({ label, value, onChange }: { label: string; value: string; onChange: (code: string) => void }) {
  return (
    <span className="language">
      <input
        type="text"
        className="language-code num"
        aria-label={label}
        value={value}
        maxLength={3}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value.toLowerCase().replace(/[^a-z]/g, '').slice(0, 3))}
        onBlur={() => {
          const code = languageCode(value);
          if (code !== value) onChange(code);
        }}
      />
      <span className="language-name muted">{languageNote(value)}</span>
    </span>
  );
}

/** One row's content in a reorderable list: what it is called and the fields to edit. */
interface RowView<T> {
  /** The item's name for buttons and screen readers, such as `Japanese audio` or `GroupA signs`. */
  readonly describe: (item: T, position: number) => string;
  /** The row's own fields; `update` replaces the item. */
  readonly fields: (item: T, position: number, update: (next: T) => void) => ReactNode;
}

/**
 * A list of tracks the user puts in order: drag the handle, press Up or Down, or Alt+Arrow keys anywhere in a row.
 * Each row has a tick to include it; the first ticked row is marked Default.
 */
function ReorderList<T extends { readonly included: boolean }>({
  label,
  items,
  keyOf,
  view,
  onChange,
}: {
  label: string;
  items: readonly T[];
  keyOf: (item: T) => string;
  view: RowView<T>;
  onChange: (next: T[]) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const defaultIndex = items.findIndex((t) => t.included);
  const names = items.map((item, i) => view.describe(item, i));
  // two streams in one language would read the same; their position tells them apart
  const unique = names.map((n, i) => (names.indexOf(n) !== names.lastIndexOf(n) ? `${n} ${i + 1}` : n));

  // after a move, focus goes back to the control in the moved row that had it (the browser can drop focus when the
  // row's node is moved); a move button that is now disabled (the row reached an end) hands focus to the row's other
  // move button, so focus never falls to the page
  const refocus = useRef<{ readonly key: string; readonly control: HTMLElement } | null>(null);
  useEffect(() => {
    const wanted = refocus.current;
    refocus.current = null;
    if (wanted === null || !listRef.current) return;
    const row = (Array.from(listRef.current.children) as HTMLElement[]).find((li) => li.dataset.key === wanted.key);
    if (!row || !row.contains(wanted.control)) return;
    const control = wanted.control;
    const dir = control.dataset.dir;
    if (control instanceof HTMLButtonElement && control.disabled && dir !== undefined) {
      row.querySelector<HTMLButtonElement>(`button[data-dir="${dir === 'up' ? 'down' : 'up'}"]`)?.focus();
    } else {
      control.focus();
    }
  }, [items]);

  /** Moves the item at `from` to `to`; `control`, the element in its row that has focus, gets it back after. */
  const moveTo = (from: number, to: number, control: HTMLElement | null) => {
    if (to < 0 || to >= items.length || to === from) return;
    if (control !== null) refocus.current = { key: keyOf(items[from]!), control };
    onChange(move(items, from, to));
  };

  const onRowKey = (e: ReactKeyboardEvent, index: number) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    moveTo(index, e.key === 'ArrowUp' ? index - 1 : index + 1, e.target instanceof HTMLElement ? e.target : null);
  };

  const onHandleDown = (e: ReactPointerEvent<HTMLSpanElement>, key: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(key);
  };

  const onHandleMove = (e: ReactPointerEvent<HTMLSpanElement>, key: string) => {
    if (dragging !== key || !listRef.current) return;
    const rows = Array.from(listRef.current.children) as HTMLElement[];
    let target = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const box = rows[i]!.getBoundingClientRect();
      if (e.clientY < box.top + box.height / 2) {
        target = i;
        break;
      }
    }
    const from = items.findIndex((item) => keyOf(item) === key);
    if (from >= 0) moveTo(from, target, null);
  };

  const endDrag = () => setDragging(null);

  return (
    <ul ref={listRef} className="reorder" aria-label={label}>
      {items.map((item, i) => {
        const key = keyOf(item);
        const name = unique[i]!;
        const update = (next: T) => onChange(items.map((x, j) => (j === i ? next : x)));
        return (
          <li
            key={key}
            data-key={key}
            className={['track-row', i === defaultIndex ? 'is-default' : '', dragging === key ? 'is-dragging' : '', item.included ? '' : 'is-left-out'].join(' ').trim()}
            onKeyDown={(e) => onRowKey(e, i)}
          >
            <span
              className="grip"
              aria-hidden="true"
              title="Drag to reorder"
              onPointerDown={(e) => onHandleDown(e, key)}
              onPointerMove={(e) => onHandleMove(e, key)}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
            <input
              type="checkbox"
              className="tick"
              aria-label={`Include ${name}`}
              checked={item.included}
              onChange={(e) => update({ ...item, included: e.target.checked })}
            />
            <div className="track-fields">{view.fields(item, i, update)}</div>
            <div className="track-order">
              {i === defaultIndex && <span className="default-mark">Default</span>}
              {items.length > 1 && (
                <>
                  <button type="button" className="step-move" data-dir="up" aria-label={`Move ${name} up`} disabled={i === 0} onClick={(e) => moveTo(i, i - 1, e.currentTarget)}>
                    <span aria-hidden="true">↑</span>
                  </button>
                  <button type="button" className="step-move" data-dir="down" aria-label={`Move ${name} down`} disabled={i === items.length - 1} onClick={(e) => moveTo(i, i + 1, e.currentTarget)}>
                    <span aria-hidden="true">↓</span>
                  </button>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One episode's chapter titles as free text. The fields start from the draft's names (the episode info's) and a field
 * is sent to `onSave` with the others when it loses focus changed; an emptied field shows the encoder's own name
 * again. When saved names come back, only the fields whose name changed take it, so typing in another field is kept.
 */
function ChapterFields({
  names,
  startsUs,
  disabled,
  onSave,
}: {
  names: readonly string[];
  startsUs: readonly number[];
  disabled: boolean;
  onSave: (fields: readonly string[]) => void;
}) {
  const [fields, setFields] = useState<readonly string[]>(names);
  const shown = useRef(names);
  useEffect(() => {
    const before = shown.current;
    shown.current = names;
    setFields((current) => (current.length !== names.length ? [...names] : current.map((f, i) => (names[i] !== before[i] ? names[i]! : f))));
  }, [names]);
  const firstUs = startsUs[0] ?? 0;

  const leave = (i: number) => {
    const next = fields.map((f, j) => (j === i && f.trim() === '' ? defaultChapterName(i) : f));
    setFields(next);
    if (next.some((f, j) => f !== names[j])) onSave(next);
  };

  return (
    <ol className="chapters">
      {fields.map((name, i) => (
        <li key={i}>
          <span className="chapter-time num muted">{clock(((startsUs[i] ?? firstUs) - firstUs) / 1000)}</span>
          <input
            type="text"
            aria-label={`Chapter ${i + 1} title`}
            value={name}
            maxLength={100}
            disabled={disabled}
            onChange={(e) => {
              const value = e.target.value;
              setFields((current) => current.map((f, j) => (j === i ? value : f)));
            }}
            onBlur={() => leave(i)}
          />
        </li>
      ))}
    </ol>
  );
}

/** The fields of one episode. */
function EpisodeFields({
  draft,
  chapterStartsUs,
  chaptersDisabled,
  edit,
  saveChapters,
}: {
  draft: EpisodeDraft;
  chapterStartsUs: readonly number[];
  chaptersDisabled: boolean;
  edit: (field: string, value: unknown) => void;
  saveChapters: (fields: readonly string[]) => void;
}) {
  const audioView: RowView<RecordAudio> = {
    describe: (a) => `${languageName(a.language) || 'Undetermined'} audio`,
    fields: (a, i, update) => (
      <>
        <input type="text" className="track-name" aria-label={`Name of audio stream ${i + 1}`} value={a.name} placeholder="No name" onChange={(e) => update({ ...a, name: e.target.value })} />
        <LanguageField label={`Language of audio stream ${i + 1}`} value={a.language} onChange={(language) => update({ ...a, language })} />
      </>
    ),
  };
  const trackView: RowView<TrackDraft> = {
    describe: (t) => t.name || `${t.kind} subtitles`,
    fields: (t, i, update) => (
      <>
        <input type="text" className="track-name" aria-label={`Name of subtitle track ${i + 1}`} value={t.name} placeholder="No name" onChange={(e) => update({ ...t, name: e.target.value })} />
        <LanguageField label={`Language of subtitle track ${i + 1}`} value={t.language} onChange={(language) => update({ ...t, language })} />
        <span className="track-kind muted">{t.kind === 'full' ? 'Full dialogue' : 'Signs and songs'}</span>
      </>
    ),
  };
  return (
    <div className="details-fields">
      <label className="field">
        <span className="field-label">MKV title</span>
        <input type="text" value={draft.title} onChange={(e) => edit('title', e.target.value)} />
      </label>

      <section aria-labelledby="details-video">
        <h3 id="details-video">Video</h3>
        <div className="track-row single">
          <div className="track-fields">
            <input type="text" className="track-name" aria-label="Video name" value={draft.video.name} placeholder="No name" onChange={(e) => edit('video', { ...draft.video, name: e.target.value })} />
            <LanguageField label="Video language" value={draft.video.language} onChange={(language) => edit('video', { ...draft.video, language })} />
          </div>
        </div>
      </section>

      <section aria-labelledby="details-audio">
        <h3 id="details-audio">Audio</h3>
        {draft.audio.length > 0 ? (
          <ReorderList label="Audio" items={draft.audio} keyOf={(a) => String(a.pid)} view={audioView} onChange={(next) => edit('audio', next)} />
        ) : (
          <p className="muted">The playlist has no audio streams.</p>
        )}
      </section>

      <section aria-labelledby="details-subtitles">
        <h3 id="details-subtitles">Subtitles</h3>
        {draft.tracks.length > 0 ? (
          <ReorderList label="Subtitles" items={draft.tracks} keyOf={(t) => t.key} view={trackView} onChange={(next) => edit('tracks', next)} />
        ) : (
          <p className="muted">No subtitle tracks are chosen for this episode. Pick them in Episodes.</p>
        )}
      </section>

      {draft.chapters.length > 0 && (
        <section aria-labelledby="details-chapters">
          <h3 id="details-chapters">Chapters</h3>
          {chaptersDisabled && <p className="muted">The saved chapter names could not be loaded, so they cannot be changed here.</p>}
          <ChapterFields names={draft.chapters} startsUs={chapterStartsUs} disabled={chaptersDisabled} onSave={saveChapters} />
        </section>
      )}
    </div>
  );
}

/**
 * The Details sheet over the page: for one episode at a time, its MKV title, the video track's name and language, the
 * audio streams and subtitle tracks (names, languages, ticks to include, and their order, the first ticked one marked
 * Default) and the chapter titles. Every change but a chapter title is the user's draft: it is marked edited, so later
 * defaults never replace it. Chapter titles are saved to the disc playlist's episode info (`saveEpisodeInfo`) as a
 * field is left, one save after another, each field put back on its playlist chapter by the session's episode list;
 * the episode's AniList choices are kept as they are. Escape, Close or a click outside closes it, after the field
 * being typed in is left.
 */
export function MetadataPanel({ state, dispatch, episodes, api, session, info, infoFailed, onInfo, onClose }: MetadataPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const drafts = Object.values(state.metadata.episodes).sort((a, b) => a.index - b.index);
  const [picked, setPicked] = useState<number | null>(null);
  const shown = drafts.find((d) => d.index === picked) ?? drafts[0] ?? null;

  const closeNow = useRef(onClose);
  closeNow.current = onClose;
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // leaving the field being typed in saves it before the sheet goes
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      closeNow.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const edit = (index: number) => (field: string, value: unknown) =>
    dispatch({ type: 'setMetadata', metadata: withUserEdit(state.metadata, `episodes.${index}.${field}`, value) });

  const times = shown === null ? undefined : episodes.episodes.find((e) => e.index === shown.index);

  // chapter names are saved one after another, each from the names the last save stored
  const [chapterError, setChapterError] = useState<string | null>(null);
  const stored = useRef(info);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const onInfoNow = useRef(onInfo);
  onInfoNow.current = onInfo;
  const firsts = firstChapters(session.episodeSpec);
  const saveChapters = (index: number) => (fields: readonly string[]) => {
    const first = firsts[index - 1];
    if (first === undefined) return;
    saving.current = saving.current.then(async () => {
      const current = stored.current?.chapterNames ?? {};
      const chapterNames = withChapterNames(current, first, fields);
      if (sameNames(chapterNames, current)) return;
      try {
        const saved = await api.saveEpisodeInfo(session.discKey, session.playlistId, { chapterNames, anilist: stored.current?.anilist ?? {} });
        stored.current = saved;
        setChapterError(null);
        onInfoNow.current(saved);
      } catch (e) {
        setChapterError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className="sheet details" role="dialog" aria-modal="true" aria-labelledby="details-heading" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2 id="details-heading">Details</h2>
          <button ref={closeRef} type="button" className="quiet" aria-label="Close details" onClick={onClose}>
            Close
          </button>
        </header>
        <p className="muted">What each episode's file says about itself: its title, its tracks' names and languages, their order, and its chapters.</p>

        {shown === null ? (
          <p className="details-empty muted">The episodes are still loading.</p>
        ) : (
          <>
            {drafts.length > 1 && (
              <nav className="episode-picker" aria-label="Episodes">
                {drafts.map((d) => (
                  <button
                    key={d.index}
                    type="button"
                    className="num"
                    aria-label={`Episode ${d.index}`}
                    aria-pressed={d.index === shown.index}
                    onClick={() => setPicked(d.index)}
                  >
                    {d.index}
                  </button>
                ))}
              </nav>
            )}
            <p className="episode-name">
              <span className="num">Episode {shown.index}</span>
              {shown.episodeTitle !== '' && <span className="muted">{shown.episodeTitle}</span>}
            </p>
            {chapterError !== null && (
              <p className="error" role="alert">
                The chapter titles were not saved. {chapterError}
              </p>
            )}
            <EpisodeFields
              key={shown.index}
              draft={shown}
              chapterStartsUs={times?.chapters.map((c) => c.startUs) ?? []}
              chaptersDisabled={infoFailed}
              edit={edit(shown.index)}
              saveChapters={saveChapters(shown.index)}
            />
          </>
        )}
      </aside>
    </div>
  );
}
