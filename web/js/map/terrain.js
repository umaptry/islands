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

function colorFor(energy) {
  const { steps } = bands();
  for (const step of steps) {
    if (energy < step.limit) return step.rgb;
  }
  return steps[steps.length - 1].rgb;
}

/** A stable key for "would this produce the same texture". */
function signature(posts, cells, region, unit) {
  let sum = 0;
  for (const post of posts) {
    // Position and energy are the only inputs. Ids are not: two posts swapping
    // ids would produce the same ground, and rebuilding for that is waste.
    sum = (sum + post.x * 31 + post.y * 17 + energyOf(post) * 7) % 1e12;
  }
  return [
    posts.length, Math.round(sum), cells.length,
    Math.round(region.minX), Math.round(region.minY),
    Math.round(region.maxX), Math.round(region.maxY),
    unit.toFixed(2),
  ].join('|');
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
  const unit = Math.max(MIN_UNIT, Math.min(MAX_UNIT, scale || 1));
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
  const pixels = image.data;
  const { floor } = bands();

  for (let i = 0; i < field.length; i += 1) {
    const energy = field[i];
    const at = i * 4;
    if (energy < floor) {
      pixels[at + 3] = 0;   // open sea: the canvas below shows through
      continue;
    }
    const [r, g, b] = colorFor(energy);
    pixels[at] = r;
    pixels[at + 1] = g;
    pixels[at + 2] = b;
    // Fade in over the first half-unit of energy. Without it the coastline is a
    // hard staircase, because a threshold on a rasterised field always is.
    pixels[at + 3] = Math.min(255, Math.round(((energy - floor) / 0.5) * 255));
  }
  ctx.putImageData(image, 0, 0);

  cache = { key, canvas, minX, minY, scale: scaled, width, height };
  return cache;
}

export function invalidateTerrain() {
  cache = null;
  palette = null;
}
