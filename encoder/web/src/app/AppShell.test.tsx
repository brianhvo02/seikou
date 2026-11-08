// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';

afterEach(cleanup);

describe('AppShell', () => {
  it('marks the section of the page on screen and shows the page', () => {
    render(
      <AppShell route={{ kind: 'disc', discKey: 'f.x' }}>
        <p>page body</p>
      </AppShell>,
    );
    expect(screen.getByText('page body')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Library' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Queue' }).getAttribute('aria-current')).toBeNull();
  });

  it('puts the progress slot content under the bar', () => {
    render(
      <AppShell route={{ kind: 'queue' }} progress={<span>Encoding episode 2</span>}>
        <p>page</p>
      </AppShell>,
    );
    expect(screen.getByText('Encoding episode 2')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Queue' }).getAttribute('aria-current')).toBe('page');
  });
});
