import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Auth, Device } from '../auth';
import { HttpError, json } from '../http';
import type { Handler, Response } from '../http';
import type { RelayState } from '../rtc/relay';
import type { OwnerStore } from '@seikou/titles/owner-store';
import type { TitleService } from '../titles/service';
import { bearerToken } from './admin';

/** What the title and owner routes work on. */
export interface TitleLibrary {
  readonly service: TitleService;
  readonly owner: OwnerStore;
}

/** The catalogue's art ids (`artIdOf`); anything else is unknown (ruling T9d). */
const ART_ID = /^[0-9a-f]{32}$/;
const ART_CACHE = 'private, max-age=2592000, immutable';

const notFound = (): Response => json(404, { error: 'not found' });

/** The request's device, from `Authorization: Bearer` or `t=`; `requireToken` has already let only valid ones through. */
export function requestDevice(auth: Auth, authorization: string | undefined, url: URL): Device | null {
  const token = bearerToken(authorization) ?? url.searchParams.get('t');
  return token === null ? null : auth.verify(token);
}

export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'bad request');
  }
}

/**
 * `GET /api/me`, `GET /api/titles`, `GET /api/titles/<id>` and `GET /api/art/<artId>?size=small|large`, behind the
 * token guard. While the gate is `owners`, a guest gets 404 from every title route, so the library's existence isn't
 * revealed (ruling T9c); `me` answers every paired device, with the relay's usage while the relay is on (else null)
 * and the NAS's rendezvous id (`nasId`, null without a rendezvous), so a pairing made before the WebRTC route learns it,
 * and whether the NAS offers quality levels (`levels`: false when `LEVELS_BACKEND` is off or the GPU self-test failed).
 */
export function titleRoutes(auth: Auth, library: TitleLibrary, relay?: RelayState, nasId: string | null = null, levels = false): Handler {
  const { service } = library;
  return async (req, url) => {
    if (req.method !== 'GET') return null;
    const path = url.pathname;
    const isMe = path === '/api/me';
    const isTitles = path === '/api/titles' || path.startsWith('/api/titles/');
    const isArt = path.startsWith('/api/art/');
    if (!isMe && !isTitles && !isArt) return null;
    const device = requestDevice(auth, req.headers.authorization, url);
    if (!device) return json(401, { error: 'unauthorized' });
    const open = device.owner || service.gate() === 'everyone';
    if (isMe) {
      const usage = relay?.settings().enabled ? relay.usage() : null;
      return json(200, { owner: device.owner, titleLibrary: open, personId: device.personId, personName: device.personName, relay: usage, nasId, levels });
    }
    if (!open) return notFound();

    const segments = path.split('/').slice(3);
    if (segments.length > 1) return notFound();
    const catalogue = service.catalogue();
    if (isTitles) {
      if (segments.length === 0) return json(200, { titles: catalogue.titles });
      const detail = catalogue.detail(decodeSegment(segments[0]!));
      return detail ? json(200, detail) : notFound();
    }

    const artId = segments[0]!;
    const size = url.searchParams.get('size') ?? 'small';
    if (!ART_ID.test(artId) || (size !== 'small' && size !== 'large')) return notFound();
    // lookup results' posters only for owners, who alone can look up (ruling T9e)
    const source = catalogue.art(artId) ?? service.encodeArtUrls(artId) ?? (device.owner ? service.lookupArtUrls(artId) : null);
    if (!source) return notFound();
    // a folder cover's file comes only from the catalogue, which found it itself; never from the request
    const cached = await service.art.get(artId, size, 'file' in source ? { file: source.file } : source[size]);
    if (!cached) return notFound();
    let length: number;
    try {
      length = (await stat(cached.path)).size;
    } catch {
      return notFound();
    }
    return {
      status: 200,
      headers: {
        'Content-Type': cached.type,
        'Content-Length': String(length),
        'Cache-Control': ART_CACHE,
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
      body: createReadStream(cached.path),
    };
  };
}
