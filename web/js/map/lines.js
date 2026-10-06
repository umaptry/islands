// Lines between people, and what travels on them (段3).
//
// One line per pair of people, ending on the post the two touched most - the
// server decides which post and where it stands, so a line never waits for the
// viewport to load its ends. How a line is drawn depends on the distance:
//
//   far        lines between islands merge into one white 航路 per island
//              pair, as wide as everything on it together. Lines inside one
//              island are too short to read from there and are left out.
//   near/deep  each pair on its own: white over the sea between islands, an
//              earth path (土の道) inside one.
//
// Yours are orange at every distance. The people the AI thinks are like you -
// and like whoever you are looking at - get an orange dotted line, until the
// two of you actually meet: then it is a real line and the dots go (Q24・Q28).
//
// Boats, balloons and walkers travel only the lines that are alive now (two
// separate days within two weeks, decided by the server). Like decor.js, where
// each one is is a pure function of the clock, so a hidden tab or a dropped
// frame cannot leave a boat stranded somewhere.

import { REDUCED_MOTION, hashId } from './decor.js';
import { drawSprite } from './sprites.js';

const MINE = '#ff8a1f';
const MINE_UNDER = 'rgba(122, 52, 0, .35)';
const ROUTE = '#ffffff';
const ROUTE_UNDER = 'rgba(23, 46, 74, .22)';
const PATH = '#e2bd86';
const PATH_UNDER = 'rgba(74, 52, 38, .45)';

// Line width by tier (1 weak .. 3 strong), CSS px.
const WIDTHS = [0, 1.6, 2.6, 3.8];
// Tier of a merged route from the sum of its lines' strength: the same bounds
// core/config.py CONNECTION_TIER_BOUNDS uses for one line.
const ROUTE_TIER_BOUNDS = [3, 8];
const FAINT_ALPHA = 0.26;
const FRESH_DAYS = 30;

// Vehicles: the longer side of each sprite, CSS px.
const SIZES = { row: 22, sail: 26, ferry: 30, balloon: 28, walker: 18 };
// A route that this many people use gets the ferry.
const FERRY_PEOPLE = 4;
// Ends further apart than this share of the world go by balloon.
const BALLOON_REACH = 0.4;
// Seconds between departures: strong lines often, weak ones now and then.
const INTERVAL = { min: 6, max: 20 };
// One crossing: the world's width in about 40 s, never quicker than 6 or
// slower than 18. In world units, so a crossing does not speed up as you zoom.
const CROSSING = { span: 40, min: 6, max: 18 };
const CAP = { phone: 15, wide: 30 };

// ---------------------------------------------------------------- geometry

/** A gentle quadratic arc from p to q. `seed` picks which side it bows to. */
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

function headingX({ p, c, q }, t) {
  return 2 * (1 - t) * (c.x - p.x) + 2 * t * (q.x - c.x);
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
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.quadraticCurveTo(c.x, c.y, q.x, q.y);
  if (dash) ctx.setLineDash(dash);
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

export function routeTier(strength) {
  if (strength >= ROUTE_TIER_BOUNDS[1]) return 3;
  if (strength >= ROUTE_TIER_BOUNDS[0]) return 2;
  return 1;
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

/** Lines between islands, merged per island pair (the far view's 航路). */
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

export function vehicleKind({ sameIsland, distance, span, people, tier }) {
  if (sameIsland) return 'walker';
  if (distance > span * BALLOON_REACH) return 'balloon';
  if (people >= FERRY_PEOPLE) return 'ferry';
  if (tier >= 3) return 'sail';
  return 'row';
}

/** Every crossing under way at `time` on one line.
 *
 * A boat leaves every `interval` seconds and takes `duration` to cross; each
 * departure goes the other way from the last, so the line is travelled back and
 * forth. Positions come from the clock alone.
 */
export function tripsAt(time, { seed, interval, duration }) {
  const t = time + ((seed % 997) / 997) * interval;
  const last = Math.floor(t / interval);
  const trips = [];
  for (let k = last; k >= last - Math.ceil(duration / interval); k -= 1) {
    const age = t - k * interval;
    if (age < 0 || age >= duration) continue;
    trips.push({ progress: age / duration, forward: ((k % 2) + 2) % 2 === 0 });
  }
  return trips;
}

export function intervalFor(strength) {
  const share = Math.min(1, Math.max(0, (Number(strength) || 0) / ROUTE_TIER_BOUNDS[1]));
  return INTERVAL.max - (INTERVAL.max - INTERVAL.min) * share;
}

// ---------------------------------------------------------------- drawing

/** The pairs to draw at this distance, each with its arc on screen. */
function layout(view) {
  const { rows, islands, toScreen, far, meId, landOf } = view;
  const islandOf = islandFinder(islands);
  const routes = buildRoutes(rows, islandOf);
  const routeOf = new Map();
  routes.forEach((route) => route.rows.forEach((row) => routeOf.set(row, route)));

  const lines = [];
  rows.forEach((row) => {
    if (!row.a_at || !row.b_at) return;
    // The arc is drawn from the end with the smaller id, so A→B and B→A bow
    // the same way.
    const flip = String(row.a) > String(row.b);
    const from = flip ? row.b_at : row.a_at;
    const to = flip ? row.a_at : row.b_at;
    const a = islandOf(row.a_post, row.a_at);
    const b = islandOf(row.b_post, row.b_at);
    const mine = Boolean(meId) && (row.a === meId || row.b === meId);
    // One named island can be several pieces of land; a walker stays on one.
    const landA = landOf ? landOf(row.a_post) : null;
    const landB = landOf ? landOf(row.b_post) : null;
    lines.push({
      row, mine,
      sameIsland: Boolean(a) && a === b && (!landA || !landB || landA === landB),
      route: routeOf.get(row) || null,
      world: Math.hypot(row.a_at[0] - row.b_at[0], row.a_at[1] - row.b_at[1]),
      arc: arc(toScreen(from[0], from[1]), toScreen(to[0], to[1]), hashId(`${row.a}|${row.b}`)),
    });
  });
  const routeArcs = far ? routes.map((route) => ({
    route,
    arc: arc(toScreen(route.a.cx, route.a.cy), toScreen(route.b.cx, route.b.cy), hashId(route.key), 0.18),
  })) : [];
  return { lines, routeArcs };
}

/** Solid lines (under the towns). Returns the layout the vehicles reuse. */
export function drawLines(ctx, view) {
  const { width, height, far, level } = view;
  const plan = layout(view);
  const now = Date.now();
  const grow = level === 'deep' ? 1.3 : 1;

  if (far) {
    plan.routeArcs.forEach(({ route, arc: shape }) => {
      if (!onScreen(shape, width, height)) return;
      stroke(ctx, shape, {
        color: ROUTE, under: ROUTE_UNDER,
        width: route.faint ? 1 : WIDTHS[routeTier(route.strength)],
        alpha: freshness(route, now),
      });
    });
  } else {
    plan.lines.forEach(({ row, mine, sameIsland, arc: shape }) => {
      if (mine || !onScreen(shape, width, height)) return;
      stroke(ctx, shape, {
        color: sameIsland ? PATH : ROUTE,
        under: sameIsland ? PATH_UNDER : ROUTE_UNDER,
        width: row.faint ? 1 : WIDTHS[row.tier || 1] * grow,
        alpha: freshness(row, now),
      });
    });
  }
  // Yours, on top, at every distance.
  plan.lines.forEach(({ row, mine, arc: shape }) => {
    if (!mine || !onScreen(shape, width, height)) return;
    stroke(ctx, shape, {
      color: MINE, under: MINE_UNDER,
      width: row.faint ? 1.2 : WIDTHS[row.tier || 1] * (far ? 1 : grow),
      alpha: Math.max(0.45, freshness(row, now)),
    });
  });
  return plan;
}

/** Where a person stands: their most energetic post with a place. */
export function homeOf(posts) {
  let best = null;
  posts.forEach((post) => {
    if (post.x == null || post.y == null) return;
    const energy = Number(post.energy) || 0;
    if (!best || energy > best.energy) best = { post, energy };
  });
  return best ? best.post : null;
}

/** The pairs that already share a line, as "a|b" both ways. */
function pairsOf(rows) {
  const pairs = new Set();
  rows.forEach((row) => { pairs.add(`${row.a}|${row.b}`); pairs.add(`${row.b}|${row.a}`); });
  return pairs;
}

/** Dotted lines to the people the AI thinks are alike (Q24・Q28).
 *
 * From you to yours, and from the post being looked at to its author's. A pair
 * that already shares a real line keeps only the real one.
 */
export function drawHints(ctx, view) {
  const { rows, toScreen, width, height, meId, home, similar, selected, selectedSimilar, focus } = view;
  const pairs = pairsOf(rows);
  const sets = [];
  if (meId && home) sets.push({ owner: meId, from: home, people: similar });
  if (selected && selectedSimilar && selectedSimilar.author === selected.author_id
    && selected.author_id !== meId) {
    sets.push({ owner: selected.author_id, from: selected, people: selectedSimilar.people });
  }
  sets.forEach(({ owner, from, people }) => {
    (people || []).forEach((person) => {
      if (!person.post || person.id === owner || pairs.has(`${owner}|${person.id}`)) return;
      const shape = arc(toScreen(from.x, from.y), toScreen(person.post.x, person.post.y),
        hashId(`${owner}|${person.id}`), 0.12);
      if (shape.length < 8 || !onScreen(shape, width, height)) return;
      // The person whose card is open (段4) stands out; the rest step back.
      const style = !focus ? { width: 2, alpha: 0.9 }
        : person.id === focus ? { width: 3.5, alpha: 1 } : { width: 2, alpha: 0.4 };
      stroke(ctx, shape, { color: MINE, ...style, dash: [1, 6] });
    });
  });
}

function drawVehicle(ctx, kind, x, y, size, facing, time, alpha) {
  const name = kind === 'walker'
    ? (REDUCED_MOTION || Math.floor(time * 3) % 2 ? 'walker_a' : 'walker_b')
    : { row: 'boat_row', sail: 'boat_sail', ferry: 'ferry', balloon: 'balloon' }[kind];
  // Boats sit in the water on the line; the balloon floats above it.
  const foot = kind === 'balloon' ? y - 6 : kind === 'walker' ? y + size * 0.45 : y + size * 0.3;
  ctx.save();
  ctx.translate(x, 0);
  if (facing < 0) ctx.scale(-1, 1);
  const box = drawSprite(ctx, name, 0, foot, size, { alpha });
  ctx.restore();
  return box ? { x, y: foot - box.h / 2, r: Math.max(14, size * 0.6) } : null;
}

/** Vehicles on the lines that are alive now. Returns their tap targets. */
export function drawVehicles(ctx, view, plan, time) {
  const { width, height, far, level, span, phone } = view;
  const cap = phone ? CAP.phone : CAP.wide;
  const crossing = (world) => Math.max(CROSSING.min, Math.min(CROSSING.max, (world / span) * CROSSING.span));
  const routeArc = new Map(plan.routeArcs.map(({ route, arc: shape }) => [route, shape]));

  const moving = [];
  plan.lines.forEach((line) => {
    const { row, sameIsland, route } = line;
    if (!row.ongoing) return;
    // From far away, a boat between islands rides the route, and walkers
    // inside an island are too small to see.
    const shape = far ? (route ? routeArc.get(route) : null) : line.arc;
    if (!shape || shape.length < 24) return;
    const kind = vehicleKind({
      sameIsland, distance: line.world, span,
      people: route ? route.people.size : 2, tier: row.tier || 1,
    });
    const seed = hashId(`${row.a}|${row.b}`);
    const trips = REDUCED_MOTION
      ? [{ progress: 0.5, forward: true }]
      : tripsAt(time, { seed, interval: intervalFor(row.strength), duration: crossing(line.world) });
    trips.forEach((trip) => moving.push({ line, shape, kind, trip, seed }));
  });

  // Yours first, then the strongest, up to the cap.
  moving.sort((a, b) => (b.line.mine - a.line.mine) || ((b.line.row.strength || 0) - (a.line.row.strength || 0)));
  const hits = [];
  const grow = level === 'deep' ? 1.2 : 1;
  moving.slice(0, cap).forEach(({ line, shape, kind, trip, seed }) => {
    const eased = 0.5 - Math.cos(Math.PI * trip.progress) / 2;
    const t = trip.forward ? eased : 1 - eased;
    const point = pointOn(shape, t);
    if (point.x < -40 || point.x > width + 40 || point.y < -40 || point.y > height + 40) return;
    const dx = headingX(shape, t) * (trip.forward ? 1 : -1);
    const bob = REDUCED_MOTION ? 0 : Math.sin(time * 1.6 + (seed % 7)) * (kind === 'balloon' ? 2 : 0.8);
    // Fade in leaving the quay and out arriving, rather than popping.
    const alpha = REDUCED_MOTION ? 1 : Math.min(1, trip.progress / 0.08, (1 - trip.progress) / 0.08);
    const size = SIZES[kind] * (far ? 0.85 : grow);
    const hit = drawVehicle(ctx, kind, point.x, point.y + bob, size, dx < 0 ? -1 : 1, time, alpha);
    if (hit && alpha > 0.5) hits.push({ ...hit, vehicle: line.row });
  });
  return hits;
}

/** Q53: a gull sets off from you toward the island of somebody like you.
 *
 * Only for someone on another island - next door, you can already see them.
 * A tap flies the camera there.
 */
export function drawGuide(ctx, view, time, face) {
  const { toScreen, width, height, home, similar, islands } = view;
  if (!home || !similar || !similar.length) return null;
  const islandOf = islandFinder(islands);
  const mineIsland = islandOf(home.id, [home.x, home.y]);
  const target = similar.find((person) => person.post
    && islandOf(person.post.id, [person.post.x, person.post.y]) !== mineIsland);
  if (!target) return null;
  const shape = arc(toScreen(home.x, home.y), toScreen(target.post.x, target.post.y),
    hashId(`guide|${target.id}`), 0.12);
  if (shape.length < 40) return null;

  // Six and a half seconds out, then a rest before the next one leaves.
  const cycle = 9;
  const flight = 6.5;
  const age = REDUCED_MOTION ? flight * 0.35 : time % cycle;
  if (age > flight) return null;
  const progress = age / flight;
  const point = pointOn(shape, 0.5 - Math.cos(Math.PI * progress) / 2);
  if (point.x < -20 || point.x > width + 20 || point.y < -20 || point.y > height + 20) return null;
  const alpha = REDUCED_MOTION ? 1 : Math.min(1, progress / 0.1, (1 - progress) / 0.1);
  const flap = REDUCED_MOTION || Math.floor(time * 4) % 2 ? 'gull_up' : 'gull_down';
  const y = point.y + (REDUCED_MOTION ? 0 : Math.sin(time * 3) * 1.5);
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(point.x, 0);
  if (headingX(shape, progress) < 0) ctx.scale(-1, 1);
  drawSprite(ctx, flap, 0, y + 4, 24);
  ctx.restore();
  // The one it is flying to, carried underneath.
  ctx.save();
  ctx.globalAlpha *= alpha;
  face(target.icon_id, point.x, y + 12, 14);
  ctx.restore();
  return { x: point.x, y: y + 4, r: 22, guide: target.post };
}
