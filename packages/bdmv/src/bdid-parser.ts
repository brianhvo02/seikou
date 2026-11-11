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

/**
 * `CERTIFICATE/id.bdmv`: the disc's organisation and disc IDs as lower-case hex, as libbluray prints them with
 * `str_print_hex` into `BDID_DATA` (`bdid_parse.h`). BD-J uses them to name the disc's persistent storage and binding
 * unit data area.
 */
export interface BdidData {
  /** `org_id`: the organisation ID, 4 bytes as 8 hex digits. */
  readonly orgId: string;
  /** `disc_id`: the disc ID, 16 bytes as 32 hex digits. */
  readonly discId: string;
}

const ID_START = 40;

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Parses the bytes of `CERTIFICATE/id.bdmv` (libbluray `_bdid_parse`); the extension data libbluray ignores is ignored.
 * Throws a ParseError for a bad `BDID` signature, an unsupported version, or a file too short to hold both IDs.
 * @example ../examples/parse-bdid.ts#parse
 */
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
