// SPDX-License-Identifier: LGPL-3.0-or-later

/** Thrown when a file cannot be read as Matroska: truncated, malformed, or using a feature the reader does not take (for `readMatroska`: lacing and unknown sizes). */
export class MkvReadError extends Error {}

/** Thrown when a file is not Matroska at all: no EBML header, or an EBML DocType other than `matroska` or `webm`. */
export class NotMatroskaError extends MkvReadError {}
