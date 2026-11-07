import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/meet-text.js', import.meta.url), 'utf8');
const text = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// Every name and island here is made up for the test.
const mio = { id: 'm', display_name: 'みお' };
const kenta = { id: 'k', display_name: 'けんた' };

test('island names follow the map: the heading and 村', () => {
  assert.equal(text.islandLabel({ name: '焚き火 / 山', posts: 12 }), '焚き火村');
  assert.equal(text.islandLabel({ name: '簿記', posts: 50 }), '簿記村');
  assert.equal(text.islandLabel({}), '');
});

test('a merge names both islands, who led up to it and how many people there are now', () => {
  const said = text.describeChange({
    kind: 'merge', reason: 'mine', people: [mio, kenta], people_role: 'interaction',
    before: { islands: [{ name: 'キャンプ', posts: 6, people: 8 }, { name: '焚き火 / 山', posts: 4, people: 5 }] },
    after: { name: 'キャンプ', posts: 10, people: 14 },
  });
  assert.equal(said.text, 'キャンプ村と焚き火村が合流しました。');
  assert.equal(said.people, 'みおさんとけんたさんのやりとりがきっかけです。');
  assert.equal(said.numbers, '人数 8→14人');
  assert.equal(said.tag, 'あなたの村');
});

test('a quiet island names who posted there instead', () => {
  const said = text.describeChange({
    kind: 'birth', reason: 'big', people: [mio], people_role: 'posts',
    after: { name: '簿記', posts: 3, people: 2 },
  });
  assert.equal(said.text, '簿記村が生まれました。');
  assert.equal(said.people, 'みおさんが投稿しています。');
  assert.equal(said.numbers, '投稿 3件・2人');
});

test('a change without a name in it asks the map what stands there', () => {
  const nameAt = (place) => (place?.cx === 1 ? 'トマト村' : '');
  const grew = text.describeChange({
    kind: 'tier', place: { cx: 1, cy: 2 }, people: [],
    before: { tier: 0, tier_name: '小屋' }, after: { tier: 1, tier_name: '村' },
  }, { nameAt });
  assert.equal(grew.text, 'トマト村がにぎやかになりました。');
  assert.equal(grew.people, '');
  const lost = text.describeChange({ kind: 'tier', place: { cx: 9 }, before: { tier: 2, tier_name: '港町' },
    after: { tier: 1, tier_name: '村' } }, { nameAt });
  assert.equal(lost.text, 'ある村が少し静かになりました。');
});

test('splits, renames, landmarks and quiet islands each read as one sentence', () => {
  const split = text.describeChange({ kind: 'split', before: { name: '山', posts: 9 },
    after: { islands: [{ name: '登山', posts: 5 }, { name: 'キャンプ', posts: 4 }] } });
  assert.equal(split.text, '山村が登山村とキャンプ村に分かれました。');
  assert.equal(split.numbers, '投稿 9件→5件・4件');
  assert.equal(text.describeChange({ kind: 'rename', before: { name: '山' }, after: { name: '登山 / 山' } }).text,
    '山村が登山村になりました。');
  assert.equal(text.describeChange({ kind: 'landmark', place: {}, before: {}, after: { landmark: 'テント' } },
    { nameAt: () => '山村' }).text, '山村に目印「テント」ができました。');
  assert.equal(text.describeChange({ kind: 'quiet', before: { name: '山', posts: 2 }, after: { posts: 0, people: 0 } }).text,
    '山村がなくなりました。');
});

test('three or more people are counted, and the digest has a label', () => {
  assert.equal(text.namesOf([mio, kenta, { display_name: 'ゆき' }]), 'みおさんたち3人');
  assert.equal(text.digestLabel(3), '前回から 3件の変化');
});

test('changes not looked at stay for the next visit: new first, each once, none past 14 days', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const row = (id, days) => ({ id, created_at: new Date(now - days * 864e5).toISOString() });
  const merged = text.mergeKept([row('b', 0), row('a', 1)], [row('a', 1), row('old', 2), row('gone', 15)], now);
  assert.deepEqual(merged.map((c) => c.id), ['b', 'a', 'old']);
  assert.deepEqual(text.mergeKept(null, undefined, now), []);
  assert.deepEqual(text.keptOf(merged, new Set(['a'])).map((c) => c.id), ['b', 'old']);
  const many = Array.from({ length: 80 }, (_, i) => row(`r${i}`, 0));
  assert.equal(text.keptOf(many, new Set()).length, text.KEPT_MAX);
});
