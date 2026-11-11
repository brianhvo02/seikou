/** Formats microseconds as `m:ss`, or `h:mm:ss` from an hour on, truncating toward zero and clamping negatives to 0; a non-finite value gives `--:--`. */
export function formatTime(us: number): string {
  if (!Number.isFinite(us)) return '--:--';
  const total = Math.max(0, Math.floor(us / 1e6));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
