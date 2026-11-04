import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// decor.js as decor.test.mjs loads it, to reach map B's sea strokes and the shore test.
globalThis.window = { matchMedia: () => ({ matches: false }), devicePixelRatio: 1 };
globalThis.__boatsB = [];
let source = await readFile(new URL('../../web/js/map/decor.js', import.meta.url), 'utf8');
source = source
  .replace("import { drawSpriteTurned, fogImage } from './sprites.js';", () => 'const drawSpriteTurned = () => {}; const fogImage = () => null;')
  .replace("import { drawBoat } from './vehicles.js';", () => 'const drawBoat = (c, x, y, size, angle, extra) => globalThis.__boatsB.push(extra.alpha);')
  .replace(/import \{ beachThreshold[^;]*;/, () => 'const beachThreshold = () => 1; const conesNear = () => []; const conesOf = () => []; const groundSum = () => 0; const postsNear = () => [];');
const decor = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('map B sea strokes stand on a world grid, only in open sea, and the same ones every time', () => {
  const box = { minX: -200, minY: -200, maxX: 1200, maxY: 1200 };
  // The island is the disc of radius 400 around (500, 500): coast is positive inland.
  const coast = (x, y) => 400 - Math.hypot(x - 500, y - 500);
  const dashes = decor.seaDashesB(box, coast);
  assert.ok(dashes.length > 100);
  dashes.forEach(([x, y]) => assert.ok(coast(x, y) <= -22.5, `(${x}, ${y})`));
  assert.deepEqual(decor.seaDashesB(box, coast), dashes);
  // A smaller window shows part of the same strokes, not new ones.
  const part = decor.seaDashesB({ minX: 900, minY: 300, maxX: 1100, maxY: 700 }, coast);
  part.forEach(([x, y]) => assert.ok(dashes.some(([a, b]) => a === x && b === y)));
});

test('map B boats are drawn only over water: the shore test asks the island, not the posts', () => {
  const toScreen = (x, y) => ({ x, y });
  const base = { sea: { x: 0, y: 0, w: 1000, h: 1000 }, toScreen, width: 1000, height: 1000, scale: 1, maxScale: 1 };
  globalThis.__boatsB.length = 0;
  decor.drawBoats({}, { ...base, b: { isLand: () => true, coastAt: () => 100 } }, 100);
  assert.equal(globalThis.__boatsB.length, 0, 'an island under every boat: none is drawn');
  globalThis.__boatsB.length = 0;
  decor.drawBoats({}, { ...base, b: { isLand: () => false, coastAt: () => -100 } }, 100);
  assert.ok(globalThis.__boatsB.length > 0, 'open water: they are drawn');
  globalThis.__boatsB.forEach((alpha) => assert.ok(alpha > 0));
});
