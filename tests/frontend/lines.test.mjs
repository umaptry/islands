import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let source = await readFile(new URL('../../web/js/map/lines.js', import.meta.url), 'utf8');
source = source
  .replace("import { REDUCED_MOTION, hashId } from './decor.js';", () =>
    'const REDUCED_MOTION = false; const hashId = (id) => [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);')
  .replace("import { drawSprite } from './sprites.js';", () => 'const drawSprite = () => null;');
const lines = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const islands = [
  { island_id: 'farm', cx: 100, cy: 100, post_ids: ['p1', 'p2'] },
  { island_id: 'sea', cx: 800, cy: 800, post_ids: ['p3', 'p4'] },
];
const row = (a, b, a_post, b_post, extra = {}) => ({
  a, b, a_post, b_post, strength: 2, last_at: '2026-10-06T00:00:00+00:00', faint: false, ...extra,
});

test('lines between the same two islands merge into one route', () => {
  const islandOf = lines.islandFinder(islands);
  const routes = lines.buildRoutes([
    row('u1', 'u3', 'p1', 'p3'),
    row('u4', 'u2', 'p4', 'p2', { strength: 3, last_at: '2026-10-07T00:00:00+00:00' }),
    row('u1', 'u2', 'p1', 'p2'),
  ], islandOf);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].strength, 5);
  assert.equal(routes[0].people.size, 4);
  assert.equal(routes[0].last_at, '2026-10-07T00:00:00+00:00');
  assert.equal(routes[0].faint, false);
});

test('a post the island list does not know yet stands on the nearest island', () => {
  const islandOf = lines.islandFinder(islands);
  assert.equal(islandOf('new', [760, 790]).island_id, 'sea');
  assert.equal(islandOf('new', null), null);
});

test('the vehicle follows the line', () => {
  const base = { sameIsland: false, distance: 100, span: 1000, people: 2, tier: 1 };
  assert.equal(lines.vehicleKind({ ...base, sameIsland: true, distance: 900 }), 'walker');
  assert.equal(lines.vehicleKind({ ...base, distance: 450, people: 6, tier: 3 }), 'balloon');
  assert.equal(lines.vehicleKind({ ...base, people: 4, tier: 3 }), 'ferry');
  assert.equal(lines.vehicleKind({ ...base, tier: 3 }), 'sail');
  assert.equal(lines.vehicleKind(base), 'row');
});

test('route width tiers', () => {
  assert.deepEqual([0, 2.9, 3, 7.9, 8, 20].map(lines.routeTier), [1, 1, 2, 2, 3, 3]);
});

test('stronger lines send boats more often', () => {
  assert.equal(lines.intervalFor(0), 20);
  assert.equal(lines.intervalFor(100), 6);
  assert.ok(lines.intervalFor(4) < lines.intervalFor(1));
});

test('trips come from the clock alone and alternate direction', () => {
  const plan = { seed: 0, interval: 10, duration: 25 };
  assert.deepEqual(lines.tripsAt(31, plan), lines.tripsAt(31, plan));
  const trips = lines.tripsAt(31, plan);
  // Departures at 10, 20, 30 are under way at 31; the one at 0 has arrived.
  assert.equal(trips.length, 3);
  trips.forEach((trip) => assert.ok(trip.progress >= 0 && trip.progress < 1));
  const directions = trips.map((trip) => trip.forward);
  assert.notEqual(directions[0], directions[1]);
  assert.equal(lines.tripsAt(5, { seed: 0, interval: 10, duration: 4 }).length, 0);
});

test('an arc bows the same way whichever end it is drawn from', () => {
  const shape = lines.arc({ x: 0, y: 0 }, { x: 100, y: 0 }, 3);
  assert.equal(shape.length, 100);
  assert.deepEqual(lines.pointOn(shape, 0), { x: 0, y: 0 });
  assert.deepEqual(lines.pointOn(shape, 1), { x: 100, y: 0 });
  assert.notEqual(lines.pointOn(shape, 0.5).y, 0);
});

test('fresh lines are darker than old ones, faint ones faintest', () => {
  const now = Date.parse('2026-10-07T00:00:00Z');
  const fresh = lines.freshness(row('a', 'b', 'p1', 'p2', { last_at: '2026-10-07T00:00:00Z' }), now);
  const old = lines.freshness(row('a', 'b', 'p1', 'p2', { last_at: '2026-09-20T00:00:00Z' }), now);
  const faint = lines.freshness(row('a', 'b', 'p1', 'p2', { faint: true }), now);
  assert.ok(fresh > old && old > faint);
});
