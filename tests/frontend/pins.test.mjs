import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const load = async (path) => readFile(new URL(`../../web/js/${path}`, import.meta.url), 'utf8');
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const palette = dataUrl(await load('map/palette.js'));
const heat = dataUrl(await load('heat.js'));
// avatars.js reaches for the network layer; the pins only need these two, so stand in for them.
const drawn = [];
globalThis.__faceDrawn = drawn;
const avatars = dataUrl(`
  export const faceKey = (who) => (who.avatar_path ? (globalThis.__photoReady ? 'photo:' + who.avatar_path : null) : 'emoji:3');
  export const drawFace = (c, who) => globalThis.__faceDrawn.push(who);
`);
const source = (await load('map/pins.js'))
  .replace("'../avatars.js'", () => `'${avatars}'`)
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

test('pinGeometry centres the round badge on the place and grows with heat and size', () => {
  const g = pins.pinGeometry(18, 50);
  assert.equal(g.headR, 9);
  assert.equal(g.headY, 0);
  assert.ok(g.top < g.headY - g.headR + 1 && g.top > g.headY - g.headR - 2);
  assert.ok(pins.pinGeometry(36, 50).headR === 18);
  assert.ok(pins.pinGeometry(22, 95).headR > pins.pinGeometry(22, 70).headR);
  assert.ok(pins.pinGeometry(22, 70).headR > pins.pinGeometry(22, 50).headR);
  // A flame reaches above the badge; a selected pin is bigger.
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
  // A face is part of the key; the initial no longer is once a face shows.
  const faced = pins.pinSpriteKey({ ...base, face: 'photo:a.jpg' });
  assert.notEqual(faced, pins.pinSpriteKey(base));
  assert.notEqual(faced, pins.pinSpriteKey({ ...base, face: 'photo:b.jpg' }));
  assert.notEqual(faced, pins.pinSpriteKey({ ...base, face: 'emoji:3' }));
  assert.equal(faced, pins.pinSpriteKey({ ...base, face: 'photo:a.jpg', initial: 'Z' }));
});

test('a pin shows the initial until the photo is ready, then the face, from another sprite', () => {
  const target = { getTransform: () => ({ a: 1 }), globalAlpha: 1, texts: 0 };
  const ctx = new Proxy(target, {
    get: (t, name) => (name === 'fillText' ? () => { t.texts += 1; } : name in t ? t[name] : () => ({ addColorStop() {} })),
    set: (t, name, value) => { t[name] = value; return true; },
  });
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return ctx; } };
  pins.clearPinCache();
  drawn.length = 0;
  const opts = { heat: 50, size: 22, initial: 'A', face: { icon_id: 'photo', avatar_path: 'a.jpg' } };
  globalThis.__photoReady = false;
  pins.drawPostPin(ctx, 10, 10, opts);
  assert.equal(drawn.length, 0);
  assert.ok(target.texts > 0);
  globalThis.__photoReady = true;
  pins.drawPostPin(ctx, 10, 10, opts);
  assert.equal(drawn.length, 1);
  pins.drawPostPin(ctx, 10, 10, opts);   // cached now: not painted again
  assert.equal(drawn.length, 1);
});

test('drawPostPin gives back a flat result for a bad size and does not throw', () => {
  const ctx = { getTransform: () => ({ a: 1 }) };
  for (const size of [0, -5, NaN]) {
    assert.deepEqual(pins.drawPostPin(ctx, 10, 100, { size }), { top: 100, headY: 100, headR: 0 });
  }
  assert.equal(pins.drawMiniPin(ctx, 10, 100, { size: -3 }), undefined);
});

test('pinReach adds the あなた tag over yours, and a flame reaches higher than a plain pin', () => {
  assert.equal(pins.pinReach(22, 50), pins.pinGeometry(22, 50).top);
  assert.ok(pins.pinReach(22, 50, true) < pins.pinReach(22, 50));
  assert.ok(pins.pinReach(22, 80) < pins.pinReach(22, 50));
});

test('the pin is centred on its place: the badge circle sits at (x, y)', () => {
  const target = { getTransform: () => ({ a: 1 }), globalAlpha: 1 };
  const ctx = new Proxy(target, {
    get: (t, name) => (name in t ? t[name] : () => ({ addColorStop() {} })),
    set: (t, name, value) => { t[name] = value; return true; },
  });
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return ctx; } };
  pins.clearPinCache();
  const plain = pins.drawPostPin(ctx, 100, 200, { heat: 50, size: 22, initial: 'A' });
  assert.equal(plain.headY, 200);
  assert.equal(plain.headR, pins.pinGeometry(22, 50).headR);
  assert.ok(plain.top < 200 - plain.headR);
  const fire = pins.drawPostPin(ctx, 100, 200, { heat: 95, size: 22, initial: 'A', time: 0.3 });
  assert.equal(fire.headY, 200);
  assert.ok(fire.top < plain.top);
});

test('the open pin hops up past its height, then settles lifted', () => {
  assert.equal(pins.liftShare(0), 0);
  const peak = Math.max(...[0.1, 0.15, 0.2, 0.25, 0.3].map((t) => pins.liftShare(t)));
  assert.ok(peak > 1 && peak < 1.3, `a small overshoot, got ${peak}`);
  assert.equal(pins.liftShare(1), 1);
  assert.equal(pins.liftShare(null), 1);   // less motion: lifted, no hop
});

test('the top drawPostPin gives back is what pinReach says, tag and lift included', () => {
  const target = { getTransform: () => ({ a: 1 }), globalAlpha: 1 };
  const ctx = new Proxy(target, {
    get: (t, name) => (name in t ? t[name] : () => ({ addColorStop() {} })),
    set: (t, name, value) => { t[name] = value; return true; },
  });
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return ctx; } };
  pins.clearPinCache();
  for (const heat of [10, 50, 80, 95]) {
    // Still (time null): no bob, no sway, so the pin stands exactly on its place.
    const mine = pins.drawPostPin(ctx, 100, 200, { heat, size: 22, initial: 'A', mine: true });
    assert.equal(mine.headY, 200);
    assert.ok(Math.abs(mine.top - (200 + pins.pinReach(22, heat, true))) < 1e-9, `mine, heat ${heat}`);
    const plain = pins.drawPostPin(ctx, 100, 200, { heat, size: 22, initial: 'A' });
    assert.ok(Math.abs(plain.top - (200 + pins.pinReach(22, heat))) < 1e-9, `plain, heat ${heat}`);
    // Opened (openedFor null = settled): bigger, and lifted off its place.
    const open = pins.drawPostPin(ctx, 100, 200, { heat, size: 22, initial: 'A', mine: true, selected: true });
    const lift = 6 * pins.pinScale(22, heat, true);
    assert.ok(Math.abs(open.headY - (200 - lift)) < 1e-9, `lifted, heat ${heat}`);
    assert.ok(open.headR > plain.headR);
    assert.ok(Math.abs(open.top - (200 + pins.pinReach(22, heat, true, true))) < 1e-9, `open, heat ${heat}`);
    assert.ok(pins.pinReach(22, heat, false, true) < pins.pinReach(22, heat));
  }
});
