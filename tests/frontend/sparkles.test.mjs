import test from 'node:test';
import assert from 'node:assert/strict';

const { sparkleSpots, sparkleLevel } = await import('../../web/js/map/sparkles.js');

test('an island gets 3 to 5 glints, always the same ones for the same key', () => {
  for (const key of ['a', 'isl-1', '海馬島', 'x'.repeat(40)]) {
    const spots = sparkleSpots(key);
    assert.ok(spots.length >= 3 && spots.length <= 5);
    assert.deepEqual(spots, sparkleSpots(key));
    for (const s of spots) {
      assert.ok(s.ring >= 0.85 && s.ring <= 1.15);
      assert.ok(s.size >= 0.7 && s.size <= 1.3);
      assert.ok(s.phase >= 0 && s.phase < 1);
    }
  }
  assert.notDeepEqual(sparkleSpots('one'), sparkleSpots('two'));
});

test('glints twinkle out of step, and stand still without motion', () => {
  const levels = (t) => sparkleSpots('isl-1').map((s) => sparkleLevel(t, s.phase));
  assert.equal(new Set(levels(0.5)).size > 1, true);
  for (let t = 0; t < 5; t += 0.1) for (const v of levels(t)) assert.ok(v >= 0.12 && v <= 1);
  assert.equal(sparkleLevel(null, 0.3), sparkleLevel(null, 0.9));
});
