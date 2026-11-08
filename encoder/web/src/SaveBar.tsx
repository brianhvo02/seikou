// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef, useState, type Dispatch, type ReactNode } from 'react';
import { ApiError, type HelperApi } from './api';
import type { EpisodesAnswer, RecordAnswer, RecordRelease, ReleaseAnswer, SessionInfo, SubtitleRecord } from './api-types';
import { currentForm, fromRecord, releaseOf, toRecord, type HelperAction, type HelperState } from './helper-model';

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
 * Save for encoding, and what the saved record says when the page loads. Once the run is known it asks for the saved
 * record and, when there is one, for each of its releases again, and restores the record with the releases that came
 * back (`fromRecord`), unless the user has already changed something. When one of the record's releases or some of its
 * cached files are gone, it names each such release and offers "Fetch <release> again", which fetches it from Anime
 * Tosho, puts it back in the pool and restores the saved choices of the episodes that use it (`restoreRelease`),
 * leaving the rest of the page as the user has it; the user's own files cannot be fetched, so it asks to add them
 * again. While an episode with no file now had tracks from a saved release that is missing and not back in the pool,
 * Save is off, because it would write the record without its tracks. When the disc's playlist has choices saved for
 * another episode list (said on load, or by a save the backend refused for it), a line says so and that saving here
 * replaces them, and only then does Save ask the backend to replace them. Save writes `toRecord` of the state and
 * answers "Saved at <time>" or the server's message. Renders the button row (with `children` first) and, below it, the status
 * and any missing release.
 */
export function SaveBar({ api, state, dispatch, session, episodes, children }: SaveBarProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SubtitleRecord | null>(null);
  const [missing, setMissing] = useState<RecordAnswer['missing']>([]);
  // ids of the saved record's releases the backend no longer holds
  const [goneIds, setGoneIds] = useState<readonly string[]>([]);
  // id of the release being fetched again
  const [fetching, setFetching] = useState<string | null>(null);
  // the episode list another save of this playlist was made for; while it is shown, Save replaces that save
  const [otherSpec, setOtherSpec] = useState<string | null>(null);
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
      if (answer.otherEpisodeSpec !== undefined) setOtherSpec(answer.otherEpisodeSpec);
      if (answer.record === null) return;
      const record = currentForm(answer.record);
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
      const stored = await api.saveRecord(toRecord(state, session, episodes), otherSpec !== null);
      setOtherSpec(null);
      dispatch({ type: 'saved' });
      setSaved(stored);
      setMissing([]);
      setGoneIds([]);
      setStatus({ ok: true, text: `Saved at ${timeOf(stored.savedAt)}` });
    } catch (e) {
      const spec = e instanceof ApiError && e.code === 'other-episode-spec' ? e.details.episodeSpec : undefined;
      if (typeof spec === 'string') {
        // nothing was saved: the line below now says what saving again replaces
        setOtherSpec(spec);
        setStatus(null);
      } else setStatus({ ok: false, text: messageOf(e) });
    } finally {
      setSaving(false);
    }
  };

  const fetchAgain = async (record: SubtitleRecord, gone: RecordRelease, toshoId: number) => {
    setFetching(gone.id);
    try {
      const release = await api.fetchRelease(toshoId, state.episodeOffset);
      dispatch({ type: 'restoreRelease', record, release, disc: episodes });
      setMissing((m) => m.filter((x) => x.id !== gone.id));
      setGoneIds((ids) => ids.filter((id) => id !== gone.id));
      setStatus({ ok: true, text: `Fetched ${gone.label} again and restored the saved choices that use it.` });
    } catch (e) {
      setStatus({ ok: false, text: messageOf(e) });
    } finally {
      setFetching(null);
    }
  };

  // the saved releases that are gone (or some of whose files are); one gone from the backend but back in the pool
  // (added again in step 1) no longer counts
  const missingOf = (r: RecordRelease): number => missing.filter((m) => m.id === r.id).reduce((n, m) => n + m.files.length, 0);
  const gone = (saved?.releases ?? []).filter((r) => (goneIds.includes(r.id) && releaseOf(state, r.id) === null) || missingOf(r) > 0);
  // saving now would write no tracks for the episodes that used a release that is not in the pool
  // (an episode the user has since given another file or marked none no longer counts)
  const blocks = (r: RecordRelease): boolean =>
    releaseOf(state, r.id) === null && (saved?.episodes.some((e) => state.choices[e.index] === undefined && e.tracks.some((t) => t.release === r.id)) ?? false);
  const blocked = gone.some(blocks);

  return (
    <>
      <div className="actions">
        {children}
        <button type="button" className="primary" disabled={session === null || saving || blocked} onClick={() => void save()}>
          Save for encoding
        </button>
      </div>
      {(status !== null || gone.length > 0 || otherSpec !== null) && (
        <div className="save-notes">
          {otherSpec !== null && <p className="save-status">{`Subtitle choices are saved for episodes ${otherSpec}; saving here replaces them.`}</p>}
          {status !== null && (
            <p className={status.ok ? 'save-status muted' : 'save-status error'} role="status">
              {status.text}
            </p>
          )}
          {saved !== null &&
            gone.map((r) => {
              const files = missingOf(r);
              const toshoId = toshoIdOf(r.id);
              return (
                <div className="save-missing" key={r.id}>
                  <p>
                    {files > 0
                      ? `${files} ${files === 1 ? 'file' : 'files'} of ${r.label} ${files === 1 ? 'is' : 'are'} gone from the helper's cache.`
                      : `${r.label} is gone from the helper's cache.`}{' '}
                    {toshoId === null ? 'These were your own files. Add them again in step 1.' : 'Fetch it again to use the saved choices.'}
                    {blocks(r) && ' Saving is off until the release is back, so the saved choices are not overwritten.'}
                  </p>
                  {toshoId !== null && (
                    <button type="button" className="quiet" disabled={fetching !== null} onClick={() => void fetchAgain(saved, r, toshoId)}>
                      {fetching === r.id ? `Fetching ${r.label}…` : `Fetch ${r.label} again`}
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </>
  );
}
