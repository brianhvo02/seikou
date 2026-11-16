// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ReactElement } from 'react';
import type { DynamicRange } from '@seikou/nas';
import { dynamicRangeBadge } from './library-model';

/** A disc's or title's HDR badge (`DV`, `HDR10+`, `HDR10`); nothing for SDR or a NAS that sends no dynamic range. */
export function DynamicRangeBadge({ range }: { readonly range: DynamicRange | null | undefined }): ReactElement | null {
  const text = dynamicRangeBadge(range);
  return text ? (
    <span className="badge" data-testid="dynamic-range-badge">
      {text}
    </span>
  ) : null;
}
