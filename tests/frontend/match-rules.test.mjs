import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// No package.json "type" in this folder: load the module as a data: URL like the other tests.
const source = await readFile(new URL('../../web/js/match-rules.js', import.meta.url), 'utf8');
const rules = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const {
  MATCH_MAX, BEAM_STAGGER_MS, BEAM_GROW_MS, usableMatches, matchView, slideIndex, beamProgress, beamStyle,
  cardPost,
} = rules;

test('only rows with an id and a place are used, three at most', () => {
  const rows = [
    { id: 'a', x: 1, y: 2 }, { id: 'b', x: null, y: 2 }, { x: 1, y: 1 }, { id: 'c', x: '3', y: '4' },
    { id: 'd', x: 0, y: 0 }, { id: 'e', x: 5, y: 5 },
  ];
  assert.equal(MATCH_MAX, 3);
  assert.deepEqual(usableMatches(rows).map((row) => row.id), ['a', 'c', 'd']);
  assert.deepEqual(usableMatches(null), []);
  assert.deepEqual(usableMatches('x'), []);
});

test('the camera holds the new post and everyone, between the whole map and three times closer', () => {
  const from = { x: 0, y: 0 };
  const targets = [{ x: 100, y: 0 }, { x: 0, y: 60 }];
  const view = matchView({ from, targets, width: 390, height: 800, fit: 1, covered: 400 });
  assert.equal(view.x, 50);
  assert.equal(view.y, 30);
  assert.ok(view.scale >= 1 && view.scale <= 3);
  // every point lands inside the width at that scale
  assert.ok(100 * view.scale <= 390);
  assert.equal(view.anchorX, null);
  // the middle of what the sheet leaves free (between the bar at the top and the sheet)
  assert.equal(view.anchorY, 64 + (800 - 400 - 64 - 16) / 2);
  // people on top of each other do not zoom in past three times
  const close = matchView({ from, targets: [{ x: 0.1, y: 0.1 }], width: 390, height: 800, fit: 100, covered: 400 });
  assert.ok(Math.abs(close.scale - ((800 - 400 - 64 - 16) * 0.85) / 2.2) < 1e-9);   // the room kept round a lone pair
  assert.ok(close.scale <= 300);
  // a far-off person pulls back to the whole map, never beyond
  const far = matchView({ from, targets: [{ x: 5000, y: 5000 }], width: 390, height: 800, fit: 100 });
  assert.equal(far.scale, 100);
});

test('on a wide screen the sheet is at the left: the centre moves into the free part', () => {
  const view = matchView({
    from: { x: 0, y: 0 }, targets: [{ x: 50, y: 50 }], width: 1366, height: 768, fit: 2, desktop: true,
  });
  assert.equal(view.anchorY, 384);
  assert.equal(view.anchorX, 432 + (1366 - 432) / 2);
});

test('the scroll position tells which card is in view', () => {
  assert.equal(slideIndex(0, 300, 3), 0);
  assert.equal(slideIndex(149, 300, 3), 0);
  assert.equal(slideIndex(151, 300, 3), 1);
  assert.equal(slideIndex(600, 300, 3), 2);
  assert.equal(slideIndex(9999, 300, 3), 2);
  assert.equal(slideIndex(-40, 300, 3), 0);
  assert.equal(slideIndex(100, 0, 3), 0);
  assert.equal(slideIndex(100, 300, 0), 0);
  assert.equal(slideIndex(NaN, 300, 3), 0);
});

test('the lines grow one after another, and all at once under reduced motion', () => {
  assert.equal(beamProgress(0, 0), 0);
  assert.equal(beamProgress(BEAM_GROW_MS / 2, 0), 0.5);
  assert.equal(beamProgress(BEAM_GROW_MS, 0), 1);
  assert.equal(beamProgress(BEAM_STAGGER_MS, 1), 0);
  assert.equal(beamProgress(BEAM_STAGGER_MS + BEAM_GROW_MS, 1), 1);
  assert.equal(beamProgress(-100, 0), 0);
  assert.equal(beamProgress(0, 2, { reduced: true }), 1);
});

test('the line under the card in view is bold; with the cards closed all become the white dotted look', () => {
  const bold = beamStyle(1, 1);
  const thin = beamStyle(0, 1);
  assert.ok(bold.width > thin.width && bold.alpha > thin.alpha);
  assert.deepEqual(beamStyle(0, -1), beamStyle(2, -1));
  // the same width and alpha as KIN in lines.js
  assert.deepEqual(beamStyle(0, -1), { width: 1.2, alpha: 0.6, closed: true });
  assert.ok(!beamStyle(0, 1).closed && !beamStyle(1, 1).closed);
});

test('a card uses the row the map holds, else the server row with defaults filled in', () => {
  const row = { id: 'p', display_name: 'あき', body: 'こんにちは', x: 1, y: 2, tags: null };
  const bare = cardPost(row);
  assert.deepEqual([bare.like_count, bare.help_count, bare.join_count, bare.comment_count], [0, 0, 0, 0]);
  assert.deepEqual(bare.tags, []);
  assert.equal(bare.motivation, 50);
  assert.equal(bare.display_name, 'あき');
  const held = { id: 'p', display_name: 'あき', body: 'こんにちは', like_count: 4, tags: ['気軽に話しかけて'], motivation: 70 };
  const merged = cardPost(row, held);
  assert.equal(merged.like_count, 4);
  assert.deepEqual(merged.tags, ['気軽に話しかけて']);
  assert.equal(merged.motivation, 70);
  assert.equal(merged.x, 1);
});
