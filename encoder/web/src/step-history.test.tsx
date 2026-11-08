// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Step } from './helper-model';
import { useStepHistory } from './step-history';

let setStep: (s: Step) => void = () => {};
let current: Step = 1;
let allowed: (s: Step) => boolean = () => true;

function Harness() {
  const [step, set] = useState<Step>(1);
  setStep = set;
  current = step;
  useStepHistory(step, (s) => allowed(s), set);
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

  it("the URL's search is kept", () => {
    render(<Harness />);
    act(() => setStep(3));
    expect(window.location.search).toBe('?t=abc');
  });
});
