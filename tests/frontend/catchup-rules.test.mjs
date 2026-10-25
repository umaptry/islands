import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/catchup-rules.js', import.meta.url), 'utf8');
const rules = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const row = (n, extra = {}) => ({
  id: `r${n}`, type: 'island', unread: true, post_id: `p${n}`, community_id: 'c1',
  created_at: `2026-10-26T10:${String(n).padStart(2, '0')}:00Z`, payload: { kind: 'resident', name: 'A島' }, ...extra,
});

test('only unread new-resident rows with a post are picked, oldest first', () => {
  const rows = [row(3), row(1), row(2, { unread: false }), row(4, { payload: { cause: 'x' } }),
    row(5, { type: 'like' }), row(6, { post_id: null })];
  assert.deepEqual(rules.pickCatchup(rows).map((r) => r.id), ['r1', 'r3']);
});

test('with communities on, only the community on the map; off, every community', () => {
  const rows = [row(1), row(2, { community_id: 'c2' })];
  assert.deepEqual(rules.pickCatchup(rows, { communitiesOn: true, communityId: 'c1' }).map((r) => r.id), ['r1']);
  assert.deepEqual(rules.pickCatchup(rows, { communitiesOn: true, communityId: null }), []);
  assert.deepEqual(rules.pickCatchup(rows, { communitiesOn: false }).map((r) => r.id), ['r1', 'r2']);
});

test('more than ten: the newest ten, shown oldest first', () => {
  const rows = Array.from({ length: 13 }, (_, i) => row(i + 1));
  const picked = rules.pickCatchup(rows);
  assert.equal(picked.length, 10);
  assert.equal(picked[0].id, 'r4');
  assert.equal(picked[9].id, 'r13');
});

test('a row shown (or closed) in this page is never picked twice, grouped rows included', () => {
  const rows = [row(1), row(2, { ids: ['x1', 'x2'] })];
  assert.deepEqual(rules.pickCatchup(rows, { shown: new Set(['r1']) }).map((r) => r.id), ['r2']);
  assert.deepEqual(rules.pickCatchup(rows, { shown: new Set(['x2']) }).map((r) => r.id), ['r1']);
  assert.deepEqual(rules.rowIdsOf(rows), ['r1', 'x1', 'x2']);
});

test('it opens only on a quiet map, signed in, in front', () => {
  const ok = { signedIn: true, screen: 'map' };
  assert.equal(rules.canOpenCatchup(ok), true);
  assert.equal(rules.canOpenCatchup({ ...ok, signedIn: false }), false);
  assert.equal(rules.canOpenCatchup({ ...ok, screen: 'notifications' }), false);
  assert.equal(rules.canOpenCatchup({ ...ok, sheetOpen: true }), false);
  assert.equal(rules.canOpenCatchup({ ...ok, cardOpen: true }), false);
  assert.equal(rules.canOpenCatchup({ ...ok, onboarding: 'guidance' }), false);
  assert.equal(rules.canOpenCatchup({ ...ok, active: true }), false);
  assert.equal(rules.canOpenCatchup({ ...ok, visible: false }), false);
});

test('titles, steps and gestures', () => {
  assert.equal(rules.slideTitle('はな', 'キャンプ島'), 'はなさんがキャンプ島の住人になりました');
  assert.equal(rules.slideTitle('', ''), 'だれかさんがこの島の住人になりました');
  // A name that already ends in 「さん」 is not given a second one (the push does the same).
  assert.equal(rules.slideTitle('はなさん', 'キャンプ島'), 'はなさんがキャンプ島の住人になりました');
  assert.equal(rules.slideTitle('さん', 'キャンプ島'), 'さんさんがキャンプ島の住人になりました');
  assert.equal(rules.stepText(0, 3), '1 / 3');
  assert.equal(rules.swipeAction(-80, 10), 'next');
  assert.equal(rules.swipeAction(5, -80), 'next');
  assert.equal(rules.swipeAction(80, 0), null);
  assert.equal(rules.swipeAction(-20, 0), null);
  assert.equal(rules.swipeAction(0, 80), null);
  assert.equal(rules.keyAction('ArrowRight'), 'next');
  assert.equal(rules.keyAction('ArrowLeft'), 'prev');
  assert.equal(rules.keyAction('Escape'), 'close');
  assert.equal(rules.keyAction('a'), null);
  assert.equal(rules.stepTo(0, 3, 'next'), 1);
  assert.equal(rules.stepTo(2, 3, 'next'), 'done');
  assert.equal(rules.stepTo(0, 3, 'prev'), 0);
});
