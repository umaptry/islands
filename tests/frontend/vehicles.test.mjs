import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// vehicles.js imports palette.js; inline it so the module loads from a data: URL.
const palette = (await readFile(new URL('../../web/js/map/palette.js', import.meta.url), 'utf8'))
  .replace(/export const /g, 'const ').replace(/export function /g, 'function ');
let source = await readFile(new URL('../../web/js/map/vehicles.js', import.meta.url), 'utf8');
source = source.replace("import { PALETTE, mixHex } from './palette.js';", () => palette);
const vehicles = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('the cache key follows the kind, the rounded size, night and the device scale, not the heading', () => {
  const key = vehicles.vehicleKey;
  assert.equal(key({ kind: 'plane', size: 25 }), key({ kind: 'plane', size: 26.4 }), 'sizes are rounded to 2 px steps');
  assert.notEqual(key({ kind: 'plane', size: 24 }), key({ kind: 'plane', size: 30 }));
  assert.notEqual(key({ kind: 'plane', size: 24 }), key({ kind: 'boat', size: 24 }));
  assert.notEqual(key({ kind: 'boat', size: 18 }), key({ kind: 'boat', size: 18, night: true }));
  assert.notEqual(key({ kind: 'boat', size: 18, dpr: 1 }), key({ kind: 'boat', size: 18, dpr: 2 }));
  assert.equal(key({ kind: 'boat', size: 18, heading: 0 }), key({ kind: 'boat', size: 18, heading: 2.5 }));
  assert.notEqual(key({ kind: 'car', size: 12 }), key({ kind: 'boat', size: 12 }));
  assert.equal(key({ kind: 'car', size: 12 }), key({ kind: 'car', size: 12.8 }), 'a car is cached in 2 px steps too');
  assert.notEqual(key({ kind: 'car', size: 12 }), key({ kind: 'car', size: 12, night: true }));
});

test('the shadow lies to the bottom-right and does not depend on the heading', () => {
  ['plane', 'boat', 'car'].forEach((kind) => {
    const [dx, dy] = vehicles.shadowOffset(kind, 24);
    assert.ok(dx > 0 && dy > 0, `${kind}: right and down`);
  });
  const [px, py] = vehicles.shadowOffset('plane', 24);
  const [bx, by] = vehicles.shadowOffset('boat', 24);
  assert.ok(px > bx * 3 && py > by * 3, 'a plane is in the air: its shadow is far off, a boat\'s is right under it');
  assert.deepEqual(vehicles.shadowOffset('plane', 24), vehicles.shadowOffset('plane', 24));
  const [cx, cy] = vehicles.shadowOffset('car', 24);
  assert.ok(px > cx * 3 && py > cy * 3, 'a car is on the ground: its shadow is right under it');
});

test('the shadow is placed the same way for every heading', () => {
  const placed = [];
  const ctx = new Proxy({}, {
    get: (t, k) => {
      if (k === 'getTransform') return () => ({ a: 1 });
      if (k === 'translate') return (x, y) => placed.push([x, y]);
      return k in t ? t[k] : () => {};
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }); }
  };
  try {
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
    [['plane', vehicles.drawPlane, 24], ['car', vehicles.drawCar, 12]].forEach(([kind, draw, size]) => {
      const offsets = [0, 1, 2.5, -2, Math.PI].map((heading) => {
        placed.length = 0;
        assert.equal(draw(ctx, 100, 200, size, heading), true);
        const [shadow, body] = placed;
        return [shadow[0] - body[0], shadow[1] - body[1]];
      });
      const want = vehicles.shadowOffset(kind, size);
      offsets.forEach((o) => { near(o[0], want[0]); near(o[1], want[1]); });
    });
  } finally {
    delete globalThis.OffscreenCanvas;
  }
});

test('nothing is drawn for a size that is not a positive number, or without a canvas', () => {
  const ctx = new Proxy({}, { get: () => () => { throw new Error('should not touch the canvas'); } });
  [0, -5, NaN, Infinity * 0, undefined, null].forEach((size) => {
    assert.equal(vehicles.drawPlane(ctx, 10, 10, size, 0), false);
    assert.equal(vehicles.drawBoat(ctx, 10, 10, size, 0), false);
    assert.equal(vehicles.drawCar(ctx, 10, 10, size, 0), false);
  });
  assert.equal(vehicles.drawPlane(null, 10, 10, 24, 0), false);
  assert.equal(vehicles.drawBoat(ctx, NaN, 10, 18, 0), false);
  assert.equal(vehicles.drawCar(null, 10, 10, 12, 0), false);
});

test('a car picture is painted once per size and then reused for every heading', () => {
  let made = 0;
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; made += 1; }
    getContext() { return new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }); }
  };
  const ctx = new Proxy({}, {
    get: (t, k) => (k === 'getTransform' ? () => ({ a: 1 }) : k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  try {
    vehicles._clearCache();
    [0, 1, 2, 3, -1].forEach((heading) => assert.equal(vehicles.drawCar(ctx, 50, 50, 12, heading), true));
    assert.equal(made, 2, 'one body and one shadow, whatever the heading');
    assert.equal(vehicles._cacheSize(), 1);
    vehicles.drawCar(ctx, 50, 50, 12.9, 0);
    assert.equal(made, 2, '12.9 px rounds to the same 2 px step');
    vehicles.drawCar(ctx, 50, 50, 14, 0);
    assert.equal(made, 4);
  } finally {
    delete globalThis.OffscreenCanvas;
  }
});
