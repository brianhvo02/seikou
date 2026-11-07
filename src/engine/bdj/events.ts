/*
 * Ported from libbluray src/libbluray/bluray.c
 * (_process_psr_write_event, _process_psr_change_event, the _bdj_event call sites)
 * Copyright (C) 2010-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { PSR, type RegisterFile } from '../hdmv/registers';
import { BdjEvent } from './runtime';
import type { BdjEventSink, BdjPlaybackEvents } from '../bdj-types';
export type { BdjEventSink, BdjPlaybackEvents } from '../bdj-types';

const PSR_SECONDARY_AUDIO_VIDEO = PSR.SECONDARY_AUDIO_VIDEO;

/** _process_psr_event: only the BD-J notifications. A change is first a write. */
export function bindBdjPsrEvents(regs: RegisterFile, sink: BdjEventSink): () => void {
  return regs.onPsrEvent((e) => {
    if (e.type !== 'write' && e.type !== 'change') return;
    const v = e.newValue;
    switch (e.psr) {
      case PSR.ANGLE_NUMBER: sink(BdjEvent.ANGLE, v); break;
      case PSR.PLAYLIST: sink(BdjEvent.PLAYLIST, v); break;
      case PSR.PLAYITEM: sink(BdjEvent.PLAYITEM, v); break;
      case PSR.TIME: sink(BdjEvent.PTS, v); break;
      case 102: sink(BdjEvent.PSR102, v); break;
      default: break;
    }
    if (e.type !== 'change') return;
    switch (e.psr) {
      case PSR.CHAPTER: sink(BdjEvent.CHAPTER, v); break;
      case PSR.PRIMARY_AUDIO_ID: sink(BdjEvent.AUDIO_STREAM, v); break;
      case PSR.PG_STREAM: sink(BdjEvent.SUBTITLE, v); break;
      case PSR_SECONDARY_AUDIO_VIDEO: sink(BdjEvent.SECONDARY_STREAM, v); break;
      default: break;
    }
  });
}

export function bdjPlaybackEvents(sink: BdjEventSink): BdjPlaybackEvents {
  return {
    endOfPlaylist: (playlist) => sink(BdjEvent.END_OF_PLAYLIST, playlist),
    markReached: (mark) => sink(BdjEvent.MARK, mark),
    seeked: (t) => sink(BdjEvent.SEEK, t),
    rate: (rate) => sink(BdjEvent.RATE, rate),
    uoMasked: (idx) => sink(BdjEvent.UO_MASKED, idx),
  };
}
