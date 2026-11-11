// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { EXAMPLES_PAGE_MARKER, examplesPage } from './examples-page';

describe('examplesPage', () => {
  it('imports and records every example', () => {
    const page = examplesPage(['packages/a/examples/x.browser.ts'], ['fixtures/synthetic/disc1/BDMV/index.bdmv']);
    expect(page.html).toContain(EXAMPLES_PAGE_MARKER);
    expect(page.entry).toContain('import example0 from "/packages/a/examples/x.browser.ts"');
    expect(page.entry).toContain('window.__examples');
    expect(page.fixtures).toEqual(['fixtures/synthetic/disc1/BDMV/index.bdmv']);
  });
});
