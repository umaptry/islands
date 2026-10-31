// The sea's own furniture: chart hatching, small boats, gulls, whale shadows,
// and the fog at the edge of the world. (Planes fly only on the routes between
// islands, one to a route: lines.js.)
//
// None of it carries data. No boat is a person, no bird is a post, and nothing
// here touches the camera, the coordinates or the hit list, so decoration can
// never move an island or swallow a tap. It exists because a map of islands
// with nothing moving on it reads as a diagram rather than as a place.
//
// Everything is positioned as a pure function of the clock, never as an
// accumulated velocity: a backgrounded tab, a resize or a dropped frame cannot
// drift the fleet or leave a bird somewhere it should not be.

import { drawSpriteTurned, fogImage } from './sprites.js';
import { drawBoat } from './vehicles.js';
import { beachThreshold, conesNear, conesOf, groundSum, postsNear } from './land.js';

export const SYSTEM_REDUCED_MOTION = Boolean(
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
);

// A live binding, not a constant: 「動きを減らす」 in the settings changes it
// without a reload, and every module that imported it sees the new value.
export let REDUCED_MOTION = SYSTEM_REDUCED_MOTION;

export function setReducedMotion(on) {
  REDUCED_MOTION = Boolean(on);
}

export const INK = {
  bird: 'rgba(255, 255, 255, .62)',
  boat: 'rgba(255, 255, 255, .92)',
  wake: 'rgba(255, 255, 255, .3)',
  halo: 'rgba(29, 95, 144, .6)',   // palette.js halo
  glint: 'rgba(255, 255, 255, .85)',
  label: '#ffffff',
};

/** Deterministic 0..1 from a seed and an index. */
export function noise(seed, index) {
  const value = Math.sin(seed * 0.0001 + index * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/** FNV-1a over an id. Same post, same island shape, on every device. */
export function hashId(id) {
  let hash = 2166136261;
  const text = String(id);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const BOAT_COUNT = 6;
// The hull's length in screen px at the largest zoom; below that it shrinks in
// proportion to scale / maxScale (as the route boats do), and under BOAT_MIN px
// it is not drawn. The drawing is vehicles.js.
const BOAT_LENGTH = 11;
const BOAT_MIN = 3;
const BIRD_SKEINS = 2;
// Half a gull's wingspan, seen from above.
const BIRD_SIZE = 2.5;   // halved 2026-10-13, with the flock's spacing and line
// Like the boats, the gulls are BIRD_SIZE at the largest zoom and shrink in
// proportion to scale / maxScale (the flock's spacing with them); a gull whose
// wingspan would be under BIRD_MIN px is not drawn. The line keeps a floor.
const BIRD_MIN = 1.5;
const BIRD_LINE = 0.7;
const BIRD_LINE_MIN = 0.5;
// Boats and gulls wander the sea on slow closed curves (drift, below) so they
// turn gently instead of flipping round at the end of a line: everything here
// is seen from straight above, where a boat that reverses on the spot would
// show it. One round takes about a quarter of an hour for a boat and six
// minutes for a skein of gulls - a tenth of the speed they had when they
// ferried back and forth.
const BOAT_DRIFT = { period: 900, reach: 0.4 };
const BIRD_DRIFT = { period: 370, reach: 0.4 };

const GLINT_CELL = 300;   // screen px: about one sparkle candidate per cell of this size
const GLINT_CHANCE = 0.75;
const GLINT_SIZE = 3;   // screen px, half the star's width

/** A four-pointed star that swells and fades once per period, never at rest. */
function drawGlint(ctx, x, y, size) {
  const pinch = size * 0.18;
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.quadraticCurveTo(x + pinch, y - pinch, x + size, y);
  ctx.quadraticCurveTo(x + pinch, y + pinch, x, y + size);
  ctx.quadraticCurveTo(x - pinch, y + pinch, x - size, y);
  ctx.quadraticCurveTo(x - pinch, y - pinch, x, y - size);
  ctx.fill();
}

// Short white strokes on the open water. They are a pattern in the world, like the
// trees and the houses: they grow and shrink with the map (2026-10-31, the user:
// strokes of a fixed screen size looked huge against the islands zoomed out).
// Their sizes are the old fixed ones at a scale of 8 px per world unit. Zoomed out
// they fade, every other row and column going first, and under DASH_MIN px they
// are not drawn at all. Drawn before the ground, which covers the land and the
// shallows: only the open sea shows them.
const DASH_GAP = [2.9, 2.4];      // world units between strokes
const DASH_JITTER = [1.1, 0.9];   // world units a stroke strays from its place
const DASH_HALF = 0.18;           // world units, half a stroke's length
const DASH_WIDTH = 0.21;          // world units
const DASH_MIN = 1.5;             // px a stroke looks (caps included) under which none is drawn
const DASH_FULL = 3;              // px from which it is drawn at full strength
const DASH_CROWD = [10, 18];      // px between columns over which the in-between strokes fade in
const DASH_FILL = 'rgba(255, 255, 255, 0.42)';
const DASH_FAINT = 0.04;          // a pass fainter than this is not drawn

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function dashHash(x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** How strongly the strokes show at `scale` px per world unit: `shown` for every stroke
 * (by its size on screen), `between` for those left out zoomed out (by their spacing). */
export function dashStrength(scale) {
  const shown = clamp01(((2 * DASH_HALF + DASH_WIDTH) * scale - DASH_MIN) / (DASH_FULL - DASH_MIN));
  const between = clamp01((DASH_GAP[0] * scale - DASH_CROWD[0]) / (DASH_CROWD[1] - DASH_CROWD[0]));
  return { shown, between: shown * between };
}

/** The strokes kept when zoomed out: every other row, staggered, every other one along it. */
const keptOut = (c, r) => (r & 1) === 0 && ((c + (r >> 1)) & 1) === 0;

function drawDashes(ctx, view) {
  const { toScreen, width, height } = view;
  const origin = toScreen(0, 0);
  const scale = toScreen(1, 0).x - origin.x;   // screen px per world unit
  if (!(scale > 0)) return;
  const { shown, between } = dashStrength(scale);
  if (shown < DASH_FAINT) return;
  const gapX = DASH_GAP[0] * scale;
  const gapY = DASH_GAP[1] * scale;
  const r0 = Math.floor(-origin.y / gapY) - 1;
  const r1 = Math.ceil((height - origin.y) / gapY) + 1;
  const c0 = Math.floor(-origin.x / gapX) - 1;
  const c1 = Math.ceil((width - origin.x) / gapX) + 1;
  // A round-capped stroke, which is far cheaper than hundreds of ellipses.
  const along = [Math.cos(1.05) * DASH_HALF * scale, Math.sin(1.05) * DASH_HALF * scale];
  ctx.strokeStyle = DASH_FILL;
  ctx.lineWidth = DASH_WIDTH * scale;
  ctx.lineCap = 'round';
  const passes = [[true, shown]];
  if (between >= DASH_FAINT) passes.push([false, between]);
  passes.forEach(([kept, alpha]) => {
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        if (keptOut(c, r) !== kept) continue;
        const x = origin.x + (c * DASH_GAP[0] + (r & 1) * DASH_GAP[0] / 2 + (dashHash(c, r) - 0.5) * DASH_JITTER[0]) * scale;
        const y = origin.y + (r * DASH_GAP[1] + (dashHash(r + 7, c) - 0.5) * DASH_JITTER[1]) * scale;
        ctx.moveTo(x - along[0], y - along[1]);
        ctx.lineTo(x + along[0], y + along[1]);
      }
    }
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
}

export function drawSeaMarks(ctx, view, time) {
  const { sea, toScreen, width, height } = view;
  ctx.save();
  drawDashes(ctx, view);
  // (The white crests that used to be here are gone: the incoming surf along the
  // coasts, surf.js, replaces them.)
  if (!REDUCED_MOTION) {
    // Sparkles on the water, each lit for the first third of its own 3.2 s cycle.
    // One candidate per cell of a grid in WORLD units, hashed from the cell index,
    // so a sparkle stays put while you pan; the cell size follows the zoom (in
    // octave steps) so there are always a handful on screen, however far in.
    // (The ground is drawn over them, so none shows on land.)
    ctx.fillStyle = INK.glint;
    const first = toScreen(0, 0);
    const pixel = toScreen(1, 0).x - first.x;   // screen px per world unit
    if (pixel > 0) {
      const cell = 2 ** Math.round(Math.log2(GLINT_CELL / pixel));
      const fromX = Math.floor((-first.x / pixel) / cell);
      const toX = Math.ceil(((width - first.x) / pixel) / cell);
      const fromY = Math.floor((-first.y / pixel) / cell);
      const toY = Math.ceil(((height - first.y) / pixel) / cell);
      for (let gy = fromY; gy <= toY; gy += 1) {
        for (let gx = fromX; gx <= toX; gx += 1) {
          const seed = 611953 * (((gx * 73856093) ^ (gy * 19349663)) >>> 0 || 1);
          if (noise(seed, 6) > GLINT_CHANCE) continue;
          const wx = (gx + noise(seed, 1)) * cell;
          const wy = (gy + noise(seed, 2)) * cell;
          if (wx < sea.x || wx > sea.x + sea.w || wy < sea.y || wy > sea.y + sea.h) continue;
          const phase = ((time + noise(seed, 4) * 3.2) % 3.2) / 3.2;
          if (phase > 0.3) continue;
          const spot = toScreen(wx, wy);
          if (spot.x < -10 || spot.x > width + 10 || spot.y < -10 || spot.y > height + 10) continue;
          drawGlint(ctx, spot.x, spot.y, GLINT_SIZE * Math.sin((phase / 0.3) * Math.PI));
        }
      }
    }
  }
  ctx.restore();
}

// An ornamental boat wanders over the whole sea and so would cross islands: it
// is left out while it is over land, fading over this many screen px at the shore
// (the ground is asked at five spots round the boat, so one is a handful of
// cheap checks a frame).
const SHORE_FADE = 6;

/** How much of a boat at world (x, y) shows: 1 on the water, 0 on land. */
function seaShare(view, x, y) {
  const { posts, cells, scale } = view;
  if (!posts) return 1;
  const reach = SHORE_FADE / Math.max(scale || 1, 1e-6);
  // Only the posts near the boat count: look them up once for the five spots.
  const lo = [x - reach, y - reach];
  const hi = [x + reach, y + reach];
  const near = postsNear(posts, lo, hi);
  const cones = conesNear(conesOf(cells), lo, hi);
  const beach = beachThreshold();
  let wet = 0;
  [[0, 0], [reach, 0], [-reach, 0], [0, reach], [0, -reach]].forEach(([dx, dy]) => {
    if (groundSum(near, cones, x + dx, y + dy) < beach) wet += 1;
  });
  return wet / 5;
}

export function drawBoats(ctx, view, time) {
  if (REDUCED_MOTION) return;
  const { sea, toScreen, width, height, scale, maxScale } = view;
  const length = scale > 0 && maxScale > 0 ? BOAT_LENGTH * Math.min(1, scale / maxScale) : BOAT_LENGTH;
  if (length < BOAT_MIN) return;
  for (let i = 0; i < BOAT_COUNT; i += 1) {
    const seed = 7919 * (i + 1);
    const spot = drift(sea, seed, time + noise(seed, 5) * 2000, BOAT_DRIFT);
    const point = toScreen(spot.x, spot.y);
    if (point.x < -40 || point.x > width + 40 || point.y < -40 || point.y > height + 40) continue;
    const share = seaShare(view, spot.x, spot.y);
    if (share > 0) drawBoat(ctx, point.x, point.y, length, spot.angle, { alpha: 0.9 * share });
  }
}

export function drawBirds(ctx, view, time) {
  if (REDUCED_MOTION) return;
  const { sea, toScreen, width, height, scale, maxScale } = view;
  const k = scale > 0 && maxScale > 0 ? Math.min(1, scale / maxScale) : 1;
  const size = BIRD_SIZE * k;
  if (size * 2 < BIRD_MIN) return;
  ctx.save();
  ctx.strokeStyle = INK.bird;
  ctx.fillStyle = INK.bird;
  ctx.lineWidth = Math.max(BIRD_LINE_MIN, BIRD_LINE * k);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let flight = 0; flight < BIRD_SKEINS; flight += 1) {
    const seed = 15485863 * (flight + 1);
    const spot = drift(sea, seed, time + noise(seed, 5) * 800, BIRD_DRIFT);
    const lead = toScreen(spot.x, spot.y);
    if (lead.x < -60 || lead.x > width + 60 || lead.y < -60 || lead.y > height + 60) continue;
    // toScreen is a uniform scale plus a translation, so the world direction and
    // the screen direction are the same direction.
    const unitX = Math.cos(spot.angle);
    const unitY = Math.sin(spot.angle);
    for (let bird = 0; bird < 3; bird += 1) {
      const back = bird === 0 ? 0 : 4.5 * k;
      const side = (bird === 1 ? -4 : (bird === 2 ? 4 : 0)) * k;
      drawBird(ctx,
        lead.x - unitX * back - unitY * side,
        lead.y - unitY * back + unitX * side,
        spot.angle,
        size,
        time * 2.2 + bird * 1.3 + flight);
    }
  }
  ctx.restore();
}

/** A gull from above, heading along `angle`: wings swept back from a short
 * body. Now and then it beats its wings, which from above shows as the span
 * drawing in; the rest of the time it glides. */
function drawBird(ctx, x, y, angle, size, beat) {
  const flap = Math.max(0, Math.sin(beat)) ** 2 * Math.max(0, Math.sin(beat * 0.31));
  const span = size * (1 - flap * 0.35);
  const sweep = size * (0.45 + flap * 0.2);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(-sweep, -span);
  ctx.quadraticCurveTo(size * 0.1, -span * 0.35, 0, 0);
  ctx.quadraticCurveTo(size * 0.1, span * 0.35, -sweep, span);
  ctx.stroke();
  // The body, head forward.
  ctx.beginPath();
  ctx.ellipse(-size * 0.1, 0, size * 0.42, size * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Screen-space de-clutter for labels.
 *
 * Labels are drawn at every zoom, and crowding is handled where crowding
 * actually happens - in screen pixels. A label is skipped only when it would
 * land on top of one already placed. Space is claimed in priority order:
 * landmass names, then you, then everybody else, so the headline never loses to
 * a passer-by.
 */
export function makeLabelSpace() {
  const taken = [];
  function claim(x, y, textWidth, textHeight) {
    const left = x - textWidth / 2 - 2;
    const right = x + textWidth / 2 + 2;
    const top = y - textHeight / 2 - 1;
    const bottom = y + textHeight / 2 + 1;
    for (let i = 0; i < taken.length; i += 1) {
      const box = taken[i];
      if (left < box.right && right > box.left && top < box.bottom && bottom > box.top) {
        return false;
      }
    }
    taken.push({ left, right, top, bottom });
    return true;
  }
  // Space that is simply not available (the controls over the map), however
  // much it overlaps what is already reserved.
  claim.block = (x, y, w, h) => {
    taken.push({ left: x - w / 2, right: x + w / 2, top: y - h / 2, bottom: y + h / 2 });
  };
  return claim;
}

// ---------------------------------------------------------------- whales

// Three, at half the first size: ten big shadows crowded the sea (2026-10-12).
const WHALE_COUNT = 3;

/** Where something that drifts on a slow closed curve is at `time`, and which
 * way it faces. A pure function of the clock, like everything else here: a
 * hidden tab cannot strand a whale. The curve is a Lissajous figure, so each
 * whale, boat or skein turns gently, never doubles back on itself, and wanders
 * the whole sea. */
export function drift(sea, seed, time, { period = 420, reach = 0.4 } = {}) {
  const px = period * (0.8 + noise(seed, 1) * 0.5);
  const py = period * (0.8 + noise(seed, 2) * 0.5);
  const cx = sea.x + sea.w * (0.5 + (noise(seed, 3) - 0.5) * 0.3);
  const cy = sea.y + sea.h * (0.5 + (noise(seed, 4) - 0.5) * 0.3);
  const ax = sea.w * (reach * 0.55 + noise(seed, 5) * reach * 0.45);
  const ay = sea.h * (reach * 0.55 + noise(seed, 6) * reach * 0.45);
  const fx = noise(seed, 7) * Math.PI * 2;
  const fy = noise(seed, 8) * Math.PI * 2;
  const wx = (Math.PI * 2) / px;
  const wy = (Math.PI * 2) / py;
  const x = cx + ax * Math.sin(wx * time + fx);
  const y = cy + ay * Math.sin(wy * time + fy);
  const vx = ax * wx * Math.cos(wx * time + fx);
  const vy = ay * wy * Math.cos(wy * time + fy);
  return { x, y, angle: Math.atan2(vy, vx) };
}

/** A few whale shadows moving through the water, under the land. */
export function drawWhales(ctx, view, time) {
  const { sea, toScreen, scale, width, height } = view;
  const clock = REDUCED_MOTION ? 0 : time;
  const length = Math.max(12, Math.min(55, sea.w * 0.014 * scale));
  for (let i = 0; i < WHALE_COUNT; i += 1) {
    const seed = 40503 * (i + 3);
    const spot = drift(sea, seed, clock + noise(seed, 9) * 400, { period: 380, reach: 0.44 });
    const point = toScreen(spot.x, spot.y);
    if (point.x < -length || point.x > width + length || point.y < -length || point.y > height + length) continue;
    const size = length * (0.8 + noise(seed, 10) * 0.45);
    drawSpriteTurned(ctx, 'whale', point.x, point.y, size, spot.angle, { alpha: 0.5 });
  }
}

// ---------------------------------------------------------------- fog

const FOG = [232, 236, 239];
const FOG_SIZE = 192;
let fogCache = null;

/** The edge of the world: clear over the sea the map covers, thickening to
 * white past it. A square-ish falloff texture over a world rectangle three
 * times the sea's width, with plain fog beyond it. */
function fogTexture() {
  if (fogCache) return fogCache;
  const canvas = document.createElement('canvas');
  canvas.width = FOG_SIZE;
  canvas.height = FOG_SIZE;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(FOG_SIZE, FOG_SIZE);
  // The texture spans [-1, 1] on both axes; the clear box is the middle third.
  const clear = 1 / 3;
  const rise = 1 - clear;
  for (let py = 0; py < FOG_SIZE; py += 1) {
    for (let px = 0; px < FOG_SIZE; px += 1) {
      const dx = Math.max(0, Math.abs((px + 0.5) / FOG_SIZE * 2 - 1) - clear);
      const dy = Math.max(0, Math.abs((py + 0.5) / FOG_SIZE * 2 - 1) - clear);
      const d = Math.min(1, Math.hypot(dx, dy) / (rise * 0.8));
      const t = d * d * (3 - 2 * d);
      const at = (py * FOG_SIZE + px) * 4;
      image.data[at] = FOG[0];
      image.data[at + 1] = FOG[1];
      image.data[at + 2] = FOG[2];
      image.data[at + 3] = Math.round(t * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  fogCache = canvas;
  return canvas;
}

export function drawFog(ctx, view) {
  const { sea, toScreen, scale, width, height } = view;
  const cx = sea.x + sea.w / 2;
  const cy = sea.y + sea.h / 2;
  // The clear third of the texture covers the sea box itself: the fog is what
  // the camera finds when it wanders to the edge of the world.
  const clear = (Math.max(sea.w, sea.h) / 2) * 1.05;
  const half = clear * 3;
  const topLeft = toScreen(cx - half, cy - half);
  const side = half * 2 * scale;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = `rgb(${FOG[0]}, ${FOG[1]}, ${FOG[2]})`;
  // Plain fog beyond the texture, laid a few pixels under its edge so no seam of
  // sea shows between the two.
  const lap = 6;
  const left = topLeft.x + lap;
  const top = topLeft.y + lap;
  const right = topLeft.x + side - lap;
  const bottom = topLeft.y + side - lap;
  if (left > 0) ctx.fillRect(0, 0, left, height);
  if (right < width) ctx.fillRect(right, 0, width - right, height);
  if (top > 0) ctx.fillRect(Math.max(0, left), 0, right - Math.max(0, left), top);
  if (bottom < height) ctx.fillRect(Math.max(0, left), bottom, right - Math.max(0, left), height - bottom);
  // The picture (web/img/map/fog.png) when it is there, the same thing made in
  // code when it is not. The outermost pixel is left out of the source: it
  // would blend with nothing at the rim and show as a thin line of sea.
  const picture = fogImage();
  if (picture && picture.width > 4) {
    ctx.drawImage(picture, 1, 1, picture.width - 2, picture.height - 2, topLeft.x, topLeft.y, side, side);
  } else {
    const canvas = fogTexture();
    ctx.drawImage(canvas, 1, 1, canvas.width - 2, canvas.height - 2, topLeft.x, topLeft.y, side, side);
  }
  ctx.restore();
}
