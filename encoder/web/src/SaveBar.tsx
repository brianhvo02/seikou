// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef, useState, type Dispatch, type ReactNode } from 'react';
import type { HelperApi } from './api';
import type { EpisodesAnswer, RecordAnswer, RecordRelease, ReleaseAnswer, SessionInfo, SubtitleRecord } from './api-types';
import { fromRecord, releaseOf, toRecord, type HelperAction, type HelperState } from './helper-model';

/** What the save bar needs. `session` and `episodes` are null until the page has loaded them. */
export interface SaveBarProps {
  /** The backend client. */
  readonly api: HelperApi;
  /** The page's state, which Save writes. */
  readonly state: HelperState;
  /** Applies an action; a restored record arrives as `load`, a successful save as `saved`. */
  readonly dispatch: Dispatch<HelperAction>;
  /** The run, or null while it loads. */
  readonly session: SessionInfo | null;
  /** The run's episodes, or null while they load. */
  readonly episodes: EpisodesAnswer | null;
  /** Buttons shown before Save, such as Details. */
  readonly children?: ReactNode;
}

/** A line under the bar: what happened, and whether it went wrong. */
interface Status {
  readonly ok: boolean;
  readonly text: string;
}

/** The message of a failure. */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A saved time as the user's clock shows it, such as `10:04`. */
function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A saved date and time as the user's calendar shows it. */
function dateTimeOf(iso: string): string {
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

/** The Anime Tosho id a release key names (`tosho-<id>`), or null for the user's own files. */
function toshoIdOf(key: string): number | null {
  const m = /^tosho-(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/**
 * Save for encoding, and what the saved record says when the page loads. Once the run is known it asks for the
 * saved record and, when there is one, for each of its releases again, and restores the record with the releases
 * that came back (`fromRecord`), unless the user has already changed something. When one of the record's releases or
 * some of its cached files are gone, it names the first such release and offers "Fetch <release> again", which
 * fetches it from Anime Tosho and restores the saved choices onto it and the releases already pooled; the user's own
 * files cannot be fetched, so it asks to add them again. While a saved release is missing and the pool is empty, Save
 * is off, because it would write the record without its releases and tracks. Save writes `toRecord` of the state and
 * answers "Saved at <time>" or the server's message. Renders the button row (with `children` first) and, below it,
 * the status and any missing release.
 */
export function SaveBar({ api, state, dispatch, session, episodes, children }: SaveBarProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SubtitleRecord | null>(null);
  const [missing, setMissing] = useState<RecordAnswer['missing']>([]);
  // ids of the saved record's releases the backend no longer holds
  const [goneIds, setGoneIds] = useState<readonly string[]>([]);
  const [fetching, setFetching] = useState(false);
  const dirty = useRef(state.dirty);
  dirty.current = state.dirty;

  useEffect(() => {
    if (episodes === null) return;
    let live = true;
    void (async () => {
      let answer: RecordAnswer;
      try {
        answer = await api.record();
      } catch (e) {
        if (live) setStatus({ ok: false, text: `The saved choices could not be loaded. ${messageOf(e)}` });
        return;
      }
      if (!live) return;
      if (answer.error) {
        setStatus({ ok: false, text: 'The saved choices for this disc could not be read, so the helper starts fresh. Saving replaces them.' });
        return;
      }
      const record = answer.record;
      if (record === null) return;
      const offset = record.anilist?.episodeOffset ?? 0;
      const answers = await Promise.all(record.releases.map((r) => api.release(r.id, offset).catch((): ReleaseAnswer | null => null)));
      if (!live) return;
      const found = answers.filter((a): a is ReleaseAnswer => a !== null);
      const gone = record.releases.filter((_, i) => answers[i] === null).map((r) => r.id);
      setSaved(record);
      setMissing(answer.missing);
      setGoneIds(gone);
      if (dirty.current) {
        setStatus({ ok: true, text: `Choices saved ${dateTimeOf(record.savedAt)} were found after you started. Reload the page to go back to them.` });
        return;
      }
      dispatch({ type: 'load', state: fromRecord(record, found, episodes) });
      const when = dateTimeOf(record.savedAt);
      const partly = gone.length > 0;
      setStatus({ ok: true, text: partly ? `Restored what was saved ${when}, except ${gone.length === 1 ? 'a release' : 'some releases'}.` : `Restored the choices saved ${when}.` });
    })();
    return () => {
      live = false;
    };
  }, [api, dispatch, episodes]);

  const save = async () => {
    if (session === null || episodes === null) return;
    setSaving(true);
    try {
      const stored = await api.saveRecord(toRecord(state, session, episodes));
      dispatch({ type: 'saved' });
      setSaved(stored);
      setMissing([]);
      setGoneIds([]);
      setStatus({ ok: true, text: `Saved at ${timeOf(stored.savedAt)}` });
    } catch (e) {
      setStatus({ ok: false, text: messageOf(e) });
    } finally {
      setSaving(false);
    }
  };

  const fetchAgain = async (record: SubtitleRecord, gone: RecordRelease, toshoId: number) => {
    setFetching(true);
    try {
      const release = await api.fetchRelease(toshoId, record.anilist?.episodeOffset ?? 0);
      const pooled = state.releases.map((p) => p.release).filter((r) => r.key !== release.key);
      dispatch({ type: 'load', state: fromRecord(record, [...pooled, release], episodes) });
      setMissing((m) => m.filter((x) => x.release !== gone.label));
      setGoneIds((ids) => ids.filter((id) => id !== gone.id));
      setStatus({ ok: true, text: `Fetched ${gone.label} again and restored the saved choices.` });
    } catch (e) {
      setStatus({ ok: false, text: messageOf(e) });
    } finally {
      setFetching(false);
    }
  };

  // the first saved release that is gone (or some of whose files are); one gone from the backend but back in the pool
  // (added again in step 1) no longer counts
  const gone =
    saved?.releases.find((r) => (goneIds.includes(r.id) && releaseOf(state, r.id) === null) || missing.some((m) => m.release === r.label)) ?? null;
  // saving now would write no release and no tracks over the saved ones
  const blocked = gone !== null && state.releases.length === 0;
  const goneFiles = missing.filter((m) => m.release === gone?.label).reduce((n, m) => n + m.files.length, 0);
  const toshoId = gone === null ? null : toshoIdOf(gone.id);

  return (
    <>
      <div className="actions">
        {children}
        <button type="button" className="primary" disabled={session === null || saving || blocked} onClick={() => void save()}>
          Save for encoding
        </button>
      </div>
      {(status !== null || gone !== null) && (
        <div className="save-notes">
          {status !== null && (
            <p className={status.ok ? 'save-status muted' : 'save-status error'} role="status">
              {status.text}
            </p>
          )}
          {gone !== null && saved !== null && (
            <div className="save-missing">
              <p>
                {goneFiles > 0
                  ? `${goneFiles} ${goneFiles === 1 ? 'file' : 'files'} of ${gone.label} ${goneFiles === 1 ? 'is' : 'are'} gone from the helper's cache.`
                  : `${gone.label} is gone from the helper's cache.`}{' '}
                {toshoId === null ? 'These were your own files. Add them again in step 1.' : 'Fetch it again to use the saved choices.'}
                {blocked && ' Saving is off until the release is back, so the saved choices are not overwritten.'}
              </p>
              {toshoId !== null && (
                <button type="button" className="quiet" disabled={fetching} onClick={() => void fetchAgain(saved, gone, toshoId)}>
                  {fetching ? `Fetching ${gone.label}…` : `Fetch ${gone.label} again`}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
