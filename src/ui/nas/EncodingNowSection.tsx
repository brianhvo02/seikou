import { useEffect, useState, type ReactElement } from 'react';
import type { EncodingNow } from '@seikou/nas/nas-api';
import { encodingLine, encodingStatus } from './admin-model';
import type { NasClient } from './nas-client';

/** While the section shows, what is encoding is asked again this often. */
export const ENCODING_POLL_MS = 10_000;

/**
 * "Encoding now" (spec §6.4): what the NAS GPU is re-encoding and for whom, refreshed when the screen opens and every
 * 10 s. Hidden when the NAS has no quality levels (its route answers 404); a failed refresh keeps the last list, and a
 * failed first load says so while the polling goes on.
 */
export function EncodingNowSection({ nas }: { nas: NasClient }): ReactElement | null {
  const [list, setList] = useState<readonly EncodingNow[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const load = (): void => {
      nas.admin.encodingNow().then(
        (l) => {
          if (!live) return;
          setFailed(false);
          if (l === null) setMissing(true);
          else setList(l);
        },
        () => {
          if (live) setFailed(true);
        },
      );
    };
    load();
    const timer = setInterval(load, ENCODING_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [nas]);

  if (missing) return null;
  const status = encodingStatus({ list, failed });
  return (
    <section className="admin-encoding" data-testid="encoding-now" aria-labelledby="admin-encoding-head">
      <h3 id="admin-encoding-head">Encoding now</h3>
      {status !== null || list === null ? (
        <p className="status">{status}</p>
      ) : (
        <ul className="library-rows">
          {list.map((e, i) => (
            <li key={i} data-testid="encoding-row">
              {encodingLine(e)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
