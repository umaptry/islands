import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/meet-text.js', import.meta.url), 'utf8');
const text = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// Every name and island here is made up for the test.
const mio = { id: 'm', display_name: 'みお' };
const kenta = { id: 'k', display_name: 'けんた' };

test('island names follow the map: the heading and 島, or 大陸 from 50 posts', () => {
  assert.equal(text.islandLabel({ name: '焚き火 / 山', posts: 12 }), '焚き火島');
  assert.equal(text.islandLabel({ name: '簿記', posts: 50 }), '簿記大陸');
  assert.equal(text.islandLabel({}), '');
});

test('a merge names both islands, who led up to it and how many people there are now', () => {
  const said = text.describeChange({
    kind: 'merge', reason: 'mine', people: [mio, kenta], people_role: 'interaction',
    before: { islands: [{ name: 'キャンプ', posts: 6, people: 8 }, { name: '焚き火 / 山', posts: 4, people: 5 }] },
    after: { name: 'キャンプ', posts: 10, people: 14 },
  });
  assert.equal(said.text, 'キャンプ島と焚き火島が合流しました。');
  assert.equal(said.people, 'みおさんとけんたさんのやりとりがきっかけです。');
  assert.equal(said.numbers, '人数 8→14人');
  assert.equal(said.tag, 'あなたの島');
});

test('a quiet island names who posted there instead', () => {
  const said = text.describeChange({
    kind: 'birth', reason: 'big', people: [mio], people_role: 'posts',
    after: { name: '簿記', posts: 3, people: 2 },
  });
  assert.equal(said.text, '簿記島が生まれました。');
  assert.equal(said.people, 'みおさんが投稿しています。');
  assert.equal(said.numbers, '投稿 3件・2人');
});

test('a change without a name in it asks the map what stands there', () => {
  const nameAt = (place) => (place?.cx === 1 ? 'トマト島' : '');
  const grew = text.describeChange({
    kind: 'tier', place: { cx: 1, cy: 2 }, people: [],
    before: { tier: 0, tier_name: '小屋' }, after: { tier: 1, tier_name: '村' },
  }, { nameAt });
  assert.equal(grew.text, 'トマト島が小屋から村に育ちました。');
  assert.equal(grew.people, '');
  const lost = text.describeChange({ kind: 'tier', place: { cx: 9 }, before: { tier: 2, tier_name: '港町' },
    after: { tier: 1, tier_name: '村' } }, { nameAt });
  assert.equal(lost.text, 'ある島が港町から村に戻りました。');
});

test('splits, renames, landmarks and quiet islands each read as one sentence', () => {
  const split = text.describeChange({ kind: 'split', before: { name: '山', posts: 9 },
    after: { islands: [{ name: '登山', posts: 5 }, { name: 'キャンプ', posts: 4 }] } });
  assert.equal(split.text, '山島が登山島とキャンプ島に分かれました。');
  assert.equal(split.numbers, '投稿 9件→5件・4件');
  assert.equal(text.describeChange({ kind: 'rename', before: { name: '山' }, after: { name: '登山 / 山' } }).text,
    '山島が登山島になりました。');
  assert.equal(text.describeChange({ kind: 'landmark', place: {}, before: {}, after: { landmark: 'テント' } },
    { nameAt: () => '山島' }).text, '山島に目印「テント」ができました。');
  assert.equal(text.describeChange({ kind: 'quiet', before: { name: '山', posts: 2 }, after: { posts: 0, people: 0 } }).text,
    '山島がなくなりました。');
});

test('three or more people are counted, and a suggestion always has a line', () => {
  assert.equal(text.namesOf([mio, kenta, { display_name: 'ゆき' }]), 'みおさんたち3人');
  assert.equal(text.reasonLine({ reasons: [{ kind: 'island', text: '同じ山島にいます' }] }), '同じ山島にいます');
  assert.equal(text.reasonLine({ reasons: [], score: 0.42 }), '似ている度 42%');
  assert.equal(text.personMeta({ island: '山島', post_count: 4, connection_count: 0 }), '山島・投稿 4件');
  assert.equal(text.digestLabel(3), '前回から 3件の変化');
});

test('the orbit names the most telling reason in a few words', () => {
  const island = { kind: 'island', text: '同じ山島にいます' };
  assert.equal(text.orbitTag([island, { kind: 'topics', text: '共通の話題「子育て」「料理」' }]), '「子育て」');
  assert.equal(text.orbitTag([island, { kind: 'seeking', text: 'あなたの探していることを手伝えそうです' }]), '頼れそう');
  assert.equal(text.orbitTag([island]), '同じ島');
  assert.equal(text.orbitTag([{ kind: 'posts', text: '投稿の話題が少し近いです' }]), '');
  assert.equal(text.orbitTag(undefined), '');
});
