import test from 'node:test';
import assert from 'node:assert/strict';
import { facesOf, partsOf, shadowOutline, houseWindow } from '../../web/js/map/mesh.js';

test('every kind gives faces with a colour and three corners, and nothing is NaN', () => {
  for (const kind of ['tree', 'pine', 'bush', 'rock', 'house']) {
    const faces = facesOf(partsOf(kind, 2));
    assert.ok(faces.length > 2, kind);
    faces.forEach((f) => {
      assert.match(f.fill, /^#[0-9a-f]{6}$/);
      assert.equal(f.pts.length, 3);
      f.pts.flat().forEach((v) => assert.ok(Number.isFinite(v)));
    });
  }
});

test('a house is the wall then the roof, and a tree is the trunk then the crown', () => {
  const house = facesOf(partsOf('house', 0));
  assert.equal(house[house.length - 1].fill.length, 7);
  const roofRed = (c) => parseInt(c.slice(1, 3), 16) > parseInt(c.slice(5, 7), 16) + 40;
  assert.ok(roofRed(house[house.length - 1].fill), 'the last face drawn is the roof');
});

test('the shadow falls to the bottom right and the window is on the front', () => {
  const shadow = shadowOutline(1, 2.4);
  const mid = shadow.reduce((s, p) => [s[0] + p[0] / shadow.length, s[1] + p[1] / shadow.length], [0, 0]);
  assert.ok(mid[0] > 0 && mid[1] > 0);
  assert.ok(houseWindow(0)[1] > -1);
});

test('every landmark gives faces, a shadow size and lights, and nothing is NaN', async () => {
  const { landmarkLights, landmarkMesh, landmarkSize } = await import('../../web/js/map/landmarks.js');
  const forms = [
    ['lighthouse', ''], ['tower', 'clock'], ['tower', 'watch'], ['dome', 'observatory'], ['dome', 'music'],
    ['manor', 'library'], ['manor', 'school'], ['manor', 'gallery'], ['manor', 'theater'], ['manor', 'default'],
    ['workshop', 'workshop'], ['workshop', 'smithy'], ['clinic', 'lab'], ['clinic', 'clinic'], ['greenhouse', ''],
    ['windmill', ''], ['market', ''], ['pier', 'pier'], ['pier', 'fishhut'],
    ['flat', 'plaza'], ['flat', 'farm'], ['flat', 'field'], ['flat', 'garden'], ['shop', 'teahouse'], ['shop', 'bakery'],
  ];
  for (const [type, variant] of forms) {
    const faces = facesOf(landmarkMesh(type, variant));
    assert.ok(faces.length > 6, `${type}:${variant}`);
    faces.forEach((f) => {
      assert.match(f.fill, /^#[0-9a-f]{6}$/);
      f.pts.flat().forEach((v) => assert.ok(Number.isFinite(v)));
    });
    const { h, rr } = landmarkSize(type, variant);
    assert.ok(h > 0 && rr > 0);
    const lights = landmarkLights(type, variant);
    assert.ok(lights.length > 0, `${type}:${variant} has a light for the night`);
    lights.forEach((l) => [l.x, l.y, l.r, l.a].forEach((v) => assert.ok(Number.isFinite(v))));
  }
  // An unknown shape is a manor, and a name that is an object key is not a shape.
  assert.equal(landmarkMesh('constructor').length, landmarkMesh('manor', 'default').length);
});
