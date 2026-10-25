import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// No package.json "type" in this folder: load the module as a data: URL like the other tests.
const source = await readFile(new URL('../../web/js/nearby-rules.js', import.meta.url), 'utf8');
const { nearestPosts, NEARBY_MAX } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const ME = 'me';
const post = (id, author, x, y, extra = {}) => ({ id, author_id: author, x, y, ...extra });
const at = { x: 0, y: 0 };

test('nearest first, one post per person, at most three', () => {
  const posts = [
    post('far', 'a', 90, 0), post('b1', 'b', 10, 0), post('c1', 'c', 5, 0), post('d1', 'd', 20, 0),
    post('a-near', 'a', 1, 0), post('a-mid', 'a', 30, 0), post('e1', 'e', 3, 0),
  ];
  assert.equal(NEARBY_MAX, 3);
  assert.deepEqual(nearestPosts(posts, at).map((p) => p.id), ['a-near', 'e1', 'c1']);
});

test('the same person is listed once, by their nearest post', () => {
  const posts = [post('x2', 'x', 8, 0), post('x1', 'x', 2, 0), post('y1', 'y', 5, 0)];
  assert.deepEqual(nearestPosts(posts, at).map((p) => p.id), ['x1', 'y1']);
});

test('my own posts, deleted posts and posts without a place are left out', () => {
  const posts = [
    post('mine', ME, 1, 0), post('del', 'a', 2, 0, { deleted_at: '2026-10-25T00:00:00Z' }),
    post('gone', 'b', 3, 0), post('nox', 'c', undefined, 0), post('ok', 'd', 4, 0),
  ];
  assert.deepEqual(nearestPosts(posts, at, { meId: ME, gone: new Set(['gone']) }).map((p) => p.id), ['ok']);
});

test('nothing near, no place, or no list gives an empty list', () => {
  assert.deepEqual(nearestPosts([], at), []);
  assert.deepEqual(nearestPosts([post('a', 'a', 1, 1)], null), []);
  assert.deepEqual(nearestPosts([post('a', 'a', 1, 1)], { x: NaN, y: 0 }), []);
  assert.deepEqual(nearestPosts(null, at), []);
});

test('equal distances keep a stable order, and limit is respected', () => {
  const posts = [post('b', 'p2', 3, 0), post('a', 'p1', 0, 3), post('c', 'p3', -3, 0)];
  assert.deepEqual(nearestPosts(posts, at).map((p) => p.id), ['a', 'b', 'c']);
  assert.deepEqual(nearestPosts(posts, at, { limit: 2 }).map((p) => p.id), ['a', 'b']);
});
