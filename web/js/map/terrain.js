// The ground, built the way islands built it.
//
// Every post contributes a cone of energy - highest at the post, falling
// linearly to nothing at its influence radius - and the cones are ADDED. The
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

// Texture resolution, in device pixels per world unit, and the ceiling on the
// texture itself. 1400 covers a phone at 3x without ever allocating something a
// low-end device will refuse.
const MIN_UNIT = 0.6;
const MAX_UNIT = 2.4;
const MAX_TEXTURE = 1400;
const PADDING = 24;   // world units of margin, so a coastline is never clipped

let cache = null;

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

const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

// The game-board look: one line colour shared with the sprites' outlines, a
// cliff face under every southern coast so the land reads as standing up out of
// the water, and cel steps rather than gradients.
const WHITE = [255, 255, 255];
const FOAM = [240, 251, 255];
const SHADE = [24, 46, 86];
const LINE = [74, 52, 38];
const CLIFF_TOP = [196, 142, 86];
const CLIFF_FOOT = [150, 102, 62];

/** Distance in pixels from the nearest set pixel of `mask` (chamfer 1/1.414). */
function distanceFrom(mask, width, height, invert = false) {
  const far = 1e6;
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i += 1) out[i] = (mask[i] ? !invert : invert) ? 0 : far;
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
 * then the bright shallows), foam on the coast, an outline, a cliff on the
 * south side, and light from the top-left in three flat steps.
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
  const outline = Math.max(1, 1.3 * k);
  const foam = Math.max(1.5, 2.6 * k);
  const ringFrom = foam + 2.2 * k;
  const ringTo = ringFrom + 1.4 * k;
  const cliff = Math.max(2, Math.round(5 * k));

  const n = width * height;
  const band = new Int8Array(n);
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    band[i] = bandOf(field[i]);
    land[i] = band[i] >= 1 ? 1 : 0;
  }

  // The cliff: water directly below land, `cliff` pixels deep.
  const depth = new Uint8Array(n);
  for (let x = 0; x < width; x += 1) {
    let run = 255;
    for (let y = 0; y < height; y += 1) {
      const i = y * width + x;
      if (land[i]) { run = 0; continue; }
      if (run < 255) run += 1;
      if (run <= cliff) depth[i] = run;
    }
  }
  const solid = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) solid[i] = land[i] || depth[i] ? 1 : 0;

  const toSolid = distanceFrom(solid, width, height);
  const toWater = distanceFrom(solid, width, height, true);
  const toEdge = distanceFrom(land, width, height, true);

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
          // from the light faces it.
          const slope = ((field[i + 1] - field[i - 1]) + (field[i + width] - field[i - width]))
            * 0.3536 * perWorld;
          if (slope > 0.35) rgb = mix(rgb, WHITE, 0.14);
          else if (slope < -0.35) rgb = mix(rgb, SHADE, 0.17);
          // A thin contour where the ground changes band.
          const right = band[i + 1];
          const below = band[i + width];
          if ((right >= 1 && right < own) || (below >= 1 && below < own)) rgb = mix(rgb, SHADE, 0.22);
        }
        if (toEdge[i] <= outline) rgb = LINE;
      } else if (depth[i]) {
        rgb = depth[i] <= cliff * 0.55 ? CLIFF_TOP : CLIFF_FOOT;
        if (toWater[i] <= outline) rgb = LINE;
      } else if (toSolid[i] <= foam) {
        rgb = FOAM;
      } else if (band[i] === 0) {
        rgb = field[i] < shelfLimit ? shelf : shallow;
        if (toSolid[i] >= ringFrom && toSolid[i] <= ringTo && field[i] >= shelfLimit) rgb = ring;
        // Fade the outer edge of the shelf in over the first half-unit, or the
        // edge of the water is a staircase.
        alpha = Math.min(255, Math.round(((field[i] - floor) / 0.5) * 255));
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

/** A stable key for "would this produce the same texture". */
function signature(posts, cells, region, unit) {
  return JSON.stringify([posts.map(p => [p.x, p.y, energyOf(p)]), cells, region, unit.toFixed(2)]);
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
export function buildTerrain({ posts, cells = [], region, scale }) {
  // Quarter-octave steps: a pinch crosses a step every ~19% of zoom instead of
  // rebuilding the field on every frame of the gesture.
  const stepped = 2 ** (Math.round(Math.log2(scale || 1) * 4) / 4);
  const unit = Math.max(MIN_UNIT, Math.min(MAX_UNIT, stepped));
  const key = signature(posts, cells, region, unit);
  if (cache && cache.key === key) return cache;

  const minX = region.minX - PADDING;
  const minY = region.minY - PADDING;
  const spanX = (region.maxX - region.minX) + PADDING * 2;
  const spanY = (region.maxY - region.minY) + PADDING * 2;
  if (spanX <= 0 || spanY <= 0) return null;

  // One texture budget for both axes, so a wide viewport does not get a tall
  // texture it cannot use.
  const fit = Math.min(1, MAX_TEXTURE / (Math.max(spanX, spanY) * unit));
  const scaled = unit * fit;
  const width = Math.max(1, Math.round(spanX * scaled));
  const height = Math.max(1, Math.round(spanY * scaled));

  const field = new Float32Array(width * height);

  const contribute = (worldX, worldY, energy, radius) => {
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
        field[row + x] += energy * (1 - distance / r);
      }
    }
  };

  posts.forEach((post) => contribute(post.x, post.y, energyOf(post), radiusOf(post)));

  if (cells.length) {
    const { radius_base: base, radius_scale: rate, radius_trim: trim } = config().energy;
    const size = 20; // ENERGY_CELL_SIZE, see core/config.py and schema.sql
    cells.forEach((cell) => {
      const energy = Number(cell.sum_energy) || 0;
      contribute(
        (cell.cell_x + 0.5) * size,
        (cell.cell_y + 0.5) * size,
        energy,
        (base + energy * rate) * trim,
      );
    });
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  paint(image.data, field, width, height, { perScreen: scaled / (scale || 1), perWorld: scaled });
  ctx.putImageData(image, 0, 0);

  cache = {
    key, canvas, minX, minY, scale: scaled, width, height,
    trees: scatterTrees(field, width, height, minX, minY, scaled),
  };
  return cache;
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
  palette = null;
}
