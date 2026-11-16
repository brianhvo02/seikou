// @vitest-environment jsdom
// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { DiscRef, SeasonDetail, TitleSummary } from '@seikou/nas/nas-api';
import type { NasClient } from './nas-client';
import { DiscList } from './SeasonScreen';
import { TitleCard, TitleRow } from './TitleLibrary';

afterEach(cleanup);

const nas = {} as NasClient;
const title = (more: Partial<TitleSummary> = {}): TitleSummary => ({
  id: 't1', kind: 'movie', names: { english: 'Starfall Wanderer', romaji: null, native: null, synonyms: [], display: null },
  poster: null, year: 2024, seasons: 0, discs: 1, addedAt: 0, own: false, ...more,
});
const copy = (discId: string, more: Partial<DiscRef> = {}): DiscRef => ({ discId, root: 'media5', folder: `Starfall Wanderer/${discId}`, displayName: null, ...more });
const season: SeasonDetail = { id: 's', label: '', number: null, discs: [], episodes: null, extras: [] };
const badges = (): string[] => screen.queryAllByTestId('dynamic-range-badge').map((b) => b.textContent ?? '');

describe('dynamic range badges', () => {
  it('shows the title card and row badge, and none for SDR or a NAS that sends none', () => {
    render(
      <ul>
        <TitleCard nas={nas} title={title({ dynamicRange: 'dv' })} onOpen={() => {}} />
        <TitleRow nas={nas} title={title({ dynamicRange: 'hdr10plus' })} onOpen={() => {}} />
        <TitleCard nas={nas} title={title({ dynamicRange: null })} onOpen={() => {}} />
        <TitleCard nas={nas} title={title()} onOpen={() => {}} />
      </ul>,
    );
    expect(badges()).toEqual(['DV', 'HDR10+']);
    expect(screen.getAllByTestId('dynamic-range-badge').every((b) => b.classList.contains('badge'))).toBe(true);
  });

  it("shows each disc copy's own badge", () => {
    const discs = [{ number: 1, label: 'Disc 1', copies: [copy('uhd', { dynamicRange: 'hdr10' }), copy('bd', { dynamicRange: null })] }];
    render(<DiscList season={season} discs={discs} onOpen={() => {}} />);
    expect(badges()).toEqual(['HDR10']);
  });
});
