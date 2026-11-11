// SPDX-License-Identifier: LGPL-3.0-or-later
/** Options for parse. */
export interface ParseOptions {
  strict?: boolean;
}
/** Parses text. */
export function parse(text: string, options?: ParseOptions): number {
  return options?.strict ? text.length : 0;
}
