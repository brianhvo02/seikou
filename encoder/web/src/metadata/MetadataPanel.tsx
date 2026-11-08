// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { EpisodesAnswer, RecordAudio } from '../api-types';
import type { HelperAction, HelperState } from '../helper-model';
import { clock } from '../steps/lineup-model';
import { languageCode, languageName, move, withUserEdit, type EpisodeDraft, type TrackDraft } from './metadata-model';

/** What the Details sheet needs. */
export interface MetadataPanelProps {
  /** The page's state; the sheet reads and edits its metadata draft. */
  readonly state: HelperState;
  /** Applies an action to the page's state; every edit is sent as `setMetadata`. */
  readonly dispatch: Dispatch<HelperAction>;
  /** The run's episodes, for the chapter start times. */
  readonly episodes: EpisodesAnswer;
  /** Closes the sheet (the Close button, Escape, or a click outside it). */
  readonly onClose: () => void;
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

  const moveTo = (from: number, to: number) => {
    if (to < 0 || to >= items.length || to === from) return;
    onChange(move(items, from, to));
  };

  const onRowKey = (e: ReactKeyboardEvent, index: number) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    moveTo(index, e.key === 'ArrowUp' ? index - 1 : index + 1);
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
    if (from >= 0) moveTo(from, target);
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
                  <button type="button" className="step-move" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => moveTo(i, i - 1)}>
                    <span aria-hidden="true">↑</span>
                  </button>
                  <button type="button" className="step-move" aria-label={`Move ${name} down`} disabled={i === items.length - 1} onClick={() => moveTo(i, i + 1)}>
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

/** The fields of one episode. */
function EpisodeFields({ draft, chapterStartsUs, edit }: { draft: EpisodeDraft; chapterStartsUs: readonly number[]; edit: (field: string, value: unknown) => void }) {
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
  const firstUs = chapterStartsUs[0] ?? 0;

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
          <ol className="chapters">
            {draft.chapters.map((name, i) => (
              <li key={i}>
                <span className="chapter-time num muted">{clock(((chapterStartsUs[i] ?? firstUs) - firstUs) / 1000)}</span>
                <input type="text" aria-label={`Chapter ${i + 1} title`} value={name} onChange={(e) => edit(`chapters.${i}`, e.target.value)} />
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

/**
 * The Details sheet over the page: for one episode at a time, its MKV title, the video track's name and language, the
 * audio streams and subtitle tracks (names, languages, ticks to include, and their order, the first ticked one marked
 * Default) and the chapter titles. Every change is the user's: it is marked edited in the draft, so later defaults
 * never replace it. Escape, Close or a click outside closes it.
 */
export function MetadataPanel({ state, dispatch, episodes, onClose }: MetadataPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const drafts = Object.values(state.metadata.episodes).sort((a, b) => a.index - b.index);
  const [picked, setPicked] = useState<number | null>(null);
  const shown = drafts.find((d) => d.index === picked) ?? drafts[0] ?? null;

  const closeNow = useRef(onClose);
  closeNow.current = onClose;
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNow.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const edit = (index: number) => (field: string, value: unknown) =>
    dispatch({ type: 'setMetadata', metadata: withUserEdit(state.metadata, `episodes.${index}.${field}`, value) });

  const times = shown === null ? undefined : episodes.episodes.find((e) => e.index === shown.index);

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
            <EpisodeFields
              key={shown.index}
              draft={shown}
              chapterStartsUs={times?.chapters.map((c) => c.startUs) ?? []}
              edit={edit(shown.index)}
            />
          </>
        )}
      </aside>
    </div>
  );
}
