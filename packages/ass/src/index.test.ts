// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, it } from 'vitest';
import { parseAss } from './index';

it('parses a script through the barrel', () => {
  const track = parseAss('[Script Info]\nPlayResX: 640\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello\n');
  expect(track.events).toHaveLength(1);
});
