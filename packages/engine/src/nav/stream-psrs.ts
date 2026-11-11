/*
 * Ported from libbluray src/libbluray/bluray.c (_update_stream_psr_by_lang) and util/strutl.c (str_to_uint32)
 * Copyright (C) 2009-2010  Obliter0n
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2010-2019  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { StreamEntry } from '@seikou/bdmv/mpls-parser';
import type { RegisterFile } from '../hdmv/registers';

/** An ISO 639-2 language code as the three bytes a language PSR holds, big-endian (`str_to_uint32(s, 3)`). */
export function langToUint32(lang: string): number {
  return (((lang.charCodeAt(0) || 0) << 16) | ((lang.charCodeAt(1) || 0) << 8) | (lang.charCodeAt(2) || 0)) >>> 0;
}

/**
 * `_update_stream_psr_by_lang`: picks the stream of `streams` whose language matches the preferred language in PSR `psrLang`,
 * or the first when none does (which also clears `enableFlag`), writes its 1-based number into `psrStream` with
 * `enableFlag` (the PG display flag, or 0), and clears the flag when the language equals `blacklist` (the audio
 * language, so subtitles are not shown in it). Returns the chosen stream's language. */
export function updateStreamPsrByLang(
  regs: RegisterFile, psrLang: number, psrStream: number, enableFlag: number, streams: readonly StreamEntry[], blacklist: number,
): number {
  const preferred = regs.psrRead(psrLang);
  let idx = streams.findIndex((s) => langToUint32(s.lang) === preferred);
  if (idx < 0) {
    idx = 0; // preferred language not found: first stream, no subtitles
    enableFlag = 0;
  }
  const lang = langToUint32(streams[idx]!.lang);
  if (blacklist && blacklist === lang) enableFlag = 0; // no subtitles in the audio language
  regs.psrWriteBits(psrStream, ((idx + 1) | enableFlag) >>> 0, 0x80000fff);
  return lang;
}
