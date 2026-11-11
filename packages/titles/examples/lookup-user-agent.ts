// SPDX-License-Identifier: LGPL-3.0-or-later
// The User-Agent MusicBrainz and Discogs ask for, with a contact to reach whoever runs the client.
import { lookupUserAgent } from '@seikou/titles';

export default async function example(): Promise<void> {
  const withContact = lookupUserAgent('admin@example.test');
  const without = lookupUserAgent(null);
  console.log(withContact);
  console.log(without);
  if (!withContact.endsWith('; admin@example.test)') || without.includes(';')) throw new Error('the contact is not in the User-Agent');
}
