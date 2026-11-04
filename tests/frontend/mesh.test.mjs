import test from 'node:test';
import assert from 'node:assert/strict';
import { HOUSE_TIERS, HOUSE_WIDTH, facesOf, houseLights, houseTier, partsOf, shadowOutline, tierIndex, houseWindow } from '../../web/js/map/mesh.js';

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

test('a house grows with what its post gathers: hut, house, manor, castle', () => {
  const at = (n) => houseTier({ like_count: n });
  assert.deepEqual([0, 1, 3, 4, 9, 10, 100].map(at), [0, 1, 1, 2, 2, 3, 3]);
  // The four counts are added together.
  assert.equal(houseTier({ like_count: 2, help_count: 1, join_count: 3, comment_count: 4 }), 3);
  assert.equal(houseTier({ like_count: 1, comment_count: 2 }), 1);
});

test('the tier of a post with counts missing, negative or text does not break', () => {
  assert.equal(houseTier(), 0);
  assert.equal(houseTier(null), 0);
  assert.equal(houseTier({}), 0);
  assert.equal(houseTier({ like_count: -5, comment_count: 2 }), 1);
  assert.equal(houseTier({ like_count: '5' }), 2);
  assert.equal(houseTier({ like_count: 'abc', help_count: NaN, join_count: undefined, comment_count: Infinity }), 0);
  assert.equal(houseTier({ like_count: 2.9 }), 1);
});

test('every tier gives faces and windows, and the bigger tiers have more of both', () => {
  assert.equal(tierIndex('castle'), 3);
  assert.equal(tierIndex(7), 3);
  assert.equal(tierIndex('nonsense'), 1);
  const faceCounts = HOUSE_TIERS.map((kind) => {
    let n = 0;
    for (let turn = 0; turn < 6; turn += 1) {
      const faces = facesOf(partsOf(kind, turn));
      assert.ok(faces.length > 4, kind);
      faces.forEach((f) => { assert.match(f.fill, /^#[0-9a-f]{6}$/); f.pts.flat().forEach((v) => assert.ok(Number.isFinite(v))); });
      n = faces.length;
      const lights = houseLights(kind, turn);
      assert.ok(lights.length >= 1, kind);
      lights.flat().forEach((v) => assert.ok(Number.isFinite(v)));
    }
    return n;
  });
  assert.ok(faceCounts[3] > faceCounts[2] && faceCounts[2] > faceCounts[1]);
  assert.ok(houseLights('castle', 0).length > houseLights('house', 0).length);
  assert.deepEqual(houseLights('house', 0)[0].slice(2), [1.0]);
  assert.equal(HOUSE_WIDTH.length, 4);
});

test('the top tier is a long white two-storey house with a blue roof, not a castle (2026-11-04)', () => {
  const blue = (c) => parseInt(c.slice(5, 7), 16) > parseInt(c.slice(1, 3), 16) + 40;
  const faces = facesOf(partsOf('castle', 0));
  assert.ok(faces.some((f) => blue(f.fill)), 'a blue roof');
  const xs = faces.flatMap((f) => f.pts.map((p) => p[0]));
  const top = Math.max(...xs) - Math.min(...xs);
  assert.ok(top > 5.5 && top < 7.5, `about 5.6 wide, not a 7-wide castle (${top})`);
  assert.equal(houseLights('castle', 0).length, 6, 'two rows of four windows face us, the two under the porch roof stay dark');
});

test('white walls keep their wall flag through turning and are not grey (2026-11-04)', () => {
  const luma = (c) => parseInt(c.slice(1, 3), 16) + parseInt(c.slice(3, 5), 16) + parseInt(c.slice(5, 7), 16);
  for (const kind of ['house', 'manor', 'castle']) {
    for (let turn = 0; turn < 6; turn += 1) {
      const walls = partsOf(kind, turn).filter((p) => p.wall);
      assert.ok(walls.length >= 1, `${kind} ${turn} keeps wall parts`);
      const lit = facesOf(walls).map((f) => luma(f.fill));
      assert.ok(Math.min(...lit) > 600, `${kind} ${turn}: every wall seen is bright (${Math.min(...lit)})`);
    }
  }
  assert.ok(!partsOf('hut', 0).some((p) => p.wall), 'the hut has wooden walls, not white ones');
});

test('night lights sit on the window panes at every turn, only on walls that face the viewer and are not covered', () => {
  for (const kind of HOUSE_TIERS) {
    for (let turn = 0; turn < 6; turn += 1) {
      const panes = partsOf(kind, turn).filter((p) => p.glass && p.glass[1] > 0.001);
      const lights = houseLights(kind, turn);
      assert.ok(lights.length >= 1 && lights.length <= panes.length, `${kind} ${turn}: only panes that face us, none behind a roof`);
      lights.forEach(([x, y]) => {
        const near = panes.some((p) => Math.hypot(p.center[0] - x, p.center[1] * Math.sin((52 * Math.PI) / 180) - p.center[2] * Math.cos((52 * Math.PI) / 180) - y) < 0.1);
        assert.ok(near, `${kind} ${turn}: a light with no pane under it`);
      });
    }
  }
});

