// The choices map-extras.js makes, kept free of the page (no DOM, no state
// import) so tests can run them directly.

export const MINI_SHOW_ZOOM = 1.7;
export const miniVisible = (z) => z >= MINI_SHOW_ZOOM;

const finite = (value) => Number.isFinite(value);
const hasCenter = (island) => finite(island.cx) && finite(island.cy);
const nearest = (list, cx, cy) => list.map((island) => ({ island, d: Math.hypot(island.cx - cx, island.cy - cy) }))
  .sort((a, b) => a.d - b.d);

/** Every island that holds one of my posts (a person can post on several). */
export function myIslands(islands, myPostIds) {
  const ids = new Set(myPostIds);
  return ids.size ? islands.filter((island) => (island.post_ids || []).some((id) => ids.has(id))) : [];
}

/** The islands to suggest as "near". With posts of my own: the islands closest
 * to mine. Without: the ones closest to the middle of the screen, preferring
 * islands with 2+ people; when zoomed in, the island being looked at is left
 * out, since "near" should mean somewhere else. */
export function pickNear({ islands, myPostIds = [], view = null, zoomed = false, count = 3 }) {
  const all = islands.filter(hasCenter);
  const homes = myIslands(all, myPostIds);
  if (homes.length) {
    const home = homes[0];
    return nearest(all.filter((island) => !homes.includes(island)), home.cx, home.cy)
      .slice(0, count).map((entry) => entry.island);
  }
  const crowded = all.filter((island) => (island.people || 0) >= 2);
  let pool = crowded.length >= count ? crowded : all;
  if (!view) return [...pool].sort((a, b) => (b.people || 0) - (a.people || 0)).slice(0, count);
  const cx = (view.minX + view.maxX) / 2;
  const cy = (view.minY + view.maxY) / 2;
  if (zoomed && pool.length > count) pool = nearest(pool, cx, cy).slice(1).map((entry) => entry.island);
  return nearest(pool, cx, cy).slice(0, count).map((entry) => entry.island);
}

/** The newest `n` loaded posts of an island (unloaded ones are skipped; a bad
 * date sorts as oldest instead of scrambling the order). */
export function recentPosts(ids, byId, n = 2) {
  const time = (post) => Date.parse(post.created_at) || 0;
  return ids.map((id) => byId.get(id)).filter(Boolean).sort((a, b) => time(b) - time(a)).slice(0, n);
}

/** A press on the mini map (client px, canvas rect) -> world position. */
export function miniToWorld(clientX, clientY, rect, geometry, size) {
  const { k, ox, oy, world } = geometry;
  const x = ((clientX - rect.left) * size / rect.width - ox) / k;
  const y = ((clientY - rect.top) * size / rect.height - oy) / k;
  return {
    x: Math.max(world.minX, Math.min(world.maxX, x)),
    y: Math.max(world.minY, Math.min(world.maxY, y)),
  };
}
