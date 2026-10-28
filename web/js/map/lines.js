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
//                  The line starts and ends on land, though: those stretches
//                  are a quiet road with a car on it, and the boat takes over
//                  at the beach (land.js says which stretch is which).
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
import { drawBoat, drawCar, drawPlane } from './vehicles.js';
import { config, energyOf } from '../config.js';
import { blockedBy, isLandAt, mixAt, runsOf, sampleLand } from './land.js';

const ROUTE = '#ffffff';
const PATH = '#f1deb3';
const PATH_UNDER = 'rgba(74, 52, 38, .5)';

// Line width by tier (1 weak .. 3 strong), CSS px. A route over the water is a
// plain white line and thinner than a road on land: at most half what it was
// (2026-10-13), the weakest kept just visible.
const ROAD_WIDTHS = [0, 1.6, 2.6, 3.8];
// The arch is a fine dotted line (round dots), so it is told apart from the sea
// route's dashes; the dots need a little more width than a hairline to read.
const ROUTE_WIDTHS = [0, 1, 1.15, 1.3];
const ARCH_DASH = [0.1, 4.4];
const FAINT_WIDTH = { road: 1, route: 0.9, sea: 0.8 };
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
// Planes: the longer side of the sprite in CSS px at the closest zoom (it shrinks
// with the map, see sizeFor), and the cap per view.
const PLANE_SIZE = 30;
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
const BOAT_LENGTH = 20;
// Cars on the stretches of a sea route that run over land (the road from the
// town to the beach): a little smaller than a boat. The width of that road, a
// thin quiet line, and how far (CSS px) along the route a car and a boat cross-
// fade where it meets the water.
const CAR_LENGTH = 18;
// Vehicles are sized like the buildings: in proportion to the map's scale, the
// sizes above being those at the closest zoom, but never smaller than a floor
// (CSS px), so that from the zoom where the lines appear they are always seen.
const BOAT_MIN = 8;
const CAR_MIN = 7;
const PLANE_MIN = 10;
/** The share of the closest-zoom size to use now. 1 when the view does not say. */
export function sizeShare(view) {
  const { scale, maxScale } = view;
  if (!(scale > 0) || !(maxScale > 0)) return 1;
  return Math.min(1, scale / maxScale);
}
/** A vehicle's length in CSS px: `base` at the closest zoom (share 1), in
 * proportion to the scale below that, but not under `floor` (nor over `base`). */
export function vehicleSize(base, floor, share) {
  return Math.min(base, Math.max(floor, base * share));
}
const SHORE_ROAD_WIDTHS = [0, 0.9, 1.1, 1.3];
const SHORE_ROAD_UNDER = 'rgba(74, 52, 38, .32)';
const HANDOVER_PX = 14;
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

/** The control point arc() would use for [x, y] ends, so the ground can be read
 * along the very curve that is drawn (the map's scale and shift do not change a curve). */
function bowOf(from, to, seed, bend) {
  const { c } = arc({ x: from[0], y: from[1] }, { x: to[0], y: to[1] }, seed, bend);
  return [c.x, c.y];
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

/** The part of an arc from t0 to t1, as an arc of its own. */
export function slice(shape, t0, t1) {
  const { p, c, q } = shape;
  const a = pointOn(shape, t0);
  const b = pointOn(shape, t1);
  // The curve's control point beyond t0, then the share of it that is kept.
  const rest = { x: c.x + (q.x - c.x) * t0, y: c.y + (q.y - c.y) * t0 };
  const keep = t0 >= 1 ? 0 : (t1 - t0) / (1 - t0);
  return {
    p: a,
    c: { x: a.x + (rest.x - a.x) * keep, y: a.y + (rest.y - a.y) * keep },
    q: b,
    length: shape.length * (t1 - t0),
  };
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

const islandKey = (island) => island.island_id || (island.name_pending ? `${island.label}@${island.cx},${island.cy}` : island.label) || `${island.cx},${island.cy}`;

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
 * between its two ends? The ground is the one terrain.js draws (land.js, which
 * also says what "between its ends" leaves out: the line leaving and reaching
 * its own shore). `cells` is the coarse layer a saturated map has instead of
 * posts in the dense parts. The line is sampled every few world units, so only a
 * sliver thinner than that can slip through. (Not "leave out the ends' islands":
 * one island is often several pieces of land, and the line between two of them
 * crosses the sea only some of the way.) */
export function crossesLand(posts, from, to, cells = []) {
  return blockedBy(sampleLand(posts, from, to, cells));
}

// Open water this long (world units) on the straight line between two posts
// means they are not on one piece of land, whatever the island list says.
const GAP_WORLD = 20;

/** Is there open water on the straight line, in a stretch at least GAP_WORLD
 * long? `land` is sampleLand's answer for a line `length` long. */
export function hasWaterGap(land, length) {
  return runsOf(land).some((run) => !run.land && (run.to - run.from) * length >= GAP_WORLD);
}

/** Is there open water between two world points, over the given ground? (The guard against a
 * nearest-island fallback calling two far islands one; see layout and kin.js.) */
export function waterBetween(posts, cells, from, to) {
  return hasWaterGap(sampleLand(posts, from, to, cells), Math.hypot(from[0] - to[0], from[1] - to[1]));
}

// What a line IS (a road on one island, a sea route, an arch) is decided once per pair from data that
// does not depend on the view: the islands of the whole map (not the ones in view), the ground of every
// post the client holds, and the land test in world units at one fixed step (land.js STEP). Drawing then
// only scales the geometry, so the same two posts are joined by the same kind of line at every zoom
// (2026-10-25, the user: road when near, road + sea when closer, an air route closest). The answers are
// kept until the ground changes: the list of posts (a new array when the map fetches or the ground is
// rebuilt), the coarse cells, the islands, the reach factor, and a fingerprint of the posts, which is
// one cheap pass (a post whose energy changed in place, a like, shows in it). The key holds both ends
// and where they stand: a moved post is a new question.
let decided = { posts: null, cells: null, islands: null, landOf: null, factor: null, print: null, answers: new Map() };
// The last answer for each pair, kept across a change of ground: while an end's own land is not loaded
// (a post off the area fetched so far) the pair keeps what it was instead of flickering on a guess.
const lastDecided = new Map();

function fingerprint(posts) {
  let sum = 0;
  posts.forEach((post) => { sum += (energyOf(post) || 0) + post.x * 0.001 + post.y * 0.0001; });
  return `${posts.length}|${sum.toFixed(4)}`;
}

const NO_CELLS = [];

/** The kind of one line, from the world and nothing about the view.
 * `world` is { islands, posts, cells, landOf, print }; `islandOf` is islandFinder(world.islands).
 * Returns { sameIsland, hasRoute, kind, runs, final } where `final` is false while an end's land is unknown. */
export function decideLink(world, row, islandOf = islandFinder(world.islands)) {
  const { posts, cells = NO_CELLS, landOf } = world;
  const a = islandOf(row.a_post, row.a_at);
  const b = islandOf(row.b_post, row.b_at);
  const hasRoute = Boolean(a) && Boolean(b) && a !== b;
  // One named island can be several pieces of land; a road stays on one.
  const landA = landOf ? landOf(row.a_post) : null;
  const landB = landOf ? landOf(row.b_post) : null;
  let sameIsland = Boolean(a) && a === b && (!landA || !landB || landA === landB);
  // The island list can give a post the nearest island's name, so two islands far apart might read as
  // one; when a post's piece of land is not known, the ground decides: open water between the two ends
  // is not an island's road.
  const unsure = sameIsland && (!landA || !landB) && Boolean(posts);
  const flip = String(row.a) > String(row.b);
  const from = flip ? row.b_at : row.a_at;
  const to = flip ? row.a_at : row.b_at;
  let ground = null;
  if (unsure || (!sameIsland && hasRoute && posts)) {
    // Blocked or not is asked of the straight line (an arch is judged the same
    // way). The stretches - a sea route's two ends (its own shores) are roads for
    // cars, the water between is for boats - are found along the bowed curve the
    // route is drawn on, in the drawn direction (the end with the smaller id first).
    const straight = sampleLand(posts, row.a_at, row.b_at, cells);
    const bow = bowOf(from, to, hashId(`${row.a}|${row.b}`), SEA_BEND);
    ground = {
      blocked: blockedBy(straight),
      gap: hasWaterGap(straight, Math.hypot(row.a_at[0] - row.b_at[0], row.a_at[1] - row.b_at[1])),
      runs: runsOf(sampleLand(posts, from, to, cells, bow)),
    };
    if (unsure) {
      if (ground.gap) sameIsland = false;
      else ground = null;
    }
  }
  const sea = Boolean(ground) && !ground.blocked && !sameIsland;
  // Known only when both ends stand on loaded land (a post is land at its own spot).
  const final = !ground || (isLandAt(posts, cells, row.a_at[0], row.a_at[1]) && isLandAt(posts, cells, row.b_at[0], row.b_at[1]));
  return {
    sameIsland, hasRoute,
    kind: sameIsland ? 'road' : sea ? 'sea' : 'arch',
    runs: sea ? ground.runs : null,
    final,
  };
}

function decisionOf(world, row, islandOf) {
  const factor = config().energy.radius_factor ?? 1;
  const cells = world.cells || NO_CELLS;
  const { posts, islands, landOf, print } = world;
  if (decided.posts !== posts || decided.cells !== cells || decided.islands !== islands || decided.landOf !== landOf
    || decided.factor !== factor || decided.print !== print) {
    decided = { posts, cells, islands, landOf, factor, print, answers: new Map() };
  }
  const key = `${row.a_post}|${row.b_post}|${row.a_at}|${row.b_at}`;
  const { answers } = decided;
  if (!answers.has(key)) {
    let answer = decideLink({ ...world, cells }, row, islandOf);
    if (!answer.final) {
      // An end is not loaded yet: keep the last real answer for this pair, and ask again next frame.
      const before = lastDecided.get(key);
      return before || answer;
    }
    lastDecided.set(key, answer);
    answers.set(key, answer);
  }
  return answers.get(key);
}

/** The kind of every pair ('road' | 'sea' | 'arch') for a world, for tests and checks. */
export function linkKinds(world, rows) {
  const islandOf = islandFinder(world.islands);
  const print = world.posts ? fingerprint(world.posts) : null;
  return rows.map((row) => decisionOf({ ...world, print }, row, islandOf).kind);
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

/** Every pair, with its shape on screen and the route it belongs to. The KIND of each line comes from
 * decisionOf (the whole map, kept per pair); only the geometry is made from the view. */
function layout(view) {
  const { rows, toScreen, landOf } = view;
  // `world` overrides the view-sized data: the islands of the whole map and the ground of every post held.
  const world = view.world || {};
  const islands = world.islands || view.islands;
  const posts = world.posts || view.posts;
  const cells = world.cells || view.cells || NO_CELLS;
  const worldLand = world.landOf || landOf;
  const islandOf = islandFinder(islands);
  const routes = buildRoutes(rows, islandOf);
  const routeOf = new Map();
  routes.forEach((route) => route.rows.forEach((row) => routeOf.set(row, route)));

  // Once per frame, not per line.
  const print = posts ? fingerprint(posts) : null;
  const ctx = { islands, posts, cells, landOf: worldLand, print };
  const lines = [];
  rows.forEach((row) => {
    if (!row.a_at || !row.b_at) return;
    // Drawn from the end with the smaller id, so A to B and B to A bow the same way.
    const flip = String(row.a) > String(row.b);
    const from = flip ? row.b_at : row.a_at;
    const to = flip ? row.a_at : row.b_at;
    const decision = decisionOf(ctx, row, islandOf);
    const { sameIsland, kind, runs } = decision;
    const landA = worldLand ? worldLand(row.a_post) : null;
    const landB = worldLand ? worldLand(row.b_post) : null;
    const p = toScreen(from[0], from[1]);
    const q = toScreen(to[0], to[1]);
    const route = routeOf.get(row) || null;
    // Which route the line is on, for its plane: the pair of islands, or, for
    // an arch between two pieces of land of one island, the pair of pieces.
    let group = route ? route.key : linkKey(row);
    if (!route && !sameIsland && landA && landB) group = [landKey(landA), landKey(landB)].sort().join('|');
    const sea = kind === 'sea';
    lines.push({
      row, sameIsland, route, group,
      // The stretches of a sea route, along the way it is drawn (from -> to).
      runs: sea ? runs : null,
      kind,
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
  plan.lines.forEach(({ row, sameIsland, kind, arc: shape, runs }) => {
    if (!onScreen(shape, width, height)) return;
    const share = growthOf(linkKey(row), tick);
    const tier = row.tier || 1;
    if (kind === 'sea' && runs) {
      // Over the water the white dashes; over the land at its two ends a quiet
      // road (a car drives it, drawPlanes), so no boat is drawn on land.
      const alpha = freshness(row, now);
      runs.forEach(({ from, to, land }) => {
        const end = Math.min(to, share);
        if (end - from < 1e-4) return;
        const part = from === 0 && end === 1 ? shape : slice(shape, from, end);
        stroke(ctx, part, land ? {
          color: PATH, under: SHORE_ROAD_UNDER, alpha,
          width: row.faint ? FAINT_WIDTH.road * 0.8 : SHORE_ROAD_WIDTHS[tier] * grow,
        } : {
          color: ROUTE, dash: SEA_DASH, alpha,
          width: row.faint ? FAINT_WIDTH.sea : SEA_WIDTHS[tier] * grow,
        });
      });
      return;
    }
    stroke(ctx, share < 1 ? partOf(shape, share) : shape, kind === 'sea' ? {
      color: ROUTE, dash: SEA_DASH,
      width: row.faint ? FAINT_WIDTH.sea : SEA_WIDTHS[tier] * grow,
      alpha: freshness(row, now),
    } : sameIsland ? {
      color: PATH, under: PATH_UNDER,
      width: row.faint ? FAINT_WIDTH.road : ROAD_WIDTHS[tier] * grow,
      alpha: freshness(row, now),
    } : {
      color: ROUTE, dash: ARCH_DASH,
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

/** Cars and boats on the sea routes, and cars on the roads inside an island: one
 * to three per route or road by its tier, the strongest first until the screen's
 * cap is used up. `time` null: standing still. */
function drawBoats(ctx, view, plan, time) {
  const { width, height, span, phone } = view;
  const share = sizeShare(view);
  const boatLength = vehicleSize(BOAT_LENGTH, BOAT_MIN, share);
  const carLength = vehicleSize(CAR_LENGTH, CAR_MIN, share);
  const still = REDUCED_MOTION || time === null || time === undefined;
  const cap = phone ? BOAT_CAP.phone : BOAT_CAP.wide;
  const routes = new Map();
  plan.lines.forEach(({ row, kind, group: key, arc: shape, world, runs }) => {
    if ((kind !== 'sea' && kind !== 'road') || row.faint || !onScreen(shape, width, height)) return;
    if (growthOf(linkKey(row)) < 1) return;
    const strength = Number(row.strength) || 0;
    // A road is its own line (a car runs on each); a sea route is one per pair of islands.
    const id = kind === 'road' ? `road|${linkKey(row)}` : key;
    const held = routes.get(id);
    if (!held) {
      routes.set(id, { key: id, shape, world, strength, runs, tier: row.tier || 1, road: kind === 'road' });
      return;
    }
    held.tier = Math.max(held.tier, row.tier || 1);
    if (strength > held.strength) Object.assign(held, { shape, world, strength, runs });
  });
  // Roads may not use up the whole cap: at least half stays for the sea routes
  // (when there are that many), and what the sea routes leave over goes to the roads.
  const all = [...routes.values()];
  const demand = (isRoad) => all.filter((r) => r.road === isRoad).reduce((n, r) => n + boatCount(r.tier), 0);
  let roadRoom = Math.max(Math.floor(cap / 2), cap - demand(false));
  let seaRoom = cap - Math.min(demand(true), roadRoom);
  all.sort((a, b) => b.strength - a.strength).forEach(({ shape, key, world, tier, runs, road }) => {
    const count = Math.min(boatCount(tier), road ? roadRoom : seaRoom);
    if (road) roadRoom -= count; else seaRoom -= count;
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
      // A car on the land stretches (and all of a road), a boat on the water: from
      // the clock and the ground alone, handing over across a short stretch at the beach.
      const [car, boat] = road ? [1, 0] : runs ? mixAt(runs, t, HANDOVER_PX / Math.max(1, shape.length)) : [0, 1];
      if (car > 0.01) drawCar(ctx, point.x, point.y, carLength, heading, { alpha: alpha * car });
      if (boat > 0.01) drawBoat(ctx, point.x, point.y, boatLength, heading, { alpha: alpha * boat });
    }
  });
}

/** Cars and boats on the sea routes and roads, planes on the arches that are alive now (over the towns). */
export function drawPlanes(ctx, view, plan, time) {
  const { width, height, far, span, phone } = view;
  if (far || !plan) return;
  drawBoats(ctx, view, plan, time);
  const cap = phone ? PLANE_CAP.phone : PLANE_CAP.wide;
  const size = vehicleSize(PLANE_SIZE, PLANE_MIN, sizeShare(view));

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
