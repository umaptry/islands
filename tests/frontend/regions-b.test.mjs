import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BORDER_SHORE, borderPoints, frameOf, makeFaceCrowd, placeNames, regionText, thinBorders,
} from '../../web/js/map/regions-b.js';

// A square island 0..100 split down the middle: region 0 on the left, 1 on the right.
const extent = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
const regionAt = (x) => (x < 0 || x > 100 ? 255 : x < 50 ? 0 : 1);
const coastAt = (x, y) => Math.min(x, 100 - x, y, 100 - y);   // inland positive

test('a border is found where two neighbouring cells are different regions, and only there', () => {
  const points = borderPoints(extent, regionAt, coastAt, 5);
  assert.ok(points.length > 0);
  points.forEach(([x]) => assert.ok(Math.abs(x - 50) <= 2.5, `x=${x}`));
});

test('no border dot sits in the surf', () => {
  const points = borderPoints(extent, regionAt, coastAt, 5);
  points.forEach(([x, y]) => assert.ok(coastAt(x, y) > BORDER_SHORE - 3, `(${x}, ${y})`));
  assert.ok(Math.min(...points.map(([, y]) => y)) > BORDER_SHORE - 3);
});

test('the sea is not a region: no border where one side is outside', () => {
  const none = borderPoints(extent, () => 255, () => 100, 5);
  assert.equal(none.length, 0);
});

test('dots are thinned to one for each 7 px of the screen, and off-screen ones go', () => {
  const dense = [];
  for (let y = 0; y < 100; y += 1) dense.push([50, y]);
  const toScreen = (x, y) => ({ x: x * 1, y: y * 1 });   // 1 px per unit: 100 dots in 100 px
  const dots = thinBorders(dense, toScreen, { width: 390, height: 844 });
  assert.ok(dots.length <= 15 && dots.length >= 12, String(dots.length));
  dots.slice(1).forEach(([, y], i) => assert.ok(y - dots[i][1] >= 3.5));
  const away = thinBorders([[1000, 1000]], toScreen, { width: 390, height: 844 });
  assert.equal(away.length, 0);
  const underBar = thinBorders([[50, 5]], toScreen, { width: 390, height: 844, top: 90 });
  assert.equal(underBar.length, 0);
});

test('the frame is the island with a little room round it', () => {
  const [minX, minY, maxX, maxY] = frameOf({ minX: 0, minY: 100, maxX: 1000, maxY: 900 }, 0.05);
  assert.deepEqual([minX, minY, maxX, maxY], [-50, 60, 1050, 940]);
});

// A label space like decor.js makeLabelSpace: claim(x, y, w, h) is true if free, then taken.
function space() {
  const taken = [];
  return (x, y, w, h) => {
    const box = { l: x - w / 2, r: x + w / 2, t: y - h / 2, b: y + h / 2 };
    if (taken.some((o) => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t)) return false;
    taken.push(box);
    return true;
  };
}
const measure = (entry) => entry.text.length * 10;

test('names claim room in order: the regions, then the villages by size', () => {
  const placed = placeNames({
    regions: [{ text: '北 地方', x: 100, y: 100 }, { text: '東 地方', x: 110, y: 100 }, { text: '南 地方', x: 300, y: 300 }],
    villages: [{ text: 'ちいさい村', x: 300, y: 300, weight: 1 }, { text: 'おおきい村', x: 300, y: 330, weight: 9 }],
    far: true, claim: space(), measure,
  });
  const texts = placed.map((entry) => entry.text);
  assert.ok(texts.includes('北 地方'));
  assert.ok(!texts.includes('東 地方'), 'covers the first region, so it waits');
  assert.ok(texts.includes('南 地方'));
  assert.ok(!texts.includes('ちいさい村'), 'under the region name');
  assert.ok(texts.includes('おおきい村'));
});

test('close in, the regions show no names', () => {
  const placed = placeNames({
    regions: [{ text: '南 地方', x: 300, y: 300 }],
    far: false, claim: space(), measure,
  });
  assert.deepEqual(placed.map((entry) => entry.text), []);
});

test('a region reads as its own place name, with no 地方 after it', () => {
  assert.equal(regionText({ name: '食の森' }), '食の森');
});

test('a face within 20 px of one already kept is left out; a far one stays', () => {
  const crowd = makeFaceCrowd(20);
  assert.equal(crowd.crowded(100, 100), false);
  crowd.keep(100, 100);
  assert.equal(crowd.crowded(115, 110), true);
  assert.equal(crowd.crowded(100, 119), true);
  assert.equal(crowd.crowded(100, 121), false);
  assert.equal(crowd.crowded(125, 100), false);
  assert.equal(crowd.crowded(-45, 3), false);
});
