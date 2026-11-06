import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// island-b.js has no imports and no DOM, so it loads from a data: URL as it is.
const source = await readFile(new URL('../../web/js/map/island-b.js', import.meta.url), 'utf8');
const island = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { coastAt, extentB, mapParamNow, previewParam, setIslandBPosts, isLandB, islandB, islandBKey, mapBOn, regionAt, regionsB, setIslandB, setIslandBView } = island;

// A small made-up island: n = 40 cells of 5 from -100, coast = 2 * (60 - distance
// from the middle) (so 120 at the centre, 0 on the shore), 255 outside land,
// two regions split at x = 0, and "near" cells round (70, 0) where the shore is.
const N = 40;
const X0 = -100;
const CELL = 5;
function payload(extra = {}) {
  const coast = new Int8Array(N * N);
  const region = new Uint8Array(N * N);
  const near = new Uint8Array(N * N);
  for (let j = 0; j < N; j += 1) {
    for (let i = 0; i < N; i += 1) {
      const x = X0 + (i + 0.5) * CELL;
      const y = X0 + (j + 0.5) * CELL;
      const c = Math.min(120, 2 * (60 - Math.hypot(x, y)));
      coast[j * N + i] = Math.max(-127, Math.round(c / 4));
      region[j * N + i] = c > 0 ? (x < 0 ? 0 : 1) : 255;
      near[j * N + i] = Math.hypot(x - 62, y) < 8 ? 1 : 0;
    }
  }
  const b64 = (a) => Buffer.from(a.buffer).toString('base64');
  return {
    version: 'v1', grid: { x0: X0, y0: X0, cell: CELL, n: N }, coast: b64(coast), region: b64(region), near: b64(near),
    regions: [{ id: 0, name: '西', x: -30, y: 0 }, { id: 1, name: '東', x: 30, y: 0 }],
    extent: { minX: -60, minY: -60, maxX: 60, maxY: 60 }, forest: 'grove', ...extra,
  };
}

test('setIslandB decodes the grid and the small facts', () => {
  assert.equal(islandB(), null);
  setIslandB(payload());
  assert.ok(islandB());
  assert.equal(islandB().coast.length, N * N);
  assert.equal(extentB().maxX, 60);
  assert.equal(regionsB().length, 2);
  assert.equal(regionsB()[1].name, '東');
  setIslandBView({ communityKey: null, postTotal: 0, forest: null, mapParam: null });
});

test('coastAt reads the grid as it is at a cell centre and bilinearly between', () => {
  const at = (i, j) => islandB().coast[j * N + i];
  const centre = (i) => X0 + (i + 0.5) * CELL;
  // Cells 24 and 25 are well inland and away from the reference points (near (62, 0)), so nothing is raised.
  assert.equal(coastAt(centre(24), centre(20)), at(24, 20));
  const mid = coastAt((centre(24) + centre(25)) / 2, centre(20));
  assert.ok(Math.abs(mid - (at(24, 20) + at(25, 20)) / 2) < 1e-4);
  const quarter = coastAt(centre(24) + CELL / 4, centre(20));
  assert.ok(Math.abs(quarter - (at(24, 20) * 0.75 + at(25, 20) * 0.25)) < 1e-4);
  // Roughly the made-up shape: 2 * (60 - 30) at 30 from the middle.
  assert.ok(Math.abs(coastAt(30, 0) - 60) < 5);
  assert.ok(isLandB(0, 0));
  assert.ok(!isLandB(90, 90));
});

test('the raise round the reference points never jumps: no dip across the neck of a cape', () => {
  // The reference points sit near (62, 0), where the made-up coast runs out: the raise makes a cape.
  // Until 2026-11-07 it was cut off where the coast was already 8, so the distance fell back to 8
  // across the cape's neck (a line of shore grass there) and jumped by tens of units.
  const { coastLow } = island;
  for (const read of [coastAt, coastLow]) {
    let last = read(40, 0);
    for (let x = 40.5; x <= 80; x += 0.5) {
      const c = read(x, 0);
      if (c < 0) break;   // out at sea: the land is what is looked at
      assert.ok(Math.abs(c - last) < 5, `${read === coastAt ? 'coastAt' : 'coastLow'} at x=${x}: ${last} -> ${c}`);
      last = c;
    }
  }
  // The low raise stops at the shore's grass: the relief keeps a cape low.
  for (let x = 56; x <= 70; x += 1) assert.ok(coastLow(x, 0) <= Math.max(8, coastAt(x, 0)) + 1e-9);
  assert.ok(coastAt(62, 0) > coastLow(62, 0));
});

test('regionAt reads the cell; outside the land it is 255', () => {
  assert.equal(regionAt(-30, 0), 0);
  assert.equal(regionAt(30, 0), 1);
  assert.equal(regionAt(90, 90), 255);
});

test('the community key moves the coast, and only near the shore', () => {
  setIslandBView({ communityKey: null });
  const plain = (x, y) => coastAt(x, y);
  const bare = { shore: plain(58, 6), sea: plain(-95, -95), middle: plain(0, 0), nearShore: plain(-50, -20) };
  setIslandBView({ communityKey: 'bar' });
  assert.equal(coastAt(-95, -95), bare.sea, 'far offshore: not moved (no stray shoals)');
  assert.equal(coastAt(0, 0), bare.middle, 'deep inland (over 100): not moved');
  assert.notEqual(coastAt(-50, -20), bare.nearShore, 'near the shore it moves');
  const moved = [];
  for (const key of ['a', 'b', 'c', 'd']) {
    setIslandBView({ communityKey: key });
    moved.push(coastAt(-50, -20).toFixed(3));
  }
  assert.ok(new Set(moved).size > 1, 'each community has its own shore');
  setIslandBView({ communityKey: 'bar' });
  assert.equal(coastAt(-50, -20), coastAt(-50, -20), 'and the same one each time');
  setIslandBView({ communityKey: null });
});

test('a cell near a reference point is never below 8 whatever the key', () => {
  // Round (62, 0) the made-up shore is a few units from the sea; a shake of the
  // coast would otherwise be free to drown it.
  for (let key = 0; key < 40; key += 1) {
    setIslandBView({ communityKey: `community-${key}` });
    for (const [x, y] of [[62, 0], [58, 3], [66, -3], [62, 6], [57, 0]]) {
      assert.ok(coastAt(x, y) >= 8, `${key} at ${x},${y}`);
    }
  }
  setIslandBView({ communityKey: null });
});

test('mapBOn needs the island and either the server switch or ?map=b', () => {
  const place = (search) => ({ search, hash: '' });
  assert.equal(mapBOn({ features: { map_b: true } }), true);
  assert.equal(mapBOn({ features: {} }, place('')), false);
  assert.equal(mapBOn({ features: {} }, place('?map=b')), true);
  assert.equal(mapBOn({ features: {} }, { search: '', hash: '#/map?map=b' }), true);
  assert.equal(mapBOn({ features: {} }, place('?map=a')), false);
  assert.equal(mapBOn(undefined, place('')), false);
  setIslandB(null);
  assert.equal(mapBOn({ features: { map_b: true } }), false, 'no island, no plan B');
  assert.equal(islandBKey(), '');
  setIslandB(payload());
});

test('a post on a shore far from the reference points stands on land, whatever the key', () => {
  const spot = { x: -57, y: 0 };   // about 6 inland, nowhere near the near cells
  let drowned = 0;
  for (let key = 0; key < 40; key += 1) {
    setIslandBPosts([]);
    setIslandBView({ communityKey: `community-${key}` });
    if (coastAt(spot.x, spot.y) <= 0) drowned += 1;
  }
  assert.ok(drowned > 0, 'without the guard some shores would drown it');
  setIslandBPosts([spot]);
  for (let key = 0; key < 40; key += 1) {
    setIslandBView({ communityKey: `community-${key}` });
    assert.ok(coastAt(spot.x, spot.y) >= 8 && isLandB(spot.x, spot.y), `${key}`);
    assert.ok(coastAt(spot.x + 8, spot.y + 8) >= 8, 'and round it, within 12');
  }
  setIslandBPosts([]);
  setIslandBView({ communityKey: null });
});

test('?map= is remembered once seen, even after the app rewrites the address', () => {
  assert.equal(mapParamNow({ search: '', hash: '#/map?map=b' }), 'b');
  assert.equal(mapParamNow({ search: '', hash: '#/map' }), 'b');
  assert.equal(mapBOn({ features: {} }, { search: '', hash: '#/map' }), true);
  assert.equal(mapParamNow({ search: '?map=a', hash: '' }), 'a');
  assert.equal(mapBOn({ features: {} }, { search: '', hash: '#/map' }), false);
});

test('?forest= and ?roads= are remembered after the address loses them, each on its own', () => {
  assert.equal(previewParam('forest', { search: '?forest=mass&roads=demo', hash: '#/map' }), 'mass');
  assert.equal(previewParam('roads', { search: '?forest=mass&roads=demo', hash: '#/map' }), 'demo');
  assert.equal(previewParam('forest', { search: '', hash: '#/map' }), 'mass');
  assert.equal(previewParam('roads', { search: '', hash: '#/map' }), 'demo');
  assert.equal(previewParam('forest', { search: '', hash: '#/map?forest=grove' }), 'grove');
  assert.equal(previewParam('roads', { search: '', hash: '#/map' }), 'demo');
  assert.equal(previewParam('nothing', { search: '', hash: '#/map' }), null);
});
