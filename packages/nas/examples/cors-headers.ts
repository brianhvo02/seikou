// SPDX-License-Identifier: LGPL-3.0-or-later
// The CORS headers for a request: the player's own origins are allowed, others get none.
import { corsHeaders } from '@seikou/nas';

export default async function example(): Promise<void> {
  const player = corsHeaders('https://bluray.pages.dev');
  const stranger = corsHeaders('https://example.invalid');
  console.log(player['Access-Control-Allow-Origin'], stranger['Access-Control-Allow-Origin']);

  if (player['Access-Control-Allow-Origin'] !== 'https://bluray.pages.dev') throw new Error('the player was refused');
  if (stranger['Access-Control-Allow-Origin'] !== undefined || stranger.Vary !== 'Origin') throw new Error('a stranger was allowed');
}
