/**
 * Class-library gaps as our JVM meets them (tools/bdj-library/README.md, RunRecord `missingClasses`, `caughtGaps`):
 * every gap throwable is caught where it is made (Java often catches a missing class and goes on quietly), and followed
 * as the interpreter unwinds it, so a lookup that dies in platform code (Ruling R13) can be told from a gap the disc
 * meets. Patches Jvm.prototype.fillInStackTrace and sets the interpreter's unwind observer until stop().
 */
import { setUnwindObserver } from '../../src/bdj/jvm/interpreter';
import { Jvm } from '../../src/bdj/jvm/jvm';
import type { JObject } from '../../src/bdj/jvm/values';
import { gapExempt, gapOf, type UnwindStep } from './classify';

/** Throwables that mean a gap in the class library (Task 2's work): a class, a native or a platform method missing. */
const GAPS = new Set(['java/lang/NoClassDefFoundError', 'java/lang/ClassNotFoundException', 'java/lang/UnsatisfiedLinkError', 'java/lang/NoSuchMethodError']);

export interface GapTracker {
  /** The gaps met so far (gapOf names): every one, and those some throw of which was not exempt (gapExempt). */
  gaps(): { readonly all: ReadonlySet<string>; readonly counted: ReadonlySet<string> };
  stop(): void;
}

export function trackGaps(limit = 5000): GapTracker {
  const thrown: { jvm: Jvm; e: JObject; steps: UnwindStep[] }[] = [];
  const paths = new Map<JObject, UnwindStep[]>();
  const fill = Jvm.prototype.fillInStackTrace;
  Jvm.prototype.fillInStackTrace = function (this: Jvm, e, t) {
    fill.call(this, e, t);
    if (thrown.length < limit && GAPS.has(e.cls.name) && !paths.has(e)) {
      const steps: UnwindStep[] = [];
      paths.set(e, steps);
      thrown.push({ jvm: this, e, steps });
    }
  };
  setUnwindObserver((e, method) => {
    const steps = paths.get(e);
    if (!steps) return;
    const step: UnwindStep = method ? { platform: method.cls.loader === null } : 'uncaught';
    // platform steps beyond a few hundred add nothing (the verdict turns on a disc step or 'uncaught', always kept)
    if (step === 'uncaught' || !step.platform || steps.length < 200) steps.push(step);
  });
  return {
    gaps() {
      const all = new Set<string>();
      const counted = new Set<string>();
      for (const { jvm, e, steps } of thrown) {
        let gap: string | null = null;
        try {
          gap = gapOf(jvm.describe(e));
        } catch {
          continue;
        }
        if (!gap) continue;
        all.add(gap);
        if (!gapExempt(e.cls.name, steps)) counted.add(gap);
      }
      return { all, counted };
    },
    stop() {
      Jvm.prototype.fillInStackTrace = fill;
      setUnwindObserver(null);
    },
  };
}
