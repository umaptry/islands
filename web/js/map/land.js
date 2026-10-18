// Is a spot on the map land or sea? The one answer lines.js (which stretch of a
// route is a road for cars and which is water for boats) and decor.js (the
// ornamental boats keep off the islands) share.
//
// The ground is the one terrain.js draws: every post adds a cone of energy
// (groundOf, coast wobble included), highest at the post and falling to nothing
// at its reach, and where the sum reaches the beach threshold there is land.
// `cells` is the coarse layer a saturated map has instead of posts in the dense
// parts; its cones are plain circles, as in terrain.js.

import { config, energyOf, radiusOf } from '../config.js';
import { groundOf } from './coast.js';

// The coarse layer's cell size (ENERGY_CELL_SIZE, as in terrain.js).
export const CELL_SIZE = 20;

const NO_CELLS = [];
const NO_CONES = [];
const conesCache = new WeakMap();

/** The coarse cells as plain cones [x, y, energy, radius]. Kept per cells array
 * (and reach factor), as the list only changes when the map fetches. */
export function conesOf(cells) {
  if (!cells || !cells.length) return NO_CONES;
  const { radius_base: base, radius_scale: rate, radius_trim: trim, radius_factor: factor = 1 } = config().energy;
  const held = conesCache.get(cells);
  if (held && held.factor === factor && held.length === cells.length) return held.cones;
  const cones = [];
  cells.forEach((cell) => {
    const energy = Number(cell.sum_energy) || 0;
    const radius = (base + energy * rate) * trim * factor;
    if (!(energy > 0) || !(radius > 0)) return;
    cones.push([(cell.cell_x + 0.5) * CELL_SIZE, (cell.cell_y + 0.5) * CELL_SIZE, energy, radius]);
  });
  conesCache.set(cells, { factor, length: cells.length, cones });
  return cones;
}

/** The posts that can matter inside a box (world coordinates): those whose circle
 * touches it (the coast only ever shortens the reach, never past the radius). */
export function postsNear(posts, lo, hi) {
  const near = [];
  posts.forEach((post) => {
    const radius = radiusOf(post);
    if (!(energyOf(post) > 0) || !(radius > 0)) return;
    if (post.x < lo[0] - radius || post.x > hi[0] + radius
      || post.y < lo[1] - radius || post.y > hi[1] + radius) return;
    near.push(post);
  });
  return near;
}

/** The cones whose circle touches the box. */
export function conesNear(cones, lo, hi) {
  return cones.filter(([x, y, , radius]) => !(x < lo[0] - radius || x > hi[0] + radius
    || y < lo[1] - radius || y > hi[1] + radius));
}

/** The summed ground at (x, y) from the given posts and cones. */
export function groundSum(posts, cones, x, y) {
  let sum = 0;
  for (const post of posts) sum += groundOf(post, x, y);
  for (const [cx, cy, energy, radius] of cones) {
    const distance = Math.hypot(x - cx, y - cy);
    if (distance < radius) sum += energy * (1 - distance / radius);
  }
  return sum;
}

export const beachThreshold = () => config().energy.biome_thresholds.desert;

/** Is (x, y) land? One spot; for a few per frame (a line is sampled with
 * sampleLand). `cells` is the coarse layer, or none. */
export function isLandAt(posts, cells, x, y) {
  const spot = [x, y];
  const near = postsNear(posts, spot, spot);
  return groundSum(near, conesNear(conesOf(cells || NO_CELLS), spot, spot), x, y) >= beachThreshold();
}

// A line is sampled every STEP world units (so a thin strip of land is not
// skipped on a long line), at least MIN_SAMPLES and at most MAX_SAMPLES points.
const STEP = 4;
const MIN_SAMPLES = 12;
const MAX_SAMPLES = 260;

/** For each of the evenly spaced samples along the line from `from` to `to`:
 * is it land? The line is straight, or, with `bendTo` (the control point of a
 * quadratic curve, as lines.js draws a sea route), bowed through it: the stretches
 * must be found along the way the route is drawn, or its road would run past the
 * shore by the width of the bow. */
export function sampleLand(posts, from, to, cells = NO_CELLS, bendTo = null) {
  const beach = beachThreshold();
  const pts = bendTo ? [from, to, bendTo] : [from, to];
  const lo = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))];
  const hi = [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  const near = postsNear(posts, lo, hi);
  const cones = conesNear(conesOf(cells), lo, hi);
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const samples = Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.ceil(length / STEP)));
  const land = [];
  for (let i = 0; i < samples; i += 1) {
    const t = (i + 0.5) / samples;
    const u = 1 - t;
    const x = bendTo
      ? u * u * from[0] + 2 * u * t * bendTo[0] + t * t * to[0]
      : from[0] + (to[0] - from[0]) * t;
    const y = bendTo
      ? u * u * from[1] + 2 * u * t * bendTo[1] + t * t * to[1]
      : from[1] + (to[1] - from[1]) * t;
    land.push(groundSum(near, cones, x, y) >= beach);
  }
  return land;
}

/** Does the line run over land between its two ends? The stretch still on the
 * first end's land and the stretch already on the last end's land are the line
 * leaving and reaching its own shore, so they do not count; any land between them
 * (another island, or a bay of the ends' own coast) does, and so does a line with
 * no open water on it at all. */
export function blockedBy(land) {
  const samples = land.length;
  let first = 0;
  while (first < samples && land[first]) first += 1;
  if (first === samples) return true;
  let last = samples - 1;
  while (land[last]) last -= 1;
  return land.slice(first, last + 1).some(Boolean);
}

/** The stretches of a line, as [{ from, to, land }] with from and to in 0..1
 * along it, in order and touching. Where the flags flip, the boundary sits
 * halfway between the two samples. */
export function runsOf(land) {
  const n = land.length;
  const runs = [];
  let start = 0;
  for (let i = 1; i <= n; i += 1) {
    if (i < n && land[i] === land[start]) continue;
    runs.push({ from: start === 0 ? 0 : start / n, to: i === n ? 1 : i / n, land: land[start] });
    start = i;
  }
  return runs;
}

/** The same stretches walked from the other end. */
export function reverseRuns(runs) {
  return runs.map(({ from, to, land }) => ({ from: 1 - to, to: 1 - from, land })).reverse();
}

/** Is the spot `t` (0..1) along the line on land? */
export function landAtRuns(runs, t) {
  for (const run of runs) if (t < run.to) return run.land;
  return runs.length ? runs[runs.length - 1].land : false;
}

/** How much of a car and how much of a boat to draw at `t`, [car, boat], each 0
 * to 1: a car on the land stretches, a boat on the water ones, and across a
 * boundary (`fade` wide in t, centred on it) one fading out as the other comes in. */
export function mixAt(runs, t, fade) {
  let car = 0;
  let boat = 0;
  const half = Math.max(1e-6, fade) / 2;
  for (const run of runs) {
    // How much of the window [t - half, t + half] lies inside this stretch.
    const inside = Math.max(0, Math.min(run.to, t + half) - Math.max(run.from, t - half));
    const share = Math.min(1, inside / (half * 2));
    if (run.land) car += share; else boat += share;
  }
  // Beyond the line's ends the window is empty: keep the shares adding up to 1.
  const total = car + boat;
  return total > 0 ? [car / total, boat / total] : [0, 0];
}
