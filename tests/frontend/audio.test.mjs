import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/feedback-rules.js', import.meta.url), 'utf8');
const {
  SE_NAMES, SE_GAP_MS, audioShouldRun, maySe, ambientShouldPlay, defaultSettings,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const on = defaultSettings();
const off = { ...on, sound: false };

test('audio runs only with sound on and the tab in front', () => {
  assert.equal(audioShouldRun(on, false), true);
  assert.equal(audioShouldRun(off, false), false);
  assert.equal(audioShouldRun(on, true), false);
});

test('effects: known names only, gap respected, silent when off', () => {
  assert.deepEqual([...SE_NAMES], ['success', 'click', 'hardClick', 'pop', 'fanfare', 'switch']);
  assert.equal(maySe('pop', on, false, 0, 1000), true);
  assert.equal(maySe('nope', on, false, 0, 1000), false);
  assert.equal(maySe('pop', on, false, 1000, 1000 + SE_GAP_MS - 1), false);
  assert.equal(maySe('pop', on, false, 1000, 1000 + SE_GAP_MS), true);
  assert.equal(maySe('pop', off, false, 0, 1000), false);
  assert.equal(maySe('pop', on, true, 0, 1000), false);
});

test('ambience needs the map wanting it as well', () => {
  assert.equal(ambientShouldPlay(true, on, false), true);
  assert.equal(ambientShouldPlay(false, on, false), false);
  assert.equal(ambientShouldPlay(true, off, false), false);
  assert.equal(ambientShouldPlay(true, on, true), false);
});

test('switching community has a sound, a short buzz and a wash under 600 ms', async () => {
  const rules = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.equal(maySe('switch', on, false, 0, 1000), true);
  assert.equal(maySe('switch', off, false, 0, 1000), false);
  assert.deepEqual(rules.buzzFor('switch', { vibrate: true }), [12, 50, 22]);
  assert.equal(rules.buzzFor('switch', { vibrate: false }), null);
  assert.ok(rules.SWITCH_FX_MS > 0 && rules.SWITCH_FX_MS <= 600);
});
