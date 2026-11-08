// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef, useState, type Dispatch, type ReactNode } from 'react';
import type { HelperApi } from './api';
import type { EpisodesAnswer, RecordAnswer, ReleaseAnswer, SessionInfo, SubtitleRecord } from './api-types';
import { fromRecord, toRecord, type HelperAction, type HelperState } from './helper-model';

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
 * saved record and, when there is one, for its release again, and restores both with `fromRecord` (unless the user
 * has already changed something). When the record's release or some of its cached files are gone, it says so and
 * offers "Fetch <release> again", which fetches the release from Anime Tosho and restores the saved choices onto it;
 * the user's own files cannot be fetched, so it asks to add them again. Save writes `toRecord` of the state and
 * answers "Saved at <time>" or the server's message. Renders the button row (with `children` first) and, below it,
 * the status and any missing release.
 */
export function SaveBar({ api, state, dispatch, session, episodes, children }: SaveBarProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SubtitleRecord | null>(null);
  const [missing, setMissing] = useState<RecordAnswer['missing']>([]);
  const [releaseGone, setReleaseGone] = useState(false);
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
      let release: ReleaseAnswer | null = null;
      if (record.release !== null) {
        try {
          release = await api.release(record.release.id, record.anilist?.episodeOffset ?? 0);
        } catch {
          release = null;
        }
      }
      if (!live) return;
      setSaved(record);
      setMissing(answer.missing);
      setReleaseGone(record.release !== null && release === null);
      if (dirty.current) {
        setStatus({ ok: true, text: `Choices saved ${dateTimeOf(record.savedAt)} were found after you started. Reload the page to go back to them.` });
        return;
      }
      dispatch({ type: 'load', state: fromRecord(record, release, episodes) });
      const when = dateTimeOf(record.savedAt);
      const partly = record.release !== null && release === null;
      setStatus({ ok: true, text: partly ? `Restored what was saved ${when}, except the release.` : `Restored the choices saved ${when}.` });
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
      setReleaseGone(false);
      setStatus({ ok: true, text: `Saved at ${timeOf(stored.savedAt)}` });
    } catch (e) {
      setStatus({ ok: false, text: messageOf(e) });
    } finally {
      setSaving(false);
    }
  };

  const fetchAgain = async (record: SubtitleRecord, toshoId: number) => {
    setFetching(true);
    try {
      const release = await api.fetchRelease(toshoId, record.anilist?.episodeOffset ?? 0);
      dispatch({ type: 'load', state: fromRecord(record, release, episodes) });
      setMissing([]);
      setReleaseGone(false);
      setStatus({ ok: true, text: `Fetched ${record.release?.label ?? 'the release'} again and restored the saved choices.` });
    } catch (e) {
      setStatus({ ok: false, text: messageOf(e) });
    } finally {
      setFetching(false);
    }
  };

  const gone = saved !== null && saved.release !== null && (releaseGone || missing.length > 0) ? saved.release : null;
  const goneFiles = missing.reduce((n, m) => n + m.files.length, 0);
  const toshoId = gone === null ? null : toshoIdOf(gone.id);

  return (
    <>
      <div className="actions">
        {children}
        <button type="button" className="primary" disabled={session === null || saving} onClick={() => void save()}>
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
              </p>
              {toshoId !== null && (
                <button type="button" className="quiet" disabled={fetching} onClick={() => void fetchAgain(saved, toshoId)}>
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
