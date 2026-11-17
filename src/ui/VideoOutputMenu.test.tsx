// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DeinterlaceMode } from '@seikou/engine/protocol';
import { VideoOutputMenu } from './VideoOutputMenu';
import { HdrBadge } from './HdrBadge';

afterEach(cleanup);

const menu = (props: { value?: 'auto' | 'element' | 'canvas'; onPick?: (p: string) => void; deinterlace?: DeinterlaceMode; onDeinterlace?: (m: DeinterlaceMode) => void }): ReturnType<typeof render> =>
  render(<VideoOutputMenu value={props.value ?? 'auto'} onPick={props.onPick ?? (() => undefined)} deinterlace={props.deinterlace ?? 'auto'} onDeinterlace={props.onDeinterlace ?? (() => undefined)} onOpenChange={() => undefined} />);

describe('VideoOutputMenu', () => {
  it('lists the three options with the current one checked, and picks one', () => {
    const onPick = vi.fn();
    menu({ onPick });
    fireEvent.click(screen.getByTestId('video-output-menu'));
    const items = screen.getAllByRole('menuitemradio').filter((i) => i.hasAttribute('data-path'));
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
    menu({ value: 'element', onPick });
    fireEvent.click(screen.getByTestId('video-output-menu'));
    fireEvent.click(screen.getAllByRole('menuitemradio')[1]);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('lists Deinterlacing Auto (checked) and Off, and picks Off', () => {
    const onDeinterlace = vi.fn();
    menu({ onDeinterlace });
    fireEvent.click(screen.getByTestId('video-output-menu'));
    expect(screen.getByText('Deinterlacing')).toBeTruthy();
    expect(screen.getByTestId('deinterlace-auto').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('deinterlace-off').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByTestId('deinterlace-auto'));
    expect(onDeinterlace).not.toHaveBeenCalled();
  });

  it('calls onDeinterlace with off when Off is picked', () => {
    const onDeinterlace = vi.fn();
    menu({ onDeinterlace });
    fireEvent.click(screen.getByTestId('video-output-menu'));
    fireEvent.click(screen.getByTestId('deinterlace-off'));
    expect(onDeinterlace).toHaveBeenCalledWith('off');
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
