// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Opening an encoded episode from the NAS in the engine: its manifest and base on the NAS's current route (HTTPS, else
 * WebRTC through a fetch port), the token refresh, the place saver, and the address bar following it. The pre-flight
 * and Next episode both go through here.
 */
import { encodePlaceKey, parseEncodeId } from '@seikou/nas/encode-id';
import { ENCODE_PLAYLIST } from '@seikou/nas/place-key';
import type { PlayerController } from '@seikou/engine/controller/player-controller';
import { LOCAL_DEVICE_NAME, type LaunchSettings, type PlaceSaver, type PlaceTarget } from '../place-saver';
import { nasEncodeSpec } from './disc-spec';
import { levelSessionOf } from './level-session';
import type { NasClient } from './nas-client';
import { pairingKey, type NasPairing } from './nas-store';
import type { PlayingRoute } from './playing-route';

/** The copy shown, instead of opening an episode, on a device that can't decode AV1. */
export const AV1_UNSUPPORTED_COPY =
  "This device can't decode AV1 video, which encoded episodes use, so this episode can't play here. Current Chrome, Edge and Firefox play AV1; Safari needs a device that decodes AV1 in hardware (iPhone 15 Pro, an M3 Mac or later).";

/** Where the AV1 warning's help link goes: the encodes section of the NAS page. */
export const ENCODES_HELP_PATH = '/help/nas#encodes';

/**
 * How long an open waits for the audio to start. Next episode's countdown opens with no user gesture, where a browser
 * may hold the audio back; the episode then opens without sound rather than not at all.
 */
export const AUDIO_START_WAIT_MS = 3000;

/** `p`, or nothing once `ms` have passed. */
function atMost(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([Promise.resolve(p).then(() => undefined), late]).finally(() => clearTimeout(timer));
}

/** What opening an encode needs. */
export interface EncodeLaunchDeps {
  readonly nas: NasClient;
  readonly controller: PlayerController;
  readonly places: PlaceSaver;
  readonly playingRoute: PlayingRoute;
}

/** The place key of an encode id (`e.<anilistId>.<episode>`); null for a malformed id. */
export function encodeKeyOf(encodeId: string): string | null {
  const parsed = parseEncodeId(encodeId);
  return parsed ? encodePlaceKey(parsed.anilistId, parsed.episode) : null;
}

/**
 * Opens `encodeId` in the engine at `startUs` (from the start without it), with the settings the player applies once it
 * plays, and starts saving its places. `stillWanted` is asked once the NAS has answered: false gives the launch up
 * before anything opens. Call it inside the click that asked for it (it starts audio).
 */
export async function launchEncode(
  deps: EncodeLaunchDeps,
  encodeId: string,
  opts: { readonly startUs?: number; readonly settings?: LaunchSettings; readonly stillWanted?: () => boolean } = {},
): Promise<boolean> {
  const { nas, controller, places, playingRoute } = deps;
  const discKey = encodeKeyOf(encodeId);
  if (discKey === null) throw new Error(`Not an encode id: ${encodeId}`);
  // Inside the gesture, before anything is awaited; and waited for (it never rejects), since an encode opens in moments
  // and one that starts before the audio ring reaches the engine plays without sound. Never for longer than
  // AUDIO_START_WAIT_MS: with no gesture (Next episode's countdown) the start may never come.
  const audio = atMost(controller.startAudio(), AUDIO_START_WAIT_MS);
  const [base, session, pairing, manifest] = await Promise.all([nas.encodeBase(encodeId), nas.session(), nas.pairing(), nas.encodeManifest(encodeId), audio]);
  if (opts.stillWanted && !opts.stillWanted()) return false;
  // The engine asks again only after the NAS refused the token it has, so that one is never handed back.
  let token = session.token;
  levelSessionOf(nas).end(); // a disc's quality lease, if one was open, is not this episode's
  const { spec, release } = nasEncodeSpec(base, token, manifest, nas.discFetch, encodeId);
  playingRoute.startEncode(encodeId);
  controller.openEncode(spec, () => nas.freshSession(token).then((s) => (token = s.token)), opts.startUs, release);
  places.begin(encodePlaceTarget(discKey, encodeId, pairing), opts.settings);
  return true;
}

/** What the place saver saves an encode under: its `e.` key, its id, its one playlist, through `pairing`. */
export function encodePlaceTarget(discKey: string, encodeId: string, pairing: NasPairing | null): PlaceTarget {
  return {
    discKey, discId: encodeId, remote: true, chosen: ENCODE_PLAYLIST, mainPlaylistId: ENCODE_PLAYLIST, encode: true,
    deviceName: pairing?.deviceName ?? LOCAL_DEVICE_NAME, pairing: pairing ? pairingKey(pairing) : null,
  };
}

/**
 * Saves the open encode's places again, as finished (Next episode saved it finished, then the next episode didn't
 * open), while it is still the one open under `opens`.
 */
export async function resumeFinishedPlaces(deps: Pick<EncodeLaunchDeps, 'nas' | 'controller' | 'places'>, encodeId: string, opens: number): Promise<void> {
  const discKey = encodeKeyOf(encodeId);
  if (discKey === null) return;
  const pairing = await deps.nas.pairing();
  const now = deps.controller.getSnapshot();
  if (now.encodeId !== encodeId || deps.controller.discOpens !== opens) return;
  // the notes Next episode kept (text files' sizes, the NAS subtitle) are this episode's still
  deps.places.begin({ ...encodePlaceTarget(discKey, encodeId, pairing), finished: true }, undefined, { keepNotes: true });
}
