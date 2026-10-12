import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let source = await readFile(new URL('../../web/js/map/lines.js', import.meta.url), 'utf8');
source = source
  .replace("import { REDUCED_MOTION, hashId } from './decor.js';", () =>
    'const REDUCED_MOTION = false; const hashId = (id) => [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);')
  .replace("import { drawSpriteTurned } from './sprites.js';", () =>
    'const drawSpriteTurned = (...args) => { (globalThis.planesDrawn ||= []).push(args); return true; };');
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

test('an arc bows the same way whichever end it is drawn from', () => {
  const shape = lines.arc({ x: 0, y: 0 }, { x: 100, y: 0 }, 3);
  assert.equal(shape.length, 100);
  assert.deepEqual(lines.pointOn(shape, 0), { x: 0, y: 0 });
  assert.deepEqual(lines.pointOn(shape, 1), { x: 100, y: 0 });
  assert.notEqual(lines.pointOn(shape, 0.5).y, 0);
});

test('a road is a straight line, an arch rises by a share of its span', () => {
  const road = lines.arc({ x: 0, y: 0 }, { x: 100, y: 0 }, 0, 0);
  assert.equal(lines.pointOn(road, 0.5).y, 0);
  const arch = lines.arc({ x: 0, y: 0 }, { x: 100, y: 0 }, 1, 0.3);
  assert.ok(Math.abs(lines.pointOn(arch, 0.5).y) > 10);
});

test('the heading follows the arc', () => {
  const road = lines.arc({ x: 0, y: 0 }, { x: 100, y: 0 }, 0, 0);
  assert.ok(Math.abs(lines.headingAt(road, 0.5)) < 1e-9);
  const back = lines.arc({ x: 100, y: 0 }, { x: 0, y: 0 }, 0, 0);
  assert.ok(Math.abs(Math.abs(lines.headingAt(back, 0.5)) - Math.PI) < 1e-9);
});

test('a growing road is the first part of the whole', () => {
  const shape = lines.arc({ x: 0, y: 0 }, { x: 100, y: 0 }, 1, 0.3);
  const part = lines.partOf(shape, 0.5);
  assert.deepEqual(part.q, lines.pointOn(shape, 0.5));
  assert.deepEqual(part.p, shape.p);
  assert.deepEqual(lines.pointOn(part, 1), lines.pointOn(shape, 0.5));
  // Halfway along the part is a quarter of the way along the whole, in x.
  const quarter = lines.pointOn(part, 0.5);
  assert.ok(Math.abs(quarter.x - lines.pointOn(shape, 0.25).x) < 1e-9);
});

test('a plane goes out and back, slowing into each end, from the clock alone', () => {
  const plan = { duration: 10, offset: 0 };
  assert.deepEqual(lines.planeAt(3, plan), lines.planeAt(3, plan));
  const out = lines.planeAt(5, plan);
  const back = lines.planeAt(15, plan);
  assert.equal(out.forward, true);
  assert.equal(back.forward, false);
  assert.ok(Math.abs(out.t - 0.5) < 1e-9 && Math.abs(back.t - 0.5) < 1e-9);
  assert.ok(lines.planeAt(0.5, plan).t < 0.05);
  assert.ok(lines.planeAt(19.5, plan).t < 0.05);
  [0, 2.2, 9.9, 10, 13.7, 19.99, 40].forEach((time) => {
    const { t } = lines.planeAt(time, plan);
    assert.ok(t >= 0 && t <= 1);
  });
});

test('a crossing takes longer over more water, within limits', () => {
  assert.equal(lines.crossingSeconds(0, 1000), 45);
  assert.equal(lines.crossingSeconds(1000, 1000), 120);
  assert.ok(lines.crossingSeconds(300, 1000) > 45 && lines.crossingSeconds(300, 1000) < 120);
});

test('the first list of lines is what the map already had; later ones grow', () => {
  lines.resetLinks();
  const first = [row('u1', 'u2', 'p1', 'p2')];
  assert.equal(lines.noteLinks(first, 1000), 0);
  assert.equal(lines.growthOf(lines.linkKey(first[0]), 1000), 1);
  const later = first.concat(row('u1', 'u3', 'p1', 'p3'));
  assert.equal(lines.noteLinks(later, 2000), 1);
  assert.equal(lines.noteLinks(later, 2100), 0, 'a pair is new only once');
  const key = lines.linkKey(later[1]);
  assert.equal(lines.growthOf(key, 2000), 0);
  const half = lines.growthOf(key, 2330);
  assert.ok(half > 0.5 && half < 1);
  assert.equal(lines.growthOf(key, 2700), 1);
  assert.equal(lines.growthOf(key, 2800), 1, 'and stays grown');
});

test('fresh lines are darker than old ones, faint ones faintest', () => {
  const now = Date.parse('2026-10-07T00:00:00Z');
  const fresh = lines.freshness(row('a', 'b', 'p1', 'p2', { last_at: '2026-10-07T00:00:00Z' }), now);
  const old = lines.freshness(row('a', 'b', 'p1', 'p2', { last_at: '2026-09-20T00:00:00Z' }), now);
  const faint = lines.freshness(row('a', 'b', 'p1', 'p2', { faint: true }), now);
  assert.ok(fresh > old && old > faint);
});

// A canvas that records strokes and nothing else.
function fakeCanvas() {
  const calls = { strokes: 0 };
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key === 'stroke') return () => { calls.strokes += 1; };
      if (key in target) return target[key];
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  return { ctx, calls };
}

test('zoomed in: one plane per route however many arches; zoomed out: no lines, no planes', () => {
  lines.resetLinks();
  const rows = [
    row('u1', 'u3', 'p1', 'p3', { a_at: [100, 100], b_at: [800, 800], tier: 1 }),
    row('u2', 'u4', 'p2', 'p4', { a_at: [110, 100], b_at: [810, 800], tier: 2, strength: 5 }),
  ];
  const view = {
    rows, islands, toScreen: (x, y) => ({ x: x / 2, y: y / 2 }), width: 600, height: 600,
    level: 'near', far: false, landOf: null, span: 1000, phone: true,
  };
  const near = fakeCanvas();
  const plan = lines.drawLinks(near.ctx, view);
  assert.equal(near.calls.strokes, 2, 'both arches are drawn, without an outline under them');
  globalThis.planesDrawn = [];
  lines.drawPlanes(near.ctx, view, plan, 30);
  assert.equal(globalThis.planesDrawn.length, 1);

  const far = fakeCanvas();
  const farView = { ...view, level: 'far', far: true };
  const none = lines.drawLinks(far.ctx, farView);
  assert.equal(none, null);
  assert.equal(far.calls.strokes, 0);
  globalThis.planesDrawn = [];
  lines.drawPlanes(far.ctx, farView, none, 30);
  assert.equal(globalThis.planesDrawn.length, 0);
});
