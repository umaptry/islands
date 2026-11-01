import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/return-post.js', import.meta.url), 'utf8');
const rules = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const ID = '6f1c1b0e-5a53-4a43-9a52-3b8f0c2d9e11';
const HOUR = 3600 * 1000;

const fakeStorage = ({ failRead = false, failWrite = false } = {}) => {
  const map = new Map();
  return {
    getItem: (key) => { if (failRead) throw new Error('blocked'); return map.has(key) ? map.get(key) : null; },
    setItem: (key, value) => { if (failWrite) throw new Error('blocked'); map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    map,
  };
};

test.beforeEach(() => rules.resetPendingMemory());

// ---------------------------------------------------------------- the address

test('#/map?post=<id> is read; any other address is not', () => {
  assert.equal(rules.postIdFromHash(`#/map?post=${ID}`), ID);
  assert.equal(rules.postIdFromHash(`#/map?x=1&post=${ID}`), ID);
  assert.equal(rules.postIdFromHash('#/map'), null);
  assert.equal(rules.postIdFromHash('#/map?post='), null);
  assert.equal(rules.postIdFromHash(`#/me?post=${ID}`), null, 'only the map takes a post');
  assert.equal(rules.postIdFromHash(`#/map/x?post=${ID}`), null);
  assert.equal(rules.postIdFromHash(''), null);
  assert.equal(rules.postIdFromHash(undefined), null);
});

test('an id that could be markup or a path is refused', () => {
  for (const bad of ['<script>', 'a/b', '../x', 'a b', '', 'x'.repeat(65), 'あ']) {
    assert.equal(rules.validPostId(bad), false, bad);
    assert.equal(rules.postIdFromHash(`#/map?post=${encodeURIComponent(bad)}`), null, bad);
  }
  assert.equal(rules.validPostId(ID), true);
  assert.equal(rules.validPostId('p_1-A'), true);
  assert.equal(rules.validPostId(42), false);
});

test('the link that opens a post', () => {
  assert.equal(rules.mapLinkFor(ID), `#/map?post=${ID}`);
  assert.equal(rules.mapLinkFor('<x>'), '#/map');
  assert.equal(rules.postIdFromHash(rules.mapLinkFor(ID)), ID, 'a link round-trips');
});

// ---------------------------------------------------------------- remembering

test('save, read and take: the post is opened once', () => {
  const storage = fakeStorage();
  assert.equal(rules.readPendingPost(storage, 1000), null);
  assert.equal(rules.savePendingPost(storage, ID, 1000), true);
  assert.equal(rules.readPendingPost(storage, 2000), ID);
  assert.equal(rules.readPendingPost(storage, 2000), ID, 'reading does not use it up');
  assert.equal(rules.takePendingPost(storage, 3000), ID);
  assert.equal(rules.readPendingPost(storage, 3000), null);
  assert.equal(storage.map.size, 0);
});

test('it survives a page that is gone and back (a Google round trip): the storage is the memory', () => {
  const storage = fakeStorage();
  rules.savePendingPost(storage, ID, 5000);
  rules.resetPendingMemory();   // the page was reloaded
  assert.equal(rules.readPendingPost(storage, 6000), ID);
});

test('a bad id is not saved', () => {
  const storage = fakeStorage();
  assert.equal(rules.savePendingPost(storage, '<x>'), false);
  assert.equal(rules.savePendingPost(storage, null), false);
  assert.equal(storage.map.size, 0);
  assert.equal(rules.readPendingPost(storage), null);
});

test('an old or odd value is ignored', () => {
  const storage = fakeStorage();
  rules.savePendingPost(storage, ID, 0);
  rules.resetPendingMemory();
  assert.equal(rules.readPendingPost(storage, rules.RETURN_TTL_MS), ID, 'still good on the last moment');
  assert.equal(rules.readPendingPost(storage, rules.RETURN_TTL_MS + HOUR), null, 'too old');
  assert.equal(rules.readPendingPost(storage, -rules.RETURN_TTL_MS - HOUR), null, 'from the future');

  for (const raw of ['not json', '{}', '{"id":"<x>","at":1}', '{"id":"ok","at":"soon"}', 'null']) {
    storage.map.set(rules.RETURN_KEY, raw);
    assert.equal(rules.readPendingPost(storage, 1), null, raw);
  }
});

test('a newer link replaces an older one', () => {
  const storage = fakeStorage();
  rules.savePendingPost(storage, 'first', 1000);
  rules.savePendingPost(storage, 'second', 2000);
  assert.equal(rules.takePendingPost(storage, 3000), 'second');
});

test('without usable storage it is kept in memory for this page, and nothing throws', () => {
  const noWrite = fakeStorage({ failWrite: true });
  assert.equal(rules.savePendingPost(noWrite, ID, 1000), true);
  assert.equal(rules.readPendingPost(noWrite, 2000), ID);
  assert.equal(rules.takePendingPost(noWrite, 2000), ID);
  assert.equal(rules.readPendingPost(noWrite, 2000), null);

  const noRead = fakeStorage({ failRead: true });
  rules.savePendingPost(noRead, ID, 1000);
  assert.equal(rules.readPendingPost(noRead, 2000), ID);

  assert.equal(rules.savePendingPost(null, ID, 1000), true);
  assert.equal(rules.readPendingPost(null, 2000), ID);
  assert.doesNotThrow(() => rules.clearPendingPost(null));
  assert.equal(rules.readPendingPost(null, 2000), null);
});

test('clearing forgets both the storage and the memory', () => {
  const storage = fakeStorage();
  rules.savePendingPost(storage, ID, 1000);
  rules.clearPendingPost(storage);
  assert.equal(rules.readPendingPost(storage, 1500), null);
  assert.equal(storage.map.size, 0);
});

test('the 会 of an invite QR is kept for a day, until it is joined', () => {
  rules.resetPendingMemory();
  const storage = fakeStorage();
  const now = Date.UTC(2026, 9, 31, 1);
  assert.equal(rules.saveInviteJoin(storage, ID, now), true);
  assert.equal(rules.readInviteJoin(storage, now + 23 * HOUR), ID);
  assert.equal(rules.readInviteJoin(storage, now + 25 * HOUR), null);
  // the post to open is a separate memory: taking it does not drop the join
  assert.equal(rules.takePendingPost(storage, now), null);
  assert.equal(rules.readInviteJoin(storage, now), ID);
  rules.clearInviteJoin(storage);
  assert.equal(rules.readInviteJoin(storage, now), null);
  assert.equal(rules.saveInviteJoin(storage, '../etc', now), false);
});

test('承認を待つ間は、招待の投稿と会への参加を長く預かる（普通の期限を超えても残る）', async () => {
  const mod = await import(new URL('../../web/js/return-post.js', import.meta.url));
  const store = (() => { const map = new Map(); return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) }; })();
  const HOUR = 3600 * 1000;
  const t0 = Date.parse('2026-11-01T00:00:00Z');
  mod.resetPendingMemory();
  mod.savePendingPost(store, 'post-a', t0, mod.WAITING_HOLD_MS);
  mod.saveInviteJoin(store, 'post-b', t0, mod.WAITING_HOLD_MS);
  assert.equal(mod.readPendingPost(store, t0 + 7 * 24 * HOUR), 'post-a', '6時間より長く残る');
  assert.equal(mod.readInviteJoin(store, t0 + 7 * 24 * HOUR), 'post-b', '1日より長く残る');
  assert.equal(mod.readPendingPost(store, t0 + 15 * 24 * HOUR), null, '14日で切れる');
  // 預かりを頼まなかった普通の保存は、今までの期限のまま
  mod.resetPendingMemory();
  mod.savePendingPost(store, 'post-c', t0);
  assert.equal(mod.readPendingPost(store, t0 + 5 * HOUR), 'post-c');
  assert.equal(mod.readPendingPost(store, t0 + 7 * HOUR), null);
});
