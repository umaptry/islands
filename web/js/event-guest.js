// Somebody who applied to a 会 and is a member of no community yet (a guest) may open only the pages of that 会
// (D 5-2). This remembers their live registrations (GET /api/events/mine) so the router's guard can send them back to the
// guest page, and keeps quiet when the server has nothing to say (an older server, or a failed read).

import { publicApi } from './event-public-api.js';
import { session } from './session.js';
import { state } from './state.js';
import { eventHashFor } from './event-rules.js';

let live = [];

/** Read my live registrations. Quiet on failure: nobody is held for not knowing. */
export async function refreshEventGuest() {
  if (!session.signedIn()) { live = []; return live; }
  try {
    live = await publicApi.mine();
  } catch {
    live = [];
  }
  return live;
}

export function forgetEventGuest() { live = []; }

/** Remember one registration right after applying (the list is read again at the next start). */
export function noteEventGuest(entry) {
  live = [...live.filter((item) => item.code !== entry.code), entry];
}

/** The guest page to hold this person on, or null (a member of any community, or no live registration). */
export function guestHome() {
  if (!session.signedIn() || !state.account || !state.account.display_name) return null;
  if (state.communities.length > 0 || !live.length) return null;
  const first = [...live].sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))[0];
  return eventHashFor(first.code, 'me');
}
