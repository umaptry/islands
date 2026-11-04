import test from 'node:test';
import assert from 'node:assert/strict';
import { PROP_KINDS, WALKER_LOOKS, WALK_FRAMES, WALK_TURNS, dogFaces, propParts, walkerFaces } from '../../web/js/map/props-mesh.js';

const finite = (value) => Array.isArray(value) ? value.every(finite) : typeof value !== 'number' || Number.isFinite(value);

test('every thing round a house has a shape, with no NaN in it', () => {
  PROP_KINDS.forEach((kind) => {
    [0, 1].forEach((frame) => {
      const parts = propParts(kind, { rot: 1.1, frame });
      assert.ok(parts.length > 0, kind);
      parts.forEach((part) => assert.ok(finite(part.tris), `${kind} frame ${frame}`));
    });
  });
});

test('walkers and dogs have faces in every turn and step', () => {
  for (let look = 0; look < WALKER_LOOKS.length; look += 1) {
    for (let turn = 0; turn < WALK_TURNS; turn += 3) {
      for (let frame = 0; frame < WALK_FRAMES * 2; frame += 5) {
        const faces = walkerFaces(look, turn, frame);
        assert.ok(faces.length > 0);
        faces.forEach(({ pts }) => assert.ok(finite(pts)));
      }
    }
  }
  assert.ok(dogFaces(-3, 9).length > 0, 'a turn or frame out of range wraps round');
});
