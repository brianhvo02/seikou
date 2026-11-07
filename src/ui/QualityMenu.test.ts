import { describe, expect, it } from 'vitest';
import type { LevelInfo } from '@seikou/nas/nas-api';
import type { LevelState } from './nas/level-session';
import { levelItemLabel, levelMenuItems } from './QualityMenu';

const orig: LevelInfo = { level: 'original', label: 'Original', budgetMbps: 0, available: true };
const p1080: LevelInfo = { level: 'h264-1080', label: '1080p', budgetMbps: 10.2, available: true };
const phone: LevelInfo = { level: 'phone-720', label: 'Phone', budgetMbps: 3, available: true };
const state = (levels: LevelInfo[], level: LevelState['at']['level'] = 'original'): LevelState => ({ discId: 'd', levels, at: { level, audio: 1 }, notice: null });

describe('QualityMenu', () => {
  it('labels a re-encoded level with its whole-number rate and Original bare', () => {
    expect(levelItemLabel(p1080)).toBe('1080p · 10 Mbps');
    expect(levelItemLabel(orig)).toBe('Original');
  });
  it('is hidden with fewer than two available levels', () => {
    expect(levelMenuItems(state([orig]))).toEqual([]);
    expect(levelMenuItems(state([orig, { ...p1080, available: false, reason: 'no-encoder' }]))).toEqual([]);
  });
  it('disables an unavailable level with its reason and checks the current one', () => {
    const items = levelMenuItems(state([orig, p1080, { ...phone, available: false, reason: 'busy' }], 'h264-1080'));
    expect(items.map((i) => [i.level, i.checked, i.disabled, i.title])).toEqual([
      ['original', false, false, undefined],
      ['h264-1080', true, false, undefined],
      ['phone-720', false, true, 'the NAS is busy'],
    ]);
  });
});
