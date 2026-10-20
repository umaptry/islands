import test from 'node:test';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';

// No package.json "type" in this folder: load the module as a data: URL like the other tests.
const source = await readFile(new URL('../../web/js/image-viewer-rules.js', import.meta.url), 'utf8');
const { dragBackdrop, shouldDismissSwipe, viewerActions } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('a long pull down closes the viewer; a short slow one does not', () => {
  assert.equal(shouldDismissSwipe({ dx: 5, dy: 140, elapsedMs: 900 }), true);
  assert.equal(shouldDismissSwipe({ dx: 5, dy: 60, elapsedMs: 900 }), false);
});

test('a short quick flick down closes it', () => {
  assert.equal(shouldDismissSwipe({ dx: 0, dy: 60, elapsedMs: 80 }), true);
  assert.equal(shouldDismissSwipe({ dx: 0, dy: 30, elapsedMs: 20 }), false);
});

test('upwards, sideways and mostly-sideways pulls never close it', () => {
  assert.equal(shouldDismissSwipe({ dx: 0, dy: -300, elapsedMs: 100 }), false);
  assert.equal(shouldDismissSwipe({ dx: 300, dy: 20, elapsedMs: 100 }), false);
  assert.equal(shouldDismissSwipe({ dx: 200, dy: 150, elapsedMs: 100 }), false);
  assert.equal(shouldDismissSwipe(), false);
});

test('the backdrop thins as the image is pulled down, never below a quarter', () => {
  assert.equal(dragBackdrop(0), 1);
  assert.equal(dragBackdrop(-20), 1);
  assert.ok(dragBackdrop(100, 800) < 1 && dragBackdrop(100, 800) > 0.25);
  assert.equal(dragBackdrop(5000, 800), 0.25);
});

test('the reaction bar: messages, いいね, 手伝えるかも - never 参加; messages press only where the card can open them', () => {
  const withComments = viewerActions({ hasComments: true });
  assert.deepEqual(withComments.map((a) => a.kind), ['comments', 'like', 'help']);
  assert.ok(withComments.every((a) => a.pressable));
  const without = viewerActions({ hasComments: false });
  assert.equal(without[0].pressable, false);
  assert.ok(without.slice(1).every((a) => a.pressable));
});
