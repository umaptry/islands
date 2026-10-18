import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// buildings.js imports palette.js; inline it so the module loads from a data: URL.
const palette = (await readFile(new URL('../../web/js/map/palette.js', import.meta.url), 'utf8'))
  .replace(/export const /g, 'const ').replace(/export function /g, 'function ');
let source = await readFile(new URL('../../web/js/map/buildings.js', import.meta.url), 'utf8');
source = source.replace("import { PALETTE, mixHex } from './palette.js';", () => palette);
const B = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const CANDIDATES = ['灯台', '風車', '時計塔', '図書館', '工房', '温室', '天文台', '市場', '港の桟橋', '鍛冶場', '学び舎', '茶屋',
  '劇場', '庭園', '畑', '釣り小屋', '画廊', '音楽堂', '研究所', 'パン屋', '診療所', '見張り台', '運動場', '広場'];

test('every landmark candidate has a shape, and the list is exactly the 24', () => {
  assert.deepEqual([...B.LANDMARK_NAMES].sort(), [...CANDIDATES].sort());
  CANDIDATES.forEach((n) => assert.ok(B.landmarkForm(n).type));
});

test('names go to their shape type', () => {
  assert.equal(B.landmarkForm('灯台').type, 'lighthouse');
  assert.equal(B.landmarkForm('風車').type, 'windmill');
  assert.equal(B.landmarkForm('時計塔').type, 'tower');
  assert.equal(B.landmarkForm('港の桟橋').type, 'pier');
  assert.equal(B.landmarkForm('釣り小屋').type, 'pier');
  assert.deepEqual(['広場', '畑', '運動場', '庭園'].map((n) => B.landmarkForm(n).type), ['flat', 'flat', 'flat', 'flat']);
});

test('an unknown name is a manor, even a name that is an object key', () => {
  assert.deepEqual(B.landmarkForm('なぞの建物'), { type: 'manor', variant: 'default' });
  assert.equal(B.landmarkForm('constructor').type, 'manor');
  assert.equal(B.landmarkForm(undefined).type, 'manor');
});

test('sizes round to 2 px steps', () => {
  assert.equal(B.roundSize(36), 36);
  assert.equal(B.roundSize(36.9), 36);
  assert.equal(B.roundSize(37.1), 38);
  assert.equal(B.roundSize(0.2), 2);
});

test('the cache key tells shapes, sizes, looks and seeds apart', () => {
  const base = { shape: 'settlement', id: 2, size: 36, calm: false, night: false, dpr: 2, seed: 1 };
  const k = B.cacheKey(base);
  assert.equal(k, B.cacheKey({ ...base, size: 36.8 }));
  assert.notEqual(k, B.cacheKey({ ...base, id: 3 }));
  assert.notEqual(k, B.cacheKey({ ...base, size: 40 }));
  assert.notEqual(k, B.cacheKey({ ...base, calm: true }));
  assert.notEqual(k, B.cacheKey({ ...base, night: true }));
  assert.notEqual(k, B.cacheKey({ ...base, dpr: 1 }));
  assert.notEqual(k, B.cacheKey({ ...base, seed: 2 }));
});

test('the box stands on the foot point', () => {
  const box = B.placeBox({ l: -10, r: 14, t: -30, b: 0 }, 100, 200);
  assert.deepEqual(box, { left: 90, top: 170, right: 114, bottom: 200, w: 24, h: 30 });
});

test('without a canvas nothing is drawn and null comes back', () => {
  assert.equal(B.drawSettlement(null, 1, 0, 0, 36), null);
  assert.equal(B.drawLandmark({}, '灯台', 0, 0, 0), null);
});

test('drawNightLights does nothing without a canvas or with a bad size', () => {
  assert.equal(B.drawNightLights(null, { tier: 1 }, 0, 0, 40), undefined);
  assert.equal(B.drawNightLights({ getTransform: () => ({ a: 1 }) }, { tier: 1 }, 0, 0, 0), undefined);
});
