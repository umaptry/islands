// The ground of map plan B (2026-10-31), after prototype F.
//
// One community is one island whose outline is fixed (island-b.js). The island
// starts as forest; every post opens the ground round it (a soft round mound of
// "openness"), and where several overlap the opening passes the village line
// and becomes a square of bare earth. Same steps, colours, trees and reef as
// the old ground (prototype E).
//
// Prototype F was drawn in units 2.5 times smaller than the production world.
// Distances are therefore kept in the prototype's units wherever a constant of
// the prototype is used (`/ K` on the way in), and sigma, grid steps and the
// like are the prototype's numbers times K.

import { coastAt as islandCoastAt, coastLow, coastWithPosts, extentB, forestMode, islandBView, memoNoise } from './island-b.js';
import { coastLines } from './surf.js';
import { ROAD_STEP, roadCurve } from './roads-b.js';

const K = 2.5;
const CLEAR_CELL = 5;          // world units of the openness grid
const TREE_STEP = 1.9;         // prototype units: 4.75 world
const ROCK_STEP = 15;          // world units
const TREE_LIMIT = 20000;      // more than this and the grid is widened

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const hash = (x, y) => { const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return n - Math.floor(n); };
function ih(x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = ih(xi, yi);
  const b = ih(xi + 1, yi);
  const c = ih(xi, yi + 1);
  const d = ih(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
// noise() that remembers its last lattice cell (island-b.js memoNoise): the same numbers, for the calls a
// pixel row makes one after another.
const shoreNoise = memoNoise();
const deepNoise = memoNoise();
const bumpNoise = memoNoise();
const bumpFine = memoNoise();
const mixR = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

// ---- bands. 0 sea, 1 shallows, 2 sand, 3 village square, 4 grass, 5 forest, 6 deep forest.
export const COLORS = {
  sea: 0x1d88c7, shallow: 0x3ea7d0, sand: 0xe3c98b, square: 0xd2bd86, grass: 0x9cbb5e, forest: 0x5c9f48, deep: 0x4d8a40,
};
const RGB = [COLORS.sea, COLORS.shallow, COLORS.sand, COLORS.square, COLORS.grass, COLORS.forest, COLORS.deep].map(hex);
const HEIGHT = [0, 0, 1, 2, 3, 4, 5];
const VILLAGE = 1.7;
const OPEN = 0.32;
const WHITE = [255, 255, 255];
const FOAM = [240, 251, 255];
const SHADE = [24, 46, 86];
const STEP = 0.5;
const BUMP = 2;
const SUN = (() => { const v = [-0.36, -0.49, 0.79]; const n = Math.hypot(...v); return v.map((x) => x / n); })();

// The "mass" forest is one raised block: it throws a shadow to the bottom-right
// (world units, how far), as the trees and houses do.
const MASS_SHADOW = 4.5;
const SCALLOP = 0.08;   // openness either side of the forest's edge where the crowns make it bumpy
// One house opens about half as far as sigmaFor alone would (2026-11-04, the user: the clearing round one
// new house was too wide), but never so little that its yard (homestead.js, up to about 14 world units
// out) would stand on the forest.
const POST_CLEAR = 0.5;
const POST_CLEAR_MIN = 9;
// No standing tree this close to the shore (prototype units of coast distance): on the grass strip by
// the beach they looked out of place (2026-11-04, the user). The sand ends at 2.4.
const SHORE_TREE = 7;
const massStyle = () => (forestMode() === 'mass' ? { shadow: MASS_SHADOW } : null);

/** How wide one post opens the forest: wide while posts are few, narrower as
 * they grow, so the forest never runs out. */
export function sigmaFor(total) {
  return clamp(27.5 * Math.sqrt(40 / Math.max(1, total)), 11.25, 30);
}

/** Which band at a point, from the coast distance `c` (world units) and the
 * openness `o`. (xp, yp) are the prototype's coordinates, for its noise. */
function classify(c, o, xp, yp) {
  const cp = c / K;
  if (cp < -9) return 0;
  if (cp < 0) return 1;
  if (cp < 2.4) return 2;
  if (o > VILLAGE) return 3;
  if (o > OPEN || cp < 4.2 + shoreNoise(xp * 0.3, yp * 0.3) * 2.5) return 4;
  if (cp > 22 && deepNoise(xp * 0.045 + 3.1, yp * 0.045 + 7.7) > 0.58 && o < 0.08) return 6;
  return 5;
}

/** With a mass style the forest's edge follows the crowns: near the edge only
 * the tops of the crowns stay forest, so the edge is a row of round bumps. */
function scallop(b, c, o, xp, yp) {
  if ((b !== 4 && b !== 5) || Math.abs(o - OPEN) >= SCALLOP) return b;
  if (c / K < 4.2 + shoreNoise(xp * 0.3, yp * 0.3) * 2.5) return b;   // the grass along the shore stays
  const edge = (o - (OPEN - SCALLOP)) / (2 * SCALLOP);           // 0 forest side, 1 grass side
  return crownAt(xp, yp).h / 1.3 > edge * 1.1 - 0.05 ? 5 : 4;
}

// Map B's roads: the pairs who met, laid into the ground (index.js syncRoadsB hands them in through
// islandBView().roads as [ax, ay, bx, by, tier]).
// A road grows with the pair's strength (2026-11-05, the user: a wide road cut through the forest at
// once was too much): tier 1 a track that only just opens the forest, tier 2 a footpath with a little
// clearing, tier 3 the road with the forest well back. A track drawn over the canopy looked like a path
// on the treetops (the user), so it shows only where the forest has opened.
const ROAD_OPEN = 0.62;        // openness on a road's line: grass, below a village's square (VILLAGE)
const ROAD_OPEN_SIGMA = [0, 4, 5, 10];  // world units the forest steps back either side, by tier
// TRIAL (?trail=): a, a thin cut all along; b, small gaps in the forest one after another, like dots.
const trailStyle = () => (islandBView().trail === 'b' ? 'b' : 'a');
const TRAIL_GAP_OPEN = 1;      // b: openness in the middle of a gap (OPEN is 0.32)
const TRAIL_GAP_SIGMA = 6;     // b: world units, how wide one gap opens
const TRAIL_GAP_EVERY = 6;     // b: one gap every this many of the curve's points (ROAD_STEP apart)
// a: the canopy's faces are 10 world units (POLY), too coarse for a thin cut, so the track is cut into the
// canopy pixel by pixel instead: the forest falls to the track's edge. The side towards the viewer (south)
// falls gently enough that the track shows past it (less than 1 / LIFT), the far side steeply.
const TRAIL_WALL_NEAR = 1.3;   // world units of height per world unit of distance, south of the track
const TRAIL_WALL_FAR = 3;      // north of it
const TRAIL_CUT_REACH = 17;    // world units: past this the forest is untouched (the tallest canopy, 20, over the near slope)
// Thinner than at first (2026-11-05, the user: a grown road need not be this wide).
const ROAD_HALF = [0, 0.8, 0.95, 1.5];  // world units: half the path's width, by tier
// On the relief the forest is the ground, so it is not opened along a road: a grass verge only, a
// quarter of the road's width each side (2026-11-05, the user).
const ROAD_VERGE = 0.25;
const TRAIL_WOBBLE = 2.2;      // world units a tier-1 track wanders either side of the curve
// The grass between a village's houses (makeGround).
const VILLAGE_LINK_OPEN = 0.75;   // openness on the link's line: grass (OPEN 0.32), not a square (VILLAGE)
const VILLAGE_LINK_SIGMA = 7;     // world units the grass reaches either side
const roadTier = (points) => Math.min(3, Math.max(1, points.tier | 0));

/** A tier-1 track wanders: its points pushed to and fro across the curve, the same every time. */
function wander(points) {
  const out = points.map(([x, y], p) => {
    const [ax, ay] = points[Math.max(0, p - 1)];
    const [bx, by] = points[Math.min(points.length - 1, p + 1)];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    // None at the two ends, so the track still starts and ends at the houses.
    const ends = Math.min(1, p / 3, (points.length - 1 - p) / 3);
    const off = (noise(p * 0.45 + points[0][0] * 0.01, points[0][1] * 0.01) - 0.5) * 2 * TRAIL_WOBBLE * ends;
    return [x - ((by - ay) / len) * off, y + ((bx - ax) / len) * off];
  });
  out.tier = points.tier;
  return out;
}

/** The roads' curves ([[x, y], ...] each, roads-b.js roadCurve) that come near a box, with their tier. */
function roadsIn(minX, minY, maxX, maxY) {
  const list = islandBView().roads;
  if (!Array.isArray(list) || !list.length) return [];
  const reach = ROAD_OPEN_SIGMA[3] * 3 + TRAIL_WOBBLE + ROAD_STEP;
  const out = [];
  list.forEach(([ax, ay, bx, by, tier]) => {
    if (Math.max(ax, bx) < minX - reach || Math.min(ax, bx) > maxX + reach) return;
    if (Math.max(ay, by) < minY - reach || Math.min(ay, by) > maxY + reach) return;
    const points = roadCurve({ x: ax, y: ay }, { x: bx, y: by });
    points.tier = tier || 1;
    out.push(roadTier(points) === 1 ? wander(points) : points);
  });
  return out;
}

/** The openness grid for a region, and the band function that reads it. */
function makeGround({ posts, total, minX, minY, maxX, maxY, coastAt, bumpy = false }) {
  const sigma = Math.max(sigmaFor(total) * POST_CLEAR, POST_CLEAR_MIN);
  const reach = sigma * 3;
  let cs = CLEAR_CELL;
  const at0 = (v) => Math.floor((v - 2 * cs) / cs) * cs;
  let gx0 = at0(minX);
  let gy0 = at0(minY);
  while (((maxX + 2 * cs - gx0) / cs) * ((maxY + 2 * cs - gy0) / cs) > 4e6) {
    cs *= 2;
    gx0 = at0(minX);
    gy0 = at0(minY);
  }
  const nx = Math.ceil((maxX + 2 * cs - gx0) / cs) + 1;
  const ny = Math.ceil((maxY + 2 * cs - gy0) / cs) + 1;
  const open = new Float32Array(nx * ny);
  const add = (px, py, w, sig) => {
    const r = Math.ceil((sig * 3) / cs);
    const ci = Math.floor((px - gx0) / cs);
    const cj = Math.floor((py - gy0) / cs);
    const den = 2 * sig * sig;
    for (let j = Math.max(0, cj - r); j <= Math.min(ny - 1, cj + r); j += 1) {
      const wy = gy0 + (j + 0.5) * cs;
      for (let i = Math.max(0, ci - r); i <= Math.min(nx - 1, ci + r); i += 1) {
        const wx = gx0 + (i + 0.5) * cs;
        open[j * nx + i] += w * Math.exp(-((wx - px) ** 2 + (wy - py) ** 2) / den);
      }
    }
  };
  for (const p of posts) {
    if (p.x < minX - reach || p.x > maxX + reach || p.y < minY - reach || p.y > maxY + reach) continue;
    add(p.x, p.y, 1, sigma);
  }
  // The roads (islandBView().roads): a band of open ground along each, so the forest steps back from it.
  // The strongest of post and road counts, not their sum, or a road would swell every village it joins.
  const roads = roadsIn(minX, minY, maxX, maxY);
  roads.forEach((points) => {
    const tier = roadTier(points);
    const gaps = tier === 1 && trailStyle() === 'b';
    if (tier === 1 && !gaps) return;   // a: cut into the canopy in computeB, not opened here
    if (reliefOn()) return;              // the relief: a verge painted in computeB instead
    const sig = gaps ? TRAIL_GAP_SIGMA : ROAD_OPEN_SIGMA[tier];
    const peak = gaps ? TRAIL_GAP_OPEN : ROAD_OPEN;
    const r = Math.ceil((sig * 3) / cs);
    const den = 2 * sig * sig;
    const best = new Map();
    const centres = gaps ? points.filter((_, p) => p % TRAIL_GAP_EVERY === 2) : points;
    centres.forEach(([px, py]) => {
      const ci = Math.floor((px - gx0) / cs);
      const cj = Math.floor((py - gy0) / cs);
      for (let j = Math.max(0, cj - r); j <= Math.min(ny - 1, cj + r); j += 1) {
        const wy = gy0 + (j + 0.5) * cs;
        for (let i = Math.max(0, ci - r); i <= Math.min(nx - 1, ci + r); i += 1) {
          const wx = gx0 + (i + 0.5) * cs;
          const v = peak * Math.exp(-((wx - px) ** 2 + (wy - py) ** 2) / den);
          const k = j * nx + i;
          if (v > (best.get(k) || 0)) best.set(k, v);
        }
      }
    });
    best.forEach((v, k) => { if (v > open[k]) open[k] = v; });
  });
  // The grass runs between a village's houses (index.js syncVillagesB).
  const links = islandBView().villageLinks;
  if (Array.isArray(links) && links.length) {
    const r = Math.ceil((VILLAGE_LINK_SIGMA * 3) / cs);
    const den = 2 * VILLAGE_LINK_SIGMA * VILLAGE_LINK_SIGMA;
    links.forEach(([ax, ay, bx, by]) => {
      if (Math.max(ax, bx) < minX - reach || Math.min(ax, bx) > maxX + reach) return;
      if (Math.max(ay, by) < minY - reach || Math.min(ay, by) > maxY + reach) return;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 2));
      const best = new Map();
      for (let s = 0; s <= steps; s += 1) {
        const px = ax + ((bx - ax) * s) / steps;
        const py = ay + ((by - ay) * s) / steps;
        const ci = Math.floor((px - gx0) / cs);
        const cj = Math.floor((py - gy0) / cs);
        for (let j = Math.max(0, cj - r); j <= Math.min(ny - 1, cj + r); j += 1) {
          const wy = gy0 + (j + 0.5) * cs;
          for (let i = Math.max(0, ci - r); i <= Math.min(nx - 1, ci + r); i += 1) {
            const wx = gx0 + (i + 0.5) * cs;
            const v = VILLAGE_LINK_OPEN * Math.exp(-((wx - px) ** 2 + (wy - py) ** 2) / den);
            const k = j * nx + i;
            if (v > (best.get(k) || 0)) best.set(k, v);
          }
        }
      }
      best.forEach((v, k) => { if (v > open[k]) open[k] = v; });
    });
  }

  const gridAt = (x, y) => {
    const fx = clamp((x - gx0) / cs - 0.5, 0, nx - 1.001);
    const fy = clamp((y - gy0) / cs - 0.5, 0, ny - 1.001);
    const i = fx | 0;
    const j = fy | 0;
    const u = fx - i;
    const v = fy - j;
    const k = j * nx + i;
    return (open[k] * (1 - u) + open[k + 1] * u) * (1 - v) + (open[k + nx] * (1 - u) + open[k + nx + 1] * u) * v;
  };
  const openNoise = memoNoise();
  const opennessAt = (x, y) => gridAt(x, y) * (0.78 + 0.44 * openNoise((x / K) * 0.16, (y / K) * 0.16));
  const bandAt = (x, y, c = coastAt(x, y)) => {
    if (c / K < 0) return classify(c, 0, 0, 0);
    const o = opennessAt(x, y);
    const b = classify(c, o, x / K, y / K);
    return bumpy ? scallop(b, c, o, x / K, y / K) : b;
  };
  return { sigma, opennessAt, bandAt };
}

// The forest as one canopy of crowns: each a small dome on a jittered grid, in
// prototype units. Only its edge is read (scallop): where the crowns make it bumpy.
function crownAt(x, y) {
  const G = 1.9;
  const gi = Math.floor(x / G);
  const gj = Math.floor(y / G);
  let best = 9;
  for (let dj = -1; dj <= 1; dj += 1) {
    for (let di = -1; di <= 1; di += 1) {
      const a = gi + di;
      const b = gj + dj;
      const px = (a + 0.5) * G + (ih(a, b) - 0.5) * 1.3;
      const py = (b + 0.5) * G + (ih(b + 101, a) - 0.5) * 1.3;
      const r = 1.2 * (0.85 + 0.35 * ih(a + 7, b));
      const dx = x - px;
      const dy = y - py;
      // Far from the best so far: no need for hypot's last digit.
      if (Math.sqrt(dx * dx + dy * dy) / r > best * (1 + 1e-9) + 1e-12) continue;
      const d = Math.hypot(dx, dy) / r;
      if (d < best) best = d;
    }
  }
  return { h: best < 1 ? Math.sqrt(1 - best * best) * 1.3 : 0 };
}
// Where the conifers grow. Turned and given a finer second layer: plain value
// noise has edges along the grid, which showed as straight lines in the canopy.
const pineAt = (x, y) => {
  const u = x * 0.866 - y * 0.5;
  const v = x * 0.5 + y * 0.866;
  return 0.5 + (noise(u * 0.035 + 11, v * 0.035 + 4) - 0.5) * 0.85 + (noise(u * 0.11 + 3.7, v * 0.11 + 8.3) - 0.5) * 0.35;
};

// The mass forest as one low-poly solid, lit face by face as the tree objects
// are (mesh.js): its edge and its steps are slopes, not walls.
const POLY = 10;   // world units between the corners of its faces
// [rise from the grass, each step, top roughness] (world units)
const POLY_H = [13, 7, 0.6];
// Seen at the objects' angle (mesh.js, 52 degrees): a point h high is drawn h * cos(52) further up.
const LIFT = Math.cos((52 * Math.PI) / 180);

// The relief (2026-11-05, the user: a track drawn over the canopy made the island look solid, so the
// canopy could be the ground itself): the whole island is the raised low-poly ground, never cut down;
// villages, squares and roads are painted onto its faces and lifted with them, and so is everything
// standing on it (index.js lifts what it draws by reliefLift).
// The ground is the canopy's kind of surface (2026-11-05, the user: terraces were too strong, and the
// grass painted up a sheer riser looked wrong; as smooth as the forest now): low-poly faces POLY apart
// over a gentle roll, so what is painted on it lies on faces that are never steep.
// The shore as the first relief had it (2026-11-06, the user, after a tilt and a step up from the sand:
// the beach and the grass by it were best at first): the land rises from the grass strip, the same all
// round. The north third is a tableland instead of a tilt (the tilt made the north shore shoot up): a
// slope along its southern edge, and from the shore it rises gently. Higher at the back, so seen from
// the south it hides nothing.
const RELIEF_BASE = 12;      // world units: the ground inland, over the shore
// Slower than at first (2026-11-06, the user: rising over 2.5 the land stood up from the strip as a dark wall).
const RELIEF_SHORE_RAMP = 8; // prototype units of coast distance over which the land rises from the grass strip
const RELIEF_ROLL = 18;      // world units: the broad roll up and down across the island
const PLATEAU = 28;         // world units: the tableland over the ground south of it
const PLATEAU_EDGE = 0.34;   // its edge, half way up its slope: this share of the island's height from the north
const PLATEAU_SLOPE = 35;    // world units: how wide the slope is
const PLATEAU_FLAT = 0.5;    // the roll on its top, this much of elsewhere's: a table, not more hills
const PLATEAU_WANDER = 40;   // world units: how far the edge wanders north and south
const PLATEAU_SHORE = 28;    // prototype units of coast distance over which it rises from the shore: gently
                             // enough that, seen from the south, the north shore's slope hides nothing
const RELIEF_MAX = 48;       // the highest the ground goes (strips: rows to compute below)
const RELIEF_LIGHT = 1.3;    // the faces' light and shade, this many times the canopy's
// Trees along a grown road, a little back from its verge (2026-11-05, the user); a quarter as many as at
// first (2026-11-06, the user: too many).
const ROAD_TREE_EVERY = 5.5;   // world units along the road between two places a tree may stand
const ROAD_TREE_BACK = 2.4;    // world units from the verge's edge to the tree
const ROAD_TREE_SHARE = 0.14;  // of those places, this many have a tree
const smoothstep = (t) => t * t * (3 - 2 * t);
function reliefShape(x, y, c) {
  if (c < 0) return 0;
  const xp = x / K;
  const yp = y / K;
  const inland = c / K - 4.2 - noise(xp * 0.3, yp * 0.3) * 2.5;
  const base = clamp(inland / RELIEF_SHORE_RAMP, 0, 1);
  const roll = (noise(xp * 0.045 + 11.3, yp * 0.045 + 4.7) - 0.5) * RELIEF_ROLL;
  const rough = (noise(xp * 0.2 + 5.1, yp * 0.2 + 1.3) - 0.5) * 3;
  let table = 0;
  const ext = extentB();
  if (ext) {
    const edge = ext.minY + PLATEAU_EDGE * (ext.maxY - ext.minY) + (noise(xp * 0.015 + 2.9, 8.1) - 0.5) * 2 * PLATEAU_WANDER;
    table = smoothstep(clamp((edge - y) / PLATEAU_SLOPE + 0.5, 0, 1)) * smoothstep(clamp(inland / PLATEAU_SHORE, 0, 1));
  }
  return Math.max(0, base * (RELIEF_BASE + roll * (1 - (1 - PLATEAU_FLAT) * table) + rough) + PLATEAU * table);
}
// The default since 2026-11-07 (the user: houses and roads were to be drawn on the raised ground, not
// cut into the forest); ?relief=0 shows the flat ground again.
export const reliefOn = () => islandBView().relief !== '0' && forestMode() === 'mass';
const FLAT_GROUND = { opennessAt: () => 0 };
// The height is asked for by every house, tree and walker each frame, and finding a point's face is slow:
// it is kept on a grid a world unit apart and read between the grid's corners (the faces are POLY apart,
// so this is all but exact).
const RELIEF_GRID_PAD = 60;  // world units around the island's extent
let reliefKept = { key: null, at: null };
function reliefGrid(exact) {
  const ext = extentB();
  if (!ext) return (x, y) => exact(x, y).h;
  const x0 = Math.floor(ext.minX - RELIEF_GRID_PAD);
  const y0 = Math.floor(ext.minY - RELIEF_GRID_PAD);
  const nx = Math.ceil(ext.maxX + RELIEF_GRID_PAD) - x0 + 2;
  const ny = Math.ceil(ext.maxY + RELIEF_GRID_PAD) - y0 + 2;
  const kept = new Float32Array(nx * ny).fill(NaN);
  const corner = (i, j) => {
    const k = j * nx + i;
    let v = kept[k];
    if (v !== v) { v = exact(x0 + i, y0 + j).h; kept[k] = v; }
    return v;
  };
  return (x, y) => {
    const fx = x - x0;
    const fy = y - y0;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    if (!(i >= 0 && j >= 0 && i < nx - 1 && j < ny - 1)) return 0;   // out at sea (the sea's marks ask too)
    const u = fx - i;
    const v = fy - j;
    return (corner(i, j) * (1 - u) + corner(i + 1, j) * u) * (1 - v) + (corner(i, j + 1) * (1 - u) + corner(i + 1, j + 1) * u) * v;
  };
}
/** The height of the relief ground at a point (world units, 0 on the shore), on the main thread: the
 * same faces as computeB's. */
export function reliefHeight(x, y) {
  const key = islandBView().communityKey;
  if (reliefKept.key !== key || !reliefKept.at) {
    reliefKept = { key, at: reliefGrid(polyForest(FLAT_GROUND, coastLow, POLY, POLY_H, reliefShape)) };
  }
  return reliefKept.at(x, y) || 0;
}
/** How far up the screen something standing at (x, y) is drawn, in world units. */
export const reliefLift = (x, y) => (reliefOn() ? reliefHeight(x, y) * LIFT : 0);
const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const srgb = (c) => 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.min(1, c) ** (1 / 2.4) - 0.055);
const FLAT_LIT = 0.5 + 0.16 + 0.85 * SUN[2];
function polyForest(ground, coastAt, s, [H1, H2, rough], custom = null) {
  const heightAt = custom ? (x, y) => custom(x, y, coastAt(x, y)) : (x, y) => {
    const c = coastAt(x, y);
    if (c < 0) return 0;
    const xp = x / K;
    const yp = y / K;
    const cp = c / K;
    const o = ground.opennessAt(x, y);
    const base = Math.min(clamp((cp - 4.2 - noise(xp * 0.3, yp * 0.3) * 2.5) / 2.5, 0, 1), clamp((OPEN - o) / 0.06, 0, 1));
    const cn = cp + (noise(xp * 0.15 + 6.6, yp * 0.15 + 3.8) - 0.5) * 4;
    const steps = Math.min(clamp((0.17 - o) / 0.05, 0, 1) + clamp((0.06 - o) / 0.03, 0, 1), clamp((cn - 11) / 3, 0, 1) + clamp((cn - 19) / 3, 0, 1));
    return base * H1 + steps * H2 + (noise(xp * 0.2 + 5.1, yp * 0.2 + 1.3) - 0.5) * rough * base;
  };
  const corners = new Map();
  const corner = (a, b) => {
    const key = (a + 50000) * 100000 + (b + 50000);
    let v = corners.get(key);
    if (!v) {
      const x = (a + b * 0.5) * s + (ih(a + 91, b + 17) - 0.5) * s * 0.35;
      const y = b * s * 0.866 + (ih(b + 53, a + 29) - 0.5) * s * 0.35;
      v = [x, y, heightAt(x, y)];
      corners.set(key, v);
    }
    return v;
  };
  const faces = new Map();
  let lastKey = NaN;   // the face asked for last: the next pixel is nearly always in it
  let lastFace = null;
  const face = (i, j, up) => {
    const key = ((i + 50000) * 100000 + (j + 50000)) * 2 + (up ? 1 : 0);
    if (key === lastKey) return lastFace;
    let f = faces.get(key);
    if (!f) {
      const P = up ? [corner(i, j), corner(i + 1, j), corner(i, j + 1)] : [corner(i + 1, j + 1), corner(i, j + 1), corner(i + 1, j)];
      const e1 = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]];
      const e2 = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
      let nv = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const len = Math.hypot(...nv) || 1;
      nv = nv.map((q) => q / len);
      if (nv[2] < 0) nv = nv.map((q) => -q);
      const lit = 0.5 + 0.16 * nv[2] + 0.85 * Math.max(0, nv[0] * SUN[0] + nv[1] * SUN[1] + nv[2] * SUN[2]);
      const cx = (P[0][0] + P[1][0] + P[2][0]) / 3 / K;
      const cy = (P[0][1] + P[1][1] + P[2][1]) / 3 / K;
      const area = e1[0] * e2[1] - e2[0] * e1[1];
      f = {
        P, area, ratio: lit / FLAT_LIT,
        pine: clamp((pineAt(cx, cy) - 0.52) / 0.22 + 0.3, 0, 1),
        tone: (ih(i * 2 + (up ? 1 : 0) + 7, j + 313) - 0.5) * (rough < 1 ? 0.02 : 0.06),
      };
      faces.set(key, f);
    }
    lastKey = key;
    lastFace = f;
    return f;
  };
  const inside = (f, x, y) => {
    const [A, B, C] = f.P;
    const w1 = ((x - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (y - A[1])) / f.area;
    const w2 = ((B[0] - A[0]) * (y - A[1]) - (x - A[0]) * (B[1] - A[1])) / f.area;
    const w0 = 1 - w1 - w2;
    return w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6 ? A[2] * w0 + B[2] * w1 + C[2] * w2 : null;
  };
  const found = { f: null, h: 0 };   // one object for every answer: the caller reads it at once
  return (x, y) => {
    const v = y / (s * 0.866);
    const u = x / s - v * 0.5;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const up = (u - i) + (v - j) < 1;
    let f = face(i, j, up);
    let h = inside(f, x, y);
    for (let dj = -1; h === null && dj <= 1; dj += 1) {
      for (let di = -1; h === null && di <= 1; di += 1) {
        for (const q of [true, false]) {
          const g = face(i + di, j + dj, q);
          const hh = inside(g, x, y);
          if (hh !== null) { f = g; h = hh; break; }
        }
      }
    }
    found.f = f;
    found.h = h === null ? 0 : h;
    return found;
  };
}

/** Distance in pixels from the nearest set pixel of `mask` (chamfer 1/1.414). */
function distanceFrom(mask, width, height) {
  const far = 1e6;
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i += 1) out[i] = mask[i] ? 0 : far;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      let v = out[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, out[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, out[i - width] + 1);
        if (x > 0) v = Math.min(v, out[i - width - 1] + 1.414);
        if (x < width - 1) v = Math.min(v, out[i - width + 1] + 1.414);
      }
      out[i] = v;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      let v = out[i];
      if (v === 0) continue;
      if (x < width - 1) v = Math.min(v, out[i + 1] + 1);
      if (y < height - 1) {
        v = Math.min(v, out[i + width] + 1);
        if (x < width - 1) v = Math.min(v, out[i + width + 1] + 1.414);
        if (x > 0) v = Math.min(v, out[i + width - 1] + 1.414);
      }
      out[i] = v;
    }
  }
  return out;
}

/** Anti-aliasing for a texture shown at about its own size (as terrain.js). */
function smoothEdges(pixels, width, height) {
  const source = pixels.slice();
  const same = new Uint32Array(source.buffer, source.byteOffset, width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const v = same[i];
      if (v === same[i + 1] && v === same[i - 1] && v === same[i + width] && v === same[i - width]) continue;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = -width; dy <= width; dy += width) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const at = (i + dy + dx) * 4;
          const w = source[at + 3];
          r += source[at] * w;
          g += source[at + 1] * w;
          b += source[at + 2] * w;
          a += w;
        }
      }
      const at = i * 4;
      if (a === 0) continue;
      pixels[at] = r / a;
      pixels[at + 1] = g / a;
      pixels[at + 2] = b / a;
      pixels[at + 3] = a / 9;
    }
  }
}

const grounds = new WeakMap();   // computeB's result -> what scatterTreesB needs

/**
 * Plan B's ground, in the shape of terrain.js's compute(): { pixels, field,
 * minX, minY, scale, width, height, coast }. `field` is the OPENNESS of the
 * ground (0 on water), not a sum of cones; whether a point is land is
 * island-b.js's isLandB. `cells` (the coarse layer) is not used: plan B draws
 * every post.
 */
export function computeB({ posts, region, scale, unit, padding, limit, smooth = false, surf = false, groundBox = null }) {
  const minX = region.minX - padding;
  const minY = region.minY - padding;
  const spanX = (region.maxX - region.minX) + padding * 2;
  const spanY = (region.maxY - region.minY) + padding * 2;
  if (spanX <= 0 || spanY <= 0) return null;
  const fit = Math.min(1, limit / (Math.max(spanX, spanY) * unit));
  const scaled = unit * fit;
  const width = Math.max(1, Math.round(spanX * scaled));
  const height = Math.max(1, Math.round(spanY * scaled));
  const n = width * height;

  // A post stands on land however the coast is shaken: guarded in this calculation only.
  const coastAt = coastWithPosts(posts);
  const total = islandBView().postTotal || posts.length;
  const style = massStyle();
  // The ground's openness grid and the roads are made for `groundBox` when one is given (a strip of the picture, computeBStrip): the whole picture's, so that a strip sees what the whole would.
  const gbox = groundBox || { minX, minY, maxX: minX + spanX, maxY: minY + spanY };
  const ground = makeGround({ posts, total, minX: gbox.minX, minY: gbox.minY, maxX: gbox.maxX, maxY: gbox.maxY, coastAt, bumpy: !!style });
  const mass = forestMode() === 'mass';

  const wpp = 1 / scaled;          // world units per texture pixel
  const wppP = wpp / K;            // the same in prototype units
  const band = new Int8Array(n);
  const cst = new Float32Array(n);
  const field = new Float32Array(n);
  const bump = new Float32Array(n);
  const lit = new Float32Array(n);
  const crown = mass ? new Float32Array(n).fill(-1) : null;   // 0 where the forest is, -1 elsewhere
  const tone = mass ? new Float32Array(n) : null;
  const pine = mass ? new Float32Array(n) : null;
  for (let j = 0; j < height; j += 1) {
    const wy = minY + (j + 0.5) * wpp;
    for (let i = 0; i < width; i += 1) {
      const wx = minX + (i + 0.5) * wpp;
      const k = j * width + i;
      const c = coastAt(wx, wy);
      cst[k] = c;
      const xp = wx / K;
      const yp = wy / K;
      let b;
      if (c < 0) {
        b = c / K < -9 ? 0 : 1;
      } else {
        const o = ground.opennessAt(wx, wy);
        field[k] = o;
        b = classify(c, o, xp, yp);
        if (style && !reliefOn()) b = scallop(b, c, o, xp, yp);
      }
      band[k] = b;
      if (b >= 2) {
        bump[k] = (bumpNoise(xp * 0.22, yp * 0.22) - 0.5) * 1.2 + (bumpFine(xp * 0.7 + 17.3, yp * 0.7 + 5.1) - 0.5) * 0.18;
        // The low-poly forest gives every forest pixel its own tone and conifer mix
        // below, and the light is its faces': only "forest here" is read.
        if (mass && b >= 5) crown[k] = 0;
      }
    }
  }
  // Where the low-poly solid stands above the grass is forest; its faces' light per pixel.
  let polyF = null;
  let polyH = null;
  const relief = mass && reliefOn();
  if (relief) {
    // The relief: every land pixel takes the height and the light of the ground's face; the bands stay
    // as the openness made them, painted on.
    // Its height from the coast with the low raise (island-b.js coastLow): a cape stays low.
    const at = polyForest(FLAT_GROUND, coastWithPosts(posts, { low: true }), POLY, POLY_H, reliefShape);
    polyF = new Float32Array(n);
    polyH = new Float32Array(n);
    for (let j = 0; j < height; j += 1) {
      const wy = minY + (j + 0.5) * wpp;
      for (let i = 0; i < width; i += 1) {
        const k = j * width + i;
        if (band[k] < 2) continue;
        const { f, h } = at(minX + (i + 0.5) * wpp, wy);
        polyH[k] = Math.max(0, h);
        polyF[k] = Math.max(0.3, 1 + (f.ratio - 1) * RELIEF_LIGHT);
        pine[k] = f.pine; tone[k] = f.tone;
      }
    }
  } else if (mass) {
    const at = polyForest(ground, coastAt, POLY, POLY_H);
    polyF = new Float32Array(n);
    polyH = new Float32Array(n);
    for (let j = 0; j < height; j += 1) {
      const wy = minY + (j + 0.5) * wpp;
      for (let i = 0; i < width; i += 1) {
        const k = j * width + i;
        if (band[k] < 4) continue;
        const { f, h } = at(minX + (i + 0.5) * wpp, wy);
        if (h > 0.5) { band[k] = 5; polyF[k] = f.ratio; polyH[k] = h; pine[k] = f.pine; tone[k] = f.tone; } else band[k] = 4;
      }
    }
  }
  // a: the tracks cut into the canopy (TRAIL_WALL_*): its height capped by the distance to the track.
  if (mass && !relief && trailStyle() === 'a') {
    roadsIn(gbox.minX, gbox.minY, gbox.maxX, gbox.maxY).filter((points) => roadTier(points) === 1).forEach((points) => {
      const half = ROAD_HALF[1];
      const reach = half + TRAIL_CUT_REACH;
      for (let p = 1; p < points.length; p += 1) {
        const [ax, ay] = points[p - 1];
        const [bx, by] = points[p];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy || 1;
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - minX) * scaled));
        const i1 = Math.min(width - 1, Math.ceil((Math.max(ax, bx) + reach - minX) * scaled));
        const j0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - minY) * scaled));
        const j1 = Math.min(height - 1, Math.ceil((Math.max(ay, by) + reach - minY) * scaled));
        for (let j = j0; j <= j1; j += 1) {
          const wy = minY + (j + 0.5) * wpp;
          for (let i = i0; i <= i1; i += 1) {
            const k = j * width + i;
            if (band[k] < 5) continue;
            const wx = minX + (i + 0.5) * wpp;
            const t = clamp(((wx - ax) * dx + (wy - ay) * dy) / len2, 0, 1);
            const ex = wx - (ax + dx * t);
            const ey = wy - (ay + dy * t);
            const d = Math.hypot(ex, ey);
            if (d >= reach) continue;
            const slope = TRAIL_WALL_FAR + (TRAIL_WALL_NEAR - TRAIL_WALL_FAR) * clamp(ey / (d || 1), 0, 1);
            const cap = Math.max(0, d - half) * slope;
            if (polyH[k] <= cap) continue;
            polyH[k] = cap;
            if (cap <= 0.5) band[k] = 4;
          }
        }
      }
    });
  }
  // The roads themselves. Tiers 2 and 3: the open ground of a village's square (band 3), a step below
  // the grass, the footpath still half grown over. Tier 1: a worn line on the grass where the forest has
  // opened, none on the canopy.
  const path = new Uint8Array(n);
  roadsIn(gbox.minX, gbox.minY, gbox.maxX, gbox.maxY).forEach((points) => {
    const tier = roadTier(points);
    const half = ROAD_HALF[tier];
    const verge = relief && tier > 1 ? half * 2 * ROAD_VERGE : 0;
    const reach = half + verge;
    for (let p = 1; p < points.length; p += 1) {
      const [ax, ay] = points[p - 1];
      const [bx, by] = points[p];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - minX) * scaled));
      const i1 = Math.min(width - 1, Math.ceil((Math.max(ax, bx) + reach - minX) * scaled));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - minY) * scaled));
      const j1 = Math.min(height - 1, Math.ceil((Math.max(ay, by) + reach - minY) * scaled));
      for (let j = j0; j <= j1; j += 1) {
        const wy = minY + (j + 0.5) * wpp;
        for (let i = i0; i <= i1; i += 1) {
          const k = j * width + i;
          if (band[k] < 4) continue;   // the sea, the beach and the squares stay as they are
          const wx = minX + (i + 0.5) * wpp;
          const t = clamp(((wx - ax) * dx + (wy - ay) * dy) / len2, 0, 1);
          const ex = wx - (ax + dx * t);
          const ey = wy - (ay + dy * t);
          // A little wobble on the edge, like the villages' ground.
          const edge = half * (0.85 + 0.3 * noise(wx / K * 0.9 + 3.3, wy / K * 0.9 + 8.1));
          const d2 = ex * ex + ey * ey;
          if (d2 > edge * edge) {
            if (verge && band[k] >= 5 && d2 <= (edge + verge) * (edge + verge)) band[k] = 4;
            continue;
          }
          if (tier === 1) {
            if (band[k] === 4 || relief) path[k] = 1;
          } else {
            band[k] = 3;
            path[k] = tier;
          }
        }
      }
    }
  });
  const g = 1 / (2 * wppP);
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const k = j * width + i;
      if (band[k] < 2) { lit[k] = 1; continue; }
      const bx = (bump[k + (i < width - 1 ? 1 : 0)] - bump[k - (i > 0 ? 1 : 0)]) * g;
      const by = (bump[k + (j < height - 1 ? width : 0)] - bump[k - (j > 0 ? width : 0)]) * g;
      lit[k] = 1 + clamp(-(bx * SUN[0] + by * SUN[1]) * 0.25 * BUMP, -0.08, 0.08);
      if (mass && crown[k] >= 0) lit[k] = 1;
    }
  }

  // The forest as one raised block: it throws a shadow to the bottom-right, as the trees and houses do.
  let shadeAt = null;
  if (style && !relief) {
    const top = new Uint8Array(n);
    for (let k = 0; k < n; k += 1) top[k] = band[k] >= 5 ? 1 : 0;
    const toTop = distanceFrom(top, width, height);
    const sx = 0.82 * style.shadow * scaled;
    const sy = 0.57 * style.shadow * scaled;
    const shadowSteps = Math.ceil(Math.hypot(sx, sy));
    const reach = shadowSteps + 1;
    shadeAt = new Float32Array(n);
    for (let j = 0; j < height; j += 1) {
      for (let i = 0; i < width; i += 1) {
        const k = j * width + i;
        if (top[k] || band[k] < 2 || toTop[k] > reach) continue;
        for (let t = 1; t <= shadowSteps; t += 1) {
          const f = t / shadowSteps;
          const ii = Math.round(i - sx * f);
          const jj = Math.round(j - sy * f);
          if (ii < 0 || jj < 0) break;
          const q = jj * width + ii;
          if (top[q]) { shadeAt[k] = 0.4 * (1 - 0.5 * f); break; }
        }
      }
    }
  }

  // The distance to the land, for the foam and for the surf lines (surf.js).
  const landMask = new Uint8Array(n);
  for (let k = 0; k < n; k += 1) landMask[k] = band[k] >= 2 ? 1 : 0;
  const toLand = distanceFrom(landMask, width, height);

  const perScreen = scaled / (scale || 1);
  const k1 = Math.max(0.25, perScreen);
  const foam = Math.max(1.5, 2.6 * k1);
  const ringFrom = foam + 2.2 * k1;
  const ringTo = ringFrom + 1.4 * k1;
  const lx = Math.max(1, Math.round(1.2 * k1));
  const ly = Math.max(1, Math.round(1.8 * k1));
  const shelf = mixR(RGB[0], RGB[1], 0.45);
  const ring = mixR(RGB[1], WHITE, 0.18);
  const shelfEdge = -15;           // world units: the shelf is darker beyond this
  const outer = -9 * K;            // the sea begins here

  const pixels = new Uint8ClampedArray(n * 4);
  let memoPine = NaN;
  let memoTone = NaN;
  let memoLit = NaN;
  let memoRgb = null;
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const k = j * width + i;
      const b = band[k];
      const c = cst[k];
      const at = k * 4;
      let rgb;
      let alpha = 255;
      if (b >= 2) {
        rgb = RGB[b];
        if (mass && b >= 5) {
          const tn = tone[k];
          if (pine[k] === memoPine && tn === memoTone && polyF[k] === memoLit) {
            rgb = memoRgb;   // the same face as the pixel before it (a face is hundreds of pixels): the same colour
          } else {
            rgb = mixR(RGB[5], [58, 122, 70], pine[k]);
            rgb = tn > 0 ? mixR(rgb, WHITE, tn) : mixR(rgb, SHADE, -tn);
            rgb = rgb.map((q) => Math.round(srgb(lin(q) * polyF[k])));
            memoPine = pine[k]; memoTone = tn; memoLit = polyF[k]; memoRgb = rgb;
          }
        }
        if (path[k] === 1) {
          rgb = mixR(RGB[4], RGB[3], 0.3);   // the track: grass a little worn
        } else if (path[k] === 2) {
          rgb = mixR(RGB[3], RGB[4], 0.45);
        }
        // The relief: what is painted on the ground takes its face's light.
        if (relief && b < 5) rgb = rgb.map((q) => Math.round(srgb(lin(q) * polyF[k])));
        const hOf = (q) => (mass && q >= 5 ? HEIGHT[4] : HEIGHT[q]);   // no deep-forest step
        const h = hOf(b);
        if (i >= lx && j >= ly && !relief) {
          const above = hOf(band[k - ly * width - lx]);
          if (above > h) rgb = mixR(rgb, SHADE, 0.16 * STEP * 2);                 // a higher step's shadow
          else if (above < h && b >= 3) rgb = mixR(rgb, WHITE, 0.10 * STEP * 2);  // lit top-left rim
        }
        if (!relief && i < width - lx && j < height - ly && hOf(band[k + ly * width + lx]) < h && b >= 3) {
          rgb = mixR(rgb, [rgb[0] * 0.8, rgb[1] * 0.82, rgb[2] * 0.82], STEP);
        }
        const f = mass && b >= 5 ? 1 : b === 2 ? 1 + (lit[k] - 1) * 0.5 : lit[k];
        rgb = [rgb[0] * f, rgb[1] * f, rgb[2] * f];
        if (shadeAt && shadeAt[k] > 0) rgb = mixR(rgb, SHADE, shadeAt[k]);
      } else if (toLand[k] <= foam) {
        rgb = FOAM;
      } else if (b === 1) {
        rgb = c < shelfEdge ? mixR(shelf, RGB[1], clamp((c - outer) / (shelfEdge - outer), 0, 1)) : RGB[1];
        if (toLand[k] >= ringFrom && toLand[k] <= ringTo && c >= shelfEdge) rgb = ring;
        alpha = Math.min(255, Math.round(clamp((c - outer) / K, 0, 1) * 255));
      } else {
        pixels[at + 3] = 0;   // open sea: the canvas below shows through
        continue;
      }
      pixels[at] = rgb[0];
      pixels[at + 1] = rgb[1];
      pixels[at + 2] = rgb[2];
      pixels[at + 3] = alpha;
    }
  }
  // Where the forest shows on the picture, for the trees: none stands where it would look grown on it.
  const cover = new Uint8Array(n);
  for (let k = 0; k < n; k += 1) cover[k] = band[k] >= 5 ? 1 : 0;
  if (mass) {
    // Front to back in each column: a raised point covers the rows up to where it is drawn.
    const src = pixels.slice();
    const lift = LIFT * scaled;
    for (let i = 0; i < width; i += 1) {
      let ymin = height;
      for (let j = height - 1; j >= 0; j -= 1) {
        const k = j * width + i;
        const p = Math.max(0, j - Math.round(polyH[k] * lift));
        if (p >= ymin) continue;
        for (let y = p; y < ymin; y += 1) {
          const at = (y * width + i) * 4;
          pixels[at] = src[k * 4]; pixels[at + 1] = src[k * 4 + 1]; pixels[at + 2] = src[k * 4 + 2]; pixels[at + 3] = src[k * 4 + 3];
          cover[y * width + i] = band[k] >= 5 ? 1 : 0;
        }
        ymin = p;
      }
    }
  }
  if (smooth) smoothEdges(pixels, width, height);
  const coast = surf ? coastLines(toLand, width, height, { perScreen, perWorld: scaled, minX, minY, scale: scale || 1, world: true }) : null;
  const built = { pixels, field, minX, minY, scale: scaled, width, height, coast };
  grounds.set(built, { ground, mass, coastAt, cover });
  return built;
}

// ---- the sharp texture in strips (2026-11-02)
//
// The sharp close-up is one big picture, and on a phone it took seconds to
// make. It can be made as horizontal strips by several workers at once and put
// together on the page: computeBStrip makes the rows [from, to) of exactly the
// picture computeB would make, by computing a few more rows above and below
// (what the lift, the shadows, the foam and the smoothing read from their
// neighbours) and cutting them off. The surf is traced across the whole
// picture, so surfB makes it on its own (it only needs where the land is).

/** The size computeB gives a texture (the same arithmetic), or null if empty. */
function frameB({ region, padding, unit, limit }) {
  const minX = region.minX - padding;
  const minY = region.minY - padding;
  const spanX = (region.maxX - region.minX) + padding * 2;
  const spanY = (region.maxY - region.minY) + padding * 2;
  if (spanX <= 0 || spanY <= 0) return null;
  const fit = Math.min(1, limit / (Math.max(spanX, spanY) * unit));
  const scaled = unit * fit;
  return {
    minX, minY, spanX, spanY, scaled,
    width: Math.max(1, Math.round(spanX * scaled)),
    height: Math.max(1, Math.round(spanY * scaled)),
  };
}

/** Only the mass forest, whose picture is made pixel by pixel from the ground, can be made in strips. */
const stripOk = () => forestMode() === 'mass';

/** How many rows above and below a strip it needs computed too. */
function stripPad(frame, scale) {
  const perScreen = frame.scaled / (scale || 1);
  const k1 = Math.max(0.25, perScreen);
  const foam = Math.max(1.5, 2.6 * k1);
  const ringTo = foam + 2.2 * k1 + 1.4 * k1;
  const ly = Math.max(1, Math.round(1.8 * k1));
  const shadowRows = Math.ceil(0.57 * MASS_SHADOW * frame.scaled) + 2;
  const high = reliefOn() ? RELIEF_MAX : POLY_H[0] + POLY_H[1] + POLY_H[2] * 0.5;
  const lift = Math.ceil(high * LIFT * frame.scaled) + 1;
  const near = Math.ceil(ringTo) + ly + shadowRows + 6;
  return { top: near, bottom: near + lift };
}

const LAND_COST = 3;   // a row of land costs about this many rows of sea to make

/**
 * How to cut the sharp texture into `parts` strips: { width, height, minX, minY,
 * scale, strips: [{ from, to }, ...] } (rows), or null when it must be made in
 * one piece (not this kind of ground, or too small to be worth it).
 */
export function stripsB({ region, scale, unit, padding = 0, limit, parts }) {
  const frame = frameB({ region, padding, unit, limit });
  if (!stripOk() || !frame) return null;
  const pad = stripPad(frame, scale);
  // A strip is only worth it if its extra rows cost no more than the strip itself.
  const count = Math.max(1, Math.min(parts, Math.floor(frame.height / (pad.top + pad.bottom))));
  if (count < 2) return null;
  // Cut where the work is shared evenly: land (forest) costs several times what
  // the open sea does, so equal heights would leave one worker with most of it.
  const block = 16;
  const blocks = Math.ceil(frame.height / block);
  const weight = new Float64Array(blocks);
  let total = 0;
  for (let q = 0; q < blocks; q += 1) {
    const wy = frame.minY + (q * block + Math.min(block, frame.height - q * block) / 2) / frame.scaled;
    let land = 0;
    for (let t = 0; t < 12; t += 1) if (islandCoastAt(frame.minX + ((t + 0.5) / 12) * frame.spanX, wy) >= 0) land += 1;
    weight[q] = (1 + (LAND_COST - 1) * (land / 12)) * Math.min(block, frame.height - q * block);
    total += weight[q];
  }
  const cuts = [0];
  let seen = 0;
  let q = 0;
  for (let s = 1; s < count; s += 1) {
    const goal = (total * s) / count;
    while (q < blocks && seen + weight[q] < goal) { seen += weight[q]; q += 1; }
    const rows = Math.min(block, frame.height - q * block);
    const at = q * block + (q < blocks ? Math.round(((goal - seen) / weight[q]) * rows) : 0);
    cuts.push(Math.max(cuts[cuts.length - 1] + 1, Math.min(frame.height - (count - s), at)));
  }
  cuts.push(frame.height);
  const strips = [];
  for (let s = 0; s < count; s += 1) strips.push({ from: cuts[s], to: cuts[s + 1] });
  return { width: frame.width, height: frame.height, minX: frame.minX, minY: frame.minY, scale: frame.scaled, strips };
}

/** Rows [from, to) of what computeB makes for the same options: { pixels (those
 * rows only), width, height: to - from, rowFrom, minX, minY (of the first
 * row), scale }. */
export function computeBStrip({ posts, region, scale, unit, padding, limit, smooth = false }, from, to) {
  const frame = frameB({ region, padding, unit, limit });
  if (!stripOk() || !frame) return null;
  const pad = stripPad(frame, scale);
  const wpp = 1 / frame.scaled;
  const a = Math.max(0, from - pad.top);
  const b = Math.min(frame.height, to + pad.bottom);
  // The same pixels, as a smaller window: same x range, same pixel size.
  const built = computeB({
    posts,
    region: { minX: frame.minX, maxX: frame.minX + frame.spanX, minY: frame.minY + a * wpp, maxY: frame.minY + b * wpp },
    scale, unit: frame.scaled, padding: 0, limit: Infinity, smooth,
    groundBox: { minX: frame.minX, minY: frame.minY, maxX: frame.minX + frame.spanX, maxY: frame.minY + frame.spanY },
  });
  if (!built || built.width !== frame.width || built.height !== b - a) throw new Error('strip does not fit');
  const row = frame.width * 4;
  return {
    pixels: built.pixels.slice((from - a) * row, (to - a) * row),
    width: frame.width, height: to - from, rowFrom: from,
    minX: frame.minX, minY: frame.minY + from * wpp, scale: frame.scaled,
  };
}

/** The surf lines computeB would trace (`coast`), without making the picture: the
 * land is where the coast distance is not negative. */
export function surfB({ posts, region, scale, unit, padding, limit }) {
  const frame = frameB({ region, padding, unit, limit });
  if (!frame) return null;
  const { minX, minY, scaled, width, height } = frame;
  const coastAt = coastWithPosts(posts);
  const wpp = 1 / scaled;
  const land = new Uint8Array(width * height);
  for (let j = 0; j < height; j += 1) {
    const wy = minY + (j + 0.5) * wpp;
    for (let i = 0; i < width; i += 1) land[j * width + i] = coastAt(minX + (i + 0.5) * wpp, wy) >= 0 ? 1 : 0;
  }
  const toLand = distanceFrom(land, width, height);
  const perScreen = scaled / (scale || 1);
  return coastLines(toLand, width, height, { perScreen, perWorld: scaled, minX, minY, scale: scale || 1, world: true });
}

// ---- trees and rocks
const cellNoise = (gx, gy, salt) => {
  let h = (Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663) ^ Math.imul(salt, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/**
 * Trees and rocks for a ground computeB made; the same shape as terrain.js's
 * scatterTrees: [{ x, y, name: 'tree' | 'pine' | 'rock', k, wet? }], back to
 * front. Returns null for a ground that computeB did not make.
 *
 * "grove" (default): trees one by one, conifers and broadleaves each in their
 * own patches. "mass": the canopy is already in the pixels; trees stand only on
 * the forest's rim and, here and there, on the grass beside it. The grid is
 * prototype F's 1.9 (4.75 world), widened if it would give over TREE_LIMIT.
 */
export function scatterTreesB(built) {
  const made = grounds.get(built);
  if (!made) return null;
  const { ground, mass, coastAt, cover } = made;
  const { minX, minY, width, height, scale } = built;
  const ext = extentB();
  let x0 = minX;
  let y0 = minY;
  let x1 = minX + width / scale;
  let y1 = minY + height / scale;
  if (ext) {
    x0 = Math.max(x0, ext.minX);
    y0 = Math.max(y0, ext.minY);
    x1 = Math.min(x1, ext.maxX);
    y1 = Math.min(y1, ext.maxY);
  }
  const bandP = (xp, yp) => ground.bandAt(xp * K, yp * K);
  const near = mass ? (xp, yp, d) => [[d, 0], [-d, 0], [0, d], [0, -d], [d * 0.7, d * 0.7], [-d * 0.7, -d * 0.7]].map(([u, v]) => bandP(xp + u, yp + v)) : null;

  // A tree on the grass whose foot, or the ground just below it, is drawn as forest would look grown on
  // the forest (2026-11-02, the user: those south of a clearing). Its crown over the forest behind is fine.
  const onForest = (x, y) => {
    const i = Math.floor((x - minX) * scale);
    const j = Math.floor((y - minY) * scale);
    return i >= 0 && j >= 0 && i < width && j < height && cover[j * width + i] === 1;
  };
  const reachesForest = (x, y, size) => {
    const r = 2.2 * size;   // about the crown's half-width (index.js: TREE_WORLD x TREE_B / 2), a little less
    return [[0, 0], [-r, 0], [r, 0], [0, r * 0.5], [-r * 0.7, r * 0.4], [r * 0.7, r * 0.4]].some(([u, v]) => onForest(x + u, y + v));
  };
  const trees = [];
  const place = (step) => {
    trees.length = 0;
    for (let gj = Math.floor(y0 / K / step); gj * step * K < y1; gj += 1) {
      for (let gi = Math.floor(x0 / K / step); gi * step * K < x1; gi += 1) {
        const gx = gi * step;
        const gy = gj * step;
        const xp = gx + (hash(gx, gy) - 0.5) * 1.6 * (step / TREE_STEP);
        const yp = gy + (hash(gy, gx) - 0.5) * 1.6 * (step / TREE_STEP);
        const x = xp * K;
        const y = yp * K;
        if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
        const b = ground.bandAt(x, y);
        if (b < 4) continue;
        const grove = noise(xp * 0.09 + 5, yp * 0.09 + 9);
        let dens;
        if (mass) {
          const around = near(xp, yp, 2.6);
          // The canopy is raised: no tree stands on its rim, only on the grass beside it.
          dens = b >= 5 ? 0 : around.some((q) => q >= 5) ? 0.12 : 0.015;
        } else {
          dens = b === 6 ? 0.92 : b === 5 ? 0.4 + 0.55 * grove : 0.02 + 0.06 * (grove > 0.6);
        }
        if (hash(xp * 3.1, yp * 7.7) > dens) continue;
        if (coastAt(x, y) / K < SHORE_TREE) continue;
        const k = 0.85 + hash(xp, yp * 2) * 0.7;
        if (mass && reachesForest(x, y, k)) continue;
        const isPine = pineAt(xp, yp) + (b === 6 ? 0.18 : 0) + (hash(xp * 5, yp) - 0.5) * 0.1 > 0.55;
        trees.push({ x, y, name: isPine ? 'pine' : 'tree', k });
      }
    }
  };
  let step = TREE_STEP;
  place(step);
  for (let tries = 0; trees.length > TREE_LIMIT && tries < 4; tries += 1) {
    step *= Math.sqrt(trees.length / TREE_LIMIT) * 1.02;
    place(step);
  }
  // The relief: trees along the grown roads, a little back from the verge on either side.
  if (mass && reliefOn()) {
    roadsIn(x0, y0, x1, y1).forEach((points) => {
      const tier = roadTier(points);
      if (tier < 2) return;
      const back = ROAD_HALF[tier] * (1 + 2 * ROAD_VERGE) + ROAD_TREE_BACK;
      let run = 0;
      for (let p = 1; p < points.length; p += 1) {
        const [ax, ay] = points[p - 1];
        const [bx, by] = points[p];
        const len = Math.hypot(bx - ax, by - ay) || 1;
        run += len;
        if (run < ROAD_TREE_EVERY) continue;
        run = 0;
        const nx = -(by - ay) / len;
        const ny = (bx - ax) / len;
        for (const side of [-1, 1]) {
          const seed = hash(bx * 0.37 + side, by * 0.53);
          if (seed > ROAD_TREE_SHARE) continue;
          const off = back + hash(by, bx * side) * 1.2;
          const along = (seed / ROAD_TREE_SHARE - 0.5) * 1.1;   // a little forward or back of the place
          const x = bx + nx * off * side + ((bx - ax) / len) * along;
          const y = by + ny * off * side + ((by - ay) / len) * along;
          if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
          if (ground.bandAt(x, y) < 4) continue;
          if (coastAt(x, y) / K < SHORE_TREE) continue;
          const xp = x / K;
          const yp = y / K;
          trees.push({ x, y, name: pineAt(xp, yp) > 0.55 ? 'pine' : 'tree', k: 0.85 + hash(xp, yp * 2) * 0.5 });
        }
      }
    });
  }

  // Rocks: in the near shallows and on the sand.
  for (let gj = Math.floor(y0 / ROCK_STEP); gj * ROCK_STEP < y1; gj += 1) {
    for (let gi = Math.floor(x0 / ROCK_STEP); gi * ROCK_STEP < x1; gi += 1) {
      const x = (gi + cellNoise(gi, gj, 11)) * ROCK_STEP;
      const y = (gj + cellNoise(gi, gj, 12)) * ROCK_STEP;
      if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
      const cp = coastAt(x, y) / K;
      const wet = cp < -1.5 && cp > -8;
      const sand = cp > 0.3 && cp < 2.2;
      if (!wet && !sand) continue;
      if (cellNoise(gi, gj, 13) > (wet ? 0.47 : 0.14)) continue;
      const k = wet ? 0.7 + cellNoise(gi, gj, 14) * 1.1 : 0.8 + cellNoise(gi, gj, 14) * 1.4;
      trees.push(wet ? { x, y, name: 'rock', k, wet: true } : { x, y, name: 'rock', k });
    }
  }
  return trees.sort((a, b) => a.y - b.y);
}
