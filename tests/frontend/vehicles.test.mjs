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
});

test('the shadow lies to the bottom-right and does not depend on the heading', () => {
  ['plane', 'boat'].forEach((kind) => {
    const [dx, dy] = vehicles.shadowOffset(kind, 24);
    assert.ok(dx > 0 && dy > 0, `${kind}: right and down`);
  });
  const [px, py] = vehicles.shadowOffset('plane', 24);
  const [bx, by] = vehicles.shadowOffset('boat', 24);
  assert.ok(px > bx * 3 && py > by * 3, 'a plane is in the air: its shadow is far off, a boat\'s is right under it');
  assert.deepEqual(vehicles.shadowOffset('plane', 24), vehicles.shadowOffset('plane', 24));
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
    const offsets = [0, 1, 2.5, -2, Math.PI].map((heading) => {
      placed.length = 0;
      assert.equal(vehicles.drawPlane(ctx, 100, 200, 24, heading), true);
      const [shadow, body] = placed;
      return [shadow[0] - body[0], shadow[1] - body[1]];
    });
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
    const want = vehicles.shadowOffset('plane', 24);
    offsets.forEach((o) => { near(o[0], want[0]); near(o[1], want[1]); });
  } finally {
    delete globalThis.OffscreenCanvas;
  }
});

test('nothing is drawn for a size that is not a positive number, or without a canvas', () => {
  const ctx = new Proxy({}, { get: () => () => { throw new Error('should not touch the canvas'); } });
  [0, -5, NaN, Infinity * 0, undefined, null].forEach((size) => {
    assert.equal(vehicles.drawPlane(ctx, 10, 10, size, 0), false);
    assert.equal(vehicles.drawBoat(ctx, 10, 10, size, 0), false);
  });
  assert.equal(vehicles.drawPlane(null, 10, 10, 24, 0), false);
  assert.equal(vehicles.drawBoat(ctx, NaN, 10, 18, 0), false);
});
