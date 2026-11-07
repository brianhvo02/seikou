import { CodingType } from '@seikou/bdmv/stream-types';
import { buildSyntheticDisc, syntheticClip } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';

function write(outDir: string, files: ReadonlyMap<string, Uint8Array>, skip: (path: string) => boolean = () => false): void {
  writeFixture(outDir, files, skip);
}

// A disc whose playlist declares VC-1 video (fake AVC payload; nothing decodes it, so it plays without a picture).
write(
  'fixtures/synthetic/vc1-disc',
  buildSyntheticDisc({
    clips: [syntheticClip('00001', 2, { audio: CodingType.LPCM })],
    playlists: [{ id: '00000', clipIds: ['00001'], videoCodingType: CodingType.VC1 }],
  }),
);

// A partial backup: playlists and clip info, but no BDMV/STREAM.
write(
  'fixtures/synthetic/partial-disc',
  buildSyntheticDisc({
    clips: [syntheticClip('00001', 2, { audio: CodingType.LPCM })],
    playlists: [{ id: '00000', clipIds: ['00001'] }],
  }),
  (path) => path.startsWith('BDMV/STREAM/'),
);
