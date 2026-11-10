// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NasDrive } from '@seikou/nas/nas-api';
import { DrivesSection } from './DrivesSection';
import { NasHttpError } from './nas-client';

afterEach(cleanup);

const drives: NasDrive[] = [
  { name: 'mediaA', discs: 12, missing: false },
  { name: 'mediaB', discs: 3, missing: true },
];

it('offers to forget only a missing drive with discs, asks first, and shows the drives the NAS answers', async () => {
  const forgetDrive = vi.fn(async () => [drives[0]!, { name: 'mediaB', discs: 0, missing: true }]);
  render(<DrivesSection nas={{ admin: { drives: async () => drives, forgetDrive } }} />);
  await screen.findAllByTestId('nas-drive');
  expect(screen.getAllByTestId('nas-drive-status').map((e) => e.textContent)).toEqual(['12 discs', 'Not found at the last scan · 3 discs kept']);
  expect(screen.getAllByTestId('nas-drive-forget')).toHaveLength(1);
  fireEvent.click(screen.getByTestId('nas-drive-forget'));
  expect(screen.getByText(/Forget the 3 discs kept from mediaB\?/)).toBeTruthy();
  fireEvent.click(screen.getByTestId('nas-drive-forget-cancel'));
  expect(forgetDrive).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('nas-drive-forget'));
  fireEvent.click(screen.getByTestId('nas-drive-forget-confirm'));
  await waitFor(() => expect(screen.getAllByTestId('nas-drive-status')[1]!.textContent).toBe('Not found at the last scan'));
  expect(forgetDrive).toHaveBeenCalledWith('mediaB');
  expect(screen.queryByTestId('nas-drive-forget')).toBeNull();
});

it('says why a forget was refused', async () => {
  const forgetDrive = vi.fn(async (): Promise<NasDrive[]> => {
    throw new NasHttpError(409, 'scanning');
  });
  render(<DrivesSection nas={{ admin: { drives: async () => drives, forgetDrive } }} />);
  fireEvent.click(await screen.findByTestId('nas-drive-forget'));
  fireEvent.click(screen.getByTestId('nas-drive-forget-confirm'));
  expect((await screen.findByTestId('nas-drives-error')).textContent).toBe('The library is being scanned. Try again when the scan has finished.');
});

it('shows nothing on a NAS without the drives route, and says so when the list fails otherwise', async () => {
  const old = render(<DrivesSection nas={{ admin: { drives: async () => Promise.reject(new NasHttpError(404, null)), forgetDrive: async () => [] } }} />);
  await new Promise((r) => setTimeout(r, 0));
  expect(old.container.innerHTML).toBe('');
  old.unmount();
  render(<DrivesSection nas={{ admin: { drives: async () => Promise.reject(new Error('offline')), forgetDrive: async () => [] } }} />);
  expect(await screen.findByText("The drives didn't load.")).toBeTruthy();
});
