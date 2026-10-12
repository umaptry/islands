import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/map/kin.js', import.meta.url), 'utf8');
const { kinLines, KIN_SAME_ISLAND, KIN_OTHER_ISLAND } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// Two islands: everything with x < 500 is on "home", the rest on "away".
const HOME = { id: 'home' };
const AWAY = { id: 'away' };
const islandOf = (id, at) => (at[0] < 500 ? HOME : AWAY);
const row = (id, author, x, y = 0) => ({ id, author_id: author, x, y });
const mine = [{ id: 'm1', x: 100, y: 100 }];

test('three people on your island get straight dots, one over the water gets an arch', () => {
  const ranked = [
    row('a1', 'a', 110), row('b1', 'b', 900), row('c1', 'c', 120), row('d1', 'd', 130),
    row('e1', 'e', 140), row('f1', 'f', 950),
  ];
  const lines = kinLines({ mine, neighbors: new Map([['m1', ranked]]), islandOf, me: 'me' });
  const near = lines.filter((line) => !line.across).map((line) => line.person);
  const far = lines.filter((line) => line.across).map((line) => line.person);
  assert.deepEqual(near, ['a', 'c', 'd'], 'the best three on the same island, in rank order');
  assert.deepEqual(far, ['b'], 'only the best one over the water');
  assert.equal(near.length, KIN_SAME_ISLAND);
  assert.equal(far.length, KIN_OTHER_ISLAND);
  assert.deepEqual(lines[0].from, { x: 100, y: 100 });
  assert.deepEqual(lines[0].to, { x: 110, y: 0 });
});

test('no dots to yourself, to somebody you already have a line with, or twice to one person', () => {
  const ranked = [
    row('own', 'me', 105), row('a1', 'a', 110), row('a2', 'a', 115), row('z1', 'z', 120), row('c1', 'c', 130),
  ];
  const lines = kinLines({
    mine, neighbors: new Map([['m1', ranked]]), islandOf, me: 'me', linked: new Set(['z']),
  });
  assert.deepEqual(lines.map((line) => line.person), ['a', 'c']);
});

test('a person is dotted from one of your posts only, the first that names them', () => {
  const two = [{ id: 'm1', x: 100, y: 0 }, { id: 'm2', x: 200, y: 0 }];
  const lines = kinLines({
    mine: two,
    neighbors: new Map([['m1', [row('a1', 'a', 110)]], ['m2', [row('a1', 'a', 110), row('b1', 'b', 210)]]]),
    islandOf, me: 'me',
  });
  assert.deepEqual(lines.map((line) => [line.mine, line.person]), [['m1', 'a'], ['m2', 'b']]);
});

test('nothing to draw without islands, neighbours or a position', () => {
  const ranked = [row('a1', 'a', 110)];
  assert.deepEqual(kinLines({ mine, neighbors: new Map([['m1', ranked]]), islandOf: () => null, me: 'me' }), []);
  assert.deepEqual(kinLines({ mine, neighbors: new Map(), islandOf, me: 'me' }), []);
  assert.deepEqual(kinLines({
    mine: [{ id: 'm1', x: null, y: 0 }], neighbors: new Map([['m1', ranked]]), islandOf, me: 'me',
  }), []);
});
