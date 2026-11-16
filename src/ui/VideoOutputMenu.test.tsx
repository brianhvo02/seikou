// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VideoOutputMenu } from './VideoOutputMenu';
import { HdrBadge } from './HdrBadge';

afterEach(cleanup);

describe('VideoOutputMenu', () => {
  it('lists the three options with the current one checked, and picks one', () => {
    const onPick = vi.fn();
    render(<VideoOutputMenu value="auto" onPick={onPick} onOpenChange={() => undefined} />);
    fireEvent.click(screen.getByTestId('video-output-menu'));
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => [i.getAttribute('data-path'), i.textContent, i.getAttribute('aria-checked')])).toEqual([
      ['auto', "Auto (HDR through the browser's video player)", 'true'],
      ['element', 'Always the video player', 'false'],
      ['canvas', 'Always the canvas', 'false'],
    ]);
    expect(screen.getByText(/next playlist/i)).toBeTruthy();
    fireEvent.click(items[2]);
    expect(onPick).toHaveBeenCalledWith('canvas');
  });

  it('does not repeat the current one', () => {
    const onPick = vi.fn();
    render(<VideoOutputMenu value="element" onPick={onPick} onOpenChange={() => undefined} />);
    fireEvent.click(screen.getByTestId('video-output-menu'));
    fireEvent.click(screen.getAllByRole('menuitemradio')[1]);
    expect(onPick).not.toHaveBeenCalled();
  });
});

function media(initial: boolean): { mm: (q: string) => MediaQueryList; set(v: boolean): void; queries: string[] } {
  const target = new EventTarget();
  const list = Object.assign(target, { matches: initial, media: '' }) as unknown as MediaQueryList & { matches: boolean };
  const queries: string[] = [];
  return {
    mm: (q) => (queries.push(q), list),
    set: (v) => {
      (list as { matches: boolean }).matches = v;
      target.dispatchEvent(new Event('change'));
    },
    queries,
  };
}

describe('HdrBadge', () => {
  it('shows for an HDR stream on an HDR display only', () => {
    const hdr = media(true);
    const { rerender } = render(<HdrBadge active matchMedia={hdr.mm} />);
    const badge = screen.getByTestId('hdr-badge');
    expect(badge.textContent).toBe('HDR');
    expect(badge.className).toBe('level-badge');
    expect(hdr.queries).toContain('(dynamic-range: high)');
    rerender(<HdrBadge active={false} matchMedia={hdr.mm} />);
    expect(screen.queryByTestId('hdr-badge')).toBeNull();
  });

  it('stays hidden on an SDR display and follows the display changing', () => {
    const sdr = media(false);
    render(<HdrBadge active matchMedia={sdr.mm} />);
    expect(screen.queryByTestId('hdr-badge')).toBeNull();
    act(() => sdr.set(true));
    expect(screen.getByTestId('hdr-badge')).toBeTruthy();
    act(() => sdr.set(false));
    expect(screen.queryByTestId('hdr-badge')).toBeNull();
  });
});
