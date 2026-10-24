import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// No package.json "type" in this folder: load the module as a data: URL like the other tests.
const source = await readFile(new URL('../../web/js/fresh-rules.js', import.meta.url), 'utf8');
const rules = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const ME = '11111111-1111-4111-8111-111111111111';
const AKI = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-10-26T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const ago = (ms) => new Date(NOW - ms).toISOString();
const post = (id, age, author = AKI) => ({ id, author_id: author, created_at: ago(age) });

const fakeStorage = ({ failRead = false, failWrite = false } = {}) => {
  const map = new Map();
  return {
    getItem: (key) => { if (failRead) throw new Error('blocked'); return map.has(key) ? map.get(key) : null; },
    setItem: (key, value) => { if (failWrite) throw new Error('blocked'); map.set(key, String(value)); },
    map,
  };
};

test.beforeEach(() => rules.resetSeenMemory());

test('a post of the last seven days that I have not opened glows', () => {
  const posts = [post('new', 1000), post('week', 6 * DAY), post('old', 8 * DAY), post('edge', 7 * DAY)];
  const ids = rules.freshPostIds(posts, { meId: ME, seen: new Map(), now: NOW });
  assert.deepEqual([...ids].sort(), ['new', 'week']);
});

test('my own posts never glow', () => {
  const ids = rules.freshPostIds([post('mine', 1000, ME), post('theirs', 1000)], { meId: ME, now: NOW });
  assert.deepEqual([...ids], ['theirs']);
});

test('a post I have opened stops glowing; a Map or a Set of ids both work', () => {
  const posts = [post('a', 1000), post('b', 2000)];
  assert.deepEqual([...rules.freshPostIds(posts, { meId: ME, seen: new Map([['a', NOW]]), now: NOW })], ['b']);
  assert.deepEqual([...rules.freshPostIds(posts, { meId: ME, seen: new Set(['b']), now: NOW })], ['a']);
});

test('signed out, nothing glows', () => {
  assert.equal(rules.freshPostIds([post('a', 1000)], { meId: null, now: NOW }).size, 0);
  assert.equal(rules.freshPostIds([post('a', 1000)], { now: NOW }).size, 0);
});

test('odd posts are skipped: no date, a bad date, far in the future, no id', () => {
  const posts = [{ id: 'x', author_id: AKI }, { id: 'y', author_id: AKI, created_at: 'soon' },
    { id: 'z', author_id: AKI, created_at: new Date(NOW + DAY).toISOString() },
    { author_id: AKI, created_at: ago(1000) }, null, post('ok', 1000), post('skew', -60000)];
  assert.deepEqual([...rules.freshPostIds(posts, { meId: ME, now: NOW })].sort(), ['ok', 'skew']);
  assert.equal(rules.freshPostIds(null, { meId: ME, now: NOW }).size, 0);
});

test('an island glows when any of its posts does', () => {
  const islands = [{ island_id: 'i1', post_ids: ['a', 'b'] }, { island_id: 'i2', post_ids: ['c'] }, { label: 'no ids' }];
  const keys = rules.freshIslandKeys(islands, new Set(['b']), (island) => island.island_id || island.label);
  assert.deepEqual([...keys], ['i1']);
  assert.equal(rules.freshIslandKeys(islands, new Set(), (island) => island.island_id).size, 0);
  assert.equal(rules.freshIslandKeys(null, new Set(['a']), (island) => island.island_id).size, 0);
});

test('opening a post is remembered per account and survives a reload', () => {
  const storage = fakeStorage();
  rules.markSeen(storage, ME, 'a', NOW);
  assert.equal(rules.loadSeen(storage, ME, NOW).has('a'), true);
  assert.equal(rules.loadSeen(storage, AKI, NOW).has('a'), false, 'another account on this browser');
  rules.resetSeenMemory();
  assert.equal(rules.loadSeen(storage, ME, NOW).has('a'), true, 'read back from the browser');
  assert.equal(rules.loadSeen(storage, null, NOW).size, 0);
  assert.doesNotThrow(() => rules.markSeen(storage, ME, '', NOW));
});

test('without usable storage it is kept in memory for the session', () => {
  for (const storage of [null, fakeStorage({ failRead: true, failWrite: true }), fakeStorage({ failWrite: true })]) {
    rules.resetSeenMemory();
    assert.doesNotThrow(() => rules.markSeen(storage, ME, 'a', NOW));
    assert.equal(rules.loadSeen(storage, ME, NOW).has('a'), true);
    assert.deepEqual([...rules.freshPostIds([post('a', 1000)], { meId: ME, seen: rules.loadSeen(storage, ME, NOW), now: NOW })], []);
  }
});

test('what was opened more than a week ago is forgotten, and the list is capped', () => {
  const storage = fakeStorage();
  rules.markSeen(storage, ME, 'old', NOW - 8 * DAY);
  rules.markSeen(storage, ME, 'fresh', NOW - DAY);
  const seen = rules.loadSeen(storage, ME, NOW);
  assert.equal(seen.has('old'), false);
  assert.equal(seen.has('fresh'), true);
  assert.equal(JSON.parse(storage.map.get(rules.FRESH_SEEN_PREFIX + ME)).old, undefined, 'and not written back');

  for (let i = 0; i < rules.FRESH_SEEN_MAX + 20; i += 1) rules.markSeen(storage, ME, `p${i}`, NOW - 1000 + i);
  const capped = rules.loadSeen(storage, ME, NOW);
  assert.equal(capped.size, rules.FRESH_SEEN_MAX);
  assert.equal(capped.has(`p${rules.FRESH_SEEN_MAX + 19}`), true, 'the newest stays');
  assert.equal(capped.has('p0'), false, 'the oldest goes');
});

test('garbage in storage is ignored', () => {
  const storage = fakeStorage();
  for (const raw of ['nope', '[1,2]', '{"a":"x"}', 'null']) {
    storage.map.set(rules.FRESH_SEEN_PREFIX + ME, raw);
    rules.resetSeenMemory();
    assert.equal(rules.loadSeen(storage, ME, NOW).size, 0, raw);
  }
});
