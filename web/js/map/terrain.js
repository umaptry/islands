// The ground, built the way islands built it.
//
// Every post contributes a cone of energy - highest at the post, falling
// linearly to nothing at its influence radius, which reaches a little less far
// in some directions (coast.js) - and the cones are ADDED. The
// sum at each point decides what that point is made of: shallows, desert,
// savanna, plains, forest, mountain. Two quiet posts side by side make plains
// out of what either alone would leave as desert, which is the whole mechanism.
// A crowd of people writing about the same thing does not make a bigger dot; it
// makes a continent.
//
// What is different here is only what is underneath. islands placed its posts
// with Math.random(), so its continents were decoration. These coordinates come
// out of the frozen encoder, so two posts are close because the two people wrote
// about the same thing - and the ground that grows between them means it.
//
// Rebuilt when the posts change or the camera has moved far enough, never per
// frame: the field costs a few tens of milliseconds and the result is a texture
// the render loop just blits.

import { config, energyOf, radiusOf } from '../config.js';
import { coastOf, reachFrom, reachTable } from './coast.js';

// Texture resolution, in device pixels per world unit, and the ceiling on the
// texture itself. 1400 covers a phone at 3x without ever allocating something a
// low-end device will refuse.
const MIN_UNIT = 0.6;
const MAX_UNIT = 2.4;
const MAX_TEXTURE = 1400;
const PADDING = 24;   // world units of margin, so a coastline is never clipped

let cache = null;
let pending = null;   // { revision, unit, cells, region } of a ground being built elsewhere

function hexToRgb(hex) {
  const value = parseInt(String(hex).replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

let palette = null;

function bands() {
  if (palette) return palette;
  const { biome_order: order, biome_thresholds: thresholds, biome_colors: colors } =
    config().energy;
  // Paired as [upper bound, colour]: below `shallow` is open sea and gets no
  // pixels at all, and the last band has no upper bound.
  palette = {
    floor: thresholds.shallow,
    steps: order.map((name, index) => ({
      name,
      // Each band runs up to the threshold of the NEXT one. `shallow` runs from
      // the sea floor up to `desert`, and so on; `mountain` runs to infinity.
      limit: index + 1 < order.length ? thresholds[order[index + 1]] : Infinity,
      rgb: hexToRgb(colors[name]),
    })),
  };
  return palette;
}

function bandOf(energy) {
  const { floor, steps } = bands();
  if (energy < floor) return -1;
  for (let index = 0; index < steps.length; index += 1) {
    if (energy < steps[index].limit) return index;
  }
  return steps.length - 1;
}

const smooth01 = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

// The game-board look: cel steps rather than gradients, and the sand meeting the
// shallows through a line of surf. (There was a brown outline round the land and
// a brown cliff under every southern coast; both read as a strip of mud between
// the beach and the water, and were taken out on 2026-10-12.)
const WHITE = [255, 255, 255];
const FOAM = [240, 251, 255];
const SHADE = [24, 46, 86];

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

/**
 * Turn the summed field into pixels.
 *
 * The thresholds still decide everything - which band a point is, where the
 * coast is - so the ground means exactly what it did. What this adds is only
 * how it is drawn: water in three steps (open sea shows through, then the shelf,
 * then the bright shallows), foam on the coast, and light from the top-left in
 * three flat steps.
 *
 * `perScreen` is texture pixels per CSS pixel, so lines keep their on-screen
 * width at every zoom; `perWorld` is texture pixels per world unit, so the
 * slope that decides light and shade is measured in the field's own units.
 */
function paint(pixels, field, width, height, { perScreen, perWorld }) {
  const { floor, steps } = bands();
  const sea = hexToRgb(config().energy.biome_colors.sea);
  const shallow = steps[0].rgb;
  const shelf = mix(sea, shallow, 0.45);
  const ring = mix(shallow, WHITE, 0.4);
  const shelfLimit = steps[0].limit * 0.35;
  const k = Math.max(0.25, perScreen);
  const foam = Math.max(1.5, 2.6 * k);
  const ringFrom = foam + 2.2 * k;
  const ringTo = ringFrom + 1.4 * k;
  // Design 05: light from the top-left, so land throws a soft shadow to the
  // bottom-right onto the water (its mask read from up-left), and a higher band
  // throws a small one onto the lower band beside it (the "lift").
  // Not while the texture is stretched (perScreen < 0.3): a 2 px floor would be
  // a 15 px shadow on screen, and it would jump when the sharp texture arrives.
  const lit = perScreen >= 0.3;
  const dropX = lit ? Math.max(1, Math.round(5 * perScreen)) : 0;
  const dropY = lit ? Math.max(1, Math.round(6.5 * perScreen)) : 0;
  const rim = 14 * k;   // texture px over which a slope's light and shade fade out from the band edge
  const liftX = Math.max(1, Math.round(1.2 * k));
  const liftY = Math.max(1, Math.round(1.8 * k));

  const n = width * height;
  const band = new Int8Array(n);
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    band[i] = bandOf(field[i]);
    land[i] = band[i] >= 1 ? 1 : 0;
  }

  const toLand = distanceFrom(land, width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const at = i * 4;
      let rgb;
      let alpha = 255;

      if (land[i]) {
        const own = band[i];
        rgb = steps[own].rgb;
        if (own >= 2 && x > 0 && y > 0 && x < width - 1 && y < height - 1) {
          // Slope towards the bottom-right, per world unit. Ground rising away
          // from the light faces it. It shows only close to the band's lower edge
          // (a rim of a few px), and fades in smoothly: a hard threshold made a
          // sharp diagonal split of every wide slope when zoomed right in.
          const gx = (field[i + 1] - field[i - 1]) * 0.5;
          const gy = (field[i + width] - field[i - width]) * 0.5;
          const slope = (gx + gy) * 0.7072 * perWorld;
          const t = smooth01(0.15, 1.2, Math.abs(slope));
          if (t > 0) {
            const edge = (field[i] - steps[own - 1].limit) / Math.max(1e-4, Math.hypot(gx, gy));
            const w = t * (1 - smooth01(0, rim, edge));
            if (w > 0) rgb = slope > 0 ? mix(rgb, WHITE, 0.14 * w) : mix(rgb, [rgb[0] * 0.82, rgb[1] * 0.84, rgb[2] * 0.84], w);
          }
        }
        // No contour line: a higher band up-left of this pixel shades it softly.
        if (own >= 1 && x >= liftX && y >= liftY && band[i - liftY * width - liftX] > own) {
          rgb = mix(rgb, SHADE, 0.14);
        }
      } else if (toLand[i] <= foam) {
        rgb = FOAM;
      } else if (band[i] === 0) {
        rgb = field[i] < shelfLimit ? shelf : shallow;
        if (toLand[i] >= ringFrom && toLand[i] <= ringTo && field[i] >= shelfLimit) rgb = ring;
        if (lit && x >= dropX && y >= dropY && land[i - dropY * width - dropX]) rgb = mix(rgb, SHADE, 0.18);
        // Fade the outer edge of the shelf in over the first half-unit, or the
        // edge of the water is a staircase.
        alpha = Math.min(255, Math.round(((field[i] - floor) / 0.5) * 255));
      } else if (lit && x >= dropX && y >= dropY && land[i - dropY * width - dropX]) {
        // Open sea is transparent; only the shadow is painted on it.
        rgb = SHADE;
        alpha = 46;
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
}

/** Anti-aliasing for a texture shown at about its own size: every pixel that
 * differs from a neighbour becomes the average of the nine around it, so the
 * steps of a coastline or a contour blend over one pixel. Averaged with alpha
 * weights, or the transparent open sea (black, alpha 0) would darken the shelf. */
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

/** A stable key for "would this produce the same texture". */
function signature(posts, cells, region, unit, scale) {
  return JSON.stringify([posts.map(p => [p.x, p.y, energyOf(p)]), cells, region, unit.toFixed(2), isLit(unit, scale),
    config().energy.radius_factor ?? 1]);
}

let gridCache = null;
export function gridTerrain(grid) {
  if (!grid) return null;
  if (gridCache?.key === grid.revision) return gridCache;
  const canvas = document.createElement('canvas');
  canvas.width = grid.width; canvas.height = grid.height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(grid.width, grid.height);
  const field = Float32Array.from(grid.values, Number);
  const perWorld = grid.width / Math.max(1, grid.maxX - grid.minX);
  paint(image.data, field, grid.width, grid.height, { perScreen: 1, perWorld });
  ctx.putImageData(image, 0, 0);
  gridCache = { key: grid.revision, canvas, ...grid };
  return gridCache;
}

/**
 * Build the terrain texture for a world region.
 *
 * `cells` is the coarse layer from energy_cells, and is only passed when the
 * viewport held more posts than the client asked for. Each cell is treated as a
 * single post carrying the cell's summed energy - an approximation, and a
 * visible one if you go looking, but it is the difference between distant land
 * being roughly right and distant land not being there at all.
 */
export function buildTerrain({ posts, cells = [], region, scale, revision = null, elsewhere = null }) {
  const unit = groundUnit(scale);
  const factor = config().energy.radius_factor ?? 1;
  const lit = isLit(unit, scale);
  const same = (entry) => Boolean(entry) && entry.revision === revision && entry.unit === unit
    && entry.factor === factor && entry.lit === lit && entry.cells === cells && sameRegion(entry.region, region);
  // Asked every frame: when the caller's revision says nothing changed, skip
  // serialising every post into the key (most of a millisecond on a phone).
  if (revision !== null && cache && (same(cache) || same(pending))) return cache;
  const key = signature(posts, cells, region, unit, scale);
  if (cache && cache.key === key) {
    pending = null;
    // In place: the map keeps its sharp close-up while the ground is this one.
    Object.assign(cache, { revision, unit, factor, cells, region, lit });
    return cache;
  }
  // With a ground already on screen and somewhere else to build (index.js hands
  // in offthread.js's worker), the new one is made there and the old one stays,
  // stretched, until it arrives: the stop after a pinch, or a poll bringing new
  // posts, no longer stalls the map for 0.2 s (2026-10-16).
  if (elsewhere && cache && revision !== null) {
    const wanted = { revision, unit, factor, cells, region, lit };
    const sent = elsewhere({ posts, cells, region, scale }, (built, ok) => {
      if (pending !== wanted) return;   // a newer ground was asked for meanwhile
      pending = null;
      if (ok) cache = built ? { ...toCanvas(built), trees: built.trees, key, ...wanted } : null;
    });
    if (sent) {
      pending = wanted;
      return cache;
    }
  }
  pending = null;
  const built = render({ posts, cells, region, scale, unit, padding: PADDING, limit: MAX_TEXTURE, trees: true });
  if (built) cache = { ...built, key, revision, unit, factor, cells, region, lit };
  return built ? cache : null;
}

/** buildTerrain's texture as plain pixels and trees, for the worker. */
export function groundPixels({ posts, cells = [], region, scale }) {
  const built = compute({ posts, cells, region, scale, unit: groundUnit(scale), padding: PADDING, limit: MAX_TEXTURE });
  if (!built) return null;
  const { field, ...pixels } = built;
  return { ...pixels, trees: scatterTrees(field, built.width, built.height, built.minX, built.minY, built.scale) };
}

// Quarter-octave steps: a pinch crosses a step every ~19% of zoom instead of
// rebuilding the field on every frame of the gesture.
/** Whether a texture built at this zoom is sharp enough for the soft shadow (see paint). */
function isLit(unit, scale) {
  return unit / (scale || 1) >= 0.3;
}

function groundUnit(scale) {
  const stepped = 2 ** (Math.round(Math.log2(scale || 1) * 4) / 4);
  return Math.max(MIN_UNIT, Math.min(MAX_UNIT, stepped));
}

function sameRegion(a, b) {
  return a && b && a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY;
}

// The texture above covers every post, so close up it is stretched several
// times and the coasts turn into staircases. Zoomed in, the map also asks for
// this: the same ground for just the area around the screen, at the screen's
// own resolution (up to DETAIL_MAX_UNIT texture pixels per world unit and
// DETAIL_MAX_TEXTURE on a side). Not cached here: the map keeps the last one
// while it still covers the screen, and builds it only once the camera stops.
const DETAIL_MAX_UNIT = 48;   // 16 until the zoom went three times further (2026-10-18)
const DETAIL_MAX_TEXTURE = 2048;

export function buildDetail({ posts, cells = [], region, scale, pixelRatio = 1 }) {
  const built = detailPixels({ posts, cells, region, scale, pixelRatio });
  return built ? toCanvas(built) : null;
}

/** buildDetail without the canvas: plain pixels, so a Web Worker can build it
 * (terrain-worker.js, via offthread.js) and the page only puts them on a canvas. */
export function detailPixels({ posts, cells = [], region, scale, pixelRatio = 1 }) {
  const unit = Math.min(DETAIL_MAX_UNIT, (scale || 1) * pixelRatio);
  const built = compute({
    posts, cells, region, scale, unit, padding: 0, limit: DETAIL_MAX_TEXTURE, smooth: true,
  });
  if (!built) return null;
  const { field: _field, ...pixels } = built;
  return pixels;
}

/** Pixels from detailPixels (or compute) on a canvas the map can draw. */
export function toCanvas({ pixels, minX, minY, scale, width, height }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  return { canvas, minX, minY, scale, width, height };
}

/** The field over `region` (plus `padding` world units), painted into a canvas
 * of `unit` texture pixels per world unit, `limit` pixels at most on a side. */
function render({ trees, ...options }) {
  const built = compute(options);
  if (!built) return null;
  return {
    ...toCanvas(built),
    trees: trees ? scatterTrees(built.field, built.width, built.height, built.minX, built.minY, built.scale) : [],
  };
}

/** The field and its painted pixels; no canvas, no DOM. */
function compute({ posts, cells, region, scale, unit, padding, limit, smooth = false }) {
  const minX = region.minX - padding;
  const minY = region.minY - padding;
  const spanX = (region.maxX - region.minX) + padding * 2;
  const spanY = (region.maxY - region.minY) + padding * 2;
  if (spanX <= 0 || spanY <= 0) return null;

  // One texture budget for both axes, so a wide viewport does not get a tall
  // texture it cannot use.
  const fit = Math.min(1, limit / (Math.max(spanX, spanY) * unit));
  const scaled = unit * fit;
  const width = Math.max(1, Math.round(spanX * scaled));
  const height = Math.max(1, Math.round(spanY * scaled));

  const field = new Float32Array(width * height);

  const contribute = (worldX, worldY, energy, radius, coast = null) => {
    const table = coast ? reachTable(coast) : null;
    if (!(radius > 0) || !(energy > 0)) return;
    const px = (worldX - minX) * scaled;
    const py = (worldY - minY) * scaled;
    const r = radius * scaled;
    const startX = Math.max(0, Math.floor(px - r));
    const endX = Math.min(width - 1, Math.ceil(px + r));
    const startY = Math.max(0, Math.floor(py - r));
    const endY = Math.min(height - 1, Math.ceil(py + r));
    const rSq = r * r;

    for (let y = startY; y <= endY; y += 1) {
      const dy = y - py;
      const dySq = dy * dy;
      if (dySq >= rSq) continue;
      const row = y * width;
      // Solve the circle for this row instead of testing every pixel in the
      // bounding box. At 800 posts this is the difference between the field
      // being imperceptible and being a visible hitch on a phone.
      const half = Math.sqrt(rSq - dySq);
      const from = Math.max(startX, Math.ceil(px - half));
      const to = Math.min(endX, Math.floor(px + half));
      for (let x = from; x <= to; x += 1) {
        const dx = x - px;
        const distance = Math.sqrt(dx * dx + dySq);
        const reach = table ? r * reachFrom(table, dx, dy) : r;
        if (distance < reach) field[row + x] += energy * (1 - distance / reach);
      }
    }
  };

  posts.forEach((post) => contribute(post.x, post.y, energyOf(post), radiusOf(post), coastOf(post)));

  if (cells.length) {
    const { radius_base: base, radius_scale: rate, radius_trim: trim, radius_factor: factor = 1 } = config().energy;
    const size = 20; // ENERGY_CELL_SIZE, see core/config.py and schema.sql
    cells.forEach((cell) => {
      const energy = Number(cell.sum_energy) || 0;
      contribute(
        (cell.cell_x + 0.5) * size,
        (cell.cell_y + 0.5) * size,
        energy,
        (base + energy * rate) * trim * factor,
      );
    });
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  paint(pixels, field, width, height, { perScreen: scaled / (scale || 1), perWorld: scaled });
  if (smooth) smoothEdges(pixels, width, height);
  return { pixels, field, minX, minY, scale: scaled, width, height };
}

// Trees, bushes and rocks stand on the ground the field already decided. A
// jittered grid in WORLD units, hashed from the cell index, so a tree stays
// where it is while you pan and zoom - the field is rebuilt at another
// resolution, the grid is not.
const TREE_STEP = 18;

// Per band: [chance, sprite, chance, sprite, ...], read as cumulative odds.
const TREE_MIX = {
  savanna: [0.10, 'bush'],
  plains: [0.10, 'bush', 0.08, 'tree'],
  forest: [0.55, 'tree', 0.30, 'pine'],
  mountain: [0.35, 'pine', 0.30, 'rock'],
};

function cellNoise(gx, gy, salt) {
  let h = (Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663) ^ Math.imul(salt, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function scatterTrees(field, width, height, minX, minY, scaled) {
  const { steps } = bands();
  const trees = [];
  const maxX = minX + width / scaled;
  const maxY = minY + height / scaled;
  for (let gy = Math.ceil(minY / TREE_STEP); gy * TREE_STEP < maxY; gy += 1) {
    for (let gx = Math.ceil(minX / TREE_STEP); gx * TREE_STEP < maxX; gx += 1) {
      const x = (gx + cellNoise(gx, gy, 1) * 0.8) * TREE_STEP;
      const y = (gy + cellNoise(gx, gy, 2) * 0.8) * TREE_STEP;
      const px = Math.floor((x - minX) * scaled);
      const py = Math.floor((y - minY) * scaled);
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const band = bandOf(field[py * width + px]);
      const mix = band >= 0 ? TREE_MIX[steps[band].name] : null;
      if (!mix) continue;
      const roll = cellNoise(gx, gy, 3);
      let odds = 0;
      for (let i = 0; i < mix.length; i += 2) {
        odds += mix[i];
        if (roll < odds) {
          trees.push({ x, y, name: mix[i + 1], k: 0.8 + cellNoise(gx, gy, 4) * 0.4 });
          break;
        }
      }
    }
  }
  // Back to front, so a nearer tree overlaps the one behind it.
  return trees.sort((a, b) => a.y - b.y);
}

export function invalidateTerrain() {
  cache = null;
  pending = null;
  palette = null;
}
