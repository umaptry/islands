// Lines between people: roads and flight paths.
//
// One line per pair of people, ending on the post the two touched most - the
// server decides which post and where it stands, so a line never waits for the
// viewport to load its ends. Two kinds, as in the design mock:
//
//   same island    a road, drawn straight between the two. A road that is new
//                  since the map opened grows out from one end.
//   across water   a thin white arch, no outline. One plane flies back and forth
//                  per route (the pair of islands), however many arches run
//                  between them.
//
// Dotted lines to people you have not met yet are drawn here too (drawKin;
// which people is kin.js).
//
// From far away (the far zoom level) no roads, arches or planes are drawn. The
// roads are too short to read from there, and the arches used to be merged into
// one per pair of islands, drawn between the islands' centres - which put them
// somewhere else than the post-to-post arches of the nearer view, so a route
// seemed to move as you zoomed (2026-10-12). Nothing here is about who you are:
// the same lines are drawn for everyone. (The dotted lines are yours alone.)
//
// Like decor.js, where a plane is, is a pure function of the clock, so a hidden
// tab or a dropped frame cannot leave one stranded.

import { REDUCED_MOTION, hashId } from './decor.js';
import { drawSpriteTurned } from './sprites.js';

const ROUTE = '#ffffff';
const PATH = '#f1deb3';
const PATH_UNDER = 'rgba(74, 52, 38, .5)';

// Line width by tier (1 weak .. 3 strong), CSS px. A route over the water is a
// plain white line and thinner than a road on land.
const ROAD_WIDTHS = [0, 1.6, 2.6, 3.8];
const ROUTE_WIDTHS = [0, 1, 1.5, 2.1];
const FAINT_WIDTH = { road: 1, route: 0.8 };
const FAINT_ALPHA = 0.26;
const FRESH_DAYS = 30;

// The arch's rise, as a share of the distance it spans (the mock's 0.3).
const ARCH_BEND = 0.3;
// A new road takes this long to grow, in ms.
const GROW_MS = 660;
// Planes: the longer side of the sprite in CSS px, and the cap per view.
const PLANE_SIZE = { near: 24, deep: 30 };
const PLANE_CAP = { phone: 12, wide: 24 };
// One crossing: the world's width in about five minutes, never quicker than 45 s
// or slower than two minutes. In world units, so a crossing does not speed up as
// you zoom. (A fifth of the first speed: quicker read as traffic, not as a map.)
const CROSSING = { span: 300, min: 45, max: 120 };

// ---------------------------------------------------------------- geometry

/** A quadratic arc from p to q. `seed` picks which side it bows to; `bend` is
 * how far, as a share of the distance (0 is a straight line). */
export function arc(p, q, seed, bend = 0.16) {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const side = seed % 2 ? 1 : -1;
  return {
    p, q,
    c: { x: (p.x + q.x) / 2 - dy * bend * side, y: (p.y + q.y) / 2 + dx * bend * side },
    length: Math.hypot(dx, dy),
  };
}

export function pointOn({ p, c, q }, t) {
  const u = 1 - t;
  return {
    x: u * u * p.x + 2 * u * t * c.x + t * t * q.x,
    y: u * u * p.y + 2 * u * t * c.y + t * t * q.y,
  };
}

/** The direction of travel along the arc at t, in radians (0 = to the right). */
export function headingAt({ p, c, q }, t) {
  const dx = 2 * (1 - t) * (c.x - p.x) + 2 * t * (q.x - c.x);
  const dy = 2 * (1 - t) * (c.y - p.y) + 2 * t * (q.y - c.y);
  return Math.atan2(dy, dx);
}

/** The first `share` of an arc, as an arc of its own. */
export function partOf(shape, share) {
  const g = Math.max(0, Math.min(1, share));
  return {
    p: shape.p,
    c: { x: shape.p.x + (shape.c.x - shape.p.x) * g, y: shape.p.y + (shape.c.y - shape.p.y) * g },
    q: pointOn(shape, g),
    length: shape.length * g,
  };
}

function onScreen({ p, c, q }, width, height, margin = 30) {
  const xs = [p.x, c.x, q.x];
  const ys = [p.y, c.y, q.y];
  return Math.max(...xs) > -margin && Math.min(...xs) < width + margin
    && Math.max(...ys) > -margin && Math.min(...ys) < height + margin;
}

function stroke(ctx, { p, c, q }, { color, under, width, alpha = 1, dash = null }) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.lineCap = 'round';
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.quadraticCurveTo(c.x, c.y, q.x, q.y);
  if (under) {
    ctx.strokeStyle = under;
    ctx.lineWidth = width + 2;
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------- data

/** How strongly a line still shows: fresh is deep, a month old is pale. */
export function freshness(row, now = Date.now()) {
  if (row.faint) return FAINT_ALPHA;
  const last = Date.parse(row.last_at);
  const days = Number.isFinite(last) ? Math.max(0, (now - last) / 86400000) : FRESH_DAYS;
  return 0.95 - Math.min(1, days / FRESH_DAYS) * 0.5;
}

const islandKey = (island) => island.island_id || island.label || `${island.cx},${island.cy}`;

let membershipCache = { islands: null, byPost: new Map() };

/** The island a line end stands on: the one listing its post, else the
 * nearest centre (a post newer than the island list). */
export function islandFinder(islands) {
  if (membershipCache.islands !== islands) {
    const byPost = new Map();
    islands.forEach((island) => (island.post_ids || []).forEach((id) => byPost.set(id, island)));
    membershipCache = { islands, byPost };
  }
  const { byPost } = membershipCache;
  return (postId, at) => {
    const known = byPost.get(postId);
    if (known || !at || !islands.length) return known || null;
    let best = null;
    let bestDistance = Infinity;
    islands.forEach((island) => {
      const distance = Math.hypot(island.cx - at[0], island.cy - at[1]);
      if (distance < bestDistance) { best = island; bestDistance = distance; }
    });
    return best;
  };
}

/** Lines between islands, grouped per island pair: a route, which has one plane. */
export function buildRoutes(rows, islandOf) {
  const routes = new Map();
  rows.forEach((row) => {
    const a = islandOf(row.a_post, row.a_at);
    const b = islandOf(row.b_post, row.b_at);
    if (!a || !b || a === b) return;
    const [first, second] = islandKey(a) < islandKey(b) ? [a, b] : [b, a];
    const key = `${islandKey(first)}|${islandKey(second)}`;
    let route = routes.get(key);
    if (!route) {
      route = { key, a: first, b: second, strength: 0, last_at: '', faint: true, people: new Set(), rows: [] };
      routes.set(key, route);
    }
    route.strength += Number(row.strength) || 0;
    if (String(row.last_at) > route.last_at) route.last_at = String(row.last_at);
    route.faint = route.faint && Boolean(row.faint);
    route.people.add(row.a);
    route.people.add(row.b);
    route.rows.push(row);
  });
  return [...routes.values()];
}

// ---------------------------------------------------------------- new lines

export const linkKey = (row) => `${row.a}|${row.b}`;

let known = null;          // pairs already on the map when it loaded, and since
const born = new Map();    // pair -> when its road started to grow

/** Tell the lines which pairs exist now. The first list (`loaded`) is taken as
 * "what the map already had" and nothing animates; every pair that shows up in a
 * later list is new, and its road grows. Returns how many are new. */
export function noteLinks(rows, now = performance.now()) {
  const keys = rows.map(linkKey);
  if (!known) {
    known = new Set(keys);
    return 0;
  }
  let fresh = 0;
  keys.forEach((key) => {
    if (known.has(key)) return;
    known.add(key);
    born.set(key, now);
    fresh += 1;
  });
  return fresh;
}

/** Forget what the lines knew (a different person signed in, tests). */
export function resetLinks() {
  known = null;
  born.clear();
}

/** How much of a line is drawn: 1 for an old one, 0 to 1 while it grows. */
export function growthOf(key, now = performance.now()) {
  const start = born.get(key);
  if (start === undefined) return 1;
  if (REDUCED_MOTION) return 1;
  const t = (now - start) / GROW_MS;
  if (t >= 1) {
    born.delete(key);
    return 1;
  }
  return t * (2 - t);   // quickly at first, then easing in
}

/** Where a plane is on its arch at `time`, and which way it is going: out and
 * back, forever, slowing into each end. `offset` keeps a fleet out of step. */
export function planeAt(time, { duration, offset = 0 }) {
  const phase = (((time + offset) / duration) % 2 + 2) % 2;
  const forward = phase < 1;
  const leg = forward ? phase : 2 - phase;
  return { t: leg * leg * (3 - 2 * leg), forward, leg };
}

export function crossingSeconds(world, span) {
  return Math.max(CROSSING.min, Math.min(CROSSING.max, (world / span) * CROSSING.span));
}

// ---------------------------------------------------------------- drawing

// A piece of land (landmass.js) has no id; its centre is one for as long as it
// keeps the same posts.
const landKey = (mass) => `${mass.cx.toFixed(1)},${mass.cy.toFixed(1)}`;

/** Every pair, with its shape on screen and the route it belongs to. */
function layout(view) {
  const { rows, islands, toScreen, landOf } = view;
  const islandOf = islandFinder(islands);
  const routes = buildRoutes(rows, islandOf);
  const routeOf = new Map();
  routes.forEach((route) => route.rows.forEach((row) => routeOf.set(row, route)));

  const lines = [];
  rows.forEach((row) => {
    if (!row.a_at || !row.b_at) return;
    // Drawn from the end with the smaller id, so A to B and B to A bow the same way.
    const flip = String(row.a) > String(row.b);
    const from = flip ? row.b_at : row.a_at;
    const to = flip ? row.a_at : row.b_at;
    const a = islandOf(row.a_post, row.a_at);
    const b = islandOf(row.b_post, row.b_at);
    // One named island can be several pieces of land; a road stays on one.
    const landA = landOf ? landOf(row.a_post) : null;
    const landB = landOf ? landOf(row.b_post) : null;
    const sameIsland = Boolean(a) && a === b && (!landA || !landB || landA === landB);
    const p = toScreen(from[0], from[1]);
    const q = toScreen(to[0], to[1]);
    const route = routeOf.get(row) || null;
    // Which route the line is on, for its plane: the pair of islands, or, for
    // an arch between two pieces of land of one island, the pair of pieces.
    let group = route ? route.key : linkKey(row);
    if (!route && !sameIsland && landA && landB) group = [landKey(landA), landKey(landB)].sort().join('|');
    lines.push({
      row, sameIsland, route, group,
      world: Math.hypot(row.a_at[0] - row.b_at[0], row.a_at[1] - row.b_at[1]),
      arc: sameIsland
        ? arc(p, q, 0, 0)
        : arc(p, q, hashId(`${row.a}|${row.b}`), ARCH_BEND),
    });
  });
  return { lines };
}

/** Roads and arches (under the towns). Returns the layout the planes reuse,
 * or null from far away, where neither is drawn. */
export function drawLinks(ctx, view) {
  const { width, height, far, level } = view;
  if (far) return null;
  const plan = layout(view);
  const now = Date.now();
  const tick = performance.now();
  const grow = level === 'deep' ? 1.3 : 1;
  plan.lines.forEach(({ row, sameIsland, arc: shape }) => {
    if (!onScreen(shape, width, height)) return;
    const share = growthOf(linkKey(row), tick);
    const tier = row.tier || 1;
    stroke(ctx, share < 1 ? partOf(shape, share) : shape, sameIsland ? {
      color: PATH, under: PATH_UNDER,
      width: row.faint ? FAINT_WIDTH.road : ROAD_WIDTHS[tier] * grow,
      alpha: freshness(row, now),
    } : {
      color: ROUTE,
      width: row.faint ? FAINT_WIDTH.route : ROUTE_WIDTHS[tier] * grow,
      alpha: freshness(row, now),
    });
  });
  return plan;
}

// Dotted lines: plain white like a route, and fainter (a hint of where to
// look, as in the mock). Drawn only zoomed in, like the routes.
const KIN = { width: 1.2, dash: [3, 5], alpha: { near: 0.6, deep: 0.65 } };

/** Dotted lines from your posts to people like you (under the towns, with the
 * roads). Straight on the same island; across water, an arch like a route's. */
export function drawKin(ctx, view, kin) {
  const { toScreen, width, height, level } = view;
  kin.forEach((line) => {
    const p = toScreen(line.from.x, line.from.y);
    const q = toScreen(line.to.x, line.to.y);
    const shape = line.across ? arc(p, q, hashId(line.key), ARCH_BEND) : arc(p, q, 0, 0);
    if (!onScreen(shape, width, height)) return;
    stroke(ctx, shape, {
      color: ROUTE, width: KIN.width,
      alpha: KIN.alpha[level] || KIN.alpha.near, dash: KIN.dash,
    });
  });
}

/** Planes on the arches that are alive now (over the towns). */
export function drawPlanes(ctx, view, plan, time) {
  const { width, height, far, level, span, phone } = view;
  if (far || !plan) return;
  const cap = phone ? PLANE_CAP.phone : PLANE_CAP.wide;
  const size = PLANE_SIZE[level] || PLANE_SIZE.near;

  // The arches between two islands are drawn one per pair of people, but the
  // plane is one per route: it flies the strongest arch of its route that is on
  // screen. Keyed by the route, so it keeps its place in the schedule while you
  // pan from one of its arches to another.
  const best = new Map();
  plan.lines.forEach(({ row, sameIsland, group: key, arc: shape, world }) => {
    if (sameIsland || row.faint || !onScreen(shape, width, height)) return;
    if (growthOf(linkKey(row)) < 1) return;
    const strength = Number(row.strength) || 0;
    const held = best.get(key);
    if (!held || strength > held.strength) best.set(key, { shape, key, world, strength });
  });
  const flights = [...best.values()].sort((a, b) => b.strength - a.strength);
  flights.slice(0, cap).forEach(({ shape, key, world }) => {
    const seed = hashId(key);
    const duration = crossingSeconds(world, span);
    const { t, forward, leg } = REDUCED_MOTION
      ? { t: 0.5, forward: true, leg: 0.5 }
      : planeAt(time, { duration, offset: (seed % 997) / 997 * duration * 2 });
    const point = pointOn(shape, t);
    if (point.x < -40 || point.x > width + 40 || point.y < -40 || point.y > height + 40) return;
    const heading = headingAt(shape, t) + (forward ? 0 : Math.PI);
    // Fade in leaving the airfield and out arriving, rather than popping.
    const alpha = REDUCED_MOTION ? 1 : Math.min(1, leg / 0.08, (1 - leg) / 0.08);
    drawSpriteTurned(ctx, 'plane', point.x, point.y, size, heading, { alpha });
  });
}
