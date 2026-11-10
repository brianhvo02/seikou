// SPDX-License-Identifier: LGPL-3.0-or-later
import { useState } from 'react';
import { CHAPTER_NAMES } from './episode-info-model';

/** What the picker needs: the chapter, its name as the page holds it, and what a change does. */
export interface ChapterNamePickerProps {
  /** The playlist chapter (1-based). */
  readonly chapter: number;
  /** Its name; empty for none. */
  readonly name: string;
  /** True while the names cannot be changed (not loaded, or the load failed). */
  readonly disabled: boolean;
  /** The name was changed; empty for "No name". */
  readonly onChange: (name: string) => void;
}

const CUSTOM = '\u0000custom';
const isPreset = (name: string): boolean => (CHAPTER_NAMES as readonly string[]).includes(name);

/**
 * A chapter's name: a select of the usual names, "No name" and "Custom…", which shows a text field for any other
 * name. Choosing Custom changes nothing until something is typed; the field starts from the chapter's name.
 */
export function ChapterNamePicker({ chapter, name, disabled, onChange }: ChapterNamePickerProps) {
  const [custom, setCustom] = useState(name !== '' && !isPreset(name));
  const showCustom = custom || (name !== '' && !isPreset(name));
  const value = showCustom ? CUSTOM : name;
  return (
    <span className="chapter-name">
      <select
        aria-label={`Name of chapter ${chapter}`}
        className={value === '' ? 'unnamed' : undefined}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const picked = e.target.value;
          if (picked === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(picked);
        }}
      >
        <option value="">No name</option>
        {CHAPTER_NAMES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {showCustom && (
        <input
          type="text"
          aria-label={`Custom name for chapter ${chapter}`}
          placeholder="Chapter name"
          value={name}
          maxLength={100}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </span>
  );
}
