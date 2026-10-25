// The post a link led somebody to (#/map?post=<id>), remembered until they are
// signed in. No imports on purpose: tests/frontend loads this file on its own.
//
// Why it is kept in storage and not in the address: signing in with Google leaves
// the page and comes back to a bare address (session.adoptRedirect clears the
// hash), and a new person goes on through setup, the guidance and a first post
// before they reach the map. The link has to survive all of that.
//
// Every storage access is wrapped: private windows throw. Without storage the
// post is held in memory for this page load, which still covers the e-mail
// passcode flow (no reload) and only loses the Google round trip.

export const RETURN_KEY = 'islands-return-post';
export const RETURN_TTL_MS = 6 * 3600 * 1000;   // a link older than this is stale

let memory = null;

// Ids are uuids (or short local ids); never anything that could be markup or a path.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const validPostId = (id) => typeof id === 'string' && ID.test(id);

/** "#/map?post=ID" -> "ID"; null for any other address or an odd id. */
export function postIdFromHash(hash) {
  const text = String(hash || '');
  const [path, query = ''] = text.split('?');
  if (path !== '#/map') return null;
  const id = new URLSearchParams(query).get('post');
  return validPostId(id) ? id : null;
}

/** The address that opens a post on the map. */
export const mapLinkFor = (id) => (validPostId(id) ? `#/map?post=${encodeURIComponent(id)}` : '#/map');

/** Remember a post to go back to. Returns whether anything was kept. */
export function savePendingPost(storage, id, now = Date.now()) {
  if (!validPostId(id)) return false;
  memory = { id, at: now };
  try {
    if (storage) storage.setItem(RETURN_KEY, JSON.stringify(memory));
  } catch { /* memory only */ }
  return true;
}

function parse(raw) {
  try {
    const value = JSON.parse(raw);
    return value && validPostId(value.id) && Number.isFinite(value.at) ? { id: value.id, at: value.at } : null;
  } catch {
    return null;
  }
}

/** The remembered post id, or null (nothing saved, a bad value, or too old). */
export function readPendingPost(storage, now = Date.now()) {
  let held = null;
  try {
    held = storage ? parse(storage.getItem(RETURN_KEY)) : null;
  } catch { /* fall back to memory */ }
  if (!held) held = memory;
  if (!held || now - held.at > RETURN_TTL_MS || held.at - now > RETURN_TTL_MS) return null;
  return held.id;
}

export function clearPendingPost(storage) {
  memory = null;
  try {
    if (storage) storage.removeItem(RETURN_KEY);
  } catch { /* nothing to clear */ }
}

/** Read it and forget it: the post is opened once. */
export function takePendingPost(storage, now = Date.now()) {
  const id = readPendingPost(storage, now);
  clearPendingPost(storage);
  return id;
}

/** For tests. */
export function resetPendingMemory() {
  memory = null;
}
