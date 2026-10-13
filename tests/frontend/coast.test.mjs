import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let source = await readFile(new URL('../../web/js/map/coast.js', import.meta.url), 'utf8');
// The energy constants as /api/config serves them (core/energy.py).
const ENERGY = { coast_depth: 0.3, coast_waves: [[2, 1], [3, 0.8], [4, 0.5], [5, 0.35], [7, 0.2]] };
source = source.replace("import { config, energyOf, radiusOf } from '../config.js';", () =>
  `const config = () => ({ energy: ${JSON.stringify(ENERGY)} });
   const energyOf = (post) => post.energy; const radiusOf = (post) => post.radius;`);
const coast = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const ANGLES = [0, 1, 2, 3, -2.5];
const reaches = (id) => ANGLES.map((t) => coast.reachAt(coast.coastOf({ id }), Math.cos(t), Math.sin(t), 1));

test('coastlines match the server (tests/test_coast.py holds the same numbers)', () => {
  assert.equal(coast.hash32('abc'), 440920331);
  const expected = {
    'b14fb76b-1c98-59cc-a46d-f8cfbf62293c': [0.708454, 0.912329, 0.864196, 0.834185, 0.808537],
    '島-7': [0.95795, 0.824167, 0.819505, 0.865223, 0.89469],
  };
  Object.entries(expected).forEach(([id, values]) => {
    reaches(id).forEach((value, i) => assert.ok(Math.abs(value - values[i]) < 1e-6, `${id} @ ${ANGLES[i]}: ${value}`));
  });
});

test('a coast only ever pulls in, by coast_depth at most, and is not a circle', () => {
  ['a', 'b', 'p1', 'b14fb76b-1c98-59cc-a46d-f8cfbf62293c'].forEach((id) => {
    const shape = coast.coastOf({ id });
    const values = Array.from({ length: 720 }, (_, i) => {
      const t = (i / 720) * Math.PI * 2;
      return coast.reachAt(shape, Math.cos(t), Math.sin(t), 1);
    });
    assert.ok(Math.min(...values) >= 1 - ENERGY.coast_depth - 1e-9);
    assert.ok(Math.max(...values) <= 1 + 1e-9);
    assert.ok(Math.max(...values) - Math.min(...values) > 0.08, `${id} is nearly round`);
  });
});

test('the same post keeps its shape; another post gets another', () => {
  assert.deepEqual(reaches('p1'), reaches('p1'));
  assert.notDeepEqual(reaches('p1'), reaches('p2'));
});

test('groundOf is the cone, pulled in by the coast', () => {
  const post = { id: 'p1', x: 10, y: 20, energy: 60, radius: 40 };
  assert.equal(coast.groundOf(post, 10, 20), 60);
  assert.equal(coast.groundOf(post, 10 + 40, 20), 0);
  const reach = 40 * coast.reachAt(coast.coastOf(post), 1, 0, 1);
  assert.ok(Math.abs(coast.groundOf(post, 10 + reach / 2, 20) - 30) < 1e-9);
  assert.equal(coast.groundOf(post, 10 + reach + 0.01, 20), 0);
});
