import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// ほかのコミュニティにも出す（2026-10-29）: 同じ投稿の仲間をまとめる・出す先の候補・削除の問い・先着人数の合計。

const read = (url) => readFile(new URL(url, import.meta.url), 'utf8');
const load = async (url) => import(`data:text/javascript;base64,${Buffer.from(await read(url)).toString('base64')}`);
const rules = await load('../../web/js/community-rules.js');
const recruit = await load('../../web/js/recruit-rules.js');

const A = { id: 'a', name: 'BAR' };
const B = { id: 'b', name: '山の会' };
const C = { id: 'c', name: '読書会' };

test('shareOn: only with members only on and the server saying share', () => {
  const on = { features: { communities: true, members_only: true, share: true } };
  assert.equal(rules.shareOn(on), true);
  assert.equal(rules.shareOn({ features: { communities: true, members_only: true } }), false);
  assert.equal(rules.shareOn({ features: { communities: true, members_only: false, share: true } }), false);
  assert.equal(rules.shareOn(null), false);
});

test('groupShared: the copies of one post become one entry with every community name', () => {
  const posts = [
    { id: 'p2', share_group: 'p1', community_id: 'b', created_at: '2026-10-29T10:00:00Z' },  // the copy, written later
    { id: 'p3', share_group: null, community_id: 'a', created_at: '2026-10-28T10:00:00Z' },
    { id: 'p1', share_group: 'p1', community_id: 'a', created_at: '2026-10-20T10:00:00Z' },
  ];
  const groups = rules.groupShared(posts, { communities: [A, B] });
  assert.deepEqual(groups.map((group) => group.post.id), ['p3', 'p1'], 'an old post shared today stays where it was');
  assert.deepEqual(groups[1].names, ['BAR', '山の会']);
  assert.deepEqual(groups[1].copies.map((post) => post.id), ['p1', 'p2']);
  assert.deepEqual(groups[0].names, ['BAR']);
});

test('groupShared: the copy of the open map is the one shown', () => {
  const posts = [
    { id: 'p1', share_group: 'p1', community_id: 'a', created_at: '2026-10-20T10:00:00Z' },
    { id: 'p2', share_group: 'p1', community_id: 'b', created_at: '2026-10-29T10:00:00Z' },
  ];
  assert.equal(rules.groupShared(posts, { communities: [A, B], preferred: 'b' })[0].post.id, 'p2');
  assert.equal(rules.groupShared(posts, { communities: [A, B], preferred: 'zzz' })[0].post.id, 'p1');
  assert.equal(rules.groupShared(posts, { communities: [A] })[0].names.join(), 'BAR', 'a name I do not know is left out');
  assert.deepEqual(rules.groupShared(null), []);
});

test('shareTargets: every community but the one the post is in, marking the ones that have a copy', () => {
  assert.deepEqual(rules.shareTargets({ communities: [A, B, C], here: 'a', copies: [{ community_id: 'a' }, { community_id: 'c' }] }), [
    { id: 'b', name: '山の会', shared: false },
    { id: 'c', name: '読書会', shared: true },
  ]);
  assert.deepEqual(rules.shareTargets({ communities: [A], here: 'a' }), [], 'one community: nothing to offer');
});

test('deleteQuestion: one map asks once, several maps offer this one or all', () => {
  assert.deepEqual(rules.deleteQuestion(['BAR']).choices.map((choice) => choice.value), ['one']);
  const several = rules.deleteQuestion(['BAR', '山の会']);
  assert.deepEqual(several.choices.map((choice) => choice.value), ['one', 'all']);
  assert.match(several.body, /BAR・山の会に出しています/);
  assert.equal(several.choices[0].label, 'このコミュニティだけ外す');
  assert.equal(rules.deleteQuestion(['BAR', '山の会'], 'BAR').choices[0].label, 'BARだけ外す');
  // A copy in a community I left has no name I know: it still counts.
  const left = rules.deleteQuestion(['BAR'], 'BAR', 2);
  assert.deepEqual(left.choices.map((choice) => choice.value), ['one', 'all']);
  assert.match(left.body, /BAR・ほか1か所に出しています/);
  assert.deepEqual(rules.deleteQuestion(['BAR'], 'BAR', 1).choices.map((choice) => choice.value), ['one']);
});

test('first-come places are counted over every copy, and the terms say so only when others count', () => {
  const now = new Date('2026-10-29T03:00:00Z');
  const own = { recruit_capacity: 3, join_count: 1, group_join_count: 3 };
  assert.equal(recruit.joinCount(own), 3);
  assert.equal(recruit.recruitState(own, now), 'full');
  assert.match(recruit.joinTerms(own, now), /先着3人（ほかのコミュニティの参加も含む）/);
  const alone = { recruit_capacity: 3, join_count: 2, group_join_count: 2 };
  assert.equal(recruit.joinTerms(alone, now), '先着3人・', 'nobody elsewhere: no note');
  assert.equal(recruit.recruitState(alone, now), null);
  assert.equal(recruit.joinCount({ join_count: 2, group_join_count: 5 }), 2, 'no capacity: this map\'s own joins');
  assert.equal(recruit.joinCount({ recruit_capacity: 3, join_count: 2 }), 2, 'not shared: as before');
  assert.equal(recruit.joinCount({ recruit_capacity: 3, join_count: 2, group_join_count: null }), 2);
});
