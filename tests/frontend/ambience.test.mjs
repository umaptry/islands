import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/ambience.js', import.meta.url), 'utf8');
const A = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// A small seeded random so the plans are the same every run.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('gulls call in the morning, day and evening, never at night', () => {
  assert.equal(A.gullsAllowed('morning'), true);
  assert.equal(A.gullsAllowed('day'), true);
  assert.equal(A.gullsAllowed('evening'), true);
  assert.equal(A.gullsAllowed('night'), false);
  assert.equal(A.gullsAllowed(undefined), false);
});

test('a swell builds slowly, breaks, and hisses out for longer than it took to build', () => {
  const xs = Array.from({ length: 201 }, (_, i) => i / 200);
  const ys = xs.map(A.swellShape);
  const peak = ys.indexOf(Math.max(...ys));
  assert.ok(Math.abs(xs[peak] - A.BREAK_AT) < 0.02, 'peaks at the break');
  assert.ok(ys[0] < 0.01 && ys[200] < 0.01, 'starts and ends quiet');
  for (let i = 1; i <= peak; i++) assert.ok(ys[i] >= ys[i - 1], 'build-up only rises');
  for (let i = peak + 1; i < ys.length; i++) assert.ok(ys[i] <= ys[i - 1] + 1e-9, 'run-out only falls');
  // Asymmetric: the part above half loudness lasts longer after the peak than before it.
  const before = xs.filter((x, i) => x <= xs[peak] && ys[i] >= 0.5).length;
  assert.ok(before < 0.5 * 201 && A.BREAK_AT < 0.5, 'build is the shorter side');
  const tail = ys.slice(peak).filter((y) => y > 0.05).length;
  assert.ok(tail > peak, 'the hiss-out is longer than the build');
});

test('foam only starts at the break', () => {
  assert.equal(A.foamShape(0.1), 0);
  assert.equal(A.foamShape(A.BREAK_AT - 0.1), 0);
  assert.ok(A.foamShape(A.BREAK_AT + 0.05) > 0.7);
  assert.ok(A.foamShape(0.95) < A.foamShape(0.6));
});

test('swells last about 6-11 s, vary, and bigger sets come now and then', () => {
  const random = seeded(7);
  let sinceBig = 0;
  let bigs = 0;
  const periods = [];
  for (let i = 0; i < 400; i++) {
    const plan = A.swellPlan(random, sinceBig);
    sinceBig = plan.big ? 0 : sinceBig + 1;
    if (plan.big) bigs += 1;
    periods.push(plan.period);
    assert.ok(plan.period >= A.SWELL_MIN_S && plan.period <= A.SWELL_MAX_S);
    assert.ok(plan.peak > 0.3 && plan.peak <= 1);
    assert.ok(Math.abs(plan.pan0) <= 0.5 && Math.abs(plan.pan1) <= 0.5);
    assert.ok(plan.cutHigh > plan.cutLow);
  }
  assert.ok(bigs > 20 && bigs < 160, `sets: ${bigs}`);
  assert.ok(Math.max(...periods) - Math.min(...periods) > 3, 'the period is not fixed');
  // A big swell is louder and brighter than the usual one.
  const usual = A.swellPlan(() => 0.5, 0);
  const big = A.swellPlan(() => 0.1, 5);
  assert.equal(big.big, true);
  assert.ok(big.peak > usual.peak && big.cutHigh > usual.cutHigh);
});

test('the curves between swells sit at the quiet floor, the cut-off follows the swell', () => {
  const plan = A.swellPlan(seeded(3), 0);
  const { gain, cutoff, foam } = A.swellCurves(plan, 64);
  assert.equal(gain.length, 64);
  assert.ok(Math.abs(gain[0] - A.SWELL_FLOOR) < 0.01 && Math.abs(gain[63] - A.SWELL_FLOOR) < 0.01);
  assert.ok(Math.max(...gain) <= plan.peak + 1e-6);
  const top = gain.indexOf(Math.max(...gain));
  assert.ok(cutoff[top] > cutoff[0] + 300 && cutoff[top] > cutoff[63] + 300);
  assert.equal(foam[0], 0);
  assert.ok(Math.max(...foam) <= plan.peak * 0.8 + 1e-6);
});
