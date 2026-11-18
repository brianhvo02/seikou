// @vitest-environment jsdom
// SPDX-License-Identifier: LGPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { VideoDecoderSpeed } from '@seikou/engine/protocol';
import { INITIAL_SNAPSHOT, type PlayerController } from '@seikou/engine/controller/player-controller';
import { fakeNas } from '../../../tests/helpers/fake-nas';
import type { PlaceSaver } from '../place-saver';
import { DEVICE_CHECK_COPY, ORIGINAL_ONLY } from './level-model';
import type { NasClient } from './nas-client';
import { NasHistory } from './nas-history';
import { PlayingRoute } from './playing-route';
import { Preflight } from './Preflight';

afterEach(cleanup);

/** A committed synthetic disc's files by path (fixtureDiscFiles resolves its folder from import.meta.url, which jsdom changes). */
function discFiles(name: string): Map<string, Uint8Array<ArrayBuffer>> {
  const root = join(process.cwd(), 'fixtures/synthetic', name);
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(root, path), new Uint8Array(readFileSync(path)));
  }
  return files;
}

describe('the NAS pre-flight', () => {
  it("says it is checking the device while an MPEG-2 disc's decoder speed probe runs, and not once it settles", async () => {
    const manifest = fakeNas(discFiles('disc-mpeg2')).spec.manifest;
    const nas = {
      manifest: vi.fn(async () => manifest),
      probe: vi.fn(async () => ({ mbps: 500 })),
      playbackPlaces: vi.fn(async () => null),
      continueWatching: vi.fn(async () => []),
      levels: vi.fn(async () => ORIGINAL_ONLY),
    } as unknown as NasClient;
    let answer: (speed: VideoDecoderSpeed | null) => void = () => undefined;
    const controller = {
      subscribe: () => () => undefined,
      getSnapshot: () => INITIAL_SNAPSHOT,
      probeVideoDecoder: vi.fn(() => new Promise<VideoDecoderSpeed | null>((resolve) => (answer = resolve))),
    } as unknown as PlayerController;
    const history = new NasHistory(window);
    render(
      <Preflight
        nas={nas}
        controller={controller}
        disc={{ id: 'd1', name: 'A made-up disc', kind: 'folder', sizeBytes: null }}
        history={history}
        playingRoute={new PlayingRoute(history, () => 0)}
        places={{ begin: vi.fn() } as unknown as PlaceSaver}
        onFacts={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const line = await screen.findByTestId('nas-device-check');
    expect(line.textContent).toBe(DEVICE_CHECK_COPY);
    expect((screen.getByTestId('nas-play') as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(controller.probeVideoDecoder).toHaveBeenCalled());
    // no measurement: the pre-flight goes on without one
    await act(async () => answer(null));
    await waitFor(() => expect(screen.queryByTestId('nas-device-check')).toBeNull());
    await waitFor(() => expect((screen.getByTestId('nas-play') as HTMLButtonElement).disabled).toBe(false));
  });
});
