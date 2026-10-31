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

import { coastWithPosts, extentB, forestMode, islandBView, startB } from './island-b.js';
import { coastLines } from './surf.js';

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
  if (o > OPEN || cp < 4.2 + noise(xp * 0.3, yp * 0.3) * 2.5) return 4;
  if (cp > 22 && noise(xp * 0.045 + 3.1, yp * 0.045 + 7.7) > 0.58 && o < 0.08) return 6;
  return 5;
}

/** The openness grid for a region, and the band function that reads it. */
function makeGround({ posts, total, minX, minY, maxX, maxY, coastAt }) {
  const sigma = sigmaFor(total);
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
  const start = startB();
  if (start) add(start.x, start.y, 2.6, 6.5 * K);

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
  const opennessAt = (x, y) => gridAt(x, y) * (0.78 + 0.44 * noise((x / K) * 0.16, (y / K) * 0.16));
  const bandAt = (x, y, c = coastAt(x, y)) => (c / K < 0 ? classify(c, 0, 0, 0) : classify(c, opennessAt(x, y), x / K, y / K));
  return { sigma, opennessAt, bandAt };
}

// The forest as one canopy of crowns (forest "mass"): each a small dome on a
// jittered grid, in prototype units.
function crownAt(x, y) {
  const G = 1.9;
  const gi = Math.floor(x / G);
  const gj = Math.floor(y / G);
  let best = 9;
  let tone = 0;
  for (let dj = -1; dj <= 1; dj += 1) {
    for (let di = -1; di <= 1; di += 1) {
      const a = gi + di;
      const b = gj + dj;
      const px = (a + 0.5) * G + (ih(a, b) - 0.5) * 1.3;
      const py = (b + 0.5) * G + (ih(b + 101, a) - 0.5) * 1.3;
      const r = 1.2 * (0.85 + 0.35 * ih(a + 7, b));
      const d = Math.hypot(x - px, y - py) / r;
      if (d < best) { best = d; tone = ih(a + 3, b + 5); }
    }
  }
  return { h: best < 1 ? Math.sqrt(1 - best * best) * 1.3 : 0, tone };
}
const pineAt = (x, y) => noise(x * 0.035 + 11, y * 0.035 + 4);

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
export function computeB({ posts, region, scale, unit, padding, limit, smooth = false, surf = false }) {
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
  const ground = makeGround({ posts, total, minX, minY, maxX: minX + spanX, maxY: minY + spanY, coastAt });
  const mass = forestMode() === 'mass';

  const wpp = 1 / scaled;          // world units per texture pixel
  const wppP = wpp / K;            // the same in prototype units
  const band = new Int8Array(n);
  const cst = new Float32Array(n);
  const field = new Float32Array(n);
  const bump = new Float32Array(n);
  const lit = new Float32Array(n);
  const crown = mass ? new Float32Array(n).fill(-1) : null;
  const tone = mass ? new Float32Array(n) : null;
  const pine = mass ? new Uint8Array(n) : null;
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
      }
      band[k] = b;
      if (b >= 2) {
        bump[k] = (noise(xp * 0.22, yp * 0.22) - 0.5) * 1.2 + (noise(xp * 0.7 + 17.3, yp * 0.7 + 5.1) - 0.5) * 0.18;
        if (mass && b >= 5) {
          const cr = crownAt(xp, yp);
          crown[k] = cr.h;
          tone[k] = (cr.tone - 0.5) * 0.14;
          pine[k] = pineAt(xp, yp) + (b === 6 ? 0.18 : 0) > 0.55 ? 1 : 0;
        }
      }
    }
  }
  const g = 1 / (2 * wppP);
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const k = j * width + i;
      if (band[k] < 2) { lit[k] = 1; continue; }
      const bx = (bump[k + (i < width - 1 ? 1 : 0)] - bump[k - (i > 0 ? 1 : 0)]) * g;
      const by = (bump[k + (j < height - 1 ? width : 0)] - bump[k - (j > 0 ? width : 0)]) * g;
      lit[k] = 1 + clamp(-(bx * SUN[0] + by * SUN[1]) * 0.25 * BUMP, -0.08, 0.08);
      if (mass && crown[k] >= 0) {
        const at = (q) => (crown[q] >= 0 ? crown[q] : 0);
        const cx = (at(k + (i < width - 1 ? 1 : 0)) - at(k - (i > 0 ? 1 : 0))) * g;
        const cy = (at(k + (j < height - 1 ? width : 0)) - at(k - (j > 0 ? width : 0))) * g;
        lit[k] = (1 + clamp(-(cx * SUN[0] + cy * SUN[1]) * 0.5, -0.24, 0.24)) * (crown[k] > 0 ? 1 : 0.84);
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
          rgb = pine[k] ? [58, 122, 70] : RGB[5];
          rgb = tn > 0 ? mixR(rgb, WHITE, tn) : mixR(rgb, SHADE, -tn);
        }
        const h = HEIGHT[b];
        if (i >= lx && j >= ly) {
          const above = HEIGHT[band[k - ly * width - lx]];
          if (above > h) rgb = mixR(rgb, SHADE, 0.16 * STEP * 2);                 // a higher step's shadow
          else if (above < h && b >= 3) rgb = mixR(rgb, WHITE, 0.10 * STEP * 2);  // lit top-left rim
        }
        if (i < width - lx && j < height - ly && HEIGHT[band[k + ly * width + lx]] < h && b >= 3) {
          rgb = mixR(rgb, [rgb[0] * 0.8, rgb[1] * 0.82, rgb[2] * 0.82], STEP);
        }
        const f = b === 2 ? 1 + (lit[k] - 1) * 0.5 : lit[k];
        rgb = [rgb[0] * f, rgb[1] * f, rgb[2] * f];
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
  if (smooth) smoothEdges(pixels, width, height);
  const coast = surf ? coastLines(toLand, width, height, { perScreen, perWorld: scaled, minX, minY, scale: scale || 1 }) : null;
  const built = { pixels, field, minX, minY, scale: scaled, width, height, coast };
  grounds.set(built, { ground, mass, coastAt });
  return built;
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
  const { ground, mass, coastAt } = made;
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
  const start = startB();
  const bandP = (xp, yp) => ground.bandAt(xp * K, yp * K);
  const near = mass ? (xp, yp, d) => [[d, 0], [-d, 0], [0, d], [0, -d], [d * 0.7, d * 0.7], [-d * 0.7, -d * 0.7]].map(([u, v]) => bandP(xp + u, yp + v)) : null;

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
          dens = b >= 5 ? (around.some((q) => q < 5) ? 0.55 : 0) : around.some((q) => q >= 5) ? 0.22 : 0.015;
        } else {
          dens = b === 6 ? 0.92 : b === 5 ? 0.4 + 0.55 * grove : 0.02 + 0.06 * (grove > 0.6);
        }
        if (hash(xp * 3.1, yp * 7.7) > dens) continue;
        if (start && Math.hypot(start.x - x, start.y - y) < 5 * K) continue;
        const k = 0.85 + hash(xp, yp * 2) * 0.7;
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
