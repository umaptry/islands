// Somebody who applied to a 会 and is a member of no community yet (a guest) may open only the pages of that 会
// (D 5-2). This remembers their registrations (GET /api/events/mine?all=1: every state, so a person who cancelled, was
// declined or whose 会 was cancelled is still held) so the router's guard can send them back to the guest page, and
// keeps quiet when the server has nothing to say (an older server, or a failed read).

import { eventsApi } from './events-api.js';
import { session } from './session.js';
import { state } from './state.js';
import { eventHashFor, guestEntry } from './event-rules.js';

let live = [];

/** Read my registrations (all states). Quiet on failure: nobody is held for not knowing. */
export async function refreshEventGuest() {
  if (!session.signedIn()) { live = []; return live; }
  try {
    live = await eventsApi.mine({ all: true });
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

/** The guest page to hold this person on, or null (a member of any community, or no registration at all). */
export function guestHome() {
  if (!session.signedIn() || !state.account || !state.account.display_name) return null;
  if (state.communities.length > 0 || !live.length) return null;
  const entry = guestEntry(live);
  return entry ? eventHashFor(entry.code, 'me') : null;
}
