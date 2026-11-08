// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Step } from './helper-model';
import { useStepHistory } from './step-history';

/** A step change the user asked for: noted with the hook, then made. */
let setStep: (s: Step) => void = () => {};
/** A step change the state forced, which the user never asked for. */
let forceStep: (s: Step) => void = () => {};
let current: Step = 1;
let allowed: (s: Step) => boolean = () => true;

function Harness() {
  const [step, set] = useState<Step>(1);
  const request = useStepHistory(step, (s) => allowed(s), set);
  setStep = (s) => {
    request(s);
    set(s);
  };
  forceStep = set;
  current = step;
  return null;
}

function pop(step: unknown): void {
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate', { state: { step } }));
  });
}

beforeEach(() => {
  allowed = () => true;
  window.history.replaceState(null, '', '/?t=abc');
});
afterEach(cleanup);

describe('useStepHistory', () => {
  it('the first load replaces rather than pushes', () => {
    const before = window.history.length;
    render(<Harness />);
    expect(window.history.length).toBe(before);
    expect(window.history.state).toEqual({ step: 1 });
  });

  it('a step change pushes a history entry', () => {
    render(<Harness />);
    const before = window.history.length;
    act(() => setStep(2));
    expect(window.history.length).toBe(before + 1);
    expect(window.history.state).toEqual({ step: 2 });
  });

  it('popstate goes to the stored step and pushes nothing', () => {
    render(<Harness />);
    act(() => setStep(2));
    const before = window.history.length;
    pop(1);
    expect(current).toBe(1);
    expect(window.history.length).toBe(before);
  });

  it('popstate to an unreachable step lands on the nearest allowed earlier one', () => {
    render(<Harness />);
    act(() => setStep(2));
    allowed = (s) => s <= 2;
    pop(3);
    expect(current).toBe(2);
    expect(window.history.state).toEqual({ step: 2 });
    allowed = (s) => s === 1;
    pop(3);
    expect(current).toBe(1);
  });

  it('a step change the state forced replaces the entry instead of pushing one', () => {
    render(<Harness />);
    act(() => setStep(2));
    act(() => setStep(3));
    const before = window.history.length;
    act(() => forceStep(2));
    expect(window.history.length).toBe(before);
    expect(window.history.state).toEqual({ step: 2 });
    act(() => setStep(3));
    expect(window.history.length).toBe(before + 1);
    expect(window.history.state).toEqual({ step: 3 });
  });

  it("the URL's search is kept", () => {
    render(<Harness />);
    act(() => setStep(3));
    expect(window.location.search).toBe('?t=abc');
  });
});
