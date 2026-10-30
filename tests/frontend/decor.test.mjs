import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// decor.js imports the sprites, the vehicles and the ground; stub them so the
// module loads from a data: URL, and record the boats it would draw.
globalThis.window = { matchMedia: () => ({ matches: false }), devicePixelRatio: 1 };
const boats = [];
globalThis.__boats = boats;
let source = await readFile(new URL('../../web/js/map/decor.js', import.meta.url), 'utf8');
source = source
  .replace("import { drawSpriteTurned, fogImage } from './sprites.js';", () => 'const drawSpriteTurned = () => {}; const fogImage = () => null;')
  .replace("import { drawBoat } from './vehicles.js';", () => 'const drawBoat = (c, x, y, size) => globalThis.__boats.push(size);')
  .replace(/import \{ beachThreshold[^;]*;/, () => 'const beachThreshold = () => 1; const conesNear = () => []; const conesOf = () => []; const groundSum = () => 0; const postsNear = () => [];');
const decor = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function viewAt(scale, width = 390, height = 844, extra = {}) {
  // Camera centred on world (500, 500).
  const toScreen = (x, y) => ({ x: width / 2 + (x - 500) * scale, y: height / 2 + (y - 500) * scale });
  return { sea: { x: 0, y: 0, w: 1000, h: 1000 }, toScreen, width, height, scale, ...extra };
}

test('the ornamental boats shrink with the zoom like the route boats, and vanish under 3 px', () => {
  const time = 100;
  boats.length = 0;
  decor.drawBoats({}, viewAt(18, 1366, 900, { maxScale: 18 }), time);
  boats.forEach((s) => assert.equal(s, 11));
  boats.length = 0;
  decor.drawBoats({}, viewAt(1.8, 1366, 900, { maxScale: 18, sea: { x: 0, y: 0, w: 1e5, h: 1e5 } }), time);
  boats.forEach((s) => assert.ok(Math.abs(s - 1.1) < 1e-9 || s === 1.1));
  assert.equal(boats.length, 0, 'under 3 px nothing is drawn');
  boats.length = 0;
  decor.drawBoats({}, viewAt(9, 1366, 900, { maxScale: 18 }), time);
  boats.forEach((s) => assert.ok(Math.abs(s - 5.5) < 1e-9));
  // No maxScale: the old fixed size.
  boats.length = 0;
  decor.drawBoats({}, viewAt(1.2, 1366, 900), time);
  boats.forEach((s) => assert.equal(s, 11));
});

// A recording canvas context for the gulls: the body is the one ellipse per bird.
function birdCtx() {
  const log = { ellipses: [], begins: 0, lineWidths: [] };
  const ctx = new Proxy({}, {
    get(_, name) {
      if (name === 'ellipse') return (x, y, rx) => log.ellipses.push(rx);
      if (name === 'beginPath') return () => { log.begins += 1; };
      return () => {};
    },
    set(_, name, value) {
      if (name === 'lineWidth') log.lineWidths.push(value);
      return true;
    },
  });
  return { ctx, log };
}

// A small sea around the camera so the flocks are always on screen.
const nearSea = { x: 495, y: 495, w: 10, h: 10 };

test('the gulls are as big as before at the largest zoom, and shrink in proportion', () => {
  let { ctx, log } = birdCtx();
  decor.drawBirds(ctx, viewAt(18, 1366, 900, { maxScale: 18, sea: nearSea }), 100);
  assert.equal(log.ellipses.length, 6);
  log.ellipses.forEach((rx) => assert.ok(Math.abs(rx - 2.5 * 0.42) < 1e-9));
  ({ ctx, log } = birdCtx());
  decor.drawBirds(ctx, viewAt(9, 1366, 900, { maxScale: 18, sea: nearSea }), 100);
  assert.equal(log.ellipses.length, 6);
  log.ellipses.forEach((rx) => assert.ok(Math.abs(rx - 2.5 * 0.42 / 2) < 1e-9));
  log.lineWidths.forEach((w) => assert.ok(w >= 0.5));
});

test('gulls under 1.5 px of wingspan are not drawn', () => {
  const { ctx, log } = birdCtx();
  decor.drawBirds(ctx, viewAt(1.2, 1366, 900, { maxScale: 18, sea: nearSea }), 100);
  assert.equal(log.begins, 0);
  assert.equal(log.ellipses.length, 0);
});

test('gulls keep the old size when maxScale is not given', () => {
  const { ctx, log } = birdCtx();
  decor.drawBirds(ctx, viewAt(1.2, 1366, 900, { sea: nearSea }), 100);
  assert.equal(log.ellipses.length, 6);
  log.ellipses.forEach((rx) => assert.ok(Math.abs(rx - 2.5 * 0.42) < 1e-9));
});

test('no gulls with reduced motion', () => {
  decor.setReducedMotion(true);
  try {
    const { ctx, log } = birdCtx();
    decor.drawBirds(ctx, viewAt(18, 1366, 900, { maxScale: 18, sea: nearSea }), 100);
    assert.equal(log.begins, 0);
  } finally {
    decor.setReducedMotion(false);
  }
});

// The white strokes on the sea (2026-10-31): a pattern in the world that grows and
// shrinks with the map, instead of strokes of one screen size at every zoom.
function strokeRecorder() {
  const passes = [];
  let current = null;
  return {
    passes,
    ctx: {
      save() {}, restore() {}, fill() {}, quadraticCurveTo() {},
      beginPath() { current = { alpha: this.globalAlpha, width: this.lineWidth, segments: [] }; },
      moveTo(x, y) { current.segments.push([x, y]); },
      lineTo(x, y) { const start = current.segments.pop(); current.segments.push([start, [x, y]]); },
      stroke() { passes.push(current); },
      set globalAlpha(value) { this._alpha = value; }, get globalAlpha() { return this._alpha ?? 1; },
    },
  };
}

function strokesAt(scale, width = 390, height = 844) {
  const { ctx, passes } = strokeRecorder();
  decor.setReducedMotion(true);   // the sparkles are left out, only the strokes are drawn
  decor.drawSeaMarks(ctx, viewAt(scale, width, height), 0);
  decor.setReducedMotion(false);
  return passes;
}

const strokeLength = ([[x0, y0], [x1, y1]]) => Math.hypot(x1 - x0, y1 - y0);

test('the sea strokes are as long and as wide as before at 8 px per world unit, and grow with the map', () => {
  const near = strokesAt(8);
  assert.ok(near.length >= 1);
  assert.ok(Math.abs(near[0].width - 1.68) < 1e-9);
  assert.ok(Math.abs(strokeLength(near[0].segments[0]) - 2.88) < 1e-6);
  assert.equal(near[0].alpha, 1);
  const deep = strokesAt(16);
  assert.ok(Math.abs(deep[0].width - 3.36) < 1e-9, 'twice the zoom, twice as wide');
  assert.ok(Math.abs(strokeLength(deep[0].segments[0]) - 5.76) < 1e-6, 'and twice as long');
});

test('zoomed out the sea strokes fade, thin out, and are gone before they crowd the screen', () => {
  // Far out (a whole map is about 0.5 px per world unit): nothing at all.
  assert.equal(strokesAt(0.5).length, 0);
  assert.equal(strokesAt(2.5).length, 0);
  // Just above the floor: faint, and only every other row and column.
  const thin = strokesAt(3);
  assert.equal(thin.length, 1, 'the in-between strokes are left out');
  assert.ok(thin[0].alpha > 0 && thin[0].alpha < 0.5);
  // Close in: every stroke, at full strength.
  const full = strokesAt(8);
  assert.equal(full.length, 2);
  full.forEach((pass) => assert.equal(pass.alpha, 1));
  const strength = decor.dashStrength(4);
  assert.ok(strength.between < strength.shown);
});

test('however far out, the sea strokes on a phone screen stay a few thousand', () => {
  for (let scale = 0.3; scale <= 18; scale *= 1.15) {
    const count = strokesAt(scale).reduce((sum, pass) => sum + pass.segments.length, 0);
    assert.ok(count <= 3500, `${count} strokes at ${scale.toFixed(2)} px per world unit`);
  }
});
