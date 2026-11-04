import test from 'node:test';
import assert from 'node:assert/strict';
import { HOMESTEAD, HOMESTEAD_HALF, homestead, homesteadReach } from '../../web/js/map/homestead.js';

const kinds = (score, tier = 1) => homestead(score, tier).map((it) => it.kind);

test('nothing round a house with 0 or 1 reactions', () => {
  assert.deepEqual(homestead(0, 0), []);
  assert.deepEqual(homestead(1, 1), []);
  assert.equal(homesteadReach(1, 1), 0);
});

test('a household grows in the order the user set (2026-11-04)', () => {
  const firsts = [];
  HOMESTEAD.forEach((step) => { if (!firsts.includes(step.kind)) firsts.push(step.kind); });
  assert.deepEqual(firsts, ['woodpile', 'chicken', 'jar', 'field', 'laundry', 'well', 'doghouse', 'dog', 'cart', 'sheep', 'lamp', 'flowerbed', 'bench']);
  assert.deepEqual(kinds(2), ['woodpile']);
  assert.deepEqual(kinds(3), ['woodpile', 'chicken', 'chicken']);
  assert.ok(kinds(20).includes('bench'));
});

test('the jar goes when the well comes', () => {
  assert.ok(kinds(4).includes('jar'));
  assert.ok(kinds(6).includes('jar'));
  assert.ok(!kinds(7).includes('jar'));
  assert.ok(kinds(7).includes('well'));
});

test('every other house has its yard the other way round', () => {
  const a = homestead(8, 2, 2);
  const b = homestead(8, 2, 3);
  assert.equal(a.length, b.length);
  a.forEach((it, i) => {
    assert.equal(b[i].dx, -it.dx);
    assert.equal(b[i].dy, it.dy);
  });
});

test('things stand clear of their own house, and a bigger house has a wider yard', () => {
  [0, 1, 2, 3].forEach((tier) => {
    homestead(20, tier).forEach((it) => {
      const hw = HOMESTEAD_HALF[tier];
      assert.ok(Math.abs(it.dx) - it.r >= hw - 0.6 || Math.abs(it.dy) - it.r >= hw - 0.6, `${it.kind} on tier ${tier}`);
    });
  });
  assert.ok(homesteadReach(20, 3) > homesteadReach(20, 1));
});
