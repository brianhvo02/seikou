import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react';
import type { DiscManifest, StoredSubtitle } from '../../engine/disc/nas-api';
import { discKeyOf } from '../../engine/disc/disc-key';
import type { NasClient } from './nas-client';
import { LANGUAGES, formatOffset, languageTag, subtitleErrorMessage, type SubtitleTarget } from './subtitle-model';
import { rememberFansubDeletion } from './fansub-model';
import { SubtitleUpload, type ManifestOf } from './SubtitleUpload';
import { nameLang } from '../name-lang';

/** A title's stored subtitles (null until known), why the last fetch failed (null when it didn't), and a way to fetch them again. */
export function useStoredSubtitles(
  nas: Pick<NasClient, 'subtitlesForTitle'>,
  titleId: string,
  enabled: boolean,
): { readonly subs: readonly StoredSubtitle[] | null; readonly error: string | null; readonly reload: () => void } {
  const [subs, setSubs] = useState<readonly StoredSubtitle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    nas.subtitlesForTitle(titleId).then(
      (s) => {
        if (!live) return;
        setSubs(s);
        setError(null);
      },
      (err: unknown) => live && setError(subtitleErrorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [nas, titleId, enabled, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { subs, error, reload };
}

/** Disc manifests, each fetched once while the screen is open (a failed fetch is tried again next time). */
export function useManifests(nas: Pick<NasClient, 'manifest'> | null): ManifestOf {
  return useMemo(() => {
    const cache = new Map<string, Promise<DiscManifest>>();
    return (discId: string) => {
      if (!nas) return Promise.reject(new Error('Only owners read disc manifests here.'));
      let p = cache.get(discId);
      if (!p) {
        p = nas.manifest(discId);
        cache.set(discId, p);
        p.catch(() => cache.delete(discId));
      }
      return p;
    };
  }, [nas]);
}

/**
 * Disc key → disc id for the target's discs, from their manifests, fetched only when `needed` (an upload attached to a
 * chapter has only its disc key); `loaded` once every manifest answered or failed (a failed one is left out).
 */
export function useDiscKeys(manifestOf: ManifestOf, target: SubtitleTarget, needed: boolean): { readonly keys: ReadonlyMap<string, string>; readonly loaded: boolean } {
  const [state, setState] = useState<{ readonly discIds: string; readonly keys: ReadonlyMap<string, string> } | null>(null);
  const discIds = target.discs.map((d) => d.discId).join(',');
  useEffect(() => {
    if (!needed || discIds === '') return;
    let live = true;
    void Promise.all(
      discIds.split(',').map((id) =>
        manifestOf(id).then(
          (m): [string, string] | null => [discKeyOf(id, m.files), id],
          () => null,
        ),
      ),
    ).then((pairs) => live && setState({ discIds, keys: new Map(pairs.filter((p) => p !== null)) }));
    return () => {
      live = false;
    };
  }, [manifestOf, discIds, needed]);
  return useMemo(
    () => (state?.discIds === discIds ? { keys: state.keys, loaded: true } : { keys: new Map<string, string>(), loaded: discIds === '' }),
    [state, discIds],
  );
}

const languageName = (code: string): string | null => LANGUAGES.find((l) => l.code.toLowerCase() === code.toLowerCase())?.label ?? null;

function attachmentLabel(s: StoredSubtitle, target: SubtitleTarget, keys: ReadonlyMap<string, string>): string {
  const a = s.attachment;
  if (a.kind === 'episode') return `Episode ${a.episode}`;
  const discId = keys.get(a.discKey);
  const disc = target.discs.find((d) => d.discId === discId)?.label ?? 'A disc';
  return `${disc} · playlist ${a.playlistId} · chapter ${a.chapter + 1}`;
}

interface SubtitleListProps {
  readonly nas: NasClient;
  readonly target: SubtitleTarget;
  /** The uploads this screen lists (ownerListing), null until fetched. */
  readonly listing: { readonly attached: readonly StoredSubtitle[]; readonly notAttached: readonly StoredSubtitle[] } | null;
  /** Why the subtitles couldn't be fetched, with Try again. */
  readonly error: string | null;
  readonly manifestOf: ManifestOf;
  /** Disc key → disc id for the target's discs, and whether they are all known (useDiscKeys). */
  readonly discKeys: { readonly keys: ReadonlyMap<string, string>; readonly loaded: boolean };
  /** An upload changed or went, or Try again: the screen fetches the subtitles again. */
  readonly onChanged: () => void;
}

/**
 * The owner's list of a season's or movie's uploads: name, language, what it is for, its files and default offset, with
 * Edit (the upload form, filled in) and Delete after a confirm; then, under "Not attached", the title's uploads whose
 * disc, playlist or season is gone, to re-attach or delete.
 */
export function SubtitleList({ nas, target, listing, error: listError, manifestOf, discKeys: { keys: discKeys, loaded }, onChanged }: SubtitleListProps): ReactElement {
  const [open, setOpen] = useState<{ readonly id: string; readonly what: 'edit' | 'delete' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ readonly id: string; readonly message: string } | null>(null);
  const discIdOfKey = useCallback((key: string) => discKeys.get(key) ?? null, [discKeys]);
  const heading = useId();

  const remove = async (sub: StoredSubtitle): Promise<void> => {
    const id = sub.id;
    setBusy(true);
    setError(null);
    try {
      await nas.deleteSubtitle(id);
      if (sub.source !== undefined) rememberFansubDeletion(target.titleId);
      setOpen(null);
      onChanged();
    } catch (err) {
      setError({ id, message: subtitleErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const row = (s: StoredSubtitle): ReactElement => {
    const offset = formatOffset(s.offsetMs);
    const language = languageName(s.language);
    const what = open?.id === s.id ? open.what : null;
    // a chapter upload's disc is known only by its key: Edit waits until the discs' keys are
    const waiting = s.attachment.kind === 'chapter' && !loaded;
    return (
      <li key={s.id} className="subtitle-row" data-testid="subtitle-row" data-name={s.name} data-id={s.id}>
        <div className="subtitle-row-main">
          <span className="tag" title={s.language}>
            {languageTag(s.language)}
          </span>
          <span className="title-row-text">
            <span className="title-row-name" lang={nameLang(s.name)}>
              {s.name}
            </span>
            <span className="title-muted">
              {[attachmentLabel(s, target, discKeys), language ?? s.language].join(' · ')}
              {s.attached === false && (
                <span className="subtitle-not-attached" data-testid="subtitle-not-attached">
                  Not attached
                </span>
              )}
            </span>
            <span className="title-muted subtitle-files">{[[s.fileName, ...s.fonts.map((f) => f.name)].join(', '), offset].filter((x) => x !== null).join(' · ')}</span>
          </span>
          <span className="admin-confirm">
            <button type="button" data-testid="subtitle-edit" aria-expanded={what === 'edit'} aria-label={`Edit ${s.name}`} disabled={busy || waiting} onClick={() => setOpen(what === 'edit' ? null : { id: s.id, what: 'edit' })}>
              {waiting ? 'Loading…' : 'Edit'}
            </button>
            <button type="button" data-testid="subtitle-delete" aria-label={`Delete ${s.name}`} disabled={busy} onClick={() => setOpen({ id: s.id, what: 'delete' })}>
              Delete
            </button>
          </span>
        </div>
        {what === 'edit' && (
          <SubtitleUpload
            nas={nas}
            target={target}
            manifestOf={manifestOf}
            editing={s}
            discIdOfKey={discIdOfKey}
            onDone={() => {
              setOpen(null);
              onChanged();
            }}
            onCancel={() => setOpen(null)}
          />
        )}
        {what === 'delete' && (
          <div className="admin-confirm-box" role="group" aria-label="Confirm">
            <p>{`Delete ${s.name} and its fonts from the NAS? Everyone loses it.`}</p>
            <span className="admin-confirm">
              <button type="button" data-testid="subtitle-delete-confirm" disabled={busy} onClick={() => void remove(s)}>
                Delete
              </button>
              <button type="button" disabled={busy} onClick={() => setOpen(null)}>
                Cancel
              </button>
            </span>
          </div>
        )}
        {error?.id === s.id && (
          <p className="owner-message" role="alert">
            {error.message}
          </p>
        )}
      </li>
    );
  };
  const rows = (subs: readonly StoredSubtitle[]): ReactElement => <ul className="title-list">{subs.map(row)}</ul>;

  return (
    <section className="subtitle-section" data-testid="subtitle-list" aria-labelledby={heading}>
      <h3 className="title-section" id={heading}>
        Subtitles on the NAS
      </h3>
      {listError !== null && (
        <p className="owner-message subtitle-list-error" role="alert" data-testid="subtitle-list-error">
          {`Couldn't read the subtitles on the NAS. ${listError}`}{' '}
          <button type="button" className="title-link" onClick={onChanged}>
            Try again
          </button>
        </p>
      )}
      {listing !== null && (listing.attached.length === 0 ? <p className="title-muted subtitle-empty">None uploaded yet.</p> : rows(listing.attached))}
      {listing !== null && listing.notAttached.length > 0 && (
        <>
          <h4 className="owner-subhead">Not attached</h4>
          <p className="title-muted subtitle-empty">Their disc, playlist or season is no longer on the NAS. Edit one to attach it again, or delete it.</p>
          {rows(listing.notAttached)}
        </>
      )}
    </section>
  );
}
