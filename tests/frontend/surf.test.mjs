import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// surf.js has no imports and no DOM, so it loads from a data: URL as it is.
const source = await readFile(new URL('../../web/js/map/surf.js', import.meta.url), 'utf8');
const surf = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { SURF } = surf;

// A distance-to-land field (Euclidean) for discs of land, in texture px.
function field(width, height, discs) {
  const f = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      f[y * width + x] = Math.min(...discs.map(([cx, cy, r]) => Math.max(0, Math.hypot(x - cx, y - cy) - r)));
    }
  }
  return f;
}
const options = { perScreen: 1, perWorld: 1, minX: 0, minY: 0, scale: 1 };

test('the surf shows only from a view about one island wide, and fades in', () => {
  // Short side of the screen in world units = min(w, h) / scale.
  assert.equal(surf.surfShow(1, 390, 844), 0, 'the whole map: nothing');
  assert.equal(surf.surfShow(390 / SURF.from, 390, 844), 0, 'just before it begins');
  assert.equal(surf.surfShow(390 / SURF.full, 390, 844), 1, 'all there');
  const mid = surf.surfShow(390 / ((SURF.from + SURF.full) / 2), 390, 844);
  assert.ok(mid > 0.3 && mid < 0.7, `half way: ${mid}`);
  assert.equal(surf.surfShow(18, 390, 844), 1, 'right in');
  assert.equal(surf.surfShow(0, 390, 844), 0);
  // The same world width gives the same answer on a PC (the shorter side counts).
  assert.equal(surf.surfShow(900 / SURF.full, 1366, 900), 1);
  assert.equal(surf.surfShow(900 / SURF.from, 1366, 900), 0);
});

test('a small island opened with the enter button shows the surf, several islands do not', () => {
  // Measured on map v6: a one-post island fills a phone at scale 6.3 and a PC at 10-12;
  // the first view of the whole map is 0.4 / 0.74; three or four islands in view is ~2 / ~4.
  assert.ok(surf.surfShow(6.3, 390, 844) > 0.99);
  assert.ok(surf.surfShow(10.4, 1366, 900) > 0.85);
  assert.equal(surf.surfShow(0.4, 390, 844), 0);
  assert.equal(surf.surfShow(2, 390, 844), 0);
  assert.equal(surf.surfShow(4, 1366, 900), 0);
});

test('the lines move shoreward and the cycle has no seam', () => {
  const at = (u) => [0, 1, 2, 3].map((j) => surf.surfLine(j, u));
  const lines = at(0.5).filter((l) => l.alpha > 0.01);
  assert.ok(lines.length >= 3 && lines.length <= 4);
  // Later in the cycle every line is nearer the beach.
  const early = at(0.2).filter((l) => l.alpha > 0.1).map((l) => l.dist);
  const late = at(0.4).filter((l) => l.alpha > 0.1).map((l) => l.dist);
  assert.ok(late[0] < early[0]);
  // u -> 1 and u = 0 are the same picture: the set of (dist, alpha) matches.
  const sig = (u) => at(u).filter((l) => l.alpha > 1e-4).map((l) => `${l.dist.toFixed(2)}:${l.alpha.toFixed(2)}`).sort().join();
  assert.equal(sig(1 - 1e-9), sig(0));
  // Dies on the beach, comes up at the outer edge, outer ones fainter, all inside the checked reach.
  at(0.5).filter((l) => l.alpha > 0.01).forEach((l) => assert.ok(l.dist >= SURF.near && l.dist <= SURF.near + SURF.lines * SURF.gap + 1e-9));
  assert.ok(surf.surfLine(0, 0.9999).alpha < 0.01);
  assert.ok(surf.surfLine(2, 0.2).alpha < surf.surfLine(0, 0.2).alpha, 'the outer line is fainter');
  assert.ok(SURF.near + SURF.lines * SURF.gap <= SURF.mid + SURF.reachOut);
  assert.ok(SURF.near >= SURF.mid - SURF.reachIn);
});

test('less motion: the clock gives one fixed phase', () => {
  assert.equal(surf.surfPhase(null), surf.surfPhase(undefined));
  assert.notEqual(surf.surfPhase(1), surf.surfPhase(2));
  assert.ok(surf.surfPhase(123.4) >= 0 && surf.surfPhase(123.4) < 1);
});

test('coastLines traces one closed loop round an island, at the set distance, normals outward', () => {
  const w = 300;
  const h = 300;
  const found = surf.coastLines(field(w, h, [[150, 150, 60]]), w, h, options);
  assert.equal(found.lines.length, 1);
  const { closed, n, data } = found.lines[0];
  assert.equal(closed, true);
  assert.ok(n > 40);
  for (let k = 0; k < n; k += 1) {
    const [x, y, nx, ny, out, inn] = Array.from(data.slice(k * 6, k * 6 + 6));
    const r = Math.hypot(x - 150, y - 150);
    assert.ok(Math.abs(r - (60 + SURF.mid)) < 1.2, `radius ${r}`);
    assert.ok(nx * (x - 150) + ny * (y - 150) > 0.95 * r, 'points away from the land');
    assert.ok(out >= SURF.reachOut - 1.01 && inn >= SURF.reachIn - 1.01, 'open water both ways');
  }
});

test('the contour is in world units, whatever the texture resolution', () => {
  const w = 300;
  const h = 300;
  // 2 texture px per world unit and per screen px; the contour is 18 screen px = 36 texture px
  // from a disc of 60 px, so 48 world units from its middle.
  const found = surf.coastLines(field(w, h, [[150, 150, 60]]), w, h,
    { perScreen: 2, perWorld: 2, minX: 100, minY: 200, scale: 1 });
  const { data } = found.lines[0];
  const r = Math.hypot(data[0] - (100 + 75.25), data[1] - (200 + 75.25));
  assert.ok(Math.abs(r - 48) < 1.2, `radius ${r}`);
});

test('where another island is near, the reach there is cut short', () => {
  const w = 400;
  const h = 300;
  // Two discs 40 px apart at the edges: the gap is closer than the outer lines go.
  const found = surf.coastLines(field(w, h, [[100, 150, 50], [240, 150, 50]]), w, h, options);
  const reaches = found.lines.flatMap(({ n, data }) => Array.from({ length: n }, (_, k) => data[k * 6 + 4]));
  assert.ok(Math.min(...reaches) < SURF.reachOut - 5, 'cut short between the islands');
  assert.ok(Math.max(...reaches) >= SURF.reachOut - 1.01, 'full on the far sides');
});

test('open sea gives no lines; a speck gives none either', () => {
  assert.equal(surf.coastLines(field(100, 100, [[-500, -500, 5]]), 100, 100, options), null);
  assert.equal(surf.coastLines(field(100, 100, [[50, 50, 0]]), 100, 100, { ...options, perScreen: 8 }), null);
});

function recorder() {
  const calls = [];
  return new Proxy({}, {
    get: (_, name) => (name === 'calls' ? calls : (...args) => calls.push([name, ...args])),
    set: (_, name, value) => { calls.push(['set', name, value]); return true; },
  });
}
const viewAt = (scale, width = 390, height = 844) => ({
  scale, width, height, toScreen: (x, y) => ({ x: width / 2 + (x - 150) * scale, y: height / 2 + (y - 150) * scale }),
});
const alphas = (ctx) => ctx.calls.filter((c) => c[0] === 'set' && c[1] === 'globalAlpha').map((c) => c[2]);
const disc = () => surf.coastLines(field(300, 300, [[150, 150, 60]]), 300, 300, options);

test('drawSurf draws nothing when zoomed out and strokes paths when zoomed in', () => {
  const coast = disc();
  const far = recorder();
  assert.equal(surf.drawSurf(far, coast, viewAt(1), 5), 0);
  assert.equal(far.calls.length, 0, 'not a single call');
  const near = recorder();
  assert.equal(surf.drawSurf(recorder(), coast, viewAt(6), 5), 0, 'the first frame: it has only just been built');
  assert.ok(surf.drawSurf(near, coast, viewAt(6), 5.5) > 0);
  const strokes = near.calls.filter((c) => c[0] === 'stroke').length;
  assert.ok(strokes >= 3 && strokes <= 4, `${strokes} lines`);
  assert.equal(surf.drawSurf(recorder(), null, viewAt(6), 5), 0);
});

test('drawSurf: a fresh coast fades in, night is fainter, held still gives the same picture', () => {
  const coast = disc();
  const first = recorder();
  surf.drawSurf(first, coast, viewAt(6), 100);        // stamps the birth
  const early = recorder();
  surf.drawSurf(early, coast, viewAt(6), 100.1);
  const later = recorder();
  surf.drawSurf(later, coast, viewAt(6), 107.1);      // one whole period on: same phase as 100.1
  assert.ok(Math.max(...alphas(early)) < Math.max(...alphas(later)) * 0.5, 'still coming up at 0.1 s');
  const night = recorder();
  surf.drawSurf(night, coast, viewAt(6), 107.1, 0.5);
  assert.ok(Math.max(...alphas(night)) < Math.max(...alphas(later)) * 0.6, 'fainter at night');
  const still1 = recorder();
  const still2 = recorder();
  surf.drawSurf(still1, disc(), viewAt(6), null);
  surf.drawSurf(still2, disc(), viewAt(6), null);
  assert.deepEqual(still1.calls, still2.calls);
  assert.ok(still1.calls.length > 10);
});

test('drawSurf skips points off the screen', () => {
  const coast = surf.coastLines(field(400, 300, [[100, 150, 50], [240, 150, 50]]), 400, 300, options);
  const count = (ctx) => ctx.calls.filter((c) => c[0] === 'lineTo' || c[0] === 'moveTo').length;
  const wide = recorder();
  surf.drawSurf(wide, coast, viewAt(20, 2400, 1800), null);
  const tight = recorder();
  surf.drawSurf(tight, coast, viewAt(20, 200, 200), null);
  assert.ok(count(tight) < count(wide));
});

test('a frame of drawing is cheap: six islands of coast on a PC screen in a few ms at most', () => {
  const w = 1200;
  const h = 1200;
  const discs = [];
  for (let i = 0; i < 6; i += 1) discs.push([150 + (i % 3) * 400, 250 + Math.floor(i / 3) * 600, 90 + i * 8]);
  const coast = surf.coastLines(field(w, h, discs), w, h, { ...options, perScreen: 2, perWorld: 2 });
  const ctx = {
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    set strokeStyle(v) {}, set lineCap(v) {}, set lineJoin(v) {}, set globalAlpha(v) {}, set lineWidth(v) {},
  };
  const view = viewAt(4, 1366, 900);
  surf.drawSurf(ctx, coast, view, 1);
  const t0 = performance.now();
  for (let i = 0; i < 100; i += 1) surf.drawSurf(ctx, coast, view, 1 + i * 0.016);
  const each = (performance.now() - t0) / 100;
  assert.ok(each < 3, `${each.toFixed(2)} ms a frame`);
});
