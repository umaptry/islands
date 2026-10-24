// Which islands glow as NEW (replaces the 「今週の反応」 switch), kept free of the page so
// it can be tested in node. No imports on purpose: tests/frontend loads this file on its own.
//
// The rule: a post written in the last seven days that I have not opened yet makes its island
// glow. Opening the post's card puts it out. My own posts never glow, and signed out nothing does
// (there is no "I" to have opened anything).
//
// What I have opened is kept per account in the browser. Every storage access is guarded
// (private windows throw); without storage it is kept in memory for this page load.

export const FRESH_MS = 7 * 24 * 3600 * 1000;
export const FRESH_SEEN_MAX = 1000;          // opened posts remembered per account
export const FRESH_SEEN_PREFIX = 'islands-seen-posts:';
const CLOCK_SKEW_MS = 10 * 60 * 1000;        // a post a little "in the future" is still new

const seenMemory = new Map();                // account id -> Map(post id -> the time it was opened)

const finite = (value) => Number.isFinite(value);

/** Drop what is older than a week (such a post is no longer new, opened or not), and keep the newest
 * `FRESH_SEEN_MAX`. Takes and returns a Map. */
export function pruneSeen(seen, now = Date.now()) {
  const kept = [...seen].filter(([, at]) => finite(at) && now - at < FRESH_MS);
  kept.sort((a, b) => b[1] - a[1]);
  return new Map(kept.slice(0, FRESH_SEEN_MAX));
}

/** The opened posts of this account as a Map(id -> time), pruned. */
export function loadSeen(storage, accountId, now = Date.now()) {
  if (!accountId) return new Map();
  const held = new Map(seenMemory.get(accountId) || []);
  try {
    const raw = storage ? storage.getItem(FRESH_SEEN_PREFIX + accountId) : null;
    const value = raw ? JSON.parse(raw) : null;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.entries(value).forEach(([id, at]) => {
        if (finite(at) && at > (held.get(id) || 0)) held.set(id, at);
      });
    }
  } catch { /* memory only */ }
  const pruned = pruneSeen(held, now);
  seenMemory.set(accountId, pruned);
  return pruned;
}

/** Remember that this post was opened. Returns the new Map. */
export function markSeen(storage, accountId, postId, now = Date.now()) {
  if (!accountId || !postId) return loadSeen(storage, accountId, now);
  const seen = loadSeen(storage, accountId, now);
  seen.set(String(postId), now);
  const kept = pruneSeen(seen, now);
  seenMemory.set(accountId, kept);
  try {
    if (storage) storage.setItem(FRESH_SEEN_PREFIX + accountId, JSON.stringify(Object.fromEntries(kept)));
  } catch { /* memory only */ }
  return kept;
}

/**
 * The ids of the posts that glow: written in the last seven days, not mine, not opened yet.
 * `seen` is a Map or Set of ids. Nothing glows for a signed-out visitor (`meId` empty).
 */
export function freshPostIds(posts, { meId = null, seen = new Map(), now = Date.now() } = {}) {
  const ids = new Set();
  if (!meId) return ids;
  (Array.isArray(posts) ? posts : []).forEach((post) => {
    if (!post || !post.id || post.author_id === meId || seen.has(post.id)) return;
    const at = Date.parse(post.created_at);
    if (!finite(at) || now - at >= FRESH_MS || at - now > CLOCK_SKEW_MS) return;
    ids.add(post.id);
  });
  return ids;
}

/** The islands (by key) that hold at least one glowing post. `keyOf` is the map's island key. */
export function freshIslandKeys(islands, freshIds, keyOf) {
  const keys = new Set();
  if (!freshIds || !freshIds.size) return keys;
  (Array.isArray(islands) ? islands : []).forEach((island) => {
    if ((island.post_ids || []).some((id) => freshIds.has(id))) keys.add(keyOf(island));
  });
  return keys;
}

/** For tests: forget what this page load remembered. */
export function resetSeenMemory() {
  seenMemory.clear();
}
