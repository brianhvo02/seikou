// SPDX-License-Identifier: LGPL-3.0-or-later
// Builds fixtures/encodes/990001/{1,2}.mkv: two 60 s episodes in the shape the Seikou encoder writes (AV1, Opus, named
// chapters, an ASS track with a font, a PGS track, tags), for the Encodes library's tests. Needs VapourSynth with
// BestSource, SvtAv1EncApp and opusenc on PATH. The video is cut from encoder/fixtures/disc-speech with a fast, small
// encode; the MKVs are then rewritten through @seikou/matroska (no re-encode) to set what the encoder does not yet write.
import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { M2tsReader } from '@seikou/bdmv/demux/m2ts-reader';
import type { ByteSource } from '@seikou/bdmv/byte-source';
import type { AudioPacket, MkvAudioTrack, MkvVideoPacket, MkvSubtitleTrack, SubtitleBlock } from '@seikou/matroska';
import { discKeyOfFolder } from '../encoder/src/disc/disc-key';
import { groupDisplaySets, type PgPes } from '../encoder/src/disc/pgs';
import { encodeEpisodes } from '../encoder/src/encode';
import { opusPacketDuration } from '../encoder/src/mux/ogg';
import { assToMatroska } from '../encoder/src/mux/ass-track';
import { readMkv, writeMkv } from '../encoder/src/mux/mkv-file';
import { findTools } from '../encoder/src/tools';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const discDir = join(root, 'encoder/fixtures/disc-speech');
const subsDisc = join(root, 'fixtures/synthetic/disc-subs');
const fontPath = join(root, 'fixtures/ass/fonts/DejaVuSansMono.ttf');
const outDir = join(root, 'fixtures/encodes/990001');

const ANILIST_ID = '990001';
const TITLES = ['The Lantern Road', 'A Quiet Harbor'];
/** Chapters of every episode: the facts fixtures/encodes/README.md states. */
const CHAPTERS: [string, number][] = [['Avant', 0], ['Opening', 10], ['Part A', 20], ['Ending', 40], ['Preview', 50]];
/** Where the first PGS display set lands in the episode. */
const PGS_START_MS = 5000;

function assScript(episode: number): string {
  const line = (from: string, to: string, text: string): string => `Dialogue: 0,${from},${to},Default,,0,0,0,,${text}`;
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 640',
    'PlayResY: 360',
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,DejaVu Sans Mono,24,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,20,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    line('0:00:01.00', '0:00:03.00', `Episode ${episode} begins`),
    line('0:00:12.00', '0:00:14.00', 'The opening line'),
    line('0:00:19.00', '0:00:23.00', 'A line across the twenty second mark'),
    line('0:00:41.00', '0:00:44.00', 'The ending line'),
    line('0:00:55.00', '0:00:58.00', 'Next time'),
    '',
  ].join('\n');
}

/** The English PG stream of fixtures/synthetic/disc-subs (PID 0x1200) as display sets, the first moved to `PGS_START_MS`. */
async function pgsBlocks(): Promise<SubtitleBlock[]> {
  const path = join(subsDisc, 'BDMV/STREAM/00001.m2ts');
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    const source: ByteSource = {
      exists: (p) => p === path,
      size: () => size,
      list: () => [],
      read: async (_p, offset, length) => {
        const buf = new Uint8Array(length);
        const { bytesRead } = await file.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      },
    };
    const pes: PgPes[] = [];
    const reader = new M2tsReader({ source, path, startSpn: 0, pids: new Set([0x1200]) });
    for (let batch = await reader.next(); batch !== null; batch = await reader.next()) {
      for (const p of batch) pes.push({ ...(p.pts !== undefined ? { pts: p.pts } : {}), payload: p.payload });
    }
    const sets = groupDisplaySets(pes).sort((a, b) => a.pts90 - b.pts90);
    if (sets.length === 0 || !sets[0]!.startsEpoch) throw new Error('disc-subs has no PG display sets to reuse');
    const base = sets[0]!.pts90;
    return sets.map((s) => ({ timeMs: PGS_START_MS + Math.round((s.pts90 - base) / 90), data: s.data }));
  } finally {
    await file.close();
  }
}

async function rewrite(path: string, target: string, episode: number, startMs: number, discKey: string, pgs: SubtitleBlock[], font: Uint8Array): Promise<void> {
  const mkv = await readMkv(path);
  const video = mkv.tracks.find((t) => t.codecId === 'V_AV1')!;
  const opus = mkv.tracks.filter((t) => t.codecId === 'A_OPUS');
  const durationMs = Math.round(mkv.durationMs ?? 0);
  const blocks = new Map<number, { timeMs: number; keyframe: boolean; discardPaddingNs?: bigint; data: Uint8Array }[]>();
  for await (const b of mkv.blocks()) {
    const list = blocks.get(b.track) ?? [];
    list.push({ timeMs: b.timeMs, keyframe: b.keyframe, ...(b.discardPaddingNs !== undefined ? { discardPaddingNs: b.discardPaddingNs } : {}), data: new Uint8Array(b.data) });
    blocks.set(b.track, list);
  }

  async function* videoPackets(): AsyncGenerator<MkvVideoPacket> {
    let index = 0;
    for (const b of blocks.get(video.number) ?? []) yield { index: index++, data: b.data, keyframe: b.keyframe, timeMs: Math.round(b.timeMs) };
  }
  const audio = opus.map((track): MkvAudioTrack => {
    const list = blocks.get(track.number) ?? [];
    const lastPaddingNs = list[list.length - 1]?.discardPaddingNs ?? 0n;
    async function* packets(): AsyncGenerator<AudioPacket> {
      for (const b of list) yield { data: b.data, pts48: Math.round(b.timeMs) * 48, durationSamples: opusPacketDuration(b.data) };
    }
    return {
      channels: track.audio!.channels,
      sampleRate: track.audio!.sampleRate,
      codecPrivate: track.codecPrivate!,
      codecDelayNs: track.codecDelayNs,
      seekPreRollNs: track.seekPreRollNs,
      name: track.name || 'Japanese',
      language: track.language,
      isDefault: true,
      packets: packets(),
      end: Promise.resolve({ discardPadding48: lastPaddingNs > 0n ? Number((lastPaddingNs * 48000n + 500_000_000n) / 1_000_000_000n) : 0 }),
    };
  });

  const ass = assToMatroska(assScript(episode), durationMs);
  const subtitles: MkvSubtitleTrack[] = [
    { codecId: 'S_TEXT/ASS', name: 'English', language: 'eng', isDefault: true, codecPrivate: ass.codecPrivate, blocks: ass.blocks },
    { codecId: 'S_HDMV/PGS', name: 'English (disc)', language: 'eng', isDefault: false, blocks: pgs },
  ];
  const chapters = CHAPTERS.map(([title, s], i) => ({
    title,
    startNs: BigInt(s) * 1_000_000_000n,
    endNs: i + 1 < CHAPTERS.length ? BigInt(CHAPTERS[i + 1]![1]) * 1_000_000_000n : BigInt(durationMs) * 1_000_000n,
  }));
  await writeMkv(target, {
    title: TITLES[episode - 1]!,
    appName: 'seikou-encode',
    tags: {
      ANILIST_ID,
      EPISODE: String(episode),
      EPISODE_TITLE: TITLES[episode - 1]!,
      SEIKOU_DISC_KEY: discKey,
      SEIKOU_PLAYLIST: '00000',
      SEIKOU_EPISODE_START_MS: String(startMs),
      ENCODER: 'seikou-encode',
    },
    video: {
      width: video.video!.width,
      height: video.video!.height,
      fpsNum: 1_000_000_000,
      fpsDen: Number(video.defaultDurationNs),
      codecPrivate: video.codecPrivate!,
      name: video.name,
      language: video.language,
      isDefault: true,
    },
    videoPackets: videoPackets(),
    audio,
    subtitles,
    attachments: [{ name: 'DejaVuSansMono.ttf', mediaType: 'font/ttf', data: font }],
    chapters,
  });
}

const tmp = await mkdtemp(join(tmpdir(), 'encode-fixture-'));
try {
  const { key } = await discKeyOfFolder(discDir);
  const encoded = join(tmp, 'out');
  const paths = await encodeEpisodes(
    {
      discDir,
      playlistId: '00000',
      episodes: '1-2,3-4',
      outDir: encoded,
      namePattern: 'ep-{n}',
      crf: 40,
      preset: 10,
      filmGrain: 0,
      // Capped, because the speech disc's picture is noisy and plain CRF 40 still gives megabytes.
      extraSvtArgs: ['--mbr', '10'],
      opusBitrate: 24,
      cacheDir: join(tmp, 'bestsource'),
      tools: findTools(),
      dataDir: join(tmp, 'data'),
      noSubtitles: true,
      record: null,
      noPgs: true,
    },
    (e) => {
      if (e.kind === 'log' || e.kind === 'episode-start' || e.kind === 'episode-done') console.log(e.message);
    },
  );
  const pgs = await pgsBlocks();
  const font = new Uint8Array(await readFile(fontPath));
  await mkdir(outDir, { recursive: true });
  for (const [i, p] of paths.entries()) {
    const target = join(outDir, `${i + 1}.mkv`);
    await rewrite(p, target, i + 1, i * 60_000, key, pgs, font);
    console.log(`${target}: ${(await stat(target)).size} bytes`);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
