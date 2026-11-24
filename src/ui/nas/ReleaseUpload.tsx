// SPDX-License-Identifier: LGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { StoredSubtitle, SubtitleFor } from '@seikou/nas/nas-api';
import { extractInWorker, type ExtractMkv } from '../mkv-extract-client';
import type { NasClient } from './nas-client';
import { canUpload, releaseLanguage, releaseRow, withExtract, type ReleaseRow } from './release-model';
import { subtitleErrorMessage, uploadRelease } from './subtitle-model';

interface ReleaseUploadProps {
  readonly nas: Pick<NasClient, 'createSubtitle' | 'uploadSubtitleFile' | 'uploadSubtitleFont' | 'deleteSubtitle' | 'fansubLanguages'>;
  readonly files: readonly File[];
  /** The season the files are for: its episode count and the episodes before it (for absolute numbering). */
  readonly season: { readonly seasonId: string; readonly titleId: string; readonly count: number; readonly before: number };
  /** The season's episodes; a movie has none and its one file is for the film. */
  readonly episodes: readonly { readonly number: number; readonly name?: string | null }[];
  /** What an upload for this episode is attached to (the create call's `for`). */
  readonly targetOf: (episode: number) => Promise<SubtitleFor>;
  readonly extract?: ExtractMkv;
  readonly onDone: (stored: StoredSubtitle[]) => void;
  readonly onBusy?: (busy: boolean) => void;
}

const kindLabel = (k: 'ass' | 'srt'): string => (k === 'ass' ? 'ASS' : 'SRT');

/**
 * The owner's release form: each picked MKV is read in the worker (one at a time), its text tracks listed with the
 * English and wanted-language ASS ones ticked, the episode guessed from the name, and Upload sends the ticked tracks.
 */
export function ReleaseUpload({ nas, files, season, episodes, targetOf, extract = extractInWorker, onDone, onBusy }: ReleaseUploadProps): ReactElement {
  const movie = episodes.length === 0;
  const [rows, setRows] = useState<ReleaseRow[]>(() => files.map((f) => ({ ...releaseRow(f, season), episode: movie ? 1 : releaseRow(f, season).episode })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [done, setDone] = useState<number | null>(null);
  /** Files whose ticked tracks are stored; a retry leaves them alone. */
  const [sentFiles, setSentFiles] = useState<ReadonlySet<File>>(new Set());
  const [failures, setFailures] = useState<string[]>([]);
  const languages = useRef<readonly string[]>([]);
  const extractRef = useRef(extract);
  extractRef.current = extract;

  /** The read restarts only for other files, not for a parent's new array of the same ones. */
  const filesKey = files.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join('\n');
  const patch = useCallback((file: File, change: (r: ReleaseRow) => ReleaseRow): void => setRows((rs) => rs.map((r) => (r.file === file ? change(r) : r))), []);

  // Read the files one at a time; the form stays usable meanwhile.
  useEffect(() => {
    let live = true;
    const abort = new AbortController();
    void (async () => {
      languages.current = await nas.fansubLanguages().catch(() => []);
      for (const file of files) {
        if (!live) return;
        try {
          const found = await extractRef.current(file, (p) => live && patch(file, (r) => ({ ...r, progress: p })), abort.signal);
          if (live) patch(file, (r) => withExtract(r, found, languages.current));
        } catch (err) {
          if (live) patch(file, (r) => ({ ...r, state: 'failed', error: err instanceof Error ? err.message : String(err) }));
        }
      }
    })();
    return () => {
      live = false;
      abort.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesKey]);

  /** The rows still to send. */
  const pending = rows.map((r) => (sentFiles.has(r.file) ? { ...r, ticked: new Set<number>() } : r));
  const toggle = (file: File, number: number): void =>
    patch(file, (r) => {
      const ticked = new Set(r.ticked);
      if (!ticked.delete(number)) ticked.add(number);
      return { ...r, ticked };
    });

  const upload = async (): Promise<void> => {
    if (busy || !canUpload(pending)) return;
    setBusy(true);
    onBusy?.(true);
    setError(null);
    setFailures([]);
    const going = rows.filter((r) => r.state === 'read' && r.ticked.size > 0 && !sentFiles.has(r.file));
    const total = going.reduce((n, r) => n + (r.extract?.tracks.filter((t) => r.ticked.has(t.number)).reduce((m, t) => m + t.text.length, 0) ?? 0), 0) || 1;
    const stored: StoredSubtitle[] = [];
    const failed: string[] = [];
    let before = 0;
    for (const row of going) {
      try {
        const target = await targetOf(row.episode!);
        stored.push(...(await uploadRelease(nas, row, target, (sent) => setProgress({ sent: before + sent, total: Math.max(total, before + sent) }))));
        setSentFiles((s) => new Set(s).add(row.file));
      } catch (err) {
        failed.push(`${row.file.name}: ${subtitleErrorMessage(err)}`);
      }
      before += row.extract?.tracks.filter((t) => row.ticked.has(t.number)).reduce((m, t) => m + t.text.length, 0) ?? 0;
    }
    setBusy(false);
    onBusy?.(false);
    setProgress(null);
    setFailures(failed);
    if (stored.length > 0) setDone((d) => (d ?? 0) + stored.length);
    if (stored.length > 0) onDone(stored);
    if (failed.length > 0) setError(`${failed.length === 1 ? 'A file' : 'Some files'} didn't upload.`);
  };

  return (
    <div className="owner-form release-upload" data-testid="release-upload-form" aria-label="Upload subtitles from releases">
      {rows.map((row) => (
        <div key={`${row.file.name}-${row.file.size}`} className="release-row" data-testid="release-row" data-state={row.state}>
          <strong className="release-name">{row.file.name}</strong>
          {row.state === 'reading' && <progress className="subtitle-progress" max={1} value={row.progress} aria-label={`Reading ${row.file.name}`} />}
          {row.state === 'failed' && <span className="owner-message">{`Couldn't read this file: ${row.error ?? 'unknown error'}`}</span>}
          {row.state === 'read' && row.extract && (
            <>
              {!movie && (
                <label className="owner-field">
                  Episode
                  <select data-testid="release-episode" value={row.episode ?? ''} disabled={busy} onChange={(e) => patch(row.file, (r) => ({ ...r, episode: e.target.value === '' ? null : Number(e.target.value) }))}>
                    {row.episode === null && <option value="">Choose…</option>}
                    {episodes.map((ep) => (
                      <option key={ep.number} value={ep.number}>
                        {`Episode ${ep.number}${ep.name ? ` · ${ep.name}` : ''}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {row.extract.tracks.length === 0 && <span className="owner-message">This file has no text subtitles.</span>}
              {row.extract.tracks.map((t) => (
                <label key={t.number} className="release-track-row">
                  <input type="checkbox" data-testid="release-track" checked={row.ticked.has(t.number)} disabled={busy || sentFiles.has(row.file)} onChange={() => toggle(row.file, t.number)} />
                  <span>{`${kindLabel(t.kind)} · ${releaseLanguage(t.language)}${t.name ? ` · ${t.name}` : ''} · ${t.dialogueLines} lines`}</span>
                </label>
              ))}
            </>
          )}
        </div>
      ))}
      {progress && <progress className="subtitle-progress" data-testid="release-upload-progress" max={progress.total} value={progress.sent} aria-label="Upload progress" />}
      {error && (
        <p className="owner-message" role="alert" data-testid="release-error">
          {error}
        </p>
      )}
      {failures.map((f) => (
        <p key={f} className="owner-message">
          {f}
        </p>
      ))}
      {done !== null && (
        <p className="title-muted" role="status" data-testid="release-status">
          {`${done} ${done === 1 ? 'track' : 'tracks'} uploaded. They show to viewers once the NAS has lined them up with the disc's audio.`}
        </p>
      )}
      <div className="owner-buttons">
        <button type="button" className="owner-primary" data-testid="release-upload" disabled={busy || !canUpload(pending)} onClick={() => void upload()}>
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </div>
  );
}
