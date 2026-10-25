import test from 'node:test';
import assert from 'node:assert/strict';
import { PIN_CLEAR, boxClear, clearTownSpot, landmarkSlots, markBox, townBox } from '../../web/js/map/spots.js';

// An island that is land everywhere within 40 of (0, 0).
const land = (x, y) => Math.hypot(x, y) < 40;
const stands = (x, y, span, ground) => ground(x, y) && ground(x - span * 0.45, y) && ground(x + span * 0.45, y) && ground(x, y - span * 0.85);
const island = { cx: 0, cy: 0 };
const fit = { ring: 4, span: 4, grown: false, land, stands };
const dims = { unit: 4.5, markMin: 2.6, spots: [[0.2, -0.4], [-0.8, 0.14], [0.82, 0.16]] };

test('a box is clear when every post is at least the margin away from it', () => {
  assert.equal(boxClear([{ x: 10, y: 10 }], 0, 0, 4, 4, 3), true);
  assert.equal(boxClear([{ x: 6, y: 2 }], 0, 0, 4, 4, 3), false);
  assert.equal(boxClear([{ x: 2, y: 2 }], 0, 0, 4, 4, 3), false, 'a post inside the box');
  assert.equal(boxClear([], 0, 0, 4, 4), true);
});

test('the town stands in the middle when nothing is there, and moves off a post that is', () => {
  const free = clearTownSpot([{ x: 20, y: 20 }], island, fit);
  assert.deepEqual([free.x, free.y], [0, 0]);
  // A post exactly where the town would stand: it goes beside it, not under the pin.
  const posts = [{ x: 0, y: 0 }, { x: 10, y: 5 }];
  const spot = clearTownSpot(posts, island, fit);
  assert.ok(spot);
  assert.ok(boxClear(posts, ...townBox(spot.x, spot.y, fit.span)));
});

test('no spot clear of every pin: null, so the old choice can be used', () => {
  // Posts all over the island.
  const posts = [];
  for (let x = -36; x <= 36; x += 3) for (let y = -36; y <= 36; y += 3) posts.push({ x, y });
  assert.equal(clearTownSpot(posts, island, fit), null);
});

test('landmark spots move off a pin onto clear land, and keep apart', () => {
  const at = { x: 0, y: 0 };
  const quiet = landmarkSlots(at, 4, [], land, dims);
  assert.equal(quiet.length, 3);
  assert.ok(quiet.every((slot) => slot.land));
  // A pin on the second spot: that landmark is moved.
  const second = quiet[1];
  const posts = [{ x: second.x, y: second.y }];
  const moved = landmarkSlots(at, 4, posts, land, dims);
  moved.forEach((slot) => assert.ok(slot.land));
  assert.ok(boxClear(posts, ...markBox(moved[1].x, moved[1].y, Math.max(dims.markMin, 4 * 0.8))), 'the moved landmark is clear of the pin');
  assert.deepEqual([moved[0].x, moved[0].y], [quiet[0].x, quiet[0].y], 'the others stay');
  const size = Math.max(dims.markMin, 4 * 0.8);
  for (let i = 0; i < 3; i += 1) for (let j = i + 1; j < 3; j += 1) {
    assert.ok(Math.hypot(moved[i].x - moved[j].x, moved[i].y - moved[j].y) >= size - 1e-9, 'landmarks do not stack');
  }
});

test('a landmark spot that is in the sea stays in the sea (not drawn); no clear spot left: it stays where it was', () => {
  const edge = { x: 38.5, y: 0 };
  const seaward = landmarkSlots(edge, 4, [], land, dims);
  assert.ok(seaward.some((slot) => !slot.land));
  // Pins everywhere round the town: every landmark keeps its own usual spot.
  const posts = [];
  for (let x = -30; x <= 30; x += 1.5) for (let y = -30; y <= 30; y += 1.5) posts.push({ x, y });
  const crowded = landmarkSlots({ x: 0, y: 0 }, 4, posts, land, dims);
  const usual = dims.spots.map(([dx, dy]) => [dx * dims.unit, dy * dims.unit]);
  crowded.forEach((slot, i) => assert.deepEqual([slot.x, slot.y], usual[i]));
  assert.ok(PIN_CLEAR > 0);
});
