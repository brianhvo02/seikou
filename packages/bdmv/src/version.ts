/*
 * Ported from libbluray src/libbluray/bdnav/bdmv_parse.c (bdmv_parse_header)
 * Copyright (C) 2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ParseError } from './byte-reader';

/** File versions libbluray accepts for index.bdmv, MPLS and CLPI files. */
const SUPPORTED_VERSIONS: ReadonlySet<string> = new Set(['0100', '0200', '0240', '0300']);

export function checkVersion(file: string, version: string): void {
  if (!SUPPORTED_VERSIONS.has(version)) throw new ParseError(`${file}: unsupported file version "${version}"`);
}
