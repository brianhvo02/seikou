import type { ReactElement } from 'react';

/** Why a NAS link can't open on this device. */
export type NotFoundReason = 'unpaired' | 'missing' | 'closed';

const COPY: Record<NotFoundReason, { readonly text: string; readonly button: string }> = {
  unpaired: { text: "This link is for a NAS this device isn't paired with. Ask its owner to send you an invite.", button: 'Pair with a NAS' },
  missing: {
    text: "This NAS doesn't have what this link points to. It may have been removed or renamed, or the link may be for another NAS.",
    button: 'Back to the library',
  },
  closed: {
    text: "The NAS owner hasn't opened the title library to this device, so this link can't open here. You can still browse the NAS by folder.",
    button: 'Browse by folder',
  },
};

interface NasNotFoundProps {
  readonly reason: NotFoundReason;
  /** Leaves the link's path: to the pair screen when unpaired, to the library (or, behind the closed gate, the folders) otherwise. */
  readonly onLeave: () => void;
}

/** A NAS link this device can't open: it isn't paired, the NAS has nothing at the link, or the title library is closed to it. */
export function NasNotFound({ reason, onLeave }: NasNotFoundProps): ReactElement {
  const copy = COPY[reason];
  return (
    <section className="nas-not-found" data-testid="nas-not-found" data-reason={reason}>
      <p>{copy.text}</p>
      <button type="button" data-testid="nas-not-found-pair" onClick={onLeave}>
        {copy.button}
      </button>
    </section>
  );
}
