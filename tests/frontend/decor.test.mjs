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
