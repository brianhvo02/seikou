// SPDX-License-Identifier: LGPL-3.0-or-later
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api';
import type { EncodeSettings, Profile } from '../api-types';
import type { AppApi } from './app-api';
import { NasPairing } from './NasPairing';
import { useDocumentTitle } from './place';

/** What the page needs: the backend client. */
export interface SettingsPageProps {
  /** The backend client. */
  readonly api: AppApi;
}

/** The file name a pattern gives episode 3, as the encode writes it (the number is padded to two digits). */
export function exampleName(pattern: string): string {
  return `${pattern.trim().replaceAll('{n}', '03')}.mkv`;
}

/** The settings of the built-in profile, which a new profile starts from. */
export const STARTING_SETTINGS: EncodeSettings = {
  crf: 25,
  preset: 4,
  filmGrain: 4,
  extraSvtArgs: [],
  opusBitrate: null,
  pgs: true,
  web: false,
  namePattern: 'episode-{n}',
  destination: 'folder',
};

/** The settings as one line of plain words, for a profile's row. */
export function profileSummary(s: EncodeSettings): string {
  const parts = [
    `CRF ${s.crf}`,
    `preset ${s.preset}`,
    `film grain ${s.filmGrain}`,
    s.opusBitrate === null ? 'Opus default' : `Opus ${s.opusBitrate} kb/s`,
    s.pgs ? 'with PGS' : 'no PGS',
    s.web ? 'web package' : 'no web package',
    exampleName(s.namePattern),
  ];
  return parts.join(', ');
}

/** A field's text as the number it stands for; NaN (refused by the server, naming the field) when blank or not a number. */
const numberOf = (text: string): number => (text.trim() === '' ? Number.NaN : Number(text));

interface Draft {
  name: string;
  crf: string;
  preset: string;
  filmGrain: string;
  opusBitrate: string;
  pgs: boolean;
  web: boolean;
  namePattern: string;
  extraSvtArgs: string;
  /** Kept as the profile has it; the profile editor offers no choice of it yet. */
  destination: EncodeSettings['destination'];
}

function draftOf(name: string, s: EncodeSettings): Draft {
  return {
    name,
    crf: String(s.crf),
    preset: String(s.preset),
    filmGrain: String(s.filmGrain),
    opusBitrate: s.opusBitrate === null ? '' : String(s.opusBitrate),
    pgs: s.pgs,
    web: s.web,
    namePattern: s.namePattern,
    extraSvtArgs: s.extraSvtArgs.join(' '),
    destination: s.destination,
  };
}

function settingsOf(d: Draft): EncodeSettings {
  return {
    crf: numberOf(d.crf),
    preset: numberOf(d.preset),
    filmGrain: numberOf(d.filmGrain),
    extraSvtArgs: d.extraSvtArgs.split(/\s+/).filter((a) => a !== ''),
    // text that is not a number goes as typed, so the server refuses it and names the field (null would mean "default")
    opusBitrate: d.opusBitrate.trim() === '' ? null : Number.isNaN(Number(d.opusBitrate)) ? (d.opusBitrate as never) : Number(d.opusBitrate),
    pgs: d.pgs,
    web: d.web,
    namePattern: d.namePattern,
    destination: d.destination,
  };
}

interface FormProps {
  /** The profile being edited, or null for a new one. */
  readonly profile: Profile | null;
  readonly onSave: (name: string, settings: EncodeSettings) => Promise<void>;
  readonly onCancel: () => void;
}

/** The fields of one profile, with the server's complaint beside the field it names. */
function ProfileForm({ profile, onSave, onCancel }: FormProps) {
  const id = useId();
  const [draft, setDraft] = useState<Draft>(draftOf(profile?.name ?? '', profile?.settings ?? STARTING_SETTINGS));
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFieldErrors({});
    setProblem(null);
    try {
      await onSave(draft.name, settingsOf(draft));
    } catch (err) {
      const field = err instanceof ApiError ? err.details.field : undefined;
      const message = err instanceof Error ? err.message : String(err);
      if (typeof field === 'string') setFieldErrors({ [field]: message });
      else setProblem(message);
      setBusy(false);
    }
  };

  /** One labelled control with its hint and, when the server refused it, the message beside it. */
  const field = (key: keyof Draft, label: string, hint: ReactNode, control: 'text' | 'number', extra: { placeholder?: string; spellCheck?: boolean } = {}) => {
    const hintId = `${id}-${key}-hint`;
    const errorId = `${id}-${key}-error`;
    const error = fieldErrors[key];
    return (
      <div className="field">
        <label className="field-label" htmlFor={`${id}-${key}`}>
          {label}
        </label>
        <input
          id={`${id}-${key}`}
          type={control}
          value={String(draft[key])}
          onChange={(e) => set(key, e.target.value as never)}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? hintId : `${hintId} ${errorId}`}
          {...extra}
        />
        <span className="hint" id={hintId}>
          {hint}
        </span>
        {error !== undefined && (
          <span className="error field-error" id={errorId} role="alert">
            {error}
          </span>
        )}
      </div>
    );
  };

  return (
    <form className="profile-form" onSubmit={(e) => void submit(e)}>
      {field('name', 'Name', 'Shown when you queue an encode.', 'text')}
      <div className="field-pair">
        {field('crf', 'CRF', '0 to 63. Lower is better quality and bigger files.', 'number')}
        {field('preset', 'Preset', '-1 to 13. Lower is slower and better.', 'number')}
        {field('filmGrain', 'Film grain', '0 to 50. Grain the player adds back; 0 is none.', 'number')}
        {field('opusBitrate', 'Opus bitrate (kb/s)', '6 to 512 for each audio track. Blank lets opusenc choose.', 'number', { placeholder: "opusenc's default" })}
      </div>
      <div className="field">
        <label className="check">
          <input type="checkbox" checked={draft.pgs} onChange={(e) => set('pgs', e.target.checked)} />
          <span>PGS subtitles</span>
        </label>
        <span className="hint">Keep the disc's picture subtitles in each episode.</span>
        <label className="check">
          <input type="checkbox" checked={draft.web} onChange={(e) => set('web', e.target.checked)} />
          <span>Web package</span>
        </label>
        <span className="hint">Also write each episode as a folder for the web player.</span>
      </div>
      {field(
        'namePattern',
        'Output name pattern',
        <>
          {'{n}'} is the episode number. Episode 3 is saved as <span className="num">{exampleName(draft.namePattern)}</span>.
        </>,
        'text',
      )}
      {field(
        'extraSvtArgs',
        'Extra SVT-AV1 arguments',
        "Separated by spaces and added after the encoder's own, so a value that contains a space isn't supported. Options set by the fields above are refused.",
        'text',
        { placeholder: '--lookahead 40', spellCheck: false },
      )}
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy}>
          Save
        </button>
        <button type="button" className="quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

interface RowProps {
  readonly profile: Profile;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
  readonly onSave: (name: string, settings: EncodeSettings) => Promise<void>;
  readonly onDuplicate: () => Promise<void>;
  readonly onDelete: () => Promise<void>;
}

/** One profile: its name and settings in a line, then Edit (Duplicate for the built-in one) and Delete, or the form. */
function ProfileRow({ profile, editing, onEdit, onCancel, onSave, onDuplicate, onDelete }: RowProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** False once the row is gone (a deleted profile), so a late answer sets no state. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run =async (action: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (e) {
      if (mounted.current) {
        setProblem(e instanceof Error ? e.message : String(e));
        setConfirming(false);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <li className="profile">
      <div className="profile-head">
        <div className="profile-text">
          <span className="profile-name">{profile.name}</span>
          {profile.builtIn && <span className="mark">Built in</span>}
          <span className="muted profile-summary">{profileSummary(profile.settings)}</span>
        </div>
        {!editing && (
          <div className="profile-actions">
            {profile.builtIn ? (
              <button type="button" className="quiet" disabled={busy} aria-label={`Duplicate ${profile.name}`} onClick={() => void run(onDuplicate)}>
                Duplicate
              </button>
            ) : confirming ? (
              <>
                <span className="muted">Delete this profile?</span>
                <button type="button" className="quiet danger" disabled={busy} onClick={() => void run(onDelete)}>
                  Yes, delete
                </button>
                <button type="button" className="quiet" disabled={busy} onClick={() => setConfirming(false)}>
                  Keep it
                </button>
              </>
            ) : (
              <>
                <button type="button" className="quiet" aria-label={`Edit ${profile.name}`} onClick={onEdit}>
                  Edit
                </button>
                <button type="button" className="quiet" aria-label={`Delete ${profile.name}`} onClick={() => setConfirming(true)}>
                  Delete
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {editing && <ProfileForm profile={profile} onSave={onSave} onCancel={onCancel} />}
    </li>
  );
}

/**
 * The Settings page: the encode settings profiles. The built-in Default comes first and is only duplicated; the others
 * are edited in place (CRF, preset, film grain, Opus bitrate, PGS, web package, output name pattern, extra SVT-AV1
 * arguments), duplicated and deleted after a confirmation. A refused value is shown beside its field. Under them, "Your
 * NAS" pairs the encoder with the NAS (`NasPairing`).
 */
export function SettingsPage({ api }: SettingsPageProps) {
  useDocumentTitle('Settings · Seikou encoder');
  const [profiles, setProfiles] = useState<readonly Profile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The id of the profile open for editing, `new` for the form that makes one, or null. */
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProfiles(await api.profiles());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="content wide">
      <div className="page-head">
        <h1 className="page-title">Settings</h1>
        <button type="button" className="quiet" disabled={profiles === null || editing === 'new'} onClick={() => setEditing('new')}>
          New profile
        </button>
      </div>
      <p className="muted content-lead">
        A profile is a named set of encode settings. Queuing an encode copies the profile you pick into the job, so changing a profile later
        leaves queued and finished jobs as they were.
      </p>
      {loadError !== null && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}
      {profiles !== null && (
        <ul className="profile-list">
          {profiles.map((p) => (
            <ProfileRow
              key={p.id}
              profile={p}
              editing={editing === p.id}
              onEdit={() => setEditing(p.id)}
              onCancel={() => setEditing(null)}
              onSave={async (name, settings) => {
                const saved = await api.updateProfile(p.id, name, settings);
                setProfiles((all) => all?.map((x) => (x.id === saved.id ? saved : x)) ?? null);
                setEditing(null);
              }}
              onDuplicate={async () => {
                const copy = await api.createProfile(`${p.name} (copy)`, p.settings);
                setProfiles((all) => [...(all ?? []), copy]);
                setEditing(copy.id);
              }}
              onDelete={async () => {
                await api.deleteProfile(p.id);
                setProfiles((all) => all?.filter((x) => x.id !== p.id) ?? null);
              }}
            />
          ))}
        </ul>
      )}
      {editing === 'new' && (
        <section className="profile-new" aria-labelledby="new-profile-heading">
          <h2 id="new-profile-heading">New profile</h2>
          <ProfileForm
            profile={null}
            onCancel={() => setEditing(null)}
            onSave={async (name, settings) => {
              const made = await api.createProfile(name, settings);
              setProfiles((all) => [...(all ?? []), made]);
              setEditing(null);
            }}
          />
        </section>
      )}
      <NasPairing api={api} />
    </main>
  );
}
