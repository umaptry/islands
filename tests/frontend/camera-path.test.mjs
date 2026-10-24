import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraAt, viewHolding } from '../../web/js/map/camera-path.js';

const screenOf = (view, x, y) => ({ x: x * view.scale + view.x, y: y * view.scale + view.y });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('the move starts at the first view and ends at the last one', () => {
  const from = { scale: 0.7, x: -130, y: 50 };
  const to = viewHolding(500, 300, 195, 211, 12);
  assert.deepEqual(cameraAt(from, to, 0), from);
  const end = cameraAt(from, to, 1);
  assert.ok(near(end.scale, 12) && near(end.x, to.x) && near(end.y, to.y));
});

test('zooming to a post: the post slides to its spot in a straight line while it grows', () => {
  const from = { scale: 0.7, x: -130, y: 50 };
  const post = { x: 500, y: 300 };
  const to = viewHolding(post.x, post.y, 195, 211, 12);
  const start = screenOf(from, post.x, post.y);
  const goal = { x: 195, y: 211 };
  for (let k = 0.05; k < 1; k += 0.05) {
    const at = screenOf(cameraAt(from, to, k), post.x, post.y);
    // On the straight line from where the post is now to where it will stand.
    const cross = (at.x - start.x) * (goal.y - start.y) - (at.y - start.y) * (goal.x - start.x);
    assert.ok(Math.abs(cross) < 1e-6, `off the line at ${k}`);
    // And never past either end of it.
    assert.ok(at.x >= Math.min(start.x, goal.x) - 1e-6 && at.x <= Math.max(start.x, goal.x) + 1e-6);
  }
});

test('the first frames zoom about the post, not about the middle of the screen', () => {
  // A post right under the finger stays put while it grows.
  const from = { scale: 1, x: 0, y: 0 };
  const to = viewHolding(100, 100, 100, 100, 8);
  const at = screenOf(cameraAt(from, to, 0.3), 100, 100);
  assert.ok(near(at.x, 100) && near(at.y, 100));
});

test('the zoom itself is even: the scale changes by a constant factor per step', () => {
  const from = { scale: 1, x: 0, y: 0 };
  const to = { scale: 16, x: -300, y: -200 };
  const a = cameraAt(from, to, 0.25).scale;
  const b = cameraAt(from, to, 0.5).scale;
  assert.ok(near(b / a, 2) && near(a, 2));
});

test('every edge of the window on the world stays between the two views (no swing past the world)', () => {
  const width = 390;
  const from = { scale: 10, x: -3000, y: -1500 };           // zoomed in
  const to = { scale: 0.66, x: -135, y: 51 };                 // the whole map
  const edges = (view) => [-view.x / view.scale, (width - view.x) / view.scale];
  const [l0, r0] = edges(from);
  const [l1, r1] = edges(to);
  for (let k = 0; k <= 1.0001; k += 0.05) {
    const [l, r] = edges(cameraAt(from, to, k));
    assert.ok(l >= Math.min(l0, l1) - 1e-6 && l <= Math.max(l0, l1) + 1e-6, `left edge out at ${k}`);
    assert.ok(r >= Math.min(r0, r1) - 1e-6 && r <= Math.max(r0, r1) + 1e-6, `right edge out at ${k}`);
  }
});

test('a pan with no zoom is a plain slide, and an almost-no-zoom move does not blow up', () => {
  const from = { scale: 3, x: 0, y: 0 };
  const mid = cameraAt(from, { scale: 3, x: -100, y: -40 }, 0.5);
  assert.ok(near(mid.x, -50) && near(mid.y, -20) && near(mid.scale, 3));
  const tiny = cameraAt(from, { scale: 3.0000001, x: -100, y: -40 }, 0.5);
  assert.ok(Number.isFinite(tiny.x) && near(tiny.x, -50, 1e-3));
});
