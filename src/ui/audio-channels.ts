// SPDX-License-Identifier: LGPL-3.0-or-later
import type { AudioChannelsChoice } from '@seikou/engine/audio/channel-map';

/** `localStorage` key (a kept `bluray-web` name) of the device's Sound choice. */
export const AUDIO_CHANNELS_KEY = 'bluray-web:audio-channels';

/** The device's Sound choice: `auto` plays 5.1 or 7.1 where the output device has the channels, `stereo` always two. */
export type AudioChannelsSettingValue = 'auto' | 'stereo';

/** The Sound options with the words the menu shows. */
export const AUDIO_CHANNELS_OPTIONS: readonly { readonly value: AudioChannelsSettingValue; readonly label: string }[] = [
  { value: 'auto', label: 'Surround where the device has it' },
  { value: 'stereo', label: 'Always stereo' },
];

function isValue(v: string | null | undefined): v is AudioChannelsSettingValue {
  return v === 'auto' || v === 'stereo';
}

/** What `AudioChannelsSetting` reads from the page, injectable for tests. */
export interface AudioChannelsDeps {
  /** `localStorage`, or null when it is unavailable (it can throw in some privacy modes). */
  readonly storage: () => Storage | null;
  /** The page's query: `?audiochannels=2|6|8` (test-only) uses that many channels as if the device offered them, capped by what it does offer. */
  readonly params: URLSearchParams;
}

/**
 * The device's Sound choice as a small store (for `useSyncExternalStore`): the saved choice, else `auto`. The output
 * takes it when it starts (the first play after the page loads); a pick later applies after a reload.
 */
export class AudioChannelsSetting {
  private value: AudioChannelsSettingValue;
  private readonly listeners = new Set<() => void>();
  private readonly flag: 2 | 6 | 8 | null;

  /** Reads the saved choice and the test flag. */
  constructor(private readonly deps: AudioChannelsDeps) {
    this.value = this.saved();
    const f = deps.params.get('audiochannels');
    this.flag = f === '2' || f === '6' || f === '8' ? (Number(f) as 2 | 6 | 8) : null;
  }

  /** The choice in force. */
  get = (): AudioChannelsSettingValue => this.value;

  /** What the audio output is told: the test flag's count, else the choice. */
  outputChoice(): AudioChannelsChoice {
    return this.flag ?? this.value;
  }

  /** Makes `value` the choice and saves it; a storage that fails still lets it hold for this page. */
  choose(value: AudioChannelsSettingValue): void {
    this.value = value;
    try {
      this.deps.storage()?.setItem(AUDIO_CHANNELS_KEY, value);
    } catch {
      // not saved: the choice holds until the page closes
    }
    for (const l of [...this.listeners]) l();
  }

  /** Calls `listener` after each `choose`; returns the function that stops it. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private saved(): AudioChannelsSettingValue {
    try {
      const v = this.deps.storage()?.getItem(AUDIO_CHANNELS_KEY);
      return isValue(v) ? v : 'auto';
    } catch {
      return 'auto';
    }
  }
}

let shared: AudioChannelsSetting | null = null;

/** The page's one Sound setting, read from `localStorage` and `location.search` the first time it is asked for. */
export function audioChannelsSetting(): AudioChannelsSetting {
  shared ??= new AudioChannelsSetting({
    storage: () => {
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    },
    params: new URLSearchParams(location.search),
  });
  return shared;
}
