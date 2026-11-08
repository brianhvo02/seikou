// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import type { HelperApi } from '../api';
import type { SessionInfo } from '../api-types';
import { showAt, type PlayerLike } from './use-controller';

const session = { discKey: 'f.0123456789ABCDEF0123456789ABCDEF', playlistId: '00000' } as SessionInfo;

describe('showAt', () => {
  it('opens the disc only after the audio output is ready', async () => {
    let audioReady!: () => void;
    const order: string[] = [];
    const controller = {
      startAudio: vi.fn(() => new Promise<void>((resolve) => (audioReady = () => { order.push('audio'); resolve(); }))),
      openRemote: vi.fn(() => order.push('open')),
      seek: vi.fn(),
    } as unknown as PlayerLike;
    const api = { remoteDisc: vi.fn(async () => ({ kind: 'remote', base: 'http://x/', token: 't', manifest: {} })) } as unknown as HelperApi;

    const shown = showAt(controller, api, session, 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.openRemote).not.toHaveBeenCalled();
    audioReady();
    await shown;
    expect(order).toEqual(['audio', 'open']);
  });
});
