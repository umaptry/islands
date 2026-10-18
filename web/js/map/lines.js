// Lines between people: roads and flight paths.
//
// One line per pair of people, ending on the post the two touched most - the
// server decides which post and where it stands, so a line never waits for the
// viewport to load its ends. Two kinds, as in the design mock:
//
//   same island    a road, drawn straight between the two. A road that is new
//                  since the map opened grows out from one end.
//   across water   a sea route: a thin white dashed line, nearly straight, with
//                  little boats going back and forth (more people, more boats).
//                  But when the straight line between the two posts would run
//                  over a third island, a boat cannot go that way: the line is a
//                  thin white arch instead, and one plane flies back and forth
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
import { drawBoat, drawPlane } from './vehicles.js';
import { config, energyOf, radiusOf } from '../config.js';
import { groundOf } from './coast.js';

const ROUTE = '#ffffff';
const PATH = '#f1deb3';
const PATH_UNDER = 'rgba(74, 52, 38, .5)';

// Line width by tier (1 weak .. 3 strong), CSS px. A route over the water is a
// plain white line and thinner than a road on land: at most half what it was
// (2026-10-13), the weakest kept just visible.
const ROAD_WIDTHS = [0, 1.6, 2.6, 3.8];
const ROUTE_WIDTHS = [0, 0.7, 0.85, 1.05];
const FAINT_WIDTH = { road: 1, route: 0.6, sea: 0.8 };
// A dashed sea route needs a little more than the arch's hairline to read.
const SEA_WIDTHS = [0, 1, 1.15, 1.3];
const SEA_DASH = [5, 5];
// The sea route bows a little, as a share of its length (the arch's is 0.3).
const SEA_BEND = 0.04;
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
// Boats: this many times slower than a plane over the same distance, one per tier
// of the route (1 to 3), at most this many on the screen, with a hull this long
// in CSS px whatever the zoom (the drawing is vehicles.js, like the plane's).
const BOAT_SLOWER = 2;
const BOAT_CAP = { phone: 8, wide: 18 };
const BOAT_LENGTH = 17;
const BOAT_LENGTH_DEEP = 20;
// Does the straight line between two posts run over land? Sampled every STEP
// world units (so a thin strip of land is not skipped on a long line), at least
// MIN_SAMPLES and at most MAX_SAMPLES points; one at or above the beach
// threshold of the ground is land.
const STEP = 4;
const MIN_SAMPLES = 12;
const MAX_SAMPLES = 260;
// The coarse layer's cell size (ENERGY_CELL_SIZE, as in terrain.js).
const CELL_SIZE = 20;

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

// ---------------------------------------------------------------- blocked

/** Does the straight line from `from` to `to` (world coordinates) run over land
 * between its two ends? The ground is the one terrain.js draws: every post adds a
 * cone of energy (groundOf, coast wobble included), highest at the post and
 * falling to nothing at its reach, and where the sum reaches the beach threshold
 * there is land. `cells` is the coarse layer a saturated map has instead of
 * posts in the dense parts; its cones are plain circles, as in terrain.js. The
 * stretch still on the first end's land and the stretch already on the last
 * end's land are the line leaving and reaching its own shore, so they do not
 * count; any land between them (another island, or a bay of the ends' own coast)
 * does, and so does a line with no open water on it at all. The line is sampled
 * every few world units, so only a sliver thinner than that can slip through.
 * (Not "leave out the ends' islands": one island is often several pieces of
 * land, and the line between two of them crosses the sea only some of the way.) */
export function crossesLand(posts, from, to, cells = []) {
  const beach = config().energy.biome_thresholds.desert;
  const lo = [Math.min(from[0], to[0]), Math.min(from[1], to[1])];
  const hi = [Math.max(from[0], to[0]), Math.max(from[1], to[1])];
  // Only posts whose circle touches the segment's box can matter (the coast only
  // ever shortens the reach, never past the radius).
  const near = [];
  posts.forEach((post) => {
    const radius = radiusOf(post);
    if (!(energyOf(post) > 0) || !(radius > 0)) return;
    if (post.x < lo[0] - radius || post.x > hi[0] + radius
      || post.y < lo[1] - radius || post.y > hi[1] + radius) return;
    near.push(post);
  });
  const cones = [];
  if (cells.length) {
    const { radius_base: base, radius_scale: rate, radius_trim: trim, radius_factor: factor = 1 } = config().energy;
    cells.forEach((cell) => {
      const energy = Number(cell.sum_energy) || 0;
      const radius = (base + energy * rate) * trim * factor;
      const x = (cell.cell_x + 0.5) * CELL_SIZE;
      const y = (cell.cell_y + 0.5) * CELL_SIZE;
      if (!(energy > 0) || !(radius > 0)) return;
      if (x < lo[0] - radius || x > hi[0] + radius || y < lo[1] - radius || y > hi[1] + radius) return;
      cones.push([x, y, energy, radius]);
    });
  }
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const samples = Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.ceil(length / STEP)));
  const land = [];
  for (let i = 0; i < samples; i += 1) {
    const t = (i + 0.5) / samples;
    const x = from[0] + (to[0] - from[0]) * t;
    const y = from[1] + (to[1] - from[1]) * t;
    let sum = 0;
    for (const post of near) sum += groundOf(post, x, y);
    for (const [cx, cy, energy, radius] of cones) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance < radius) sum += energy * (1 - distance / radius);
    }
    land.push(sum >= beach);
  }
  let first = 0;
  while (first < samples && land[first]) first += 1;
  if (first === samples) return true;
  let last = samples - 1;
  while (land[last]) last -= 1;
  return land.slice(first, last + 1).some(Boolean);
}

// The answers are kept per line until the ground changes, so no frame computes
// them. The ground is the list of posts (a new array when the map fetches or the
// ground is rebuilt), the coarse cells, the islands and the reach factor; a post
// whose energy changed in place (a like) shows in the fingerprint, which is one
// cheap pass over the posts. The line's key holds both ends and where they
// stand: a moved post is a new question.
let blockedCache = { posts: null, cells: null, islands: null, factor: null, print: null, answers: new Map() };


function fingerprint(posts) {
  let sum = 0;
  posts.forEach((post) => { sum += (energyOf(post) || 0) + post.x * 0.001 + post.y * 0.0001; });
  return `${posts.length}|${sum.toFixed(4)}`;
}

const NO_CELLS = [];

function blockedOf(view, row, print) {
  const factor = config().energy.radius_factor ?? 1;
  const cells = view.cells || NO_CELLS;
  if (blockedCache.posts !== view.posts || blockedCache.cells !== cells || blockedCache.islands !== view.islands
    || blockedCache.factor !== factor || blockedCache.print !== print) {
    blockedCache = { posts: view.posts, cells, islands: view.islands, factor, print, answers: new Map() };
  }
  const key = `${row.a_post}|${row.b_post}|${row.a_at}|${row.b_at}`;
  const { answers } = blockedCache;
  if (!answers.has(key)) answers.set(key, crossesLand(view.posts, row.a_at, row.b_at, cells));
  return answers.get(key);
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

  // Once per frame, not per line.
  const print = view.posts ? fingerprint(view.posts) : null;
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
    // Over water with posts to check: a sea route unless land is in the way.
    const sea = !sameIsland && Boolean(route) && Boolean(view.posts) && !blockedOf(view, row, print);
    lines.push({
      row, sameIsland, route, group,
      kind: sameIsland ? 'road' : sea ? 'sea' : 'arch',
      world: Math.hypot(row.a_at[0] - row.b_at[0], row.a_at[1] - row.b_at[1]),
      arc: sameIsland
        ? arc(p, q, 0, 0)
        : arc(p, q, hashId(`${row.a}|${row.b}`), sea ? SEA_BEND : ARCH_BEND),
    });
  });
  return { lines };
}

/** Roads, sea routes and arches (under the towns). Returns the layout the planes and boats reuse,
 * or null from far away, where neither is drawn. */
export function drawLinks(ctx, view) {
  const { width, height, far, level } = view;
  if (far) return null;
  const plan = layout(view);
  const now = Date.now();
  const tick = performance.now();
  const grow = level === 'deep' ? 1.3 : 1;
  plan.lines.forEach(({ row, sameIsland, kind, arc: shape }) => {
    if (!onScreen(shape, width, height)) return;
    const share = growthOf(linkKey(row), tick);
    const tier = row.tier || 1;
    stroke(ctx, share < 1 ? partOf(shape, share) : shape, kind === 'sea' ? {
      color: ROUTE, dash: SEA_DASH,
      width: row.faint ? FAINT_WIDTH.sea : SEA_WIDTHS[tier] * grow,
      alpha: freshness(row, now),
    } : sameIsland ? {
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

/** How many boats a route gets: one per tier, 1 to 3. */
export function boatCount(tier) {
  return Math.max(1, Math.min(3, Math.round(Number(tier)) || 1));
}

/** Where a boat is on its route: like a plane, only slower, and boat `index` of
 * `count` starts that share of the round trip after the one before it. */
export function boatAt(time, { duration, offset = 0, index = 0, count = 1 }) {
  const slow = duration * BOAT_SLOWER;
  return planeAt(time, { duration: slow, offset: offset + index * (slow * 2 / count) });
}

/** Boats on the sea routes: one to three per route by its tier, the strongest
 * routes first until the screen's cap is used up. `time` null: standing still. */
function drawBoats(ctx, view, plan, time) {
  const { width, height, span, phone, level } = view;
  const boatLength = level === 'deep' ? BOAT_LENGTH_DEEP : BOAT_LENGTH;
  const still = REDUCED_MOTION || time === null || time === undefined;
  let room = phone ? BOAT_CAP.phone : BOAT_CAP.wide;
  const routes = new Map();
  plan.lines.forEach(({ row, kind, group: key, arc: shape, world }) => {
    if (kind !== 'sea' || row.faint || !onScreen(shape, width, height)) return;
    if (growthOf(linkKey(row)) < 1) return;
    const strength = Number(row.strength) || 0;
    const held = routes.get(key);
    if (!held) {
      routes.set(key, { key, shape, world, strength, tier: row.tier || 1 });
      return;
    }
    held.tier = Math.max(held.tier, row.tier || 1);
    if (strength > held.strength) Object.assign(held, { shape, world, strength });
  });
  [...routes.values()].sort((a, b) => b.strength - a.strength).forEach(({ shape, key, world, tier }) => {
    const count = Math.min(boatCount(tier), room);
    room -= count;
    const seed = hashId(key);
    const duration = crossingSeconds(world, span);
    for (let index = 0; index < count; index += 1) {
      const { t, forward, leg } = still
        ? { t: (index + 1) / (count + 1), forward: true, leg: 0.5 }
        : boatAt(time, { duration, offset: (seed % 997) / 997 * duration * 2, index, count });
      const point = pointOn(shape, t);
      if (point.x < -40 || point.x > width + 40 || point.y < -40 || point.y > height + 40) continue;
      const heading = headingAt(shape, t) + (forward ? 0 : Math.PI);
      const alpha = still ? 1 : Math.min(1, leg / 0.08, (1 - leg) / 0.08);
      drawBoat(ctx, point.x, point.y, boatLength, heading, { alpha });
    }
  });
}

/** Boats on the sea routes, planes on the arches that are alive now (over the towns). */
export function drawPlanes(ctx, view, plan, time) {
  const { width, height, far, level, span, phone } = view;
  if (far || !plan) return;
  drawBoats(ctx, view, plan, time);
  const cap = phone ? PLANE_CAP.phone : PLANE_CAP.wide;
  const size = PLANE_SIZE[level] || PLANE_SIZE.near;

  // The arches between two islands are drawn one per pair of people, but the
  // plane is one per route: it flies the strongest arch of its route that is on
  // screen. Keyed by the route, so it keeps its place in the schedule while you
  // pan from one of its arches to another.
  const best = new Map();
  plan.lines.forEach(({ row, sameIsland, kind, group: key, arc: shape, world }) => {
    if (sameIsland || kind === 'sea' || row.faint || !onScreen(shape, width, height)) return;
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
    drawPlane(ctx, point.x, point.y, size, heading, { alpha });
  });
}
