import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/state.js', import.meta.url), 'utf8');
const { state, setPosts, upsertPost, removePost, matchesFilters, subscribe } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('OR tags combine with text and author search', () => {
  state.filters = { query: '山', tags: ['アウトドア', '音楽'] };
  assert.equal(matchesFilters({ body: '山へ行く', tags: ['音楽'] }), true);
  assert.equal(matchesFilters({ display_name: '山田', tags: ['アウトドア'] }), true);
  assert.equal(matchesFilters({ body: '山', tags: ['料理'] }), false);
  assert.equal(matchesFilters({ body: '海', tags: ['音楽'] }), false);
});

test('partial counts preserve profile data and invalidate derived energy', () => {
  const post = { id: 'one', body: 'text', energy: 50, like_count: 0 };
  state.myPosts = [post]; state.selected = post;
  setPosts([]);
  upsertPost({ id: 'one', like_count: 1 });
  assert.equal(state.postsById.get('one').body, 'text');
  assert.equal(state.postsById.get('one').energy, null);
  assert.equal(state.selected.like_count, 1);
  assert.equal(state.myPosts[0].like_count, 1);
  upsertPost({ id: 'missing', comment_count: 2 });
  assert.equal(state.postsById.has('missing'), false);
  removePost('one');
  assert.equal(state.selected, null);
  assert.equal(state.myPosts.length, 0);
});

test('subscriptions stop receiving updates after disposal', () => {
  let count = 0;
  for (let i = 0; i < 20; i++) {
    const dispose = subscribe(() => count++);
    setPosts([]); dispose();
  }
  setPosts([]);
  assert.equal(count, 20);
});
