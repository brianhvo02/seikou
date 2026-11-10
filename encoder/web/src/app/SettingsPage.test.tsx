// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import type { EncodeSettings, Profile } from '../api-types';
import type { AppApi } from './app-api';
import { exampleName, SettingsPage } from './SettingsPage';

afterEach(cleanup);

const defaults: EncodeSettings = { crf: 25, preset: 4, filmGrain: 4, extraSvtArgs: [], opusBitrate: null, pgs: true, web: false, namePattern: 'episode-{n}', destination: 'folder' };
const standard: Profile = { id: 'default', name: 'Default', builtIn: true, settings: defaults };
const small: Profile = { id: 'ab12', name: 'Small files', builtIn: false, settings: { ...defaults, crf: 32, opusBitrate: 96, extraSvtArgs: ['--lookahead', '40'] } };

function fakeApi(profiles: Profile[] = [standard, small], overrides: Partial<AppApi> = {}): AppApi {
  return {
    profiles: vi.fn(async () => profiles),
    createProfile: vi.fn(async (name, settings) => ({ id: 'cd34', name, builtIn: false, settings })),
    updateProfile: vi.fn(async (id, name, settings) => ({ id, name, builtIn: false, settings })),
    deleteProfile: vi.fn(async () => undefined),
    nas: vi.fn(async () => ({ paired: false })),
    pairNas: vi.fn(async () => ({ paired: true, host: '127.0.0.1', personName: 'Mika Owner', reachable: true, encodes: 'ready' })),
    unpairNas: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as AppApi;
}

describe('SettingsPage', () => {
  it('lists the default first, with Duplicate instead of Edit', async () => {
    render(<SettingsPage api={fakeApi()} />);
    const items = await screen.findAllByRole('listitem');
    expect(within(items[0]!).getByText('Default')).toBeTruthy();
    expect(within(items[0]!).getByRole('button', { name: 'Duplicate Default' })).toBeTruthy();
    expect(within(items[0]!).queryByRole('button', { name: /Edit|Delete/ })).toBeNull();
    expect(within(items[1]!).getByRole('button', { name: 'Edit Small files' })).toBeTruthy();
  });

  it('editing a profile saves it', async () => {
    const api = fakeApi();
    render(<SettingsPage api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Small files' }));
    expect((screen.getByLabelText('Extra SVT-AV1 arguments') as HTMLInputElement).value).toBe('--lookahead 40');
    fireEvent.change(screen.getByLabelText('CRF'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Opus bitrate (kb/s)'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('Web package'));
    fireEvent.change(screen.getByLabelText('Extra SVT-AV1 arguments'), { target: { value: ' --lookahead   60 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1));
    expect(api.updateProfile).toHaveBeenCalledWith('ab12', 'Small files', {
      ...small.settings,
      crf: 30,
      opusBitrate: null,
      web: true,
      extraSvtArgs: ['--lookahead', '60'],
    });
  });

  it('shows a server error next to the field it names', async () => {
    const api = fakeApi([standard, small], {
      updateProfile: vi.fn(async () => {
        throw new ApiError(400, 'bad-setting', 'CRF must be a whole number from 0 to 63.', { field: 'crf' });
      }),
    });
    render(<SettingsPage api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Small files' }));
    fireEvent.change(screen.getByLabelText('CRF'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const message = await screen.findByText('CRF must be a whole number from 0 to 63.');
    expect(screen.getByLabelText('CRF').getAttribute('aria-describedby')).toContain(message.id);
  });

  it('duplicating the default makes "Default (copy)" and opens it for editing', async () => {
    const api = fakeApi();
    render(<SettingsPage api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Duplicate Default' }));
    await waitFor(() => expect(api.createProfile).toHaveBeenCalledWith('Default (copy)', defaults));
    expect(((await screen.findByLabelText('Name')) as HTMLInputElement).value).toBe('Default (copy)');
  });

  it('Duplicate can be used twice', async () => {
    const api = fakeApi();
    render(<SettingsPage api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Duplicate Default' }));
    await waitFor(() => expect(api.createProfile).toHaveBeenCalledTimes(1));
    const again = screen.getByRole('button', { name: 'Duplicate Default' }) as HTMLButtonElement;
    await waitFor(() => expect(again.disabled).toBe(false));
    fireEvent.click(again);
    await waitFor(() => expect(api.createProfile).toHaveBeenCalledTimes(2));
  });

  it('deleting asks first', async () => {
    const api = fakeApi();
    render(<SettingsPage api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Small files' }));
    expect(api.deleteProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(api.deleteProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Small files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(api.deleteProfile).toHaveBeenCalledWith('ab12'));
    await waitFor(() => expect(screen.queryByText('Small files')).toBeNull());
  });

  it('pairing with the NAS posts the code and address and shows the pairing', async () => {
    const api = fakeApi();
    render(<SettingsPage api={api} />);
    const pair = (await screen.findByRole('button', { name: 'Pair' })) as HTMLButtonElement;
    expect(pair.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: ' K7QM-4XP2-R9TD ' } });
    fireEvent.change(screen.getByLabelText('NAS address'), { target: { value: 'http://127.0.0.1:4192/api/' } });
    fireEvent.click(pair);
    await waitFor(() => expect(api.pairNas).toHaveBeenCalledWith({ code: 'K7QM-4XP2-R9TD', base: 'http://127.0.0.1:4192/api/' }));
    expect((await screen.findByText(/Paired with/)).textContent).toBe('Paired with 127.0.0.1 as Mika Owner');
  });

  it('a pasted link is sent alone, and a refusal is shown', async () => {
    const api = fakeApi([standard], {
      pairNas: vi.fn(async () => {
        throw new ApiError(409, 'not-owner', 'That code is for a person who is not an owner.');
      }),
    });
    render(<SettingsPage api={api} />);
    fireEvent.change(await screen.findByLabelText('Or paste the pairing link'), { target: { value: 'https://seikou.example/?pair=K7QM4XP2R9TD&nas=x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That code is for a person who is not an owner.');
    expect(api.pairNas).toHaveBeenCalledWith({ link: 'https://seikou.example/?pair=K7QM4XP2R9TD&nas=x' });
  });

  it('says when the NAS keeps no encodes, and Unpair asks first', async () => {
    const api = fakeApi([standard], {
      nas: vi.fn(async () => ({ paired: true as const, host: 'nas.example', personName: 'Mika Owner', reachable: true, encodes: 'not-configured' as const })),
    });
    render(<SettingsPage api={api} />);
    expect(await screen.findByText(/ENCODES_MOUNT isn't set/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unpair' }));
    expect(api.unpairNas).not.toHaveBeenCalled();
    expect(screen.getByText(/still lists it until an owner removes it/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unpair' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, unpair' }));
    await waitFor(() => expect(api.unpairNas).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText('Pairing code')).toBeTruthy();
  });

  it('shows the file name a pattern gives', () => {
    expect(exampleName('Show S01E{n}')).toBe('Show S01E03.mkv');
    expect(exampleName('plain')).toBe('plain.mkv');
  });
});
