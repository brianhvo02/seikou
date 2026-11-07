// SPDX-License-Identifier: LGPL-3.0-or-later
import { statSync } from 'node:fs';
import { createSeaDex } from '@seikou/fansubs/seadex';
import { createTosho } from '@seikou/fansubs/tosho';
import { fixtureFansubSources } from '@seikou/fansubs/fixture-sources';
import { createAniList, createAniListEpisodes } from '@seikou/titles/anilist';
import { Pacer } from '@seikou/titles/pacer';
import { fixtureAniList } from '../subs/fixture-anilist';
import type { HelperSources } from './http';

/** Sent to every outside service, so its operators can see who is asking. */
const USER_AGENT = 'seikou-encode (+https://github.com/brianhvo02/seikou)';

/**
 * The outside services the helper asks. With `SEIKOU_ENCODE_FIXTURE=<folder>` the answers are read from recorded
 * files in that folder (`seadex.json`, `tosho.json`, `files/`, `anilist.json`) and nothing touches the network;
 * this is for tests and offline runs. Otherwise they are the live services: SeaDex at `https://seadex.moe` and
 * Anime Tosho (feed `https://feed.animetosho.net`, site `https://animetosho.net`), each paced to one request per
 * 2.5 s, and AniList, whose search and episode titles share one pacer of 30 requests a minute, as Seikou's NAS
 * server paces them.
 *
 * Building live sources makes no request. Throws when the fixture variable names something that is not a folder or
 * the folder lacks a recorded file.
 */
export function createSources(env: NodeJS.ProcessEnv, fetch: typeof globalThis.fetch): HelperSources {
  const fixture = env.SEIKOU_ENCODE_FIXTURE;
  if (fixture) {
    if (!statSync(fixture, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`SEIKOU_ENCODE_FIXTURE "${fixture}" is not a folder`);
    }
    const { seadex, tosho } = fixtureFansubSources(fixture);
    const { source, episodes } = fixtureAniList(fixture);
    return { seadex, tosho, anilist: source, episodes };
  }
  const anilistPacer = new Pacer(30, 60_000);
  return {
    seadex: createSeaDex(fetch, new Pacer(1, 2_500), USER_AGENT, 'https://seadex.moe'),
    tosho: createTosho(fetch, new Pacer(1, 2_500), USER_AGENT, {
      feed: 'https://feed.animetosho.net',
      site: 'https://animetosho.net',
    }),
    anilist: createAniList(fetch, anilistPacer),
    episodes: createAniListEpisodes(fetch, anilistPacer),
  };
}
