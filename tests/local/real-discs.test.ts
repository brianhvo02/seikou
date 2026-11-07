import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CodingType, codingName } from '@seikou/bdmv/stream-types';
import { analyzeAvc, avcCodecString } from '@seikou/bdmv/codecs/h264';
import { analyzeHevc, hevcCodecString } from '@seikou/bdmv/codecs/hevc';
import { createAudioDecoderFactory } from '@seikou/engine/decode/audio-decoder';
import { hasSps } from '@seikou/engine/decode/video-decoder';
import { FileSource } from '@seikou/engine/disc/file-source';
import { loadClips, openDisc, streamPath } from '@seikou/engine/disc/open-disc';
import { normalizeDiscPaths } from '@seikou/engine/disc/paths';
import { M2tsReader } from '@seikou/bdmv/demux/m2ts-reader';
import { Timeline } from '@seikou/engine/nav/timeline';
import { chooseStreams } from '@seikou/engine/playback/stream-selection';
import { audioTracks } from '@seikou/engine/playback/tracks';
import { loadNodeAudioWasm } from '../helpers/audio-wasm';
import { directoryEntries } from '../helpers/file-blob';

const LOCAL = fileURLToPath(new URL('../../fixtures/local', import.meta.url)); // independent of the working directory

function localDiscs(): string[] {
  if (!existsSync(LOCAL)) return [];
  return readdirSync(LOCAL)
    .map((name) => join(LOCAL, name))
    .filter((dir) => existsSync(join(dir, 'BDMV')));
}

const discs = localDiscs();

describe.skipIf(discs.length === 0)('local discs', () => {
  for (const dir of discs) {
    it(`parses and demuxes ${basename(dir)}`, async () => {
      const source = new FileSource(normalizeDiscPaths(await directoryEntries(dir)));
      const disc = await openDisc(source);
      const main = disc.summaries.find((s) => s.playable);
      expect(main, 'a playable playlist').toBeDefined();
      if (!main) return;
      const mpls = disc.playlists.get(main.id);
      if (!mpls) throw new Error(`playlist ${main.id} vanished`);

      const timeline = new Timeline(mpls.playItems);
      expect(Math.abs(timeline.durationUs - main.durationUs)).toBeLessThan(1000);
      const clips = await loadClips(source, main.clipIds);
      for (const clip of clips.values()) {
        for (const map of clip.epMaps) {
          map.entries.forEach((e, i) => {
            if (i > 0) expect(e.spn).toBeGreaterThanOrEqual(map.entries[i - 1].spn);
          });
        }
      }

      const choice = chooseStreams(mpls.playItems[0].stn);
      const video = choice.video;
      expect(video, 'a main-path video stream').not.toBeNull();
      if (!video) return;
      const reader = new M2tsReader({ source, path: streamPath(mpls.playItems[0].clipId), startSpn: 0, pids: new Set([video.pid]) });
      const batch = (await reader.next()) ?? [];
      const first = batch.find((p) => hasSps(video.codingType, p.payload));
      let codec = codingName(video.codingType);
      if (video.codingType === CodingType.AVC || video.codingType === CodingType.HEVC) {
        expect(first, 'an access unit with SPS in the first 2 MB').toBeDefined();
        if (!first) return;
        const sps = (video.codingType === CodingType.AVC ? analyzeAvc : analyzeHevc)(first.payload).sps;
        if (!sps) throw new Error('SPS disappeared');
        codec = video.codingType === CodingType.AVC ? avcCodecString(sps) : hevcCodecString(sps);
        expect(codec).toMatch(/^(avc1|hev1)\./);
      } else {
        expect(batch.length, `video PES (${codec}) in the first 2 MB`).toBeGreaterThan(0);
      }
      const audio = choice.audio ? codingName(choice.audio.codingType) : `none playable (${choice.unsupportedAudio.map((a) => codingName(a.codingType)).join(', ') || 'no audio'})`;
      console.info(`${basename(dir)}: main=${main.id} ${(main.durationUs / 60e6).toFixed(1)} min, ${codec}, audio=${audio}, bdj=${disc.usesBdj}`);
      expect(reader.stats.corruptPackets).toBe(0);

      // The end of the clip too: real clips are often > 4 GiB, where truncated file handles go silent.
      const firstClipId = mpls.playItems[0].clipId;
      const lastEp = clips.get(firstClipId)?.epMaps.find((m) => m.pid === video.pid)?.entries.at(-1);
      if (!lastEp) throw new Error(`clip ${firstClipId} has no EP map for the video PID`);
      const tail = new M2tsReader({ source, path: streamPath(firstClipId), startSpn: lastEp.spn, pids: new Set([video.pid]) });
      const tailUnits = [];
      for (let batch = await tail.next(); batch !== null; batch = await tail.next()) tailUnits.push(...batch); // last PES completes on flush
      expect(tailUnits.length, `video PES after the last entry point (SPN ${lastEp.spn})`).toBeGreaterThan(0);
      expect(tail.stats.corruptPackets).toBe(0);
    }, 60_000);

    it(`decodes the first seconds of every playable audio track on ${basename(dir)}`, async () => {
      const source = new FileSource(normalizeDiscPaths(await directoryEntries(dir)));
      const disc = await openDisc(source);
      const main = disc.summaries.find((s) => s.playable);
      const mpls = main && disc.playlists.get(main.id);
      if (!mpls) throw new Error('no playable playlist');
      const item = mpls.playItems[0];
      const factory = createAudioDecoderFactory(loadNodeAudioWasm);
      for (const track of audioTracks(item.stn).filter((t) => t.playable)) {
        const entry = item.stn.audio[track.index - 1];
        const reader = new M2tsReader({ source, path: streamPath(item.clipId), startSpn: 0, pids: new Set([entry.pid]), chunkPackets: 6144 * 4 });
        const decoder = await factory(entry.codingType);
        let frames = 0;
        let failed = 0;
        for (let n = 0; n < 4; n++) {
          for (const pes of (await reader.next()) ?? []) {
            const r = decoder.decode({ data: pes.payload, ptsUs: ((pes.pts ?? 0) / 90_000) * 1e6, streamIdExtension: pes.streamIdExtension });
            failed += r.failedFrames;
            for (const c of r.chunks) frames += c.frames;
          }
        }
        decoder.close();
        console.info(`${basename(dir)}: audio ${track.index} ${track.codec} ${track.language}: ${frames} frames, ${failed} failed`);
        expect(frames, `${track.codec} produced audio`).toBeGreaterThan(48_000);
        expect(failed).toBe(0);
      }
    }, 120_000);
  }

  for (const dir of discs) {
    it(`resolves the sub-path IG streams of ${basename(dir)} to existing clips`, async () => {
      const source = new FileSource(normalizeDiscPaths(await directoryEntries(dir)));
      const disc = await openDisc(source);
      let subPathIg = 0;
      for (const [id, mpls] of disc.playlists) {
        for (const [n, item] of mpls.playItems.entries()) {
          for (const ig of item.stn.ig.filter((e) => e.subPath)) {
            subPathIg++;
            const path = mpls.subPaths[ig.subPathId];
            expect(path, `${id} item ${n}: sub-path ${ig.subPathId}`).toBeDefined();
            const clip = path?.items[ig.subClipId];
            expect(clip, `${id} item ${n}: sub-clip ${ig.subClipId}`).toBeDefined();
            if (clip) expect(source.exists(streamPath(clip.clipId)), `${id}: ${clip.clipId}.m2ts exists`).toBe(true);
          }
        }
      }
      console.info(`${basename(dir)}: ${subPathIg} sub-path IG stream entries`);
    });
  }
});
