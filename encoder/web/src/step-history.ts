// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef } from 'react';
import type { Step } from './helper-model';

/** What each history entry the helper makes stores. */
interface StepEntry {
  /** The step the entry shows. */
  readonly step: Step;
}

/** The step a history entry's state names, or null when the entry is not one the helper made. */
function entryStep(state: unknown): Step | null {
  const step = (state as Partial<StepEntry> | null)?.step;
  return step === 1 || step === 2 || step === 3 ? step : null;
}

/**
 * Ties the step on screen to the browser's history, so Back and Forward move between steps. The first render replaces
 * the current entry with `{ step }`; each later step change the user makes pushes one. On `popstate` the stored step
 * is entered through `goTo`, or, when `canEnter` no longer allows it, the nearest earlier step that does (the entry is
 * then rewritten to match). A step change that came from `popstate` pushes nothing, so there are no history loops.
 * The address, `location.search` included, is never changed: the page's token is read from it at load and a reload
 * must keep working.
 */
export function useStepHistory(step: Step, canEnter: (step: Step) => boolean, goTo: (step: Step) => void): void {
  const recorded = useRef<Step | null>(null);
  const latest = useRef({ canEnter, goTo });
  latest.current = { canEnter, goTo };

  useEffect(() => {
    if (recorded.current === null) {
      window.history.replaceState({ step } satisfies StepEntry, '', window.location.href);
    } else if (recorded.current !== step) {
      window.history.pushState({ step } satisfies StepEntry, '', window.location.href);
    }
    recorded.current = step;
  }, [step]);

  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      const target = entryStep(event.state);
      if (target === null) return;
      let landed: Step = target;
      while (landed > 1 && !latest.current.canEnter(landed)) landed = (landed - 1) as Step;
      if (landed !== target) window.history.replaceState({ step: landed } satisfies StepEntry, '', window.location.href);
      recorded.current = landed;
      latest.current.goTo(landed);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
}
