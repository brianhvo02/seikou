import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { DiscManifest, StoredSubtitle, SubtitleFor } from '../../engine/disc/nas-api';
import { formatTime } from '../format';
import type { NasClient } from './nas-client';
import { LANGUAGES, editPatch, offsetFrom, playlistChoices, subtitleErrorMessage, uploadSubtitle, validateUpload, type PlaylistChoice, type SubtitleTarget } from './subtitle-model';

/** A disc's manifest, fetched once per screen. */
export type ManifestOf = (discId: string) => Promise<DiscManifest>;

const LANGUAGE = /^[A-Za-z0-9-]{1,35}$/;
const MAX_NAME = 200;
const CHAPTER = 'chapter';
const episodeValue = (n: number): string => `episode:${n}`;

/** What an upload being edited is for, as the form's fields hold it. */
interface Prefill {
  readonly forValue: string;
  readonly discId: string;
  readonly playlistId: string;
  readonly chapter: number;
}

function prefillOf(sub: StoredSubtitle | undefined, target: SubtitleTarget, discIdOfKey: (key: string) => string | null): Prefill {
  const a = sub?.attachment;
  if (a?.kind === 'episode' && target.season?.id === a.seasonId && target.season.episodes.some((e) => e.number === a.episode)) {
    return { forValue: episodeValue(a.episode), discId: '', playlistId: '', chapter: 0 };
  }
  if (a?.kind === 'chapter') {
    const discId = discIdOfKey(a.discKey);
    if (discId !== null && target.discs.some((d) => d.discId === discId)) return { forValue: CHAPTER, discId, playlistId: a.playlistId, chapter: a.chapter };
    return { forValue: CHAPTER, discId: '', playlistId: '', chapter: 0 };
  }
  // a new upload: the first episode, or a disc and chapter where there are no episodes
  if (!sub) return target.season && target.season.episodes.length > 0 ? { forValue: '', discId: '', playlistId: '', chapter: 0 } : { forValue: CHAPTER, discId: '', playlistId: '', chapter: 0 };
  return { forValue: '', discId: '', playlistId: '', chapter: 0 };
}

const baseName = (name: string): string => name.replace(/\.[^.]*$/, '');
const offsetText = (ms: number): string => (ms === 0 ? '0' : (ms / 1000).toFixed(1));

interface SubtitleUploadProps {
  readonly nas: NasClient;
  readonly target: SubtitleTarget;
  readonly manifestOf: ManifestOf;
  /** Edits this upload (name, language, offset, what it is for) instead of making a new one. */
  readonly editing?: StoredSubtitle;
  /** The disc id a disc key stands for among the target's discs, for an upload attached to a chapter. */
  readonly discIdOfKey?: (discKey: string) => string | null;
  readonly onDone: (stored: StoredSubtitle) => void;
  readonly onCancel: () => void;
  /** Told when a write starts and when it ends (the screen keeps the sheet open meanwhile). */
  readonly onBusy?: (busy: boolean) => void;
}

/**
 * The owner's upload sheet (spec §7.2, mockup 3): a subtitle file and its fonts, what it is for (an episode of the
 * season, or a disc, playlist and chapter), a language, a name and a default offset. With `editing`, the same form
 * changes an upload's name, language, offset and attachment.
 */
export function SubtitleUpload({ nas, target, manifestOf, editing, discIdOfKey = () => null, onDone, onCancel, onBusy }: SubtitleUploadProps): ReactElement {
  const ids = useId();
  const [initial] = useState(() => prefillOf(editing, target, discIdOfKey));
  const [files, setFiles] = useState<File[]>([]);
  const [forValue, setForValue] = useState(initial.forValue);
  const [discId, setDiscId] = useState(initial.discId);
  const [playlists, setPlaylists] = useState<{ readonly discId: string; readonly choices: readonly PlaylistChoice[] } | { readonly discId: string; readonly error: string } | null>(null);
  const [playlistId, setPlaylistId] = useState(initial.playlistId);
  const [chapter, setChapter] = useState(initial.chapter);
  const [language, setLanguage] = useState(editing?.language ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [offset, setOffset] = useState(editing ? offsetText(editing.offsetMs) : '0');
  /** The number field: its text may be one the browser can't read as a number (its value is then ''). */
  const offsetField = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ readonly sent: number; readonly total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A disc's playlists, from its manifest, once a disc is chosen.
  useEffect(() => {
    if (forValue !== CHAPTER || discId === '') return;
    let live = true;
    manifestOf(discId).then(
      (manifest) => {
        if (!live) return;
        const keep = discId === initial.discId ? initial.playlistId : undefined;
        const choices = playlistChoices(manifest, keep);
        setPlaylists({ discId, choices });
        setPlaylistId((cur) => (choices.some((c) => c.id === cur) ? cur : (choices[0]?.id ?? '')));
      },
      (err: unknown) => live && setPlaylists({ discId, error: subtitleErrorMessage(err) }),
    );
    return () => {
      live = false;
    };
  }, [forValue, discId, manifestOf, initial]);

  const loaded = playlists !== null && playlists.discId === discId && 'choices' in playlists ? playlists.choices : null;
  const playlist = loaded?.find((p) => p.id === playlistId) ?? null;
  const subtitleName = files.find((f) => /\.(?:srt|ass|ssa)$/i.test(f.name))?.name;

  const forOf = (): SubtitleFor | string => {
    if (forValue.startsWith('episode:') && target.season) return { kind: 'episode', titleId: target.titleId, seasonId: target.season.id, episode: Number(forValue.slice('episode:'.length)) };
    if (forValue === CHAPTER) {
      if (discId === '') return 'Choose a disc.';
      if (!playlist) return 'Choose a playlist.';
      if (chapter >= playlist.chapters.length) return 'Choose a chapter.';
      return { kind: 'chapter', discId, playlistId: playlist.id, chapter, titleId: target.titleId };
    }
    return 'Choose what the subtitles are for.';
  };
  /** The owner changed what the upload is for. */
  const touched = forValue !== initial.forValue || (forValue === CHAPTER && (discId !== initial.discId || playlistId !== initial.playlistId || chapter !== initial.chapter));
  const setWorking = (working: boolean): void => {
    setBusy(working);
    onBusy?.(working);
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const picked = editing ? null : validateUpload(files);
    if (picked && 'error' in picked) return setError(picked.error);
    const f = forOf();
    if (!editing && typeof f === 'string') return setError(f);
    const lang = language.trim();
    if (!LANGUAGE.test(lang)) return setError('Type a language, such as en or ja.');
    const offsetMs = offsetFrom(offset, offsetField.current?.validity.badInput ?? false);
    if (offsetMs === null) return setError('The offset is in seconds, from −600 to 600.');
    const chosenName = (name.trim() || (picked ? baseName(picked.subtitle.name) : '')).slice(0, MAX_NAME);
    if (chosenName === '') return setError('Give the subtitles a name.');
    const patch = editing ? editPatch({ name: chosenName, language: lang, offsetMs }, f, { touched, attached: editing.attached !== false }) : null;
    if (patch && 'error' in patch) return setError(patch.error);
    setWorking(true);
    try {
      let stored: StoredSubtitle;
      if (editing) {
        stored = await nas.updateSubtitle(editing.id, patch!);
      } else {
        setProgress({ sent: 0, total: 1 });
        stored = await uploadSubtitle(nas, { name: chosenName, language: lang, offsetMs, for: f as SubtitleFor }, picked!, (sent, total) => setProgress({ sent, total }));
      }
      onBusy?.(false);
      onDone(stored);
    } catch (err) {
      setError(subtitleErrorMessage(err));
      setProgress(null);
      setWorking(false);
    }
  };

  const field = (id: string): string => `${ids}-${id}`;
  return (
    <form className="owner-form subtitle-upload" data-testid="subtitle-upload" aria-label={editing ? `Edit ${editing.name}` : 'Upload subtitles'} onSubmit={(e) => void submit(e)}>
      {!editing && (
        <label className="owner-field">
          Subtitle file and its fonts
          <input
            type="file"
            multiple
            accept=".srt,.ass,.ssa,.ttf,.otf,.ttc,.woff"
            data-testid="subtitle-upload-files"
            disabled={busy}
            onChange={(e) => {
              setFiles(Array.from(e.target.files ?? []));
              setError(null);
            }}
          />
          {files.length > 0 && <span className="title-muted">{files.map((f) => f.name).join(', ')}</span>}
        </label>
      )}
      <label className="owner-field">
        For
        <select data-testid="subtitle-upload-for" value={forValue} disabled={busy} onChange={(e) => setForValue(e.target.value)}>
          {forValue === '' && <option value="">Choose…</option>}
          {target.season?.episodes.map((ep) => (
            <option key={ep.number} value={episodeValue(ep.number)}>
              {`Episode ${ep.number}${ep.name ? ` · ${ep.name}` : ''}`}
            </option>
          ))}
          <option value={CHAPTER}>A disc and chapter…</option>
        </select>
      </label>
      {forValue === CHAPTER && (
        <div className="owner-numbers subtitle-chapter">
          <label className="owner-field">
            Disc
            <select
              data-testid="subtitle-upload-disc"
              value={discId}
              disabled={busy}
              onChange={(e) => {
                setDiscId(e.target.value);
                setPlaylistId('');
                setChapter(0);
              }}
            >
              {discId === '' && <option value="">Choose…</option>}
              {target.discs.map((d) => (
                <option key={d.discId} value={d.discId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          {discId !== '' && loaded === null && !(playlists?.discId === discId && 'error' in playlists) && <span className="title-muted">Reading the disc…</span>}
          {playlists?.discId === discId && 'error' in playlists && <span className="owner-message">{playlists.error}</span>}
          {loaded?.length === 0 && <span className="owner-message">This disc has no playlist of a minute or more.</span>}
          {loaded !== null && loaded.length > 0 && (
            <>
              <label className="owner-field">
                Playlist
                <select
                  data-testid="subtitle-upload-playlist"
                  value={playlistId}
                  disabled={busy}
                  onChange={(e) => {
                    setPlaylistId(e.target.value);
                    setChapter(0);
                  }}
                >
                  {loaded.map((p) => (
                    <option key={p.id} value={p.id}>
                      {`${p.id} · ${formatTime(p.durationUs)}`}
                    </option>
                  ))}
                </select>
              </label>
              {playlist && (
                <label className="owner-field">
                  Chapter
                  <select data-testid="subtitle-upload-chapter" value={chapter} disabled={busy || playlist.chapters.length === 0} onChange={(e) => setChapter(Number(e.target.value))}>
                    {playlist.chapters.map((c) => (
                      <option key={c.index} value={c.index}>
                        {`${c.index + 1} · ${formatTime(c.startUs)}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
        </div>
      )}
      <div className="owner-numbers">
        <label className="owner-field">
          Language
          <input type="text" list={field('languages')} data-testid="subtitle-upload-language" value={language} disabled={busy} placeholder="en" autoComplete="off" spellCheck={false} maxLength={35} onChange={(e) => setLanguage(e.target.value)} />
          <datalist id={field('languages')}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </datalist>
        </label>
        <label className="owner-field subtitle-offset">
          Default offset (s)
          <input type="number" step="0.1" min="-600" max="600" inputMode="decimal" data-testid="subtitle-upload-offset" value={offset} disabled={busy} ref={offsetField} onChange={(e) => setOffset(e.target.value)} />
        </label>
      </div>
      <label className="owner-field">
        Name
        <input type="text" data-testid="subtitle-upload-name" value={name} disabled={busy} maxLength={MAX_NAME} placeholder={subtitleName ? baseName(subtitleName) : 'e.g. Fansub, signs only'} onChange={(e) => setName(e.target.value)} />
      </label>
      {progress && (
        <progress className="subtitle-progress" data-testid="subtitle-upload-progress" max={progress.total} value={progress.sent} aria-label="Upload progress">
          {Math.round((progress.sent / progress.total) * 100)}%
        </progress>
      )}
      {error && (
        <p className="owner-message" role="alert" data-testid="subtitle-upload-error">
          {error}
        </p>
      )}
      <div className="owner-buttons">
        <button type="submit" className="owner-primary" data-testid="subtitle-upload-submit" disabled={busy}>
          {editing ? 'Save' : busy ? 'Uploading…' : 'Upload'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
