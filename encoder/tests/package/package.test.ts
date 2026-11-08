// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Id } from '../../src/mux/mkv-ids';
import { NotMatroskaError, readMkv } from '../../src/mux/mkv-reader';
import { packageEpisode, safeName, type EpisodeManifest } from '../../src/package/package';
import { blocksInOrder, find, findAll, parseMkv, stringOf, uintOf } from '../helpers/ebml-reader';
import { ffprobePath, haveFfprobe } from '../helpers/tools';
import { FONT, SCRIPT, writeEpisodeMkv } from './episode-mkv';

describe('packageEpisode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seikou-package-'));
  const mkv = join(dir, 'ep-01.mkv');
  const web = join(dir, 'web', 'ep-01');
  let manifest: EpisodeManifest;

  beforeAll(async () => {
    await writeEpisodeMkv(mkv);
    manifest = await packageEpisode(mkv, web);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('the WebM has only AV1 and Opus and DocType webm', async () => {
    const t = parseMkv(readFileSync(join(web, 'video.webm')));
    expect(stringOf(find(t, Id.DocType))).toBe('webm');
    expect(findAll(t, Id.CodecID).map(stringOf)).toEqual(['V_AV1', 'A_OPUS', 'A_OPUS']);
    expect(findAll(t, Id.TrackNumber).map(uintOf)).toEqual([1n, 2n, 3n]);
    expect(findAll(t, Id.Attachments)).toHaveLength(0);
    expect(findAll(t, Id.ChapString).map(stringOf)).toEqual(['Cold open', 'Part <A> & B']);
    // WebM's chapter elements: no EditionUID, EditionFlagDefault or ChapterFlagEnabled.
    expect(findAll(t, Id.EditionUID)).toHaveLength(0);
    expect(findAll(t, Id.ChapterFlagEnabled)).toHaveLength(0);
    // Every cue is a video key frame's.
    expect(findAll(t, Id.CueTrack).map(uintOf).every((n) => n === 1n)).toBe(true);
    // The blocks are the MKV's video and audio blocks, unchanged and at the same times.
    const source = blocksInOrder(parseMkv(readFileSync(mkv))).filter((b) => b.track <= 3);
    const remuxed = blocksInOrder(t);
    expect(remuxed.map((b) => [b.track, b.timeMs, b.data.toString('hex')])).toEqual(source.map((b) => [b.track, b.timeMs, b.data.toString('hex')]));
    const mkvInfo = await readMkv(mkv);
    expect(stringOf(find(t, Id.Title))).toBe(mkvInfo.title);
    if (haveFfprobe) {
      const j = JSON.parse(execFileSync(ffprobePath!, ['-v', 'error', '-show_entries', 'format=format_name:stream=codec_name', '-of', 'json', join(web, 'video.webm')], { encoding: 'utf8' })) as {
        format: { format_name: string };
        streams: { codec_name: string }[];
      };
      expect(j.format.format_name).toContain('webm');
      expect(j.streams.map((s) => s.codec_name)).toEqual(['av1', 'opus', 'opus']);
    }
  });

  it("the rebuilt ASS file equals the muxed script's events in order", () => {
    const rebuilt = readFileSync(join(web, 'subs', '1-eng-full.ass'), 'utf8');
    const dialogue = (s: string): string[] => s.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogue(rebuilt)).toEqual(dialogue(SCRIPT));
    expect(rebuilt.startsWith('[Script Info]\nTitle: Starfall Wanderer\n')).toBe(true);
    expect(rebuilt).toContain('Style: Default,Starfall Sans,48');
    expect(rebuilt.indexOf('[Events]')).toBeLessThan(rebuilt.indexOf('Dialogue:'));
    expect(existsSync(join(web, 'subs', '2-eng-signs.ass'))).toBe(true);
  });

  it('the .sup file starts with a PG header carrying the first block\'s PTS', () => {
    const sup = readFileSync(join(web, 'pgs', '1-jpn.sup'));
    expect(sup.subarray(0, 2).toString('latin1')).toBe('PG');
    expect(sup.readUInt32BE(2)).toBe(50 * 90);
    expect(sup.readUInt32BE(6)).toBe(0);
    expect(sup[10]).toBe(0x16);
    // Two display sets of two segments each, a 10-byte header before every segment.
    expect(sup.length).toBe(2 * (10 + 5 + 10 + 3));
  });

  it('chapters.vtt has one cue per chapter', () => {
    expect(readFileSync(join(web, 'chapters.vtt'), 'utf8')).toBe(
      'WEBVTT\n\n1\n00:00:00.000 --> 00:00:00.250\nCold open\n\n2\n00:00:00.250 --> 00:00:00.500\nPart &lt;A&gt; &amp; B\n',
    );
  });

  it('episode.json lists every file and the defaults', () => {
    const expected: EpisodeManifest = {
      title: 'Starfall Wanderer - 01',
      video: { file: 'video.webm', width: 64, height: 64 },
      audio: [
        { index: 0, name: 'Japanese', language: 'jpn', default: true },
        { index: 1, name: 'Commentary', language: 'eng', default: false },
      ],
      subtitles: [
        { file: 'subs/1-eng-full.ass', name: 'English (Starfall Subs)', language: 'eng', default: true },
        { file: 'subs/2-eng-signs.ass', name: 'Signs (Starfall Subs)', language: 'eng', default: false },
      ],
      pgs: [{ file: 'pgs/1-jpn.sup', name: 'Japanese (disc)', language: 'jpn' }],
      fonts: ['fonts/StarfallSans.ttf'],
      chapters: 'chapters.vtt',
    };
    expect(manifest).toEqual(expected);
    expect(JSON.parse(readFileSync(join(web, 'episode.json'), 'utf8'))).toEqual(expected);
    expect(new Uint8Array(readFileSync(join(web, 'fonts', 'StarfallSans.ttf')))).toEqual(FONT);
    expect(readdirSync(web).sort()).toEqual(['chapters.vtt', 'episode.json', 'fonts', 'pgs', 'subs', 'video.webm']);
    expect(readdirSync(join(dir, 'web'))).toEqual(['ep-01']);
  });

  it('package fails cleanly on a file that is not Matroska', async () => {
    const bad = join(dir, 'not.mkv');
    writeFileSync(bad, 'RIFF....WAVEfmt this is not Matroska');
    const out = join(dir, 'web', 'bad');
    await expect(packageEpisode(bad, out)).rejects.toBeInstanceOf(NotMatroskaError);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(join(dir, 'web'))).toEqual(['ep-01']);
  });

  it('a truncated MKV fails and leaves no directory behind', async () => {
    const cut = join(dir, 'cut.mkv');
    const whole = readFileSync(mkv);
    writeFileSync(cut, whole.subarray(0, Math.floor(whole.length * 0.6)));
    const out = join(dir, 'web', 'cut');
    await expect(packageEpisode(cut, out)).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(join(dir, 'web'))).toEqual(['ep-01']);
  });

  it('cuts a long font name to 200 bytes of UTF-8 without splitting a character', () => {
    const name = `${'星'.repeat(100)}.ttf`; // 300 bytes of kanji plus the extension
    const safe = safeName(name, 'font-1');
    expect(Buffer.byteLength(safe, 'utf8')).toBeLessThanOrEqual(200);
    expect(safe).toBe(`${'星'.repeat(65)}.ttf`);
    expect(Buffer.from(safe, 'utf8').toString('utf8')).toBe(safe);
    expect(safeName('../.hidden\u0001.otf', 'font-1')).toBe('_.hidden_.otf');
    expect(safeName('...', 'font-1')).toBe('font-1');
  });

  it('packaging again replaces the directory', async () => {
    writeFileSync(join(web, 'stale.txt'), 'old');
    await packageEpisode(mkv, web);
    expect(existsSync(join(web, 'stale.txt'))).toBe(false);
    expect(existsSync(join(web, 'episode.json'))).toBe(true);
  });
});
