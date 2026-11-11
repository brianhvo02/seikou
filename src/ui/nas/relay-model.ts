import type { NasRelayUsage, NasRoute } from './nas-client';

/**
 * The relay's wording, pure: the usage line from the NAS's usage counts, the message once the free allowance is used
 * up, the badge, and the labels of the settings and routes.
 */

const GB = 1e9;

/** "Relay this month: 412 of 1,000 GB free": whole GB (rounded down), with a thousands separator. */
export function usageLine(usage: Pick<NasRelayUsage, 'usedBytes' | 'freeBytes'>): string {
  const gb = (bytes: number): string => Math.floor(Math.max(bytes, 0) / GB).toLocaleString('en-US');
  return `Relay this month: ${gb(usage.usedBytes)} of ${gb(usage.freeBytes)} GB free`;
}

/** "The relay's free allowance for this month is used up. It resets on {date}.", the date (`YYYY-MM-DD`, UTC) in `locale`. */
export function relayLimitMessage(resetsOn: string, locale?: string): string {
  const day = new Date(`${resetsOn}T00:00:00Z`);
  const date = Number.isNaN(day.getTime())
    ? resetsOn
    : new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(day);
  return `The relay's free allowance for this month is used up. It resets on ${date}.`;
}

/** `relayLimitMessage` under its older name. */
export const limitMessage = relayLimitMessage;

/** The badge shown while a NAS disc plays over a relayed connection. */
export const RELAYED_BADGE = 'Relayed';

/** The admin screen's Relay section: its labels, and the terms they rest on (checked 2026-10-19). */
export const relaySettingsCopy = {
  heading: 'Relay',
  enable: 'Use the Cloudflare relay when a direct connection fails',
  allowPaid: 'Allow paid use beyond the free allowance',
  terms:
    "Cloudflare's relay (TURN) gives 1,000 GB free each month; its terms were checked on 2026-10-19. The usage shown is the NAS's own estimate. It is off until you turn it on, and stops at the free allowance unless you allow paid use.",
  paidConfirm: 'Beyond the free allowance, Cloudflare bills the relay to your Cloudflare account (about $0.05 per GB). Allow paid use?',
} as const;

/** How a device last reached the NAS, on the admin screen. */
export function routeLabel(route: NasRoute | undefined): string | null {
  switch (route) {
    case 'https':
      return 'Home or Tailscale';
    case 'webrtc':
      return 'WebRTC';
    case 'relay':
      return 'WebRTC (relayed)';
    default:
      return null;
  }
}
