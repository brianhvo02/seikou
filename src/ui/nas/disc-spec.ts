import type { RemoteDiscSpec } from '@seikou/engine/disc/disc-spec';
import type { EncodeSpec } from '@seikou/engine/protocol';
import type { DiscManifest, LevelAt } from '@seikou/nas/nas-api';
import { serveFetch } from '@seikou/engine/disc/port-fetch';

/** A NAS disc for the engine, and what to call once it is closed. */
export interface NasDiscOpen {
  readonly spec: RemoteDiscSpec;
  readonly release: () => void;
}

/** The files-request query for a version of the disc; undefined for Original, which is read as it is. */
export function levelQuery(at: LevelAt | undefined): string | undefined {
  return at && at.level !== 'original' ? `level=${at.level}&audio=${at.audio}` : undefined;
}

/**
 * The engine's spec for a NAS disc at `base`. Over HTTPS the engine fetches the disc itself. Over WebRTC (`rtc://`)
 * the connection lives on this thread, so the spec carries a fetch port whose requests `discFetch` answers here
 * (`NasClient.discFetch`, which follows the NAS's current connection); `release` stops answering them. For a level,
 * `manifest` is the level's and `original` the disc's own, which the BD-J worker reads.
 */
export function nasDiscSpec(
  base: string,
  token: string,
  manifest: DiscManifest,
  discFetch: typeof fetch,
  level?: { readonly at: LevelAt; readonly original: DiscManifest },
): NasDiscOpen {
  const query = levelQuery(level?.at);
  const extra = query === undefined ? {} : { query, original: level!.original };
  if (!base.startsWith('rtc://')) return { spec: { kind: 'remote', base, token, manifest, ...extra }, release: () => undefined };
  const { port1, port2 } = new MessageChannel();
  const stop = serveFetch(port1, discFetch);
  return {
    spec: { kind: 'remote', base, token, manifest, ...extra, fetchPort: port2 },
    release: () => {
      stop();
      port1.close();
    },
  };
}

/** An encoded episode for the engine, and what to call once it is closed. */
export interface NasEncodeOpen {
  readonly spec: EncodeSpec;
  readonly release: () => void;
}

/**
 * The engine's spec for an encoded episode at `base` (`NasClient.encodeBase`), on the same route as a NAS disc's: over
 * WebRTC its reads come back through a fetch port that `discFetch` answers here, which `release` stops.
 */
export function nasEncodeSpec(base: string, token: string, manifest: DiscManifest, discFetch: typeof fetch, encodeId: string): NasEncodeOpen {
  if (!base.startsWith('rtc://')) return { spec: { base, token, manifest, encodeId }, release: () => undefined };
  const { port1, port2 } = new MessageChannel();
  const stop = serveFetch(port1, discFetch);
  return {
    spec: { base, token, manifest, encodeId, fetchPort: port2 },
    release: () => {
      stop();
      port1.close();
    },
  };
}
