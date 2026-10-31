import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HOUSE_BODY, houseSpot, houseTurn } from '../../web/js/map/mesh.js';

// decor.js's hashId (FNV-1a); decor.js needs a window, so it is copied here.
function hashId(id) {
  let hash = 2166136261;
  const text = String(id);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// A house is placed by its body at the turn it is drawn at (2026-10-31, the
// user: all the way in, the face stood on the house's roof). hashId runs to
// 2^32 - 1; from 2^31 on `seed | 0` is negative, and the placing and the
// drawing used to disagree on the turn for a third of the posts.

const BIG = 3814209490;   // over 2^31

test('the turn: one rule, the same as the drawing always used, for seeds over 2^31 too', () => {
  assert.ok(BIG >= 2 ** 31);
  // What drawHouse drew before: kept, so no house on the map turns.
  const drawn = (seed) => Math.abs(seed | 0) % 6;
  [0, 1, 5, 6, 7, 2 ** 31 - 1, 2 ** 31, BIG, 2 ** 32 - 1, 4000000001].forEach((seed) => {
    const turn = houseTurn(seed);
    assert.equal(turn, drawn(seed), `seed ${seed}`);
    assert.ok(Number.isInteger(turn) && turn >= 0 && turn < 6);
  });
  // The old placing took seed % 6, which differs here.
  assert.notEqual(BIG % 6, houseTurn(BIG));
});

test('the drawing, the night lights and the placing all ask houseTurn', async () => {
  const buildings = await readFile(new URL('../../web/js/map/buildings.js', import.meta.url), 'utf8');
  const index = await readFile(new URL('../../web/js/map/index.js', import.meta.url), 'utf8');
  assert.match(buildings, /const turn = houseTurn\(seed\);/);
  assert.match(buildings, /const turn = houseTurn\(what\.seed\);/);
  assert.doesNotMatch(buildings, /seed \| 0\) % 6/);
  assert.match(index, /houseSpot\(point\.x, point\.y, clear, houseSize, tier, seed\)/);
  assert.doesNotMatch(index, /HOUSE_BODY/);
});

/** How far the house's body reaches into the circle of radius `r` round the pin
 * (px, py), in px; 0 when it keeps out. The body reaches HOUSE_BODY of the
 * drawn turn left of x and below foot. */
function intrusion(px, py, r, spot, size, tier, drawnTurn) {
  const body = HOUSE_BODY[tier][drawnTurn];
  const left = spot.x - body[0] * size;
  const bottom = spot.foot + body[1] * size;
  // The body lies right of `left` and above `bottom`: its nearest point to the pin.
  const nx = Math.max(px, left);
  const ny = Math.min(py, bottom);
  return Math.max(0, r - Math.hypot(nx - px, ny - py));
}

test('all the way in, a manor or castle never stands on its face', () => {
  const seeds = [BIG, 2 ** 31, 2 ** 32 - 1, 1, 2, 3, 4, 5];
  for (let i = 0; i < 400; i += 1) seeds.push(hashId(`post-${i}`));
  assert.ok(seeds.filter((s) => s >= 2 ** 31).length > 100);
  // A phone's and a desktop's largest house sizes (px), and a face's reach.
  [60, 120].forEach((size) => {
    const reach = 15;
    const gap = 3;
    const clear = gap + reach;
    [2, 3].forEach((tier) => {
      seeds.forEach((seed) => {
        const spot = houseSpot(200, 400, clear, size, tier, seed);
        const deep = intrusion(200, 400, reach, spot, size, tier, houseTurn(seed));
        assert.equal(deep, 0, `size ${size} tier ${tier} seed ${seed}: ${deep.toFixed(1)} px on the face`);
      });
    });
  });
});
