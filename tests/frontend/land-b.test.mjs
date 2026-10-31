import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// land.js and lines.js as land.test.mjs and lines.test.mjs load them, to check map B's switch:
// off, the posts' ground decides (as before); on, the island does and every line is a road.
const landSource = (await readFile(new URL('../../web/js/map/land.js', import.meta.url), 'utf8'))
  .replace("import { groundOf } from './coast.js';", () =>
    'const groundOf = (post, x, y) => { const d = Math.hypot(x - post.x, y - post.y); return d < post.radius ? post.energy * (1 - d / post.radius) : 0; };')
  .replace("import { config, energyOf, radiusOf } from '../config.js';", () =>
    `const config = () => ({ energy: { biome_thresholds: { desert: 30 }, radius_factor: 1, radius_base: 10, radius_scale: 1, radius_trim: 1 } });
     const energyOf = (post) => post.energy; const radiusOf = (post) => post.radius;`);
const landUrl = `data:text/javascript;base64,${Buffer.from(landSource).toString('base64')}`;
const land = await import(landUrl);

const linesSource = (await readFile(new URL('../../web/js/map/lines.js', import.meta.url), 'utf8'))
  .replace("import { REDUCED_MOTION, hashId } from './decor.js';", () =>
    'const REDUCED_MOTION = false; const hashId = (id) => [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);')
  .replace("import { drawBoat, drawCar, drawPlane } from './vehicles.js';", () =>
    'const drawPlane = () => true; const drawBoat = () => true; const drawCar = () => true;')
  .replace("from './land.js';", () => `from '${landUrl}';`)
  .replace("import { config, energyOf } from '../config.js';", () =>
    "const config = () => ({ energy: { radius_factor: 1 } }); const energyOf = (post) => post.energy;");
const lines = await import(`data:text/javascript;base64,${Buffer.from(linesSource).toString('base64')}`);

const post = (id, x, y) => ({ id, x, y, energy: 100, radius: 120 });
const ends = [post('w', 100, 100), post('e', 800, 100)];

test('without map B nothing changes: the posts decide', () => {
  assert.equal(land.bActive(), false);
  assert.equal(land.isLandAt(ends, [], 450, 100), false);
  land.useIslandB({ active: () => false, isLand: () => true });
  assert.equal(land.bActive(), false);
  assert.equal(land.isLandAt(ends, [], 450, 100), false);
});

test('with map B the island decides, on a spot and along a line', () => {
  land.useIslandB({ active: () => true, isLand: (x) => x > 300 && x < 600 });
  assert.equal(land.bActive(), true);
  assert.equal(land.isLandAt(ends, [], 450, 100), true);
  assert.equal(land.isLandAt(ends, [], 100, 100), false);
  const flags = land.sampleLand(ends, [100, 100], [800, 100]);
  assert.deepEqual(land.runsOf(flags).map((run) => run.land), [false, true, false]);
  land.useIslandB(null);
  assert.equal(land.bActive(), false);
});

test('with map B every line is a road, even between two far-apart islands', () => {
  const islands = [
    { island_id: 'a', cx: 100, cy: 100, post_ids: ['p1'] },
    { island_id: 'b', cx: 800, cy: 800, post_ids: ['p2'] },
  ];
  const row = { a: 'u1', b: 'u2', a_post: 'p1', b_post: 'p2', a_at: [100, 100], b_at: [800, 800], strength: 2 };
  const world = { islands, posts: [post('p1', 100, 100), post('p2', 800, 800)], cells: [], landOf: null };
  assert.notEqual(lines.decideLink(world, row).kind, 'road', 'off: two islands, not a road');
  land.useIslandB({ active: () => true, isLand: () => true });
  assert.equal(lines.decideLink(world, row).kind, 'road');
  const find = lines.islandFinder(islands);
  assert.equal(find('p1', [100, 100]), find('p2', [800, 800]), 'one island');
  assert.deepEqual(lines.buildRoutes([row], find), [], 'no sea routes');
  land.useIslandB(null);
});
