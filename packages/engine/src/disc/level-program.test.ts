import { describe, expect, it } from 'vitest';
import { buildSyntheticDisc, lpcmStream, syntheticClip } from '../../../../tests/helpers/synthetic-disc';
import { fakeNas } from '../../../../tests/helpers/fake-nas';
import { levelAudioOf, withOriginalAudio } from './level-program';
import { openDisc } from './open-disc';
import { FileSource } from './file-source';
import { normalizeDiscPaths } from './paths';
import type { RemoteDiscSpec } from './disc-spec';

const discWith = (streams: number) =>
  buildSyntheticDisc({
    clips: [syntheticClip('00001', 2, { audioStreams: Array.from({ length: streams }, (_, i) => lpcmStream(0x1100 + i, 2)) })],
    playlists: [{ id: '00000', clipIds: ['00001'] }],
  });

describe('levelAudioOf', () => {
  const base: RemoteDiscSpec = { kind: 'remote', base: 'https://nas/api/discs/d1/', token: 't', manifest: { discId: 'd1', name: 'D', files: [], inline: {} } };
  it("reads a level's audio, and nothing at the original or for picked files", () => {
    expect(levelAudioOf({ ...base, query: 'level=h264-1080&audio=3', original: base.manifest })).toBe(3);
    expect(levelAudioOf({ ...base, query: 'level=h264-1080', original: base.manifest })).toBe(1);
    expect(levelAudioOf(base)).toBeNull();
    expect(levelAudioOf({ ...base, query: 'level=h264-1080&audio=2' })).toBeNull(); // no original: not a level spec
    expect(levelAudioOf({ kind: 'files', entries: [] })).toBeNull();
  });
});

describe('withOriginalAudio', () => {
  it("gives the level's play items the original's audio streams", async () => {
    const level = await openDisc(new FileSource(normalizeDiscPaths([...discWith(1)].map(([p, b]) => [p, new Blob([b])] as const))));
    const original = fakeNas(discWith(3)).spec.manifest;
    const view = withOriginalAudio(level, original);
    expect(view.playlists.get('00000')!.playItems[0]!.stn.audio).toHaveLength(3);
    expect(level.playlists.get('00000')!.playItems[0]!.stn.audio).toHaveLength(1); // the level's model is untouched
    expect(view.clips).toBe(level.clips);
  });
});
