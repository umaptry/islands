import test from 'node:test';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';

// No package.json "type" in this folder: load the module as a data: URL like the other tests.
const source = await readFile(new URL('../../web/js/zoom-guard.js', import.meta.url), 'utf8');
const { blocksGesture, blocksPinchMove } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('every WebKit gesture event is cancelled', () => {
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) assert.equal(blocksGesture(type), true);
  assert.equal(blocksGesture('touchmove'), false);
  assert.equal(blocksGesture('click'), false);
});

test('a two-finger move off the map is cancelled, on the map it is left alone', () => {
  assert.equal(blocksPinchMove(2, false), true);
  assert.equal(blocksPinchMove(3, false), true);
  assert.equal(blocksPinchMove(2, true), false);
});

test('one finger always scrolls or taps normally', () => {
  assert.equal(blocksPinchMove(1, false), false);
  assert.equal(blocksPinchMove(1, true), false);
  assert.equal(blocksPinchMove(0, false), false);
});
