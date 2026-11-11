/*
 * Ported from libbluray src/libbluray/bdnav/bdid_parse.c
 * Copyright (C) 2012-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ByteReader, ParseError } from './byte-reader';
import { checkVersion } from './version';

/** CERTIFICATE/id.bdmv: the BD-J organisation and disc IDs as lower-case hex (str_print_hex). */
export interface BdidData {
  /** 8 hex digits. */
  readonly orgId: string;
  /** 32 hex digits. */
  readonly discId: string;
}

const ID_START = 40;

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** _bdid_parse; the extension data libbluray ignores is ignored. */
export function parseBdid(bytes: Uint8Array): BdidData {
  const r = new ByteReader(bytes);
  const signature = r.ascii(4);
  const version = r.ascii(4);
  if (signature !== 'BDID') throw new ParseError(`id.bdmv: bad signature "${signature}"`);
  checkVersion('id.bdmv', version);
  r.seek(ID_START);
  const orgId = hex(r.take(4));
  const discId = hex(r.take(16));
  return { orgId, discId };
}
