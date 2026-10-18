import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let source = await readFile(new URL('../../web/js/map/lines.js', import.meta.url), 'utf8');
source = source
  .replace("import { REDUCED_MOTION, hashId } from './decor.js';", () =>
    'const REDUCED_MOTION = false; const hashId = (id) => [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);')
  .replace("import { drawBoat, drawPlane } from './vehicles.js';", () =>
    `const drawPlane = (...args) => { (globalThis.planesDrawn ||= []).push(args); return true; };
     const drawBoat = (...args) => { (globalThis.boatsDrawn ||= []).push(args); return true; };`)
  .replace("import { groundOf } from './coast.js';", () =>
    'const groundOf = (post, x, y) => { const d = Math.hypot(x - post.x, y - post.y); return d < post.radius ? post.energy * (1 - d / post.radius) : 0; };')
  .replace("import { config, energyOf, radiusOf } from '../config.js';", () =>
    `const config = () => ({ energy: { biome_thresholds: { desert: 30 }, radius_factor: 1, radius_base: 10, radius_scale: 1, radius_trim: 1 } });
     const energyOf = (post) => post.energy; const radiusOf = (post) => post.radius;`);
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

// Two islands at (100,100) and (800,100); a third, "mid", between them at (450,100)
// or off to one side at (450,600). Posts carry energy and a radius of their own.
const post = (id, x, y, energy = 100, radius = 120) => ({ id, x, y, energy, radius });
const seaIslands = [
  { island_id: 'west', cx: 100, cy: 100, post_ids: ['w'] },
  { island_id: 'east', cx: 800, cy: 100, post_ids: ['e'] },
  { island_id: 'mid', cx: 450, cy: 100, post_ids: ['m'] },
];
const seaRow = (extra = {}) => row('u1', 'u2', 'w', 'e', { a_at: [100, 100], b_at: [800, 100], tier: 1, ...extra });
function seaView(posts, rows = [seaRow()], extra = {}) {
  return {
    rows, islands: seaIslands, posts, toScreen: (x, y) => ({ x: x / 2, y: y / 2 }),
    width: 600, height: 600, level: 'near', far: false, landOf: null, span: 1000, phone: false, ...extra,
  };
}
const kindsOf = (plan) => plan.lines.map((line) => line.kind);

test('a line with open sea between its ends is a sea route; land in the way makes it an arch', () => {
  const open = [post('w', 100, 100), post('e', 800, 100), post('m', 450, 600)];
  assert.deepEqual(kindsOf(lines.drawLinks(fakeCanvas().ctx, seaView(open))), ['sea']);
  const blocked = [post('w', 100, 100), post('e', 800, 100), post('m', 450, 110)];
  assert.deepEqual(kindsOf(lines.drawLinks(fakeCanvas().ctx, seaView(blocked))), ['arch']);
});

test("the stretch on the ends' own land does not block, a gap of land in between does", () => {
  const own = [post('w', 100, 100), post('w2', 300, 100), post('e', 800, 100), post('e2', 600, 100)];
  assert.equal(lines.crossesLand(own, [100, 100], [800, 100]), false, 'leaving and reaching its own shore');
  // The same ends with a piece of land of their own island in the middle: a bay.
  const bay = own.concat(post('w3', 450, 100));
  assert.equal(lines.crossesLand(bay, [100, 100], [800, 100]), true);
  // No open water at all: one stretch of land from end to end.
  const solid = [100, 200, 300, 400].map((x) => post(`s${x}`, x, 100));
  assert.equal(lines.crossesLand(solid, [100, 100], [400, 100]), true);
});

test('without view.posts every crossing is an arch with a plane, as before', () => {
  const view = seaView(undefined);
  delete view.posts;
  const plan = lines.drawLinks(fakeCanvas().ctx, view);
  assert.deepEqual(kindsOf(plan), ['arch']);
  globalThis.planesDrawn = [];
  lines.drawPlanes(fakeCanvas().ctx, view, plan, 30);
  assert.equal(globalThis.planesDrawn.length, 1);
});

test('a sea route is dashed and has boats, not planes', () => {
  const view = seaView([post('w', 100, 100), post('e', 800, 100)]);
  const dashes = [];
  const canvas = fakeCanvas();
  const ctx = new Proxy(canvas.ctx, {
    get: (target, key) => (key === 'setLineDash' ? (d) => dashes.push(d) : target[key]),
  });
  const plan = lines.drawLinks(ctx, view);
  assert.equal(dashes.length, 1);
  globalThis.planesDrawn = [];
  const boats = fakeCanvas();
  lines.drawPlanes(boats.ctx, view, plan, 30);
  assert.equal(globalThis.planesDrawn.length, 0);
});

test('a route gets one to three boats by tier, and the screen has a cap', () => {
  assert.deepEqual([0, 1, 2, 3, 4, undefined].map(lines.boatCount), [1, 1, 2, 3, 3, 1]);
  const count = (view) => {
    globalThis.boatsDrawn = [];
    lines.drawPlanes(fakeCanvas().ctx, view, lines.drawLinks(fakeCanvas().ctx, view), 30);
    return globalThis.boatsDrawn.length;
  };
  const posts = [post('w', 100, 100), post('e', 800, 100)];
  [1, 2, 3].forEach((tier) => assert.equal(count(seaView(posts, [seaRow({ tier })])), tier));
  // Many routes: one island pair each, so many pairs of islands.
  const many = [];
  const isles = [];
  const manyPosts = [];
  for (let i = 0; i < 12; i += 1) {
    const y = 20 + i * 40;
    isles.push({ island_id: `l${i}`, cx: 0, cy: y, post_ids: [`l${i}`] }, { island_id: `r${i}`, cx: 800, cy: y, post_ids: [`r${i}`] });
    manyPosts.push(post(`l${i}`, 0, y, 100, 10), post(`r${i}`, 800, y, 100, 10));
    many.push(row(`a${i}`, `b${i}`, `l${i}`, `r${i}`, { a_at: [0, y], b_at: [800, y], tier: 3 }));
  }
  const crowd = { ...seaView(manyPosts, many), islands: isles };
  assert.equal(count(crowd), 18, 'wide screen cap');
  assert.equal(count({ ...crowd, phone: true }), 8, 'phone cap');
});

test('where a boat is depends on the clock alone, slower than a plane, and boats are spread apart', () => {
  const spec = { duration: 10, offset: 0, index: 0, count: 2 };
  assert.deepEqual(lines.boatAt(7, spec), lines.boatAt(7, spec));
  assert.ok(lines.boatAt(5, spec).t < lines.planeAt(5, spec).t, 'a plane has gone further by then');
  assert.notEqual(lines.boatAt(7, spec).t, lines.boatAt(7, { ...spec, index: 1 }).t);
});

test('with no clock the boats stand still where they are drawn', () => {
  const view = seaView([post('w', 100, 100), post('e', 800, 100)], [seaRow({ tier: 2 })]);
  const plan = lines.drawLinks(fakeCanvas().ctx, view);
  const spots = () => globalThis.boatsDrawn.map(([, x, y]) => [x, y]);
  globalThis.boatsDrawn = [];
  lines.drawPlanes(fakeCanvas().ctx, view, plan, null);
  const first = spots();
  globalThis.boatsDrawn = [];
  lines.drawPlanes(fakeCanvas().ctx, view, plan, null);
  assert.equal(first.length, 2);
  assert.deepEqual(spots(), first);
});

test('coarse cells block like posts, and a thin island on a long line is not skipped', () => {
  const ends = [post('w', 100, 100), post('e', 900, 100)];
  const cell = { cell_x: 22, cell_y: 5, sum_energy: 120 };   // centred at (450, 110)
  assert.equal(lines.crossesLand(ends, [100, 100], [900, 100], []), false);
  assert.equal(lines.crossesLand(ends, [100, 100], [900, 100], [cell]), true);
  // A small island whose land (above the beach) is only a few units wide.
  const thin = ends.concat(post('t', 503, 106, 40, 30));
  assert.equal(lines.crossesLand(thin, [100, 100], [900, 100]), true);
});

test('a like that grows an island on the route is a new answer, with the same posts array', () => {
  const posts = [post('w', 100, 100), post('e', 800, 100), post('m', 450, 140, 10, 60)];
  const view = seaView(posts);
  assert.deepEqual(kindsOf(lines.drawLinks(fakeCanvas().ctx, view)), ['sea']);
  posts[2].energy = 120;
  assert.deepEqual(kindsOf(lines.drawLinks(fakeCanvas().ctx, view)), ['arch']);
});
