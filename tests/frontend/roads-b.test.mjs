import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROAD_CLEAR, ROAD_CLEAR_BY_TIER, ROAD_STEP, demoPairs, hasRoadsB, nearRoadB, roadCurve, roadIndex, setRoadsB,
} from '../../web/js/map/roads-b.js';

test('a road is a bowed curve that starts and ends on its two places', () => {
  const points = roadCurve({ x: 0, y: 0 }, { x: 300, y: 0 });
  assert.deepEqual(points[0], [0, 0]);
  const last = points[points.length - 1];
  assert.ok(Math.abs(last[0] - 300) < 1e-9 && Math.abs(last[1]) < 1e-9);
  // bowed to one side (0.12 of the length at the control point, so 0.06 at the middle)
  const middle = points[Math.floor(points.length / 2)];
  assert.ok(Math.abs(Math.abs(middle[1]) - 300 * 0.06) < 1);
  // about a step between points
  const gap = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]);
  assert.ok(gap < ROAD_STEP * 1.6, String(gap));
});

test('a spot is near a road within the clearance, and not beyond it', () => {
  const curves = [roadCurve({ x: 0, y: 0 }, { x: 200, y: 0 }, 0)];   // straight
  const near = roadIndex(curves);
  assert.equal(near(100, 0), true);
  assert.equal(near(100, ROAD_CLEAR - 1), true);
  assert.equal(near(100, ROAD_CLEAR + 1), false);
  assert.equal(near(500, 500), false);
  assert.equal(roadIndex([])(0, 0), false);
});

test('roads are kept as given, and cleared with none', () => {
  assert.equal(hasRoadsB(), false);
  setRoadsB([{ a: { x: 0, y: 0 }, b: { x: 100, y: 100 } }]);
  assert.equal(hasRoadsB(), true);
  assert.equal(nearRoadB(0, 0), true);
  assert.equal(nearRoadB(900, 0), false);
  setRoadsB(null);
  assert.equal(hasRoadsB(), false);
  assert.equal(nearRoadB(0, 0), false);
});

test('trees keep back from a road by its tier: a little from a track, more from a road', () => {
  setRoadsB([
    { a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, tier: 1 },
    { a: { x: 0, y: 500 }, b: { x: 200, y: 500 }, tier: 3 },
  ]);
  const middle = (y) => roadCurve({ x: 0, y }, { x: 200, y })[Math.floor(roadCurve({ x: 0, y }, { x: 200, y }).length / 2)];
  const [tx, ty] = middle(0);
  const [rx, ry] = middle(500);
  assert.equal(nearRoadB(tx, ty + ROAD_CLEAR_BY_TIER[1] - 0.5), true);
  assert.equal(nearRoadB(tx, ty + ROAD_CLEAR_BY_TIER[1] + 1), false);
  assert.equal(nearRoadB(rx, ry + ROAD_CLEAR_BY_TIER[3] - 0.5), true);
  assert.equal(nearRoadB(rx, ry + ROAD_CLEAR_BY_TIER[3] + 1), false);
  // No tier is a tier-1 track.
  setRoadsB([{ a: { x: 0, y: 0 }, b: { x: 200, y: 0 } }]);
  assert.equal(nearRoadB(tx, ty + ROAD_CLEAR_BY_TIER[1] + 1), false);
  setRoadsB(null);
});

test('the demo pairs join posts of different regions a fair way apart', () => {
  const posts = Array.from({ length: 60 }, (_, i) => ({ id: i, x: (i % 10) * 70, y: Math.floor(i / 10) * 70 }));
  const regionOf = (post) => (post.x < 300 ? 0 : 1);
  const pairs = demoPairs(posts, regionOf, 4);
  assert.ok(pairs.length > 0 && pairs.length <= 4);
  pairs.forEach(({ a, b }) => {
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    assert.ok(d > 125 && d < 400, String(d));
    assert.notEqual(regionOf(a), regionOf(b));
  });
  assert.deepEqual(demoPairs([], regionOf), []);
});
