/*
 * Ported from libbluray src/libbluray/bluray.c
 * (_process_psr_write_event, _process_psr_change_event, the _bdj_event call sites)
 * Copyright (C) 2010-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { PSR, type RegisterFile } from '@seikou/engine/hdmv/registers';
import { BdjEvent } from './runtime';
import type { BdjEventSink, BdjPlaybackEvents } from '@seikou/engine/bdj-types';
export type { BdjEventSink, BdjPlaybackEvents } from '@seikou/engine/bdj-types';

const PSR_SECONDARY_AUDIO_VIDEO = PSR.SECONDARY_AUDIO_VIDEO;

/**
 * Sends Java the PSR events libbluray's _process_psr_event sends (bluray.c, its _process_psr_write_event and
 * _process_psr_change_event branches): angle, playlist, play item, time and PSR102 on every write, and chapter,
 * audio, subtitle and secondary stream only on a change. A change is first a write. Runs in the engine worker;
 * the returned function unsubscribes.
 */
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

/** The playback events Java hears, each as its libbluray BDJ_EVENT_* number sent to `sink`. Runs in the engine worker. */
export function bdjPlaybackEvents(sink: BdjEventSink): BdjPlaybackEvents {
  return {
    endOfPlaylist: (playlist) => sink(BdjEvent.END_OF_PLAYLIST, playlist),
    markReached: (mark) => sink(BdjEvent.MARK, mark),
    seeked: (t) => sink(BdjEvent.SEEK, t),
    rate: (rate) => sink(BdjEvent.RATE, rate),
    uoMasked: (idx) => sink(BdjEvent.UO_MASKED, idx),
  };
}
