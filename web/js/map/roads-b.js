// Map B: roads between regions, laid on the ground (over the ground, under the trees and houses).
//
// A road joins two places that met ("お互いに会えてよかった"). That data does not exist yet, so nothing
// is drawn in production until setRoadsB() is handed pairs; `?roads=demo` hands in a few example pairs
// (demoPairs) so the look can be judged.
//
// Pure geometry and a little state; no imports, so tests/frontend/roads-b.test.mjs can run it.

/** The prototype's lengths times 2.5 (its world is the production world divided by 2.5). */
export const ROAD_BEND = 0.12;
export const ROAD_STEP = 3.75;        // world units between the curve's points
export const ROAD_WIDTH = 3.125;      // 1.25 x 2.5, the road itself
export const ROAD_EDGE_WIDTH = 4.375; // 1.75 x 2.5, its darker edge
export const ROAD_CLEAR = 5.5;        // 2.2 x 2.5: no tree stands this close to a road
/** The same by tier (terrain-b.js: a tier-1 track hardly opens the forest, a tier-2 footpath a little). */
export const ROAD_CLEAR_BY_TIER = [0, 1.5, 2.8, 3.6];
const ROAD_COLOR = '#dcc48c';
const ROAD_EDGE = 'rgba(120,86,48,0.35)';

/** The points of the quadratic curve from a to b ({x, y} each), bowed a little to one side, about
 * ROAD_STEP apart. */
export function roadCurve(a, b, bend = ROAD_BEND, step = ROAD_STEP) {
  const mx = (a.x + b.x) / 2 + (b.y - a.y) * bend;
  const my = (a.y + b.y) / 2 - (b.x - a.x) * bend;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const parts = Math.max(2, Math.ceil(length / step));
  const points = [];
  for (let s = 0; s <= parts; s += 1) {
    const u = s / parts;
    points.push([
      (1 - u) ** 2 * a.x + 2 * u * (1 - u) * mx + u * u * b.x,
      (1 - u) ** 2 * a.y + 2 * u * (1 - u) * my + u * u * b.y,
    ]);
  }
  return points;
}

/** A lookup for "is (x, y) within `distance` of a road's points?" (a square, as the prototype), over
 * the curves from roadCurve. Points are kept in cells of `distance`, so a question looks at nine. */
export function roadIndex(curves, distance = ROAD_CLEAR) {
  const cells = new Map();
  curves.forEach((points) => points.forEach(([x, y]) => {
    const key = `${Math.floor(x / distance)},${Math.floor(y / distance)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push([x, y]);
  }));
  return (x, y) => {
    if (!cells.size) return false;
    const gx = Math.floor(x / distance);
    const gy = Math.floor(y / distance);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const list = cells.get(`${gx + dx},${gy + dy}`);
        if (list && list.some(([px, py]) => Math.abs(px - x) < distance && Math.abs(py - y) < distance)) return true;
      }
    }
    return false;
  };
}

/** Example pairs for ?roads=demo: from the posts, up to `count` pairs standing in different regions
 * and 125 to 400 world units apart. `regionOf(post)` is the post's region. Deterministic. */
export function demoPairs(posts, regionOf, count = 6) {
  const out = [];
  const list = posts.filter((post) => Number.isFinite(post.x) && Number.isFinite(post.y));
  for (let i = 0; i < list.length && out.length < count; i += 7) {
    const a = list[i];
    const b = list.find((post, j) => {
      if (j <= i || regionOf(post) === regionOf(a)) return false;
      const d = Math.hypot(post.x - a.x, post.y - a.y);
      return d > 125 && d < 400;
    });
    if (b) out.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } });
  }
  return out;
}

let kept = { pairs: null, curves: [], near: () => false };

/** The roads to draw: [{ a: { x, y }, b: { x, y } }, ...] in world units; none, or null, for no roads. */
export function setRoadsB(pairs) {
  if (!pairs || !pairs.length) {
    kept = { pairs: null, curves: [], near: () => false };
    return;
  }
  const curves = pairs.map(({ a, b }) => roadCurve(a, b));
  const near = [1, 2, 3].map((tier) => {
    const mine = curves.filter((_, i) => Math.min(3, Math.max(1, pairs[i].tier | 0 || 1)) === tier);
    return roadIndex(mine, ROAD_CLEAR_BY_TIER[tier]);
  });
  kept = { pairs, curves, near: (x, y) => near.some((at) => at(x, y)) };
}

export const roadCurves = () => kept.curves;
export const hasRoadsB = () => kept.curves.length > 0;

/** Is (x, y) too near a road for a tree? */
export const nearRoadB = (x, y) => kept.near(x, y);

/** The roads, edge first and then the road, widths in world units (never under a pixel). */
export function drawRoads(ctx, toScreen, scale) {
  if (!kept.curves.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  [[ROAD_EDGE, ROAD_EDGE_WIDTH], [ROAD_COLOR, ROAD_WIDTH]].forEach(([color, width]) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, width * scale);
    kept.curves.forEach((points) => {
      ctx.beginPath();
      points.forEach(([x, y], i) => {
        const p = toScreen(x, y);
        if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      });
      ctx.stroke();
    });
  });
  ctx.restore();
}
