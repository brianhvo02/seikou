import { NasHttpError, type NasCodeTarget, type NasPerson } from './nas-client';
import type { NasPairing } from './nas-store';
import { routeLabel } from './relay-model';

/**
 * The People list and the pairing codes of NAS settings, pure: the rows from the NAS's people and a clock, whether an
 * action would take this device's owner rights, the code's target, and the confirm questions and error messages.
 */

/** What the admin screen says when the NAS refuses an action with 409 `last-owner`. */
export const lastOwnerMessage = 'At least one owner device has to stay. Make someone else an owner first.';

/** The confirm step before an action that takes this device's owner rights away. */
export const loseSettingsMessage = 'This device will lose NAS settings. Only another owner can give them back.';

/** An admin action that can take owner rights away: removing a person's owner status, or moving a device. */
export type OwnerRightsAction = { readonly kind: 'remove-owner'; readonly personId: string } | { readonly kind: 'move'; readonly deviceId: string; readonly toPersonId: string };

/** Whether `action` would leave this device without owner rights, and so without NAS settings. */
export function losesNasSettings(people: readonly NasPerson[], thisDeviceId: string | null, action: OwnerRightsAction): boolean {
  if (thisDeviceId === null) return false;
  const own = people.find((p) => p.devices.some((d) => d.id === thisDeviceId));
  if (!own?.owner) return false;
  if (action.kind === 'remove-owner') return action.personId === own.id;
  if (action.deviceId !== thisDeviceId) return false;
  const to = people.find((p) => p.id === action.toPersonId);
  return to !== undefined && !to.owner;
}

/** The longest person name the NAS takes. */
export const MAX_PERSON_NAME = 100;

/** The person picker's value for "New person…". */
export const NEW_PERSON = 'new';

/** One of a person's devices on the admin screen: `name · last seen <relative>`, marked on this device. */
export interface PersonDeviceRow {
  readonly id: string;
  readonly text: string;
  /** How it last reached the NAS (`Home or Tailscale`, `WebRTC`, `WebRTC (relayed)`); null before it first connects. */
  readonly route: string | null;
  /** This device's own row: revoking it asks first. */
  readonly thisDevice: boolean;
}

/** One person of the People list as shown: name, owner badge, devices, and the saved-data line with whether it can be cleared. */
export interface PersonRow {
  readonly id: string;
  readonly name: string;
  readonly owner: boolean;
  /** `Owner` for an owner, else null. */
  readonly badge: string | null;
  readonly devices: readonly PersonDeviceRow[];
  /** Shown in place of the devices when there are none. */
  readonly noDevices: string | null;
  /** `Saved data: 1.2 MB`, or `Saved data: none`. */
  readonly saved: string;
  /** "Clear saved data" shows only when there is some. */
  readonly canClearSaved: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ago = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

/** How long ago `at` was: `just now`, `N minutes ago`, `N hours ago` or `N days ago`. */
export function lastSeen(at: number, now: number): string {
  const since = now - at;
  if (since < MINUTE) return 'just now';
  if (since < HOUR) return ago(Math.floor(since / MINUTE), 'minute');
  if (since < DAY) return ago(Math.floor(since / HOUR), 'hour');
  return ago(Math.floor(since / DAY), 'day');
}

const UNITS = ['KB', 'MB', 'GB'] as const;

/** A byte count in short form: `none`, `512 bytes`, `1.5 KB`, `1.2 MB`, `16 MB` (units of 1024, as the quotas are). */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return 'none';
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Number(value.toFixed(1))} ${UNITS[unit]}`;
}

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** The People list: owners first, then A–Z, each with their devices and saved data. */
export function personRows(people: readonly NasPerson[], now: number, thisDeviceId: string | null): PersonRow[] {
  return [...people]
    .sort((a, b) => Number(b.owner) - Number(a.owner) || byName(a.name, b.name))
    .map((p) => ({
      id: p.id,
      name: p.name,
      owner: p.owner,
      badge: p.owner ? 'Owner' : null,
      devices: p.devices.map((d) => {
        const thisDevice = d.id === thisDeviceId;
        return { id: d.id, text: `${d.name}${thisDevice ? ' (this device)' : ''} · last seen ${lastSeen(d.lastSeen, now)}`, route: routeLabel(d.lastRoute), thisDevice };
      }),
      noDevices: p.devices.length === 0 ? 'No devices yet' : null,
      saved: `Saved data: ${formatSize(p.savedBytes)}`,
      canClearSaved: p.savedBytes > 0,
    }));
}

/**
 * The confirm step before removing a person: the devices that are unpaired (this device marked) and the saved data
 * that is deleted.
 */
export function removePersonQuestion(person: NasPerson, thisDeviceId: string | null = null): string {
  const parts: string[] = [];
  const names = person.devices.map((d) => (d.id === thisDeviceId ? `${d.name} (this device)` : d.name));
  if (names.length === 1) parts.push(`Their device ${names[0]} is unpaired`);
  else if (names.length > 1) parts.push(`Their ${names.length} devices (${names.join(', ')}) are unpaired`);
  if (person.savedBytes > 0) parts.push(`${formatSize(person.savedBytes)} of saved data is deleted`);
  if (parts.length === 0) return `Remove ${person.name}? They have no devices and no saved data.`;
  return `Remove ${person.name}? ${parts.join(', and ')}.`;
}

/** The confirm step before clearing a person's saved data. */
export function clearSavedQuestion(person: NasPerson): string {
  return `Delete ${person.name}'s saved data (${formatSize(person.savedBytes)})? Discs forget their progress and settings.`;
}

/** A failed admin action as the message to show: the last-owner refusal in words, else the error's own message. */
export function adminFailure(err: unknown): string {
  if (err instanceof NasHttpError && err.status === 409 && err.code === 'last-owner') return lastOwnerMessage;
  return err instanceof Error ? err.message : String(err);
}

/** Who a new code is for, from the picker (`NEW_PERSON` or a person's id) and the new person's name and Owner box. */
export function codeTarget(picked: string, name: string, owner: boolean): { target: NasCodeTarget } | { error: string } {
  if (picked !== NEW_PERSON) return { target: { personId: picked } };
  const trimmed = name.trim();
  if (trimmed === '') return { error: 'Give the new person a name.' };
  if (trimmed.length > MAX_PERSON_NAME) return { error: `A name is at most ${MAX_PERSON_NAME} characters.` };
  return { target: { newPerson: { name: trimmed, owner } } };
}

/** The notice beside a code the rendezvous service didn't register (`rendezvous: false`); null when it did. */
export function rendezvousNotice(rendezvous: boolean): string | null {
  return rendezvous
    ? null
    : "The pairing service didn't take this code, so it only works on your home network or over Tailscale. Try again later for a friend away from home.";
}

/** The line under a code: whom it pairs as, and how long it lasts. */
export function codeSummary(personName: string, invite: boolean): string {
  return invite ? `For ${personName} · an invite, valid 3 days` : `For ${personName} · valid 10 minutes`;
}

/** The people a device can be moved to: everyone but its own person. */
export function moveTargets(people: readonly NasPerson[], fromPersonId: string): { id: string; name: string }[] {
  return people.filter((p) => p.id !== fromPersonId).map(({ id, name }) => ({ id, name }));
}

/** The landing screen's line for a paired device: its person, or its own name on a pairing stored before people. */
export function pairedAs(pairing: Pick<NasPairing, 'deviceName' | 'personName'>): string {
  return pairing.personName ? `Paired as ${pairing.personName}.` : `Paired with the NAS as ${pairing.deviceName}.`;
}
