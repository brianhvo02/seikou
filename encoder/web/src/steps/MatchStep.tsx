// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Dispatch } from 'react';
import type { HelperApi } from '../api';
import type { CachedRelease, MatchRow } from '../api-types';
import type { HelperAction, HelperState } from '../helper-model';
import { useEpisodeTitles } from '../episode-titles';
import { languageName } from '../metadata/metadata-model';
import { optionsFor, unusedFiles } from './match-model';

/** What step 2 needs: the backend client, the page's state and the dispatcher that changes it. */
export interface MatchStepProps {
  /** The backend client; asked for the show's episode titles unless the page already has them. */
  readonly api: HelperApi;
  /** The page's state; the step reads the show, the release, its match and the choices. */
  readonly state: HelperState;
  /** Applies an action to the page's state. */
  readonly dispatch: Dispatch<HelperAction>;
}

/** One episode: its title, the release file it uses, that file's tracks to tick, and "No subtitles". */
function EpisodeRow({ row, release, rows, state, title, dispatch }: {
  row: MatchRow;
  release: CachedRelease;
  rows: readonly MatchRow[];
  state: HelperState;
  title: string | undefined;
  dispatch: Dispatch<HelperAction>;
}) {
  const choice = state.choices[row.episode];
  const none = choice === 'none';
  const file = release.files.find((f) => f.id === row.fileId) ?? null;
  const ticked = new Set(choice === undefined || choice === 'none' ? [] : choice.trackIds);
  const options = optionsFor(release, rows, row);
  const heading = `Episode ${row.episode}`;

  const toggle = (trackId: string, on: boolean) => {
    const next = (file?.tracks ?? []).map((t) => t.id).filter((id) => (id === trackId ? on : ticked.has(id)));
    dispatch({ type: 'chooseTracks', episode: row.episode, trackIds: next });
  };

  return (
    <li>
      <fieldset className="match-row" aria-label={title === undefined ? heading : `${heading}, ${title}`}>
        <div className="match-episode">
          <span className="match-number num">{row.episode}</span>
          <span className="match-title">{title ?? heading}</span>
        </div>
        <div className="match-body">
          <select
            aria-label={`Release file for ${heading}`}
            value={row.fileId ?? ''}
            onChange={(e) => dispatch({ type: 'chooseFile', episode: row.episode, fileId: e.target.value === '' ? null : e.target.value })}
          >
            <option value="">No file</option>
            {options.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          {file !== null && file.tracks.length > 0 ? (
            <ul className="match-tracks">
              {file.tracks.map((t) => {
                const language = languageName(t.language) || t.language;
                return (
                  <li key={t.id}>
                    <label className="check">
                      <input type="checkbox" checked={ticked.has(t.id)} disabled={none} onChange={(e) => toggle(t.id, e.target.checked)} />
                      <span>{t.name}</span>
                      <span className="muted">
                        {t.kind}
                        {language !== '' ? `, ${language}` : ''}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">{file === null ? 'No release file for this episode.' : 'This file has no subtitle tracks.'}</p>
          )}
          <label className="check match-none">
            <input
              type="checkbox"
              checked={none}
              onChange={(e) =>
                e.target.checked ? dispatch({ type: 'markNone', episode: row.episode }) : dispatch({ type: 'chooseFile', episode: row.episode, fileId: row.fileId })
              }
            />
            <span>No subtitles</span>
          </label>
        </div>
      </fieldset>
    </li>
  );
}

/**
 * Step 2: one row per disc episode with its AniList title (or "Episode n"), the release file it uses, that file's
 * tracks as checkboxes and "No subtitles". Release files no episode uses are listed under "Not matched". Episode
 * titles are asked of the backend once per show and shared with the page (`useEpisodeTitles`); if that fails, the
 * rows show "Episode n".
 */
export function MatchStep({ api, state, dispatch }: MatchStepProps) {
  const titles = useEpisodeTitles(api, state.title?.alId ?? null);

  const release = state.release;
  if (release === null) return null;
  const unused = unusedFiles(release, state.match);

  return (
    <div className="match-step">
      <section aria-labelledby="match-heading">
        <h2 id="match-heading">Match episodes</h2>
        <p className="muted">Check which release file goes with each episode, and which of its tracks to keep.</p>
        <ul className="match-rows">
          {state.match.map((row) => (
            <EpisodeRow key={row.episode} row={row} release={release} rows={state.match} state={state} title={titles?.[row.episode]} dispatch={dispatch} />
          ))}
        </ul>
      </section>

      {unused.length > 0 && (
        <section className="match-unmatched" aria-labelledby="unmatched-heading">
          <h2 id="unmatched-heading">Not matched</h2>
          <p className="muted">These files fit no episode. Pick one in an episode's file list to use it.</p>
          <ul aria-labelledby="unmatched-heading">
            {unused.map((f) => (
              <li key={f.id}>{f.name}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="step-next">
        <button type="button" className="primary" onClick={() => dispatch({ type: 'goTo', step: 3 })}>
          Next
        </button>
      </div>
    </div>
  );
}
