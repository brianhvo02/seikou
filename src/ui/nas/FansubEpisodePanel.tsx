import { useState, type ReactElement } from 'react';
import type { FansubEpisodeMark, StoredSubtitle } from '@seikou/nas/nas-api';
import { episodeMark, trackChip } from './fansub-model';
import type { NasClient } from './nas-client';
import { formatOffset, languageTag, subtitleErrorMessage, type SubtitleTarget } from './subtitle-model';
import { SubtitleUpload, type ManifestOf } from './SubtitleUpload';

const REASON: Record<NonNullable<FansubEpisodeMark['reason']>, string> = {
  'no-release': 'No release of this episode was found.',
  'no-tracks': 'The release has no English subtitle track.',
  'service-unavailable': 'Anime Tosho could not be reached; the next run tries again.',
  'too-large': 'The release is too large to fetch.',
};

interface FansubEpisodePanelProps {
  readonly nas: NasClient;
  readonly target: SubtitleTarget;
  readonly manifestOf: ManifestOf;
  /** The fansub tracks stored for this episode (or movie). */
  readonly tracks: readonly StoredSubtitle[];
  readonly mark?: FansubEpisodeMark;
  /** Changed: the screen fetches the subtitles again. */
  readonly onChanged: () => void;
}

/** An episode's fansub tracks for the owner: offset editor, "Line up again" and "Use original timing". */
export function FansubEpisodePanel({ nas, target, manifestOf, tracks, mark, onChanged }: FansubEpisodePanelProps): ReactElement {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (call: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await call();
      onChanged();
    } catch (err) {
      setError(subtitleErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fansub-panel" data-testid="fansub-panel">
      {tracks.length === 0 && <p className="title-muted">{mark?.reason ? REASON[mark.reason] : 'No fansub tracks for this episode.'}</p>}
      {tracks.map((s) => {
        const m = episodeMark([s], mark, s.stale === true);
        const offset = formatOffset(s.offsetMs);
        return (
          <div key={s.id} className="fansub-track" data-testid="fansub-track" data-id={s.id}>
            <div className="fansub-track-main">
              <span className="fansub-chip" title={s.name}>{trackChip(s)}</span>
              <span className="title-muted">{[s.source?.group, languageTag(s.language), offset].filter((x) => x).join(' · ')}</span>
              {m && <span className="fansub-mark" data-tone={m.tone}>{m.text}</span>}
            </div>
            <span className="admin-confirm">
              <button type="button" data-testid="fansub-edit" aria-expanded={editing === s.id} disabled={busy} onClick={() => setEditing(editing === s.id ? null : s.id)}>Offset</button>
              <button type="button" data-testid="fansub-realign" disabled={busy} onClick={() => void act(() => nas.realignFansub(s.id))}>Line up again</button>
              <button type="button" data-testid="fansub-original" disabled={busy} onClick={() => void act(() => nas.originalFansubTiming(s.id))}>Use original timing</button>
            </span>
            {editing === s.id && (
              <SubtitleUpload
                nas={nas}
                target={target}
                manifestOf={manifestOf}
                editing={s}
                onDone={() => {
                  setEditing(null);
                  onChanged();
                }}
                onCancel={() => setEditing(null)}
              />
            )}
          </div>
        );
      })}
      {error !== null && <p className="owner-message" role="alert">{error}</p>}
    </div>
  );
}
