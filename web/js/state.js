// One place for what every screen needs to agree about.
//
// Deliberately not a framework. The whole app is a canvas, a bottom sheet and
// six screens; a store with subscriptions is enough, and it keeps the rule that
// coordinates coming from the server are never recomputed here.

const listeners = new Set();

export const state = {
  account: null,          // my profile row, or null when signed out
  posts: [],              // what is in the viewport right now
  postsById: new Map(),
  cells: [],              // the coarse layer, only when the viewport saturated
  saturated: false,
  islands: [],            // named landmasses from /api/islands
  reactions: new Set(),   // "postId:kind" for everything I have reacted to
  notifications: [],
  unread: 0,
  selected: null,         // the post the sheet is showing
  view: 'map',            // 'map' | 'orbit'
  filters: { query: '', tags: [] },
  camera: { scale: 1, x: 0, y: 0 },
  myPosts: [],
  neighbors: [],          // orbit ranking for my active post
  activePostId: null,     // which of my posts the orbit is centred on
};

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notify(reason) {
  listeners.forEach((listener) => listener(reason));
}

export function setPosts(posts, { saturated = false } = {}) {
  state.posts = posts;
  state.saturated = saturated;
  state.postsById = new Map(posts.map((post) => [post.id, post]));
  notify('posts');
}

const COUNT_KEYS = ['like_count', 'help_count', 'join_count', 'comment_count'];

/** Merge one post back in after it changed, without refetching the viewport.
 *
 * `energy` is a generated column: Postgres recomputes it from the counts on
 * every write, so a row that arrives from the server always agrees with itself.
 * An OPTIMISTIC update does not - it bumps a count locally and leaves the energy
 * the server last sent. That stale number is what the terrain is drawn from, so
 * tapping いいね would light the button up and leave the island exactly the same
 * size until the next poll fifteen seconds later. Dropping the energy whenever a
 * count moves without one makes energyOf() derive it from the same formula the
 * database uses, and the ground grows under your finger.
 */
export function upsertPost(post) {
  if (!post) return;
  const index = state.posts.findIndex((entry) => entry.id === post.id);
  const merged = { ...(index >= 0 ? state.posts[index] : {}), ...post };
  const touchedCount = COUNT_KEYS.some((key) => key in post);
  if (touchedCount && !('energy' in post)) merged.energy = null;
  if (index >= 0) state.posts[index] = merged;
  else state.posts = state.posts.concat(merged);
  state.postsById.set(post.id, merged);
  if (state.selected && state.selected.id === post.id) {
    state.selected = { ...state.selected, ...merged };
  }
  const mine = state.myPosts.findIndex((entry) => entry.id === post.id);
  if (mine >= 0) state.myPosts[mine] = { ...state.myPosts[mine], ...merged };
  notify('posts');
}

export function removePost(postId) {
  state.posts = state.posts.filter((post) => post.id !== postId);
  state.postsById.delete(postId);
  state.myPosts = state.myPosts.filter((post) => post.id !== postId);
  if (state.selected && state.selected.id === postId) state.selected = null;
  notify('posts');
}

export const reactionKey = (postId, kind) => `${postId}:${kind}`;
export const hasReacted = (postId, kind) => state.reactions.has(reactionKey(postId, kind));

/** islands' search + OR tag filter, applied to whatever the viewport holds. */
export function matchesFilters(post) {
  const { query, tags } = state.filters;
  if (query) {
    const needle = query.toLowerCase();
    const haystack = `${post.body || ''} ${post.display_name || ''}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if (tags.length) {
    const own = post.tags || [];
    if (!tags.some((tag) => own.includes(tag))) return false;
  }
  return true;
}

export const filtering = () =>
  Boolean(state.filters.query || state.filters.tags.length);
