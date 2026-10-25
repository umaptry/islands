// Which posts to introduce right after a first post: the nearest ones on the map, kept free of the
// page so it can be tested in node. No imports on purpose: tests/frontend loads this file on its own.
//
// Distance is the map's own (the same x / y the post got): people who stand close say similar things.
// One post per person (the nearest of theirs), never my own, never a deleted one, at most `limit`.

export const NEARBY_MAX = 3;

/** posts: rows of the community map. At: where the new post stands ({x, y}).
 * meId: my account id. gone: ids deleted in this session (a Set or an array). */
export function nearestPosts(posts, at, { meId = null, limit = NEARBY_MAX, gone = [] } = {}) {
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return [];
  const removed = gone instanceof Set ? gone : new Set(gone);
  const best = new Map();   // author -> { post, d }
  (Array.isArray(posts) ? posts : []).forEach((post) => {
    if (!post || !post.id || !post.author_id || post.deleted_at || removed.has(post.id)) return;
    if (meId && post.author_id === meId) return;
    if (!Number.isFinite(post.x) || !Number.isFinite(post.y)) return;
    const d = Math.hypot(post.x - at.x, post.y - at.y);
    const held = best.get(post.author_id);
    if (!held || d < held.d || (d === held.d && String(post.id) < String(held.post.id))) best.set(post.author_id, { post, d });
  });
  return [...best.values()]
    .sort((a, b) => a.d - b.d || String(a.post.id).localeCompare(String(b.post.id)))
    .slice(0, Math.max(0, limit))
    .map((item) => item.post);
}
