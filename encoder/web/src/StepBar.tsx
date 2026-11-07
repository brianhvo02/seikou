// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Step } from './helper-model';

/** The steps' names, in order. */
export const STEP_NAMES: Readonly<Record<Step, string>> = { 1: 'Release', 2: 'Episodes', 3: 'Line up' };

/** What the step bar shows and does. */
export interface StepBarProps {
  /** The step on screen. */
  readonly step: Step;
  /** Whether a step can be entered now; a closed step is shown disabled. */
  readonly canEnter: (step: Step) => boolean;
  /** Called with the step the user picked. */
  readonly onSelect: (step: Step) => void;
}

/**
 * The bar of the page's three steps, numbered because they are a sequence. The step on screen carries
 * `aria-current="step"`; steps that cannot be entered yet are disabled.
 */
export function StepBar({ step, canEnter, onSelect }: StepBarProps) {
  const steps: Step[] = [1, 2, 3];
  return (
    <nav className="step-bar" aria-label="Steps">
      <ol>
        {steps.map((s) => (
          <li key={s} className={s === step ? 'current' : undefined}>
            <button type="button" aria-current={s === step ? 'step' : undefined} disabled={s !== step && !canEnter(s)} onClick={() => onSelect(s)}>
              <span className="step-number">{s}</span>
              <span className="step-name">{STEP_NAMES[s]}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
