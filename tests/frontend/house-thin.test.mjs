import test from 'node:test';
import assert from 'node:assert/strict';
import { HOUSE_BOX, crowds, houseBox, thinHouses } from '../../web/js/map/house-thin.js';

const house = (id, x, foot, tier = 1, extra = {}) => ({ id, x, foot, size: 40, tier, score: 0, seed: id.length * 7 + id.charCodeAt(id.length - 1), keep: false, ...extra });
const ids = (list) => list.map((h) => h.id).sort();

test('0 or 1 house stays as it is', () => {
  assert.deepEqual(thinHouses([]), []);
  const one = [house('a', 10, 10)];
  assert.deepEqual(thinHouses(one), one);
});

test('ten houses on one spot leave one: the biggest tier', () => {
  const list = [];
  for (let i = 0; i < 10; i += 1) list.push(house(`p${i}`, 100 + i * 0.5, 100, i === 6 ? 3 : i % 3));
  const out = thinHouses(list);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'p6');
});

test('same tier: more reactions win, then the smaller hash', () => {
  const a = house('a', 50, 50, 1, { score: 2, seed: 9 });
  const b = house('b', 51, 50, 1, { score: 5, seed: 9 });
  assert.deepEqual(thinHouses([a, b]).map((h) => h.id), ['b']);
  const c = house('c', 50, 50, 1, { seed: 3 });
  const d = house('d', 51, 50, 1, { seed: 8 });
  assert.deepEqual(thinHouses([d, c]).map((h) => h.id), ['c']);
});

test('far apart houses all stay', () => {
  const list = [];
  for (let i = 0; i < 30; i += 1) list.push(house(`f${i}`, (i % 6) * 200, Math.floor(i / 6) * 200, i % 4));
  assert.equal(thinHouses(list).length, 30);
});

test('a small overlap stays, a big one does not', () => {
  const w = HOUSE_BOX[1].half * 40 * 2;
  const a = house('a', 0, 0);
  // overlap of 10% of the width: well under a quarter of the area
  assert.equal(thinHouses([a, house('b', w * 0.9, 0)]).length, 2);
  assert.ok(!crowds(houseBox(a), houseBox(house('b', w * 0.9, 0))));
  assert.equal(thinHouses([a, house('c', w * 0.3, 0)]).length, 1);
});

test('the open or landing post keeps its house even small', () => {
  const castle = house('castle', 100, 100, 3);
  const open = house('open', 101, 100, 0, { keep: true });
  const out = thinHouses([castle, open]);
  assert.ok(out.some((h) => h.id === 'open'));
});

test('the answer does not depend on the order of the input', () => {
  const list = [];
  for (let i = 0; i < 40; i += 1) list.push(house(`o${i}`, (i * 37) % 160, (i * 53) % 120, i % 4, { score: i % 5 }));
  const want = ids(thinHouses(list));
  for (let k = 0; k < 5; k += 1) {
    const shuffled = list.slice().sort(() => Math.random() - 0.5);
    assert.deepEqual(ids(thinHouses(shuffled)), want);
  }
  assert.deepEqual(ids(thinHouses(list.slice().reverse())), want);
});

test('a house does not flicker when the camera moves a little', () => {
  const list = [house('a', 0, 0, 2), house('b', 10, 4, 1), house('c', 14, -6, 0)];
  const before = ids(thinHouses(list));
  const moved = ids(thinHouses(list.map((h) => ({ ...h, x: h.x + 3, foot: h.foot - 2 }))));
  assert.deepEqual(moved, before);
});

test('a few thousand houses are quick', () => {
  const list = [];
  for (let i = 0; i < 3000; i += 1) list.push(house(`n${i}`, (i * 7919) % 2000, (i * 104729) % 2000, i % 4));
  const t = performance.now();
  thinHouses(list);
  assert.ok(performance.now() - t < 200);
});
