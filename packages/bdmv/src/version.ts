/*
 * Ported from libbluray src/libbluray/bdnav/bdmv_parse.c (bdmv_parse_header)
 * Copyright (C) 2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * Internal to @seikou/bdmv: not part of its public API; importable through the package's subpath for Seikou's own use.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ParseError } from './byte-reader';

/** The file versions libbluray's `bdmv_parse_header` accepts (`BDMV_VERSION_0100` to `BDMV_VERSION_0300`). */
const SUPPORTED_VERSIONS: ReadonlySet<string> = new Set(['0100', '0200', '0240', '0300']);

/**
 * Checks the four version characters that follow a BDMV file's signature, as `bdmv_parse_header` does for every file
 * this package parses. Throws a ParseError naming `file` for any version other than 0100, 0200, 0240 or 0300.
 */
export function checkVersion(file: string, version: string): void {
  if (!SUPPORTED_VERSIONS.has(version)) throw new ParseError(`${file}: unsupported file version "${version}"`);
}
