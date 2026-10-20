import test from 'node:test';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';

// No package.json "type" in this folder: load the module as a data: URL like the other tests.
const source = await readFile(new URL('../../web/js/recruit-rules.js', import.meta.url), 'utf8');
const {
  addDays, availablePrompts, deadlineRange, extrasPayload, formatDeadline, jstToday, joinRefusal,
  parseCapacity, promptPlaceholder, recruitState, formatDeadlineShort, joinTerms, joinWord, usedPromptKeys,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('jstToday follows Japan time, not the phone zone', () => {
  assert.equal(jstToday(new Date('2026-12-30T14:59:59Z')), '2026-12-30');
  assert.equal(jstToday(new Date('2026-12-30T15:00:00Z')), '2026-12-31');
});

test('addDays and deadlineRange: today .. 365 days, an old own deadline stays valid', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('nope', 1), null);
  const now = new Date('2026-10-20T03:00:00Z');
  assert.deepEqual(deadlineRange(now), { min: '2026-10-20', max: '2027-10-20' });
  assert.equal(deadlineRange(now, '2026-10-01').min, '2026-10-01');
  assert.equal(deadlineRange(now, '2026-11-01').min, '2026-10-20');
});

test('formatDeadline and parseCapacity', () => {
  assert.equal(formatDeadline('2026-12-31'), '2026/12/31');
  assert.equal(formatDeadline(''), null);
  assert.equal(parseCapacity('15'), 15);
  assert.equal(parseCapacity(' 999 '), 999);
  for (const bad of ['', '0', '1000', '-3', '1.5', 'abc', null]) assert.equal(parseCapacity(bad), null);
});

test('recruitState: the deadline day is open until midnight in Tokyo', () => {
  const post = { recruit_deadline: '2026-12-31', join_count: 0 };
  assert.equal(recruitState(post, new Date('2026-12-31T14:59:59Z')), null);
  assert.equal(recruitState(post, new Date('2026-12-31T15:00:00Z')), 'deadline');
});

test('recruitState: full by the numbers, deadline wins, the server flag is a fallback', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  assert.equal(recruitState({ recruit_capacity: 3, join_count: 2 }, now), null);
  assert.equal(recruitState({ recruit_capacity: 3, join_count: 3 }, now), 'full');
  // A stale "full" from the server does not outlive a lower count.
  assert.equal(recruitState({ recruit_capacity: 3, join_count: 2, recruit_closed: 'full' }, now), null);
  assert.equal(recruitState({ recruit_closed: 'full' }, now), 'full');
  assert.equal(recruitState({ recruit_closed: 'deadline', recruit_capacity: 3, join_count: 3 }, now), 'deadline');
  assert.equal(recruitState({ recruit_deadline: '2026-10-19', recruit_capacity: 3, join_count: 3 }, now), 'deadline');
  assert.equal(recruitState({}, now), null);
  assert.equal(recruitState(null, now), null);
});

test('formatDeadlineShort drops the year only for this year (Japan time)', () => {
  const now = new Date('2026-10-20T00:00:00+09:00');
  assert.equal(formatDeadlineShort('2026-10-31', now), '10月31日まで');
  assert.equal(formatDeadlineShort('2027-01-05', now), '2027年1月5日まで');
  assert.equal(formatDeadlineShort('', now), null);
});

test('joinTerms only lists the values that exist', () => {
  const now = new Date('2026-10-20T00:00:00+09:00');
  assert.equal(joinTerms({ recruit_deadline: '2026-10-31', recruit_capacity: 10 }, now), '申込期限 10月31日まで・先着10人・');
  assert.equal(joinTerms({ recruit_deadline: '2026-10-31' }, now), '申込期限 10月31日まで・');
  assert.equal(joinTerms({ recruit_capacity: 8 }, now), '先着8人・');
  assert.equal(joinTerms({}, now), '');
});

test('joinWord says the state and who may still press', () => {
  const now = new Date('2026-10-20T00:00:00+09:00');
  const open = { recruit_deadline: '2026-10-31', recruit_capacity: 10, join_count: 3 };
  assert.deepEqual(joinWord(open, { now }), { word: '参加する', ended: false, closed: null });
  assert.equal(joinWord(open, { joined: true, now }).word, '参加済み（タップで取り消し）');
  const late = { recruit_deadline: '2026-10-10', join_count: 3 };
  assert.equal(joinWord(late, { now }).word, '受付終了');
  assert.equal(joinWord(late, { now }).ended, true);
  assert.deepEqual(joinWord(late, { joined: true, now }), { word: '参加済み（タップで取り消し）', ended: false, closed: 'deadline' });
  const full = { recruit_capacity: 3, join_count: 3 };
  assert.equal(joinWord(full, { now }).word, '満員');
  assert.equal(joinWord(full, { joined: true, now }).ended, false);
  // Without the migration the new rules are not shown or enforced here.
  assert.equal(joinWord(full, { extras: false, now }).word, '参加する');
});

test('joinRefusal reads the PostgREST message and the local detail', () => {
  assert.equal(joinRefusal('recruit_closed'), '受付は終了しました');
  assert.equal(joinRefusal('recruit_full'), '先着人数に達しました');
  assert.equal(joinRefusal('うまくいきませんでした (500)'), null);
});

test('extra prompts: hidden once used, and none when the feature is off', () => {
  const extra = [{ key: 'past', text: 'a' }, { key: 'now', text: 'b' }, { key: 'future', text: 'c' }];
  const posts = [{ prompt: 'now' }, { prompt: 'weekly' }, { prompt: null }, {}];
  assert.deepEqual([...usedPromptKeys(posts)].sort(), ['now', 'weekly']);
  assert.deepEqual(availablePrompts(extra, posts, true).map((e) => e.key), ['past', 'future']);
  assert.deepEqual(availablePrompts(extra, [], true).length, 3);
  assert.deepEqual(availablePrompts(extra, posts, false), []);
});

test('promptPlaceholder: an extra prompt shows its example sentence, the weekly one its words', () => {
  const extraPrompts = [
    { key: 'past', text: '昔がんばってたこと', example: '高校まで陸上部でした' },
    { key: 'now', text: '最近はまってること' },
  ];
  const weekly = { text: '週末の過ごし方' };
  const say = (selected) => promptPlaceholder({ selected, weekly, extraPrompts, max: 60 });
  assert.equal(say('past'), '例：高校まで陸上部でした');
  // An extra prompt without an example still names itself.
  assert.equal(say('now'), 'お題：最近はまってること');
  assert.equal(say('weekly'), 'お題：週末の過ごし方');
  assert.equal(say(null), '取り組みや活動内容（最大60文字）');
  assert.equal(say('gone'), '取り組みや活動内容（最大60文字）');
  assert.equal(promptPlaceholder({ selected: 'weekly', weekly: null, extraPrompts, max: 60 }), '取り組みや活動内容（最大60文字）');
});

test('extrasPayload: nothing when off, only filled values on create, nulls on edit', () => {
  const base = { prompt: 'past', deadline: '2026-12-31', capacity: '15' };
  assert.deepEqual(extrasPayload({ ...base, enabled: false, editing: false, recruiting: true }), {});
  assert.deepEqual(extrasPayload({ ...base, enabled: true, editing: false, recruiting: true }),
    { recruit_deadline: '2026-12-31', recruit_capacity: 15, prompt: 'past' });
  assert.deepEqual(extrasPayload({ ...base, enabled: true, editing: false, recruiting: false }), { prompt: 'past' });
  assert.deepEqual(extrasPayload({ enabled: true, editing: false, recruiting: true, prompt: null, deadline: '', capacity: '' }), {});
  assert.deepEqual(extrasPayload({ ...base, enabled: true, editing: true, recruiting: true }),
    { recruit_deadline: '2026-12-31', recruit_capacity: 15 });
  assert.deepEqual(extrasPayload({ ...base, enabled: true, editing: true, recruiting: false }),
    { recruit_deadline: null, recruit_capacity: null });
});
