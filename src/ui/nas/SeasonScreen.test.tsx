// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FansubTitleState, SeasonDetail, StoredSubtitle } from '@seikou/nas/nas-api';
import type { NasClient } from './nas-client';
import { SeasonScreen } from './SeasonScreen';

afterEach(cleanup);

const SEASON: SeasonDetail = {
  id: 's1', label: 'Season 1', number: 1, discs: [], extras: [],
  episodes: [
    { number: 1, name: null, runtimeMin: 24, discId: 'd1', playlistId: '00001' },
    { number: 2, name: null, runtimeMin: 24, discId: 'd1', playlistId: '00002' },
  ],
};

const track = (id: string, trackName: string, episode: number, alignment: NonNullable<StoredSubtitle['source']>['alignment']): StoredSubtitle => ({
  id, name: `GroupA ${trackName}`, language: 'en', offsetMs: 0, fileName: `${id}.ass`, fileSize: 10, fonts: [],
  attachment: { kind: 'episode', discKey: 'f.k', playlistId: '0000' + episode, titleId: 't1', seasonId: 's1', episode },
  uploadedAt: 1,
  source: { kind: 'fansub', group: 'GroupA', tracker: 'x', rank: 'best', toshoFileId: 1, track: 0, trackName, alignment, linedUpOn: { discKey: 'f.k', playlistId: '0000' + episode } },
});

const NEVER_RUN: FansubTitleState = { titleId: 't1', lastRunAt: null, running: false, nothingFound: false, seasons: {}, episodes: {} };
const RAN: FansubTitleState = {
  titleId: 't1', lastRunAt: Date.now(), running: false, nothingFound: false,
  seasons: { s1: { bestGroup: 'GroupA', usedGroups: [{ group: 'GroupA', rank: 'best' }] } },
  episodes: { 's1#1': { status: 'attached' }, 's1#2': { status: 'not-found', reason: 'no-release' } },
};

function fakeNas(over: Partial<Record<string, unknown>> = {}): NasClient {
  return {
    titleProgress: vi.fn(async () => ({})),
    subtitlesForTitle: vi.fn(async () => []),
    fansubTitle: vi.fn(async () => NEVER_RUN),
    runFansubs: vi.fn(async () => RAN),
    undeleteFansubs: vi.fn(async () => {}),
    realignFansub: vi.fn(),
    originalFansubTiming: vi.fn(),
    manifest: vi.fn(),
    ...over,
  } as unknown as NasClient;
}

const show = (nas: NasClient, owner: boolean): void => {
  render(
    <SeasonScreen
      nas={nas} titleId="t1" seriesName="Starfall Wanderer" heading="Season 1" season={SEASON} seasonIds={['s1']}
      onBack={() => {}} onOpen={() => {}} owner={owner ? { nas, tmdb: false, onChanged: () => {} } : undefined}
    />,
  );
};

describe('fansubs on the season screen', () => {
  it('shows a guest no fansub line', async () => {
    const nas = fakeNas();
    show(nas, false);
    await screen.findByTestId('season-screen');
    expect(screen.queryByTestId('fansub-line')).toBeNull();
    expect(nas.fansubTitle).not.toHaveBeenCalled();
  });

  it('offers an owner Find fansubs on a title that never ran', async () => {
    show(fakeNas(), true);
    const button = await screen.findByTestId('fansub-run');
    expect(button.textContent).toBe('Find fansubs');
  });

  it('marks the rows with chips and what lined up after a run', async () => {
    const subs = [track('a', 'Full', 1, { kind: 'offset', offsetMs: 800, confidence: 1 }), track('b', 'Signs', 1, { kind: 'offset', offsetMs: 800, confidence: 1 })];
    const nas = fakeNas({ subtitlesForTitle: vi.fn(async () => subs) });
    show(nas, true);
    fireEvent.click(await screen.findByTestId('fansub-run'));
    await waitFor(() => expect(screen.getByTestId('fansub-line').textContent).toContain('GroupA (SeaDex best)'));
    const rows = screen.getAllByTestId('episode-row').map((r) => r.closest('li')!);
    expect(within(rows[0]!).getAllByTestId('fansub-chip').map((c) => c.textContent)).toEqual(['Full', 'Signs']);
    const mark = within(rows[0]!).getByTestId('fansub-mark');
    expect(mark.textContent).toBe('lined up · +0.8 s');
    expect(mark.getAttribute('data-tone')).toBe('ok');
    expect(within(rows[1]!).getByTestId('fansub-mark').textContent).toBe('not found');
    expect(screen.getByTestId('fansub-run').textContent).toBe('Find fansubs again');
  });

  it('drops the mark when the panel switches a track to its original timing', async () => {
    let subs = [track('a', 'Full', 1, { kind: 'offset', offsetMs: 800, confidence: 1 })];
    const nas = fakeNas({
      fansubTitle: vi.fn(async () => RAN),
      subtitlesForTitle: vi.fn(async () => subs),
      originalFansubTiming: vi.fn(async (id: string) => {
        subs = [track(id, 'Full', 1, { kind: 'original' })];
        return subs[0]!;
      }),
    });
    show(nas, true);
    const item = (): HTMLElement => screen.getAllByTestId('episode-row')[0]!.closest('li')!;
    await screen.findAllByTestId('episode-row');
    await waitFor(() => expect(within(item()).queryByTestId('fansub-mark')).not.toBeNull());
    fireEvent.click(within(item()).getByTestId('fansub-open'));
    fireEvent.click(await screen.findByTestId('fansub-original'));
    await waitFor(() => expect(nas.originalFansubTiming).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(within(item()).queryByTestId('fansub-mark')).toBeNull());
    expect(within(item()).getAllByTestId('fansub-chip')).toHaveLength(1);
  });

  it('plays on a row tap and opens the fansubs from the button beside it', async () => {
    const opened: string[] = [];
    const nas = fakeNas({ fansubTitle: vi.fn(async () => RAN), subtitlesForTitle: vi.fn(async () => [track('a', 'Full', 1, { kind: 'offset', offsetMs: 0, confidence: 1 })]) });
    render(
      <SeasonScreen nas={nas} titleId="t1" seriesName="S" heading="Season 1" season={SEASON} seasonIds={['s1']} onBack={() => {}} onOpen={(d) => opened.push(d.name)} owner={{ nas, tmdb: false, onChanged: () => {} }} />,
    );
    const open = (await screen.findAllByTestId('fansub-open'))[0]!;
    expect(open.getAttribute('aria-label')).toBe('Fansubs for episode 1');
    fireEvent.click(screen.getAllByTestId('episode-row')[0]!);
    expect(opened).toHaveLength(1);
    expect(screen.queryByTestId('fansub-panel')).toBeNull();
    fireEvent.click(open);
    expect(await screen.findByTestId('fansub-panel')).toBeTruthy();
    expect(screen.queryByTestId('fansub-play')).toBeNull();
  });

  it('asks before bringing back deleted tracks, and only after a deletion in this session', async () => {
    const nas = fakeNas({ fansubTitle: vi.fn(async () => RAN) });
    show(nas, true);
    fireEvent.click(await screen.findByTestId('fansub-run'));
    await waitFor(() => expect(nas.runFansubs).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Bring back the tracks you deleted?')).toBeNull();
  });
});
