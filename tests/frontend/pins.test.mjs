import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const load = async (path) => readFile(new URL(`../../web/js/${path}`, import.meta.url), 'utf8');
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const palette = dataUrl(await load('map/palette.js'));
const heat = dataUrl(await load('heat.js'));
const source = (await load('map/pins.js'))
  .replace("'./palette.js'", () => `'${palette}'`)
  .replace("'../heat.js'", () => `'${heat}'`);
const pins = await import(dataUrl(source));

test('the four tiers start at 31 / 66 / 91, like heat.js', () => {
  const tiers = [0, 30, 31, 65, 66, 90, 91, 100].map(pins.pinTier);
  assert.deepEqual(tiers, ['low', 'low', 'mid', 'mid', 'flame', 'flame', 'top', 'top']);
});

test('pinColor is re-exported', () => {
  assert.equal(pins.pinColor(10), '#3F9C8E');
  assert.equal(pins.pinColor(95), '#2F63F0');
});

test('pinGeometry puts the head above the tip and grows with heat and size', () => {
  const g = pins.pinGeometry(18, 50);
  assert.equal(g.headR, 9);
  assert.equal(g.headY, -17);
  assert.ok(g.top < g.headY - g.headR + 1);
  assert.ok(pins.pinGeometry(36, 50).headR === 18);
  assert.ok(pins.pinGeometry(22, 95).headR > pins.pinGeometry(22, 70).headR);
  assert.ok(pins.pinGeometry(22, 70).headR > pins.pinGeometry(22, 50).headR);
  // A flame reaches above the head; a selected pin is bigger.
  assert.ok(pins.pinGeometry(22, 80).top < pins.pinGeometry(22, 50).top);
  assert.ok(pins.pinGeometry(22, 50, true).headR > pins.pinGeometry(22, 50).headR);
});

test('only flame tiers have moving pictures, and a still time is frame 0', () => {
  assert.equal(pins.pinFrame(80, null), 0);
  assert.equal(pins.pinFrame(20, 3.3), 0);
  assert.equal(pins.pinFrame(50, 3.3), 0);
  const seen = new Set();
  for (let t = 0; t < 0.9; t += 0.01) seen.add(pins.pinFrame(80, t));
  assert.equal(seen.size, 8);
  assert.equal(pins.pinFrame(80, 0.9), pins.pinFrame(80, 0));
  assert.equal(pins.pinFrame(95, 0.6), pins.pinFrame(95, 0));
});

test('the sprite key tells apart every look that changes the picture', () => {
  const base = { dpr: 2, tier: 'mid', frame: 0, size: 22, gold: false, selected: false, initial: 'A' };
  const keys = new Set([pins.pinSpriteKey(base)]);
  for (const change of [{ dpr: 1 }, { tier: 'low' }, { frame: 3 }, { size: 30 }, { gold: true }, { selected: true }, { initial: 'B' }]) {
    keys.add(pins.pinSpriteKey({ ...base, ...change }));
  }
  assert.equal(keys.size, 8);
  assert.equal(pins.pinSpriteKey(base), pins.pinSpriteKey({ ...base }));
});

test('drawPostPin gives back a flat result for a bad size and does not throw', () => {
  const ctx = { getTransform: () => ({ a: 1 }) };
  for (const size of [0, -5, NaN]) {
    assert.deepEqual(pins.drawPostPin(ctx, 10, 100, { size }), { top: 100, headY: 100, headR: 0 });
  }
  assert.equal(pins.drawMiniPin(ctx, 10, 100, { size: -3 }), undefined);
});
