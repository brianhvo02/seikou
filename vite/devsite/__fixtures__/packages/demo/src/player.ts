// SPDX-License-Identifier: LGPL-3.0-or-later
/** A made-up player. */
export class DemoPlayer {
  constructor(readonly name: string) {}
  /** Opens a disc. */
  open(path: string): Promise<void> {
    return Promise.resolve(void path);
  }
  /** The last path. */
  get last(): string {
    return '';
  }
}
