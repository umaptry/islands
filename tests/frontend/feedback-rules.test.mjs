import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/feedback-rules.js', import.meta.url), 'utf8');
const rules = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('nothing chosen yet: sound and buzz on, motion follows the system', () => {
  assert.deepEqual(rules.parseSettings(null), { sound: true, vibrate: true, reduceMotion: false });
  assert.deepEqual(rules.parseSettings('', true), { sound: true, vibrate: true, reduceMotion: true });
});

test('saved settings are read, and anything odd falls back to the default', () => {
  assert.deepEqual(rules.parseSettings('{"sound":false,"vibrate":true,"reduceMotion":true}'),
    { sound: false, vibrate: true, reduceMotion: true });
  assert.deepEqual(rules.parseSettings('{"sound":"no","extra":1}'), { sound: true, vibrate: true, reduceMotion: false });
  assert.deepEqual(rules.parseSettings('not json'), { sound: true, vibrate: true, reduceMotion: false });
  assert.deepEqual(rules.parseSettings('[1,2]'), { sound: true, vibrate: true, reduceMotion: false });
});

test('sound only in the three moments, never twice in quick succession', () => {
  const on = { sound: true };
  for (const moment of ['post', 'connect', 'notify']) assert.equal(rules.maySound(moment, on, 0, 1000), true);
  assert.equal(rules.maySound('react', on, 0, 1000), false);
  assert.equal(rules.maySound('tap', on, 0, 1000), false);
  assert.equal(rules.maySound('post', { sound: false }, 0, 1000), false);
  assert.equal(rules.maySound('post', on, 1000, 1000 + rules.SOUND_GAP_MS - 1), false);
  assert.equal(rules.maySound('post', on, 1000, 1000 + rules.SOUND_GAP_MS), true);
});

test('buzz follows the setting and stays short', () => {
  assert.equal(rules.buzzFor('tap', { vibrate: true }), 8);
  assert.deepEqual(rules.buzzFor('post', { vibrate: true }), [14, 60, 22]);
  assert.equal(rules.buzzFor('tap', { vibrate: false }), null);
  assert.equal(rules.buzzFor('unknown', { vibrate: true }), null);
  for (const pattern of Object.values(rules.BUZZ)) {
    const total = [].concat(pattern).reduce((a, b) => a + b, 0);
    assert.ok(total <= 120, `buzz too long: ${total}ms`);
  }
});

test('a signed-out reader key is made and recognised', () => {
  const key = rules.makeViewerKey(new Uint8Array([0, 1, 15, 16, 255, 171, 205, 239]));
  assert.equal(key, 'anon:00010f10ffabcdef');
  assert.equal(rules.isViewerKey(key), true);
  assert.equal(rules.isViewerKey('anon:short'), false);
  assert.equal(rules.isViewerKey('user-id'), false);
  assert.equal(rules.isViewerKey(null), false);
});
