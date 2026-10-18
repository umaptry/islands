import test from 'node:test';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';

// The folder has no package.json "type", so load the module as a data: URL like the other tests.
const source = await readFile(new URL('../../web/js/screens/map-extras-logic.js', import.meta.url), 'utf8');
const {
  miniToWorld, miniVisible, myIslands, pickNear, recentPosts, scaleChoice,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const isle = (id, cx, cy, people = 3, post_ids = []) => ({ island_id: id, cx, cy, people, post_ids });
const ids = (list) => list.map((island) => island.island_id);

test('scaleChoice picks the largest step that fits the bar, and says "about"', () => {
  const { label, px } = scaleChoice(1, 70);   // one island = 70px
  assert.equal(label, '島約1つ分');
  assert.equal(px, 70);
  assert.match(scaleChoice(0.2, 70).label, /約/);
  assert.equal(scaleChoice(0.0001, 70).px, 24);   // far out: clamped to the minimum bar
  assert.ok(scaleChoice(50, 70).px <= 110);
});

test('miniVisible switches on at zoom 1.7', () => {
  assert.equal(miniVisible(1.69), false);
  assert.equal(miniVisible(1.7), true);
});

test('pickNear: with posts of my own, the islands closest to mine, never mine', () => {
  const islands = [isle('a', 0, 0, 3, ['p1']), isle('b', 10, 0), isle('c', 5, 0), isle('d', 100, 0), isle('e', 50, 0)];
  assert.deepEqual(ids(pickNear({ islands, myPostIds: ['p1'] })), ['c', 'b', 'e']);
  assert.deepEqual(myIslands(islands, []), []);
});

test('pickNear: without posts, islands near the screen centre, preferring 2+ people', () => {
  const islands = [isle('a', 0, 0, 1), isle('b', 10, 0, 2), isle('c', 20, 0, 2), isle('d', 30, 0, 5), isle('e', 90, 0, 9)];
  const view = { minX: -5, maxX: 5, minY: -5, maxY: 5 };
  assert.deepEqual(ids(pickNear({ islands, view })), ['b', 'c', 'd']);   // 'a' has one person
  // moving the view moves the answer
  assert.deepEqual(ids(pickNear({ islands, view: { minX: 80, maxX: 100, minY: -5, maxY: 5 } })), ['e', 'd', 'c']);
});

test('pickNear: zoomed in, the island being looked at is left out', () => {
  const islands = [isle('a', 0, 0), isle('b', 10, 0), isle('c', 20, 0), isle('d', 30, 0)];
  const view = { minX: -2, maxX: 2, minY: -2, maxY: 2 };
  assert.deepEqual(ids(pickNear({ islands, view, zoomed: true })), ['b', 'c', 'd']);
  assert.deepEqual(ids(pickNear({ islands, view, zoomed: false })), ['a', 'b', 'c']);
});

test('pickNear: no view falls back to the most crowded; islands without a centre are skipped', () => {
  const islands = [isle('a', 0, 0, 1), isle('b', 1, 1, 9), { island_id: 'x', people: 99 }];
  assert.deepEqual(ids(pickNear({ islands })), ['b', 'a']);
});

test('recentPosts: newest first, unloaded skipped, a bad date does not scramble', () => {
  const byId = new Map([
    ['1', { id: '1', created_at: '2026-10-01T00:00:00Z' }],
    ['2', { id: '2', created_at: '2026-10-03T00:00:00Z' }],
    ['3', { id: '3', created_at: 'nonsense' }],
  ]);
  assert.deepEqual(recentPosts(['1', '2', '3', 'gone'], byId, 2).map((p) => p.id), ['2', '1']);
  assert.deepEqual(recentPosts(['3', '1'], byId, 2).map((p) => p.id), ['1', '3']);
});

test('miniToWorld measures from the canvas rect and clamps to the world', () => {
  const geometry = { k: 2, ox: 10, oy: 10, world: { minX: 0, maxX: 40, minY: 0, maxY: 40 } };
  const rect = { left: 100, top: 50, width: 92, height: 92 };   // 96px canvas shown at 92px
  const mid = miniToWorld(100 + 46, 50 + 46, rect, geometry, 96);   // the canvas centre = (48,48)
  assert.ok(Math.abs(mid.x - 19) < 1e-9 && Math.abs(mid.y - 19) < 1e-9);
  const out = miniToWorld(-500, 9999, rect, geometry, 96);
  assert.deepEqual(out, { x: 0, y: 40 });
});
