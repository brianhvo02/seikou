// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ContinueItem, DiscPlaces, EncodeDetail } from '@seikou/nas/nas-api';
import { ENCODE_PLAYLIST } from '@seikou/nas/place-key';
import type { PlayerController } from '@seikou/engine/controller/player-controller';
import type { LaunchSettings, PlaceSaver } from '../place-saver';
import { av1Playable } from '../video-caps';
import { durationLabel } from './encodes-model';
import { AV1_UNSUPPORTED_COPY, ENCODES_HELP_PATH, encodeKeyOf, launchEncode } from './encode-launch';
import { AppLink } from '../help/HelpLink';
import { PLACES_READ_TIMEOUT_MS, type NasClient } from './nas-client';
import type { NasHistory } from './nas-history';
import type { NasRoute } from './nas-route';
import type { PlayingRoute } from './playing-route';
import { ResumePrompt } from './ResumePrompt';
import { resumeOffer, within, type ResumeOffer } from './resume-model';

const ENCODES: NasRoute = { kind: 'encodes', q: '' };
const NO_OFFER: ResumeOffer = { kind: 'none' };
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface EncodePreflightProps {
  readonly nas: NasClient;
  readonly controller: PlayerController;
  readonly places: PlaceSaver;
  readonly history: NasHistory;
  readonly playingRoute: PlayingRoute;
  readonly encodeId: string;
  /** A play link's time: the episode starts there without asking (unless `resume`). */
  readonly startTimeS: number | null;
  /** From a Continue watching card or an episode's Resume: Resume is the one way on. */
  readonly resume: boolean;
  /** For tests: whether this device decodes the encode's AV1 (av1Playable by default). */
  readonly checkAv1?: (codec?: string) => Promise<boolean>;
}

/**
 * The episode's offer from its places: as resumeOffer for its one playlist, where a place that no longer fits (at or
 * past its length) is no place: an encode has no "changed" case.
 */
export function encodeOffer(places: DiscPlaces | null): ResumeOffer {
  const offer = resumeOffer(places, ENCODE_PLAYLIST, null);
  return offer.kind === 'changed' ? NO_OFFER : offer;
}

/** What a launch with no place of its own carries: an Up next card's settings for this episode, else the episode's defaults. */
export function encodeCarried(items: readonly ContinueItem[] | null, encodeId: string, places: DiscPlaces | null): LaunchSettings | undefined {
  const upNext = items?.find((i) => i.kind === 'up-next' && i.encodeId === encodeId && i.settings !== null)?.settings;
  const settings = upNext ?? places?.defaults ?? null;
  return settings ? { settings, byLanguage: true } : undefined;
}

/**
 * Before an encoded episode plays: whether this device decodes AV1 (when it can't, a warning and nothing opens), then
 * Resume at m:ss or Start from beginning for a place (Resume only from a Continue watching card), else Play.
 */
export function EncodePreflight({ nas, controller, places, history, playingRoute, encodeId, startTimeS, resume, checkAv1 = av1Playable }: EncodePreflightProps): ReactElement {
  const placeKey = encodeKeyOf(encodeId);
  /** undefined while asked; null when the NAS has no such episode. */
  const [entry, setEntry] = useState<EncodeDetail | null | undefined>(undefined);
  const [av1, setAv1] = useState<boolean | undefined>(undefined);
  const [stored, setStored] = useState<DiscPlaces | null | undefined>(undefined);
  const [items, setItems] = useState<readonly ContinueItem[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    let on = true;
    setEntry(undefined);
    setAv1(undefined);
    nas.encode(encodeId).then(
      (e) => {
        if (!on) return;
        setEntry(e);
        if (e) void checkAv1(e.tracks.find((t) => t.kind === 'video')?.codec).then((ok) => on && setAv1(ok), () => on && setAv1(false));
      },
      (err: unknown) => on && setError(message(err)),
    );
    return () => {
      on = false;
    };
  }, [nas, encodeId, checkAv1]);

  // The places, never waited on for longer than PLACES_READ_TIMEOUT_MS: a failed or stalled request is no place.
  useEffect(() => {
    if (placeKey === null) return;
    let on = true;
    setStored(undefined);
    void within(nas.playbackPlaces(placeKey, { timeoutMs: PLACES_READ_TIMEOUT_MS }), PLACES_READ_TIMEOUT_MS, null).then((p) => on && setStored(p));
    return () => {
      on = false;
    };
  }, [nas, placeKey]);

  /** A play link's own time names where to play: no question then, unless it comes from a Continue watching card. */
  const offers = startTimeS === null || resume;
  const offer = useMemo(() => (offers && stored !== undefined ? encodeOffer(stored) : NO_OFFER), [offers, stored]);
  const wantsCarried = stored !== undefined && offer.kind === 'none';
  useEffect(() => {
    if (!wantsCarried) return;
    let on = true;
    void within<readonly ContinueItem[] | null>(nas.continueWatching({ timeoutMs: PLACES_READ_TIMEOUT_MS, library: 'encodes' }), PLACES_READ_TIMEOUT_MS, null).then((list) => on && setItems(list));
    return () => {
      on = false;
    };
  }, [nas, wantsCarried]);
  const ready = entry != null && av1 === true && stored !== undefined && (!wantsCarried || items !== undefined) && !opening;

  const go = (startUs: number | undefined, settings: LaunchSettings | undefined): void => {
    setOpening(true);
    setError(null);
    const stillWanted = (): boolean => {
      const r = history.route();
      return live.current && r?.kind === 'encodePlay' && r.encodeId === encodeId;
    };
    launchEncode({ nas, controller, places, playingRoute }, encodeId, { ...(startUs !== undefined ? { startUs } : {}), ...(settings ? { settings } : {}), stillWanted }).then(
      (opened) => {
        if (!opened && live.current) setOpening(false);
      },
      (err: unknown) => {
        if (!live.current) return;
        setOpening(false);
        setError(message(err));
      },
    );
  };
  const placeSettings = (o: ResumeOffer): LaunchSettings | undefined => (o.kind === 'none' ? undefined : { settings: o.place.settings, byLanguage: false });
  const play = (): void =>
    offer.kind === 'short' ? go(undefined, placeSettings(offer)) : go(startTimeS !== null ? startTimeS * 1e6 : undefined, encodeCarried(items ?? null, encodeId, stored ?? null));
  const back = (): void => history.back(ENCODES);

  const name = entry ? (entry.episodeTitle ?? `Episode ${entry.episode}`) : null;
  const length = entry ? durationLabel(entry.durationMs) : null;

  if (av1 === false) {
    return (
      <section className="preflight encode-preflight" data-testid="encode-av1-unsupported">
        {name && <h3>{name}</h3>}
        <p className="encode-av1-copy" role="alert">
          {AV1_UNSUPPORTED_COPY}
        </p>
        <div className="preflight-actions">
          <AppLink history={history} to={ENCODES_HELP_PATH} className="title-link" testId="encode-av1-help">
            About encodes
          </AppLink>
          <button type="button" className="title-link" onClick={back}>
            Back
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="preflight encode-preflight" data-testid="encode-preflight">
      {entry === null ? (
        <p className="status" data-testid="encode-missing">
          This episode isn&rsquo;t on the NAS any more.
        </p>
      ) : (
        <>
          <h3>{name ?? 'Loading…'}</h3>
          {entry && <p className="library-meta">{[`Episode ${entry.episode}`, ...(length ? [length] : [])].join(' · ')}</p>}
        </>
      )}
      {error && (
        <div className="error-banner" role="alert" data-testid="nas-error">
          {error}
        </div>
      )}
      {offer.kind === 'ask' && (
        <ResumePrompt
          place={offer.place}
          changed={false}
          resumeOnly={resume}
          disabled={!ready}
          nowMs={Date.now()}
          onResume={() => go(offer.place.timeUs, placeSettings(offer))}
          onStartOver={() => go(undefined, placeSettings(offer))}
        />
      )}
      <div className="preflight-actions">
        {offer.kind !== 'ask' && entry !== null && (
          <button type="button" className="primary" data-testid="encode-preflight-play" disabled={!ready} onClick={play}>
            {opening ? 'Opening…' : 'Play'}
          </button>
        )}
        <button type="button" onClick={back}>
          Back
        </button>
      </div>
    </section>
  );
}
