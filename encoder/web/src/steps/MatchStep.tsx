// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Dispatch } from 'react';
import type { HelperApi } from '../api';
import { candidatesFor, releaseOf, type HelperAction, type HelperState } from '../helper-model';
import { useEpisodeTitles } from '../episode-titles';
import { languageName } from '../metadata/metadata-model';
import { fileValue, parseFileValue, unusedFiles } from './match-model';

/** What step 2 needs: the backend client, the page's state and the dispatcher that changes it. */
export interface MatchStepProps {
  /** The backend client; asked for the show's episode titles unless the page already has them. */
  readonly api: HelperApi;
  /** The page's state; the step reads the show, the pooled releases and the choices. */
  readonly state: HelperState;
  /** Applies an action to the page's state. */
  readonly dispatch: Dispatch<HelperAction>;
}

/** One episode, shown by its release number: its title, the release file it uses, that file's tracks to tick, and "No subtitles". */
function EpisodeRow({ episode, state, number, title, dispatch }: {
  episode: number;
  state: HelperState;
  /** The episode's number as the release and AniList count it: the run's episode plus the episode offset. */
  number: number;
  title: string | undefined;
  dispatch: Dispatch<HelperAction>;
}) {
  const choice = state.choices[episode];
  const none = choice === 'none';
  const options = candidatesFor(state, episode);
  // an episode marked as having no subtitles shows, disabled, the file unticking "No subtitles" brings back
  const fallback = options.find((c) => c.matched) ?? null;
  const shown = choice === 'none' ? fallback : choice === undefined ? null : choice;
  const file = shown === null ? null : (releaseOf(state, shown.releaseKey)?.release.files.find((f) => f.id === shown.fileId) ?? null);
  const ticked = new Set(choice === undefined || choice === 'none' ? [] : choice.trackIds);
  const value = shown === null ? '' : fileValue(shown.releaseKey, shown.fileId);
  const heading = `Episode ${number}`;

  const toggle = (trackId: string, on: boolean) => {
    const next = (file?.tracks ?? []).map((t) => t.id).filter((id) => (id === trackId ? on : ticked.has(id)));
    dispatch({ type: 'chooseTracks', episode, trackIds: next });
  };
  const choose = (picked: { releaseKey: string; fileId: string } | null) =>
    dispatch({ type: 'chooseFile', episode, releaseKey: picked?.releaseKey ?? null, fileId: picked?.fileId ?? null });

  return (
    <li>
      <fieldset className="match-row" aria-label={title === undefined ? heading : `${heading}, ${title}`}>
        <div className="match-episode">
          <span className="match-number num">{number}</span>
          <span className="match-title">{title ?? heading}</span>
        </div>
        <div className="match-body">
          <select
            aria-label={`Release file for ${heading}`}
            value={value}
            onChange={(e) => choose(parseFileValue(e.target.value))}
          >
            <option value="">No file</option>
            {options.map((c) => {
              const v = fileValue(c.releaseKey, c.fileId);
              return (
                <option key={v} value={v}>
                  {releaseOf(state, c.releaseKey)?.release.files.find((f) => f.id === c.fileId)?.name ?? c.fileId}
                </option>
              );
            })}
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
                e.target.checked ? dispatch({ type: 'markNone', episode }) : choose(fallback)
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
 * Step 2: one row per disc episode, numbered as the release numbers it (the run's episode plus the episode offset),
 * with its AniList title for that number (or "Episode n"), the file it uses from any pooled release (`candidatesFor`),
 * that file's tracks as checkboxes and "No subtitles". Release files no episode uses are listed under "Not matched".
 * Episode titles are asked of the backend once per show and shared with the page (`useEpisodeTitles`); if that
 * fails, the rows show "Episode n".
 */
export function MatchStep({ api, state, dispatch }: MatchStepProps) {
  const titles = useEpisodeTitles(api, state.title?.alId ?? null);

  // every release's match has one row per episode of the run
  const episodes = state.releases[0]?.release.match.rows.map((r) => r.episode);
  if (episodes === undefined) return null;
  const unused = unusedFiles(state).flatMap((r) => r.files.map((f) => ({ key: fileValue(r.pooled.release.key, f.id), name: f.name })));

  return (
    <div className="match-step">
      <section aria-labelledby="match-heading">
        <h2 id="match-heading">Match episodes</h2>
        <p className="muted">Check which release file goes with each episode, and which of its tracks to keep.</p>
        <ul className="match-rows">
          {episodes.map((episode) => (
            <EpisodeRow key={episode} episode={episode} state={state} number={episode + state.episodeOffset} title={titles?.[episode + state.episodeOffset]} dispatch={dispatch} />
          ))}
        </ul>
      </section>

      {unused.length > 0 && (
        <section className="match-unmatched" aria-labelledby="unmatched-heading">
          <h2 id="unmatched-heading">Not matched</h2>
          <p className="muted">These files fit no episode. Pick one in an episode's file list to use it.</p>
          <ul aria-labelledby="unmatched-heading">
            {unused.map((f) => (
              <li key={f.key}>{f.name}</li>
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
