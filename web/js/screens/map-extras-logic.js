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

/** The island closest to a world point (null when none has a centre). */
export function nearestIsland(islands, x, y) {
  const list = islands.filter(hasCenter);
  return list.length ? nearest(list, x, y)[0].island : null;
}

/** Where to look after the tryout: wide enough to hold the tryout and the few
 * islands around it (not the whole map, not a speck of sea). Returns the
 * world point to centre and the scale, kept between `fit` and `fit * 3`. */
export function trialView({ trial, islands, width, height, fit, around = 3 }) {
  const near = nearest(islands.filter(hasCenter), trial.x, trial.y).slice(0, around).map((entry) => entry.island);
  const xs = [trial.x, ...near.map((island) => island.cx)];
  const ys = [trial.y, ...near.map((island) => island.cy)];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const room = 220 / fit;   // never closer than about 220 px at the whole-map zoom
  const spanX = Math.max((maxX - minX) * 1.6, room);
  const spanY = Math.max((maxY - minY) * 1.6, room);
  const scale = Math.min(width * 0.9 / spanX, height * 0.5 / spanY);
  return {
    x: (minX + maxX) / 2, y: (minY + maxY) / 2,
    scale: Math.max(fit, Math.min(fit * 3, scale)),
  };
}

/** An open search box closes when the map (anything outside the header) is touched, but only while
 * nothing is typed: a search in progress stays, the touch just moves the map. */
export function searchClosesOnTouch({ open, value = '', query = '', inside = false }) {
  return Boolean(open) && !inside && !String(value).trim() && !String(query).trim();
}
