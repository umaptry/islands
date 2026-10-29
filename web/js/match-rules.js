// The choices the 「つながりそうな投稿」 cards make, kept free of the page (no DOM, no state import)
// so tests can run them directly.

export const MATCH_MAX = 3;
export const BEAM_STAGGER_MS = 250;   // each line starts this long after the one before
export const BEAM_GROW_MS = 650;      // and takes this long to reach its person
export const MATCH_FETCH_MS = 3000;   // slower than this and the old card comes instead

const finite = (value) => Number.isFinite(value);

/** The rows worth a card: at most three, each with a place on the map and an id. */
export function usableMatches(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && row.id && row.x != null && row.y != null && finite(Number(row.x)) && finite(Number(row.y)))
    .slice(0, MATCH_MAX);
}

/** Where to look so that the new post and everyone it may connect to are in view above the sheet.
 * Returns the world point to centre, the scale (kept between `fit` and `fit * 3`) and the pixel spot of the
 * screen that point goes to: `anchorY` always, `anchorX` on a wide screen with the sheet at the left (null
 * otherwise). `covered`: how tall the sheet is on a phone; `head`: the bar over the top of the map. */
export function matchView({ from, targets, width, height, fit, desktop = false, panel = 432, covered = 0, head = 64 }) {
  const xs = [from.x, ...targets.map((t) => t.x)];
  const ys = [from.y, ...targets.map((t) => t.y)];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const room = 220 / fit;   // never closer than about 220 px at the whole-map zoom
  const spanX = Math.max((maxX - minX) * 1.5, room);
  const spanY = Math.max((maxY - minY) * 1.5, room);
  // The sheet covers the lower part of a phone and the left side of a wide screen.
  const freeW = desktop ? Math.max(200, width - panel) : width;
  const freeH = desktop ? Math.max(200, height - 2 * head) : Math.max(120, height - covered - head - 16);
  const scale = Math.min(freeW * 0.85 / spanX, freeH * 0.85 / spanY);
  return {
    x: (minX + maxX) / 2, y: (minY + maxY) / 2,
    scale: Math.max(fit, Math.min(fit * 3, scale)),
    anchorX: desktop ? panel + freeW / 2 : null,
    anchorY: desktop ? height / 2 : head + freeH / 2,
  };
}

/** Which card a sideways scroll has come to (0-based). `stride`: the distance from one card to the next. */
export function slideIndex(scrollLeft, stride, count) {
  if (!(count > 0)) return 0;
  if (!(stride > 0)) return 0;
  const index = Math.round(scrollLeft / stride);
  return Math.max(0, Math.min(count - 1, Number.isFinite(index) ? index : 0));
}

/** How far line `index` has grown (0 to 1) `elapsed` ms after the first one began. */
export function beamProgress(elapsed, index, { reduced = false } = {}) {
  if (reduced) return 1;
  const t = (elapsed - index * BEAM_STAGGER_MS) / BEAM_GROW_MS;
  return Math.max(0, Math.min(1, t));
}

/** How a line looks: the one under the card in view is thick and deep; the others thin and pale.
 * `focus` -1 (the card is closed): all of them thin and pale. */
export function beamStyle(index, focus) {
  // closed: the same look as the white dotted lines (KIN in lines.js), which the beams turn into
  if (focus < 0) return { width: 1.2, alpha: 0.6, closed: true };
  return index === focus ? { width: 4, alpha: 1 } : { width: 2, alpha: 0.6 };
}

/** The post a card shows: the row the map already holds (it has the counts), else the row the server gave,
 * with what a card needs filled in. */
export function cardPost(row, held = null) {
  const base = held || row;
  return {
    ...row, ...base,
    tags: Array.isArray(base.tags) ? base.tags : (Array.isArray(row.tags) ? row.tags : []),
    like_count: base.like_count || 0, help_count: base.help_count || 0,
    join_count: base.join_count || 0, comment_count: base.comment_count || 0,
    motivation: Number.isFinite(Number(base.motivation)) ? Number(base.motivation) : 50,
    display_name: base.display_name || row.display_name || '',
  };
}
