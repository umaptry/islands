// The planes, boats and cars on the map, drawn in code in the same design as the
// buildings (buildings.js): no outline, white as the main colour with the roof
// red as the accent, faces lit from the top-left, pale-blue windows, and a soft
// shadow that always falls to the bottom-right.
//
// Like the buildings, each shape is painted once into a small off-screen canvas
// and then stamped with drawImage, turned to its heading. The picture is made
// facing right (heading 0) and without a shadow: the shadow is a second picture
// of the silhouette that is turned with the vehicle but placed by a fixed
// screen offset, so it stays at the bottom-right whichever way the vehicle
// goes. A plane flies, so its shadow lies well apart from it; a boat's or car's lies
// right under it.
//
// This file has no DOM use at load time (the tests import it as it is).

import { PALETTE, mixHex } from './palette.js';

const INK = '#1B2430';
const dark = (c, t) => mixHex(c, INK, t);
const light = (c, t) => mixHex(c, '#FFFFFF', t);

const SAND_SHADE = dark(PALETTE.sand, 0.25);
// Same three faces as a wall: lit top, the lit side, the side in shade.
const WALL = [PALETTE.wall, mixHex(PALETTE.wall, SAND_SHADE, 0.35), mixHex(PALETTE.wall, SAND_SHADE, 0.6)];
const GLASS = mixHex(PALETTE.shallow, '#FFFFFF', 0.35);
const WARM = '#FFD98A';
const SHADOW = dark(PALETTE.forest, 0.75);

// How long each design is in its own units (the picture is scaled so that this
// length is `size` CSS px), the room the picture needs round it, and its shadow.
const SPECS = {
  plane: {
    length: 30,
    bounds: { l: -16.5, r: 16, t: -15, b: 15 },
    // Far from the plane: it is up in the air.
    shadow: { dx: 0.42, dy: 0.55, alpha: 0.2, blur: 1.3, scale: 0.9 },
  },
  boat: {
    length: 20,
    bounds: { l: -22, r: 11.5, t: -7, b: 7 },
    // Right under the hull.
    shadow: { dx: 0.07, dy: 0.11, alpha: 0.28, blur: 0.5, scale: 1 },
  },
  car: {
    length: 20,
    bounds: { l: -11, r: 11, t: -5.2, b: 5.2 },
    // On the ground, right under the body.
    shadow: { dx: 0.06, dy: 0.1, alpha: 0.3, blur: 0.45, scale: 1 },
  },
};
const PAD = 4;

// ---------------------------------------------------------------- the cache
const MAX_ENTRIES = 60;
const cache = new Map();

// Sizes are cached in steps of about 1.15 times (as buildings.js stepSize): the
// vehicles grow and shrink with the map, and a smooth pinch must not paint a new
// picture every frame. The picture is stretched by drawImage to the real size.
const STEP_MIN = 2;
const STEP_RATIO = 1.15;
const STEP_COUNT = Math.round(Math.log(48 / STEP_MIN) / Math.log(STEP_RATIO));
/** The size a picture is painted at for a vehicle that is `size` px long. */
export const roundSize = (size) => {
  const n = Math.round(Math.log(Math.max(size, STEP_MIN) / STEP_MIN) / Math.log(STEP_RATIO));
  return Math.round(STEP_MIN * STEP_RATIO ** Math.min(n, STEP_COUNT) * 10) / 10;
};

/** The device scale a ctx paints at, in quarter steps (so a smooth zoom does
 * not make a new cache entry every frame). */
function scaleOf(ctx) {
  let a = 1;
  try { a = ctx.getTransform().a; } catch { a = 1; }
  if (!(a > 0)) a = 1;
  return Math.min(4, Math.max(0.5, Math.round(a * 4) / 4));
}

/** The cache key of a picture. The heading is not in it: the picture is turned
 * when it is stamped. */
export function vehicleKey({ kind, size, night = false, dpr = 1 }) {
  return [kind, roundSize(size), night ? 1 : 0, dpr].join('|');
}

/** Where a vehicle's shadow lies relative to it, on the screen, in CSS px. It
 * does not take the heading: the light comes from the top-left whichever way
 * the vehicle faces. */
export function shadowOffset(kind, size) {
  const { dx, dy } = SPECS[kind].shadow;
  return [size * dx, size * dy];
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ---------------------------------------------------------------- the shapes
// All drawn facing right (+x), in design units, with `paint` choosing the colour:
// the real one for the body, one flat dark one for the shadow.

function poly(ctx, pts, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
}

function planeBody(ctx, shade, night) {
  const c = (color) => (shade ? SHADOW : color);
  const roof = PALETTE.roof;
  const fuselage = (half) => {
    ctx.beginPath();
    ctx.moveTo(15, 0);
    ctx.quadraticCurveTo(14.2, half * -2.4, 11, half * -2.4);
    ctx.lineTo(-10, half * -1.8);
    ctx.lineTo(-15, half * -0.6);
    ctx.lineTo(-15, half * 0.6);
    ctx.lineTo(-10, half * 1.8);
    ctx.lineTo(11, half * 2.4);
    ctx.quadraticCurveTo(14.2, half * 2.4, 15, 0);
    ctx.closePath();
  };
  // Wings and tailplanes behind the fuselage: the lit side, then the shaded one.
  poly(ctx, [[4, -1.6], [-3.4, -14], [-7.6, -14], [-5.6, -1.6]], c(WALL[0]));
  poly(ctx, [[4, 1.6], [-3.4, 14], [-7.6, 14], [-5.6, 1.6]], c(WALL[2]));
  poly(ctx, [[-10.6, -1.5], [-14.2, -6.6], [-16, -6.6], [-14.4, -1.2]], c(light(roof, 0.18)));
  poly(ctx, [[-10.6, 1.5], [-14.2, 6.6], [-16, 6.6], [-14.4, 1.2]], c(dark(roof, 0.2)));
  // Fuselage: shaded all over, then the lit upper half on top.
  ctx.fillStyle = c(WALL[1]);
  fuselage(1);
  ctx.fill();
  ctx.fillStyle = c(WALL[0]);
  ctx.beginPath();
  ctx.moveTo(15, 0);
  ctx.quadraticCurveTo(14.2, -2.4, 11, -2.4);
  ctx.lineTo(-10, -1.8);
  ctx.lineTo(-15, -0.6);
  ctx.lineTo(-15, 0);
  ctx.closePath();
  ctx.fill();
  if (shade) return;
  // A red band round the nose, lit above and shaded below.
  poly(ctx, [[8, -2.3], [9.8, -2.35], [9.8, 0], [8, 0]], light(roof, 0.12));
  poly(ctx, [[8, 0], [9.8, 0], [9.8, 2.35], [8, 2.3]], dark(roof, 0.12));
  // Windows: the cockpit, and a dashed row down the side.
  ctx.fillStyle = night ? WARM : GLASS;
  ctx.beginPath();
  ctx.ellipse(12.4, 0, 1.5, 1.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = night ? WARM : GLASS;
  ctx.globalAlpha = night ? 1 : 0.85;
  ctx.lineWidth = 0.9;
  ctx.setLineDash([1.1, 0.9]);
  ctx.beginPath();
  ctx.moveTo(5.5, -1.1);
  ctx.lineTo(-8, -0.85);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function boatHull(ctx, k = 1) {
  const m = (x, y) => [x * k, y * k];
  ctx.beginPath();
  ctx.moveTo(...m(-10, -3));
  ctx.lineTo(...m(2, -3.6));
  ctx.quadraticCurveTo(...m(7, -3), ...m(10, 0));
  ctx.quadraticCurveTo(...m(7, 3), ...m(2, 3.6));
  ctx.lineTo(...m(-10, 3));
  ctx.quadraticCurveTo(...m(-11.2, 0), ...m(-10, -3));
  ctx.closePath();
}

function boatBody(ctx, shade, night) {
  const c = (color) => (shade ? SHADOW : color);
  const roof = PALETTE.roof;
  if (!shade) {
    // The wake: two lines opening out behind the stern.
    ctx.save();
    ctx.globalAlpha = 0.65;
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-11, -1.6);
    ctx.lineTo(-21, -5.4);
    ctx.moveTo(-11, 1.6);
    ctx.lineTo(-21, 5.4);
    ctx.stroke();
    ctx.restore();
  }
  // Hull: the lit side, the half in shade, a white deck inside.
  ctx.fillStyle = c(WALL[1]);
  boatHull(ctx);
  ctx.fill();
  ctx.save();
  boatHull(ctx);
  ctx.clip();
  poly(ctx, [[-12, 0], [12, 0], [12, 5], [-12, 5]], c(WALL[2]));
  ctx.restore();
  ctx.fillStyle = c(WALL[0]);
  boatHull(ctx, 0.74);
  ctx.fill();
  // The cabin: a small pyramid roof seen from above, red, lit from the top.
  const A = [-3.6, -2.3];
  const B = [2.8, -2.3];
  const C = [2.8, 2.3];
  const D = [-3.6, 2.3];
  const top = [-0.4, 0];
  poly(ctx, [A, B, top], c(light(roof, 0.22)));
  poly(ctx, [A, D, top], c(light(roof, 0.08)));
  poly(ctx, [D, C, top], c(dark(roof, 0.12)));
  poly(ctx, [B, C, top], c(dark(roof, 0.24)));
  if (shade) return;
  // A pale window band at the cabin's bow.
  poly(ctx, [[3.4, -1.7], [4.6, -1.5], [4.6, 1.5], [3.4, 1.7]], night ? WARM : GLASS);
}

function carShell(ctx, k = 1) {
  const x = 10 * k;
  const y = 4.1 * k;
  const r = 2.8 * k;
  ctx.beginPath();
  ctx.moveTo(-x + r, -y);
  ctx.lineTo(x - r, -y);
  ctx.quadraticCurveTo(x, -y, x, -y + r);
  ctx.lineTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.lineTo(-x + r, y);
  ctx.quadraticCurveTo(-x, y, -x, y - r);
  ctx.lineTo(-x, -y + r);
  ctx.quadraticCurveTo(-x, -y, -x + r, -y);
  ctx.closePath();
}

function carBody(ctx, shade, night) {
  const c = (color) => (shade ? SHADOW : color);
  const roof = PALETTE.roof;
  // Body: the lit side, the half in shade, a white top inside (as the boat's hull).
  ctx.fillStyle = c(WALL[1]);
  carShell(ctx);
  ctx.fill();
  ctx.save();
  carShell(ctx);
  ctx.clip();
  poly(ctx, [[-12, 0], [12, 0], [12, 6], [-12, 6]], c(WALL[2]));
  ctx.restore();
  ctx.fillStyle = c(WALL[0]);
  carShell(ctx, 0.8);
  ctx.fill();
  // The cabin: a small red roof, lit from the top-left like the cabin of a boat.
  poly(ctx, [[-5, -3.2], [2.6, -3.2], [2.6, 0], [-5, 0]], c(light(roof, 0.16)));
  poly(ctx, [[-5, 0], [2.6, 0], [2.6, 3.2], [-5, 3.2]], c(dark(roof, 0.16)));
  if (shade) return;
  // Pale glass: the windscreen ahead of the roof, a thinner one behind it.
  poly(ctx, [[3.1, -2.7], [5, -3.1], [5, 3.1], [3.1, 2.7]], GLASS);
  poly(ctx, [[-6.4, -2.5], [-5.4, -2.6], [-5.4, 2.6], [-6.4, 2.5]], GLASS);
  if (night) {
    ctx.fillStyle = WARM;
    ctx.beginPath();
    ctx.arc(9.4, -2.5, 0.9, 0, Math.PI * 2);
    ctx.arc(9.4, 2.5, 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
}

const PAINT = { plane: planeBody, boat: boatBody, car: carBody };

// ---------------------------------------------------------------- stamps
/** One picture of the design, painted at scale k px per design unit * dpr. */
function paintPicture(kind, { size, night, dpr, shade }) {
  const spec = SPECS[kind];
  const k = size / spec.length;
  const b = spec.bounds;
  const pad = shade ? PAD : 1;
  const l = b.l * k - pad;
  const t = b.t * k - pad;
  const w = (b.r - b.l) * k + pad * 2;
  const h = (b.b - b.t) * k + pad * 2;
  const canvas = makeCanvas(Math.max(1, Math.ceil(w * dpr)), Math.max(1, Math.ceil(h * dpr)));
  const cx = canvas.getContext('2d');
  cx.setTransform(dpr * k, 0, 0, dpr * k, -l * dpr, -t * dpr);
  cx.lineJoin = 'round';
  if (shade && 'filter' in cx) cx.filter = `blur(${(spec.shadow.blur * k).toFixed(2)}px)`;
  PAINT[kind](cx, shade, night);
  return { canvas, l, t, w, h };
}

function entryFor(kind, size, night, dpr) {
  const key = vehicleKey({ kind, size, night, dpr });
  let e = cache.get(key);
  if (e) {
    cache.delete(key);
    cache.set(key, e);
    return e;
  }
  const s = roundSize(size);
  e = {
    size: s,
    body: paintPicture(kind, { size: s, night, dpr, shade: false }),
    shadow: paintPicture(kind, { size: s, night: false, dpr, shade: true }),
  };
  cache.set(key, e);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return e;
}

function stamp(ctx, pic, x, y, heading, scale) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(pic.canvas, pic.l, pic.t, pic.w, pic.h);
  ctx.restore();
}

function drawVehicle(kind, ctx, x, y, size, heading, opts) {
  if (!ctx || !(size > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const { alpha = 1, night = false } = opts || {};
  const turn = Number.isFinite(heading) ? heading : 0;
  const e = entryFor(kind, size, night, scaleOf(ctx));
  const scale = size / e.size;
  const [ox, oy] = shadowOffset(kind, size);
  const spec = SPECS[kind].shadow;
  const prev = ctx.globalAlpha;
  // The shadow first, turned like the vehicle but moved by a fixed screen offset.
  ctx.globalAlpha = prev * alpha * spec.alpha;
  stamp(ctx, e.shadow, x + ox, y + oy, turn, scale * spec.scale);
  ctx.globalAlpha = prev * alpha;
  stamp(ctx, e.body, x, y, turn, scale);
  ctx.globalAlpha = prev;
  return true;
}

/** A plane seen from above, centred on (x, y), nose to `heading` (radians, 0 =
 * right). `size` is its length in CSS px. opts: alpha, night (lit windows).
 * Returns false when nothing could be drawn. */
export function drawPlane(ctx, x, y, size, heading = 0, opts = {}) {
  return drawVehicle('plane', ctx, x, y, size, heading, opts);
}

/** A boat seen from above, centred on (x, y), bow to `heading`, a white wake
 * behind it. `size` is the hull's length in CSS px. */
export function drawBoat(ctx, x, y, size, heading = 0, opts = {}) {
  return drawVehicle('boat', ctx, x, y, size, heading, opts);
}

/** A car seen from above, centred on (x, y), nose to `heading`. `size` is its
 * length in CSS px. White body, red roof, pale windows; opts: alpha, night
 * (headlights on). */
export function drawCar(ctx, x, y, size, heading = 0, opts = {}) {
  return drawVehicle('car', ctx, x, y, size, heading, opts);
}

export const _cacheSize = () => cache.size;
export const _clearCache = () => cache.clear();
