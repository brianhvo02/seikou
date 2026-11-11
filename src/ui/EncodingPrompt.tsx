import { useEffect, useRef, type ReactElement } from 'react';

/** TextDecoder labels offered for subtitle files that are not UTF-8, with the names people know them by. */
const ENCODINGS: ReadonlyArray<readonly [label: string, name: string]> = [
  ['utf-8', 'UTF-8'],
  ['windows-1252', 'Western (Windows-1252)'],
  ['iso-8859-2', 'Central European (ISO-8859-2)'],
  ['shift_jis', 'Japanese (Shift_JIS)'],
  ['euc-kr', 'Korean (EUC-KR)'],
  ['gbk', 'Simplified Chinese (GBK)'],
  ['big5', 'Traditional Chinese (Big5)'],
  ['windows-1251', 'Cyrillic (Windows-1251)'],
];

interface EncodingPromptProps {
  readonly fileName: string;
  /** null cancels. */
  onAnswer(encoding: string | null): void;
}

/**
 * A modal asking which text encoding a subtitle file that isn't UTF-8 uses, with a button per entry of `ENCODINGS`. It
 * calls `onAnswer` with the chosen `TextDecoder` label, or null on Cancel or Escape. Focus starts on the first choice.
 */
export function EncodingPrompt({ fileName, onAnswer }: EncodingPromptProps): ReactElement {
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onAnswer(null);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onAnswer]);

  return (
    <div className="picker-backdrop encoding-backdrop">
      <div className="picker encoding-prompt" role="dialog" aria-modal="true" aria-labelledby="encoding-title" data-testid="encoding-prompt">
        <h2 id="encoding-title">Choose the subtitle encoding</h2>
        <p>
          <strong>{fileName}</strong> isn't UTF-8. Choose its encoding:
        </p>
        <ul>
          {ENCODINGS.map(([label, name], i) => (
            <li key={label}>
              <button ref={i === 0 ? firstRef : undefined} type="button" data-testid={`encoding-${label}`} onClick={() => onAnswer(label)}>
                {name}
              </button>
            </li>
          ))}
        </ul>
        <div className="picker-actions">
          <button type="button" data-testid="encoding-cancel" onClick={() => onAnswer(null)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
