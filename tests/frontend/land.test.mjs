import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let source = await readFile(new URL('../../web/js/map/land.js', import.meta.url), 'utf8');
source = source
  .replace("import { groundOf } from './coast.js';", () =>
    'const groundOf = (post, x, y) => { const d = Math.hypot(x - post.x, y - post.y); return d < post.radius ? post.energy * (1 - d / post.radius) : 0; };')
  .replace("import { config, energyOf, radiusOf } from '../config.js';", () =>
    `const config = () => ({ energy: { biome_thresholds: { desert: 30 }, radius_factor: 1, radius_base: 10, radius_scale: 1, radius_trim: 1 } });
     const energyOf = (post) => post.energy; const radiusOf = (post) => post.radius;`);
const land = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const post = (id, x, y, energy = 100, radius = 120) => ({ id, x, y, energy, radius });
// Land reaches 84 units from a post here (100 * (1 - d / 120) >= 30).
const ends = [post('w', 100, 100), post('e', 800, 100)];

test('a spot is land where the summed ground reaches the beach threshold', () => {
  assert.equal(land.isLandAt(ends, [], 100, 100), true);
  assert.equal(land.isLandAt(ends, [], 180, 100), true);
  assert.equal(land.isLandAt(ends, [], 190, 100), false);
  assert.equal(land.isLandAt(ends, [], 450, 100), false);
  // Two weak cones add up to land neither makes alone.
  const weak = [post('a', 400, 100, 20, 100), post('b', 430, 100, 20, 100)];
  assert.equal(land.isLandAt(weak.slice(0, 1), [], 415, 100), false);
  assert.equal(land.isLandAt(weak, [], 415, 100), true);
  // Coarse cells count like posts (centred at (450, 110) here).
  assert.equal(land.isLandAt(ends, [{ cell_x: 22, cell_y: 5, sum_energy: 120 }], 450, 110), true);
});

test('a line over two shores and open water is land, sea, land', () => {
  const flags = land.sampleLand(ends, [100, 100], [800, 100]);
  assert.equal(land.blockedBy(flags), false);
  const runs = land.runsOf(flags);
  assert.deepEqual(runs.map((r) => r.land), [true, false, true]);
  assert.equal(runs[0].from, 0);
  assert.equal(runs[2].to, 1);
  runs.slice(1).forEach((run, i) => assert.equal(run.from, runs[i].to, 'the stretches touch'));
  // The first shore ends about 84 / 700 of the way, the second starts 84 from the end.
  assert.ok(Math.abs(runs[0].to - 84 / 700) < 0.02, String(runs[0].to));
  assert.ok(Math.abs(runs[1].to - (1 - 84 / 700)) < 0.02, String(runs[1].to));
});

test('land in between blocks the line and splits the sea', () => {
  const flags = land.sampleLand(ends.concat(post('m', 450, 100)), [100, 100], [800, 100]);
  assert.equal(land.blockedBy(flags), true);
  assert.deepEqual(land.runsOf(flags).map((r) => r.land), [true, false, true, false, true]);
  assert.equal(land.blockedBy(land.sampleLand([post('s', 100, 100), post('t', 160, 100)], [100, 100], [160, 100])), true, 'no open water at all');
});

test('walking the stretches from the other end mirrors them', () => {
  const runs = land.runsOf(land.sampleLand(ends, [100, 100], [800, 100]));
  const back = land.reverseRuns(runs);
  assert.equal(back.length, 3);
  assert.equal(back[0].from, 0);
  assert.equal(back[2].to, 1);
  assert.ok(Math.abs(back[0].to - (1 - runs[2].from)) < 1e-12);
  assert.deepEqual(back.map((r) => r.land), [true, false, true]);
  const reversed = land.sampleLand(ends, [800, 100], [100, 100]);
  assert.deepEqual(land.runsOf(reversed).map((r) => r.land), back.map((r) => r.land));
});

test('land or sea at a place along the line, and the handover across a beach', () => {
  const runs = [{ from: 0, to: 0.1, land: true }, { from: 0.1, to: 0.9, land: false }, { from: 0.9, to: 1, land: true }];
  assert.equal(land.landAtRuns(runs, 0.05), true);
  assert.equal(land.landAtRuns(runs, 0.5), false);
  assert.equal(land.landAtRuns(runs, 0.95), true);
  assert.equal(land.landAtRuns(runs, 1), true);
  assert.deepEqual(land.mixAt(runs, 0.5, 0.04), [0, 1]);
  assert.deepEqual(land.mixAt(runs, 0.03, 0.04), [1, 0]);
  const [car, boat] = land.mixAt(runs, 0.1, 0.04);
  assert.ok(Math.abs(car - 0.5) < 1e-9 && Math.abs(boat - 0.5) < 1e-9, 'half and half on the boundary');
  const [c2, b2] = land.mixAt(runs, 0.11, 0.04);
  assert.ok(b2 > 0.5 && c2 < 0.5 && Math.abs(c2 + b2 - 1) < 1e-9);
  assert.deepEqual(land.mixAt(runs, 0, 0.04), [1, 0], 'the line end is not a boundary');
});

test('a bowed line is read along its curve, not along the straight chord', () => {
  // The curve bows 60 units away from the chord: the chord stays on the west
  // island for 84 units, the bowed curve leaves its land sooner.
  const straight = land.runsOf(land.sampleLand(ends, [100, 100], [800, 100]));
  const bowed = land.runsOf(land.sampleLand(ends, [100, 100], [800, 100], [], [450, 400]));
  assert.ok(bowed[0].to < straight[0].to, `${bowed[0].to} < ${straight[0].to}`);
  assert.equal(bowed[0].land, true);
});
