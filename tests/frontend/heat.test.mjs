import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/heat.js', import.meta.url), 'utf8');
const {
  FLAME_CORE_PATH, FLAME_INNER_PATH, FLAME_OUTER_PATH, HEAT_COLORS, flameSway, getFlameScale,
  HEAT_FRAMES, getHeatTier, heatBob, heatColor, heatFrameAt, heatFrameCount, heatFrameTime,
  heatSpriteHalf, heatSpriteValue, isFlameTier, heatMorph, morphMotion, morphScale, mixHex, outlinePath,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('the four tiers start where the design says', () => {
  const tiers = [0, 30, 31, 65, 66, 90, 91, 100].map(getHeatTier);
  assert.deepEqual(tiers, ['lime', 'lime', 'orange', 'orange', 'flame', 'flame', 'blueFlame', 'blueFlame']);
  assert.deepEqual(['lime', 'orange', 'flame', 'blueFlame'].map(isFlameTier), [false, false, true, true]);
});

test('flames grow with the number, balls do not', () => {
  assert.equal(getFlameScale(10), 1);
  assert.equal(getFlameScale(65), 1);
  assert.ok(Math.abs(getFlameScale(66) - 0.8) < 1e-9);
  assert.ok(Math.abs(getFlameScale(90) - 1.1) < 1e-9);
  assert.ok(Math.abs(getFlameScale(91) - 1.1) < 1e-9);
  assert.ok(Math.abs(getFlameScale(100) - 1.3) < 1e-9);
  assert.ok(getFlameScale(80) > getFlameScale(70));
  assert.ok(getFlameScale(300) <= 1.3 + 1e-9);
});

test('each tier has its colours and the outlines are paths to draw', () => {
  assert.equal(HEAT_COLORS.lime.main, '#9BE03C');
  assert.equal(HEAT_COLORS.orange.main, '#FF9A2E');
  assert.equal(HEAT_COLORS.flame.outer, '#FF4B2B');
  assert.equal(HEAT_COLORS.blueFlame.outer, '#2F6BFF');
  assert.equal(heatColor(10), '#9BE03C');
  assert.equal(heatColor(95), '#2F6BFF');
  [FLAME_OUTER_PATH, FLAME_INNER_PATH, FLAME_CORE_PATH].forEach((path) => {
    assert.match(path, /^M [\d. ,CZ-]+Z$/);
  });
});

test('balls drift and flames sway, and holding still means no movement at all', () => {
  assert.notEqual(heatBob('lime', 1, 0), 0);
  assert.notEqual(heatBob('orange', 1, 0), 0);
  assert.equal(heatBob('flame', 1, 0), 0);
  assert.deepEqual(flameSway('flame', null), { skew: 0, sx: 1, sy: 1, innerSx: 1, innerSy: 1 });
  const calm = flameSway('flame', 3, 0);
  const wild = flameSway('blueFlame', 3, 0);
  assert.ok(Math.abs(calm.skew) <= 0.05 + 1e-9);
  assert.ok(Math.abs(wild.skew) <= 0.15 + 1e-9);
});

test('crowd sprites: similar values share a picture, flames get a few frames', () => {
  for (const v of [0, 20, 31, 50, 66, 75, 90, 91, 95, 100]) {
    const shared = heatSpriteValue(v);
    assert.equal(getHeatTier(shared), getHeatTier(v));
  }
  assert.equal(heatFrameCount('lime'), 1);
  assert.equal(heatFrameCount('orange'), 1);
  assert.equal(heatFrameCount('flame'), HEAT_FRAMES);
  assert.equal(heatFrameTime('lime', 0), null);
  assert.notEqual(heatFrameTime('blueFlame', 2), heatFrameTime('blueFlame', 3));
  for (let t = 0; t < 20; t += 0.37) {
    const f = heatFrameAt('blueFlame', t, 3.3);
    assert.ok(Number.isInteger(f) && f >= 0 && f < HEAT_FRAMES);
  }
  assert.equal(heatFrameAt('flame', null), 0);
  assert.equal(heatFrameAt('orange', 5), 0);
  // The sprite box always holds the object: bigger flames need bigger boxes.
  assert.ok(heatSpriteHalf(21, 100) > heatSpriteHalf(21, 70));
  assert.ok(heatSpriteHalf(21, 50) > 21);
});

test('the compose object changes shape and colour without a jump anywhere on the slider', () => {
  let previous = heatMorph(0);
  for (let v = 0.5; v <= 100; v += 0.5) {
    const now = heatMorph(v);
    const moved = Math.max(...now.points.map((value, i) => Math.abs(value - previous.points[i])));
    assert.ok(moved < 2, `outline jumps ${moved} at ${v}`);
    for (const key of ['flame', 'orange', 'blue']) {
      assert.ok(Math.abs(now[key] - previous[key]) < 0.15, `${key} jumps at ${v}`);
    }
    assert.ok(Math.abs(morphScale(v) - morphScale(v - 0.5)) < 0.02, `size jumps at ${v}`);
    previous = now;
  }
  // One outline, always in the flame's seven curves, so it can be blended.
  assert.equal(heatMorph(37).points.length, heatMorph(83).points.length);
  assert.match(outlinePath(heatMorph(60).points), /^M [\d. ,CZ-]+Z$/);
});

test('in the middle of each tier the compose object looks like that tier', () => {
  const lime = heatMorph(15);
  assert.equal(lime.flame, 0);
  assert.equal(lime.body.main, HEAT_COLORS.lime.main.toLowerCase());
  const orange = heatMorph(48);
  assert.equal(orange.flame, 0);
  assert.equal(orange.body.main, HEAT_COLORS.orange.main.toLowerCase());
  const flame = heatMorph(78);
  assert.equal(flame.flame, 1);
  assert.equal(flame.outer, HEAT_COLORS.flame.outer.toLowerCase());
  assert.ok(Math.abs(flame.scale - getFlameScale(78)) < 1e-9);
  const blue = heatMorph(97);
  assert.equal(blue.outer, HEAT_COLORS.blueFlame.outer.toLowerCase());
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
});

test('a ball bobs and a flame sways, blended; holding still is still', () => {
  assert.equal(morphMotion(heatMorph(15), null).bob, 0);
  assert.notEqual(morphMotion(heatMorph(15), 1).bob, 0);
  assert.equal(morphMotion(heatMorph(15), 1).skew, 0);
  assert.equal(morphMotion(heatMorph(80), 1).bob, 0);
  assert.notEqual(morphMotion(heatMorph(80), 1).skew, 0);
});
