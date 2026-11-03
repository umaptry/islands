import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Map plan B's ground. Loaded as the worker loads it: the real modules, wired to
// each other through data: URLs.
const asModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const read = (path) => readFile(new URL(`../../web/js/${path}`, import.meta.url), 'utf8');
const configUrl = asModule(await read('config.js'));
const coastUrl = asModule((await read('map/coast.js')).replace("'../config.js'", `'${configUrl}'`));
const surfUrl = asModule(await read('map/surf.js'));
const islandUrl = asModule(await read('map/island-b.js'));
const roadsUrl = asModule(await read('map/roads-b.js'));
const terrainBUrl = asModule((await read('map/terrain-b.js'))
  .replace("'./island-b.js'", `'${islandUrl}'`).replace("'./surf.js'", `'${surfUrl}'`).replace("'./roads-b.js'", `'${roadsUrl}'`));
const terrainUrl = asModule((await read('map/terrain.js'))
  .replace("'../config.js'", `'${configUrl}'`).replace("'./coast.js'", `'${coastUrl}'`).replace("'./surf.js'", `'${surfUrl}'`)
  .replace("'./island-b.js'", `'${islandUrl}'`).replace("'./terrain-b.js'", `'${terrainBUrl}'`));
const { useConfig } = await import(configUrl);
const island = await import(islandUrl);
const { computeB, scatterTreesB, sigmaFor, COLORS } = await import(terrainBUrl);
const { detailPixels, groundPixels } = await import(terrainUrl);

const ENERGY = {
  energy_per_interaction: 5, radius_base: 30, radius_scale: 0.45, radius_trim: 2 / 3, radius_factor: 1,
  biome_order: ['shallow', 'desert', 'savanna', 'plains', 'forest', 'mountain'],
  biome_thresholds: { shallow: 0.05, desert: 30, savanna: 50, plains: 90, forest: 300, mountain: 700 },
  biome_colors: {
    sea: '#1F8FE8', shallow: '#63CDF9', desert: '#E6CF9B', savanna: '#C8B676',
    plains: '#81C784', forest: '#41A873', mountain: '#34806C',
  },
  coast_depth: 0.3, coast_waves: [[2, 1], [3, 0.8], [4, 0.5], [5, 0.35], [7, 0.2]],
};
const setFlag = (on) => useConfig({ energy: ENERGY, features: { map_b: on } });

// The same made-up island as island-b.test.mjs: coast = 2 * (60 - distance from
// the middle), capped at 120. The start village is up in the north.
const N = 40;
function payload(extra = {}) {
  const coast = new Int8Array(N * N);
  const region = new Uint8Array(N * N);
  const near = new Uint8Array(N * N);
  for (let j = 0; j < N; j += 1) {
    for (let i = 0; i < N; i += 1) {
      const x = -100 + (i + 0.5) * 5;
      const y = -100 + (j + 0.5) * 5;
      const c = Math.min(120, 2 * (60 - Math.hypot(x, y)));
      coast[j * N + i] = Math.max(-127, Math.round(c / 4));
      region[j * N + i] = c > 0 ? 0 : 255;
    }
  }
  const b64 = (a) => Buffer.from(a.buffer).toString('base64');
  return {
    version: 'v1', grid: { x0: -100, y0: -100, cell: 5, n: N }, coast: b64(coast), region: b64(region), near: b64(near),
    regions: [], start: { x: 0, y: -48 }, extent: { minX: -100, minY: -100, maxX: 100, maxY: 100 }, forest: 'grove', ...extra,
  };
}

const POSTS = [{ id: 'p1', x: 30, y: 10 }];
const REGION = { minX: -100, minY: -100, maxX: 100, maxY: 100 };
const job = { posts: POSTS, cells: [], region: REGION, scale: 2, pixelRatio: 1 };
const options = { posts: POSTS, region: REGION, scale: 1, unit: 1, padding: 0, limit: 2000 };

const rgbAt = (built, x, y) => {
  const px = Math.floor((x - built.minX) * built.scale);
  const py = Math.floor((y - built.minY) * built.scale);
  const at = (py * built.width + px) * 4;
  return [...built.pixels.slice(at, at + 4)];
};
const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
// The band whose colour is nearest (the light and shade move a colour a little).
function nearest(rgb) {
  let best = null;
  for (const [name, value] of Object.entries(COLORS)) {
    const c = hex(value);
    const d = Math.hypot(rgb[0] - c[0], rgb[1] - c[1], rgb[2] - c[2]);
    if (!best || d < best.d) best = { name, d };
  }
  return best.name;
}
const reset = (extra) => {
  island.setIslandB(payload(extra));
  island.setIslandBView({ communityKey: 'bar', postTotal: 0, forest: null, mapParam: null });
  setFlag(true);
};

test('the shape of the result is the old compute()', () => {
  reset();
  const built = computeB(options);
  assert.deepEqual(Object.keys(built).sort(), ['coast', 'field', 'height', 'minX', 'minY', 'pixels', 'scale', 'width'].sort());
  assert.equal(built.width, 200);
  assert.equal(built.pixels.length, 200 * 200 * 4);
  assert.equal(built.field.length, 200 * 200);
  assert.equal(built.coast, null);
  const surfed = computeB({ ...options, surf: true, smooth: true });
  assert.ok(surfed.coast && Array.isArray(surfed.coast.lines), 'the surf can trace the island');
  assert.ok(surfed.coast.lines.length >= 1);
});

test('under a post the ground is open (grass or a square), far from one it is forest', () => {
  reset();
  const built = computeB(options);
  assert.ok(['grass', 'square'].includes(nearest(rgbAt(built, 30, 10))), nearest(rgbAt(built, 30, 10)));
  assert.ok(built.field[(110 * 200) + 130] > 0.32, 'openness is in `field`');
  const far = nearest(rgbAt(built, -40, 20));
  assert.ok(['forest', 'deep'].includes(far), far);
  // The start village is open too, with no post near it.
  assert.ok(['grass', 'square'].includes(nearest(rgbAt(built, 0, -48))));
});

test('outside the island is sea; the shore is sand, then shallows', () => {
  reset();
  island.setIslandBView({ communityKey: null });   // the plain shore, so the distances below are exact
  const built = computeB(options);
  assert.equal(rgbAt(built, -95, -95)[3], 0, 'open sea shows the canvas below');
  assert.ok(rgbAt(built, 0, 66)[3] > 0, 'the shallows are painted');
  assert.equal(nearest(rgbAt(built, 0, 66)), 'shallow');
  assert.equal(nearest(rgbAt(built, 0, 59.5)), 'sand');
});

test('more posts in the community narrow how far each one opens the forest', () => {
  assert.ok(Math.abs(sigmaFor(40) - 27.5) < 1e-9);
  assert.equal(sigmaFor(4), 30);
  assert.equal(sigmaFor(100000), 11.25);
  assert.ok(sigmaFor(400) < sigmaFor(40));
  reset();
  const few = computeB(options);
  island.setIslandBView({ postTotal: 1000 });
  const many = computeB(options);
  const at = (b) => b.field[(100 + 10) * 200 + (100 + 30 + 22)];   // 22 units east of the post
  assert.ok(at(few) > at(many) * 3, `${at(few)} vs ${at(many)}`);
});

test('trees stand on the forest and never in the sea', () => {
  reset();
  const built = computeB(options);
  const trees = scatterTreesB(built);
  const plain = trees.filter((t) => t.name !== 'rock');
  assert.ok(plain.length > 50, `${plain.length} trees`);
  assert.ok(plain.length < 20000);
  assert.ok(plain.every((t) => island.isLandB(t.x, t.y)), 'no tree in the sea');
  const wet = trees.filter((t) => t.wet);
  assert.ok(wet.every((t) => !island.isLandB(t.x, t.y)), 'wet rocks are in the shallows');
  for (let i = 1; i < trees.length; i += 1) assert.ok(trees[i - 1].y <= trees[i].y, 'back to front');
  assert.ok(plain.every((t) => t.name === 'tree' || t.name === 'pine'));
  // Few where the forest is opened, many in the forest.
  const near = plain.filter((t) => Math.hypot(t.x - 30, t.y - 10) < 12).length / (Math.PI * 144);
  const deep = plain.filter((t) => Math.hypot(t.x + 30, t.y - 10) < 20).length / (Math.PI * 400);
  assert.ok(deep > near * 2, `${deep} vs ${near}`);
  assert.equal(scatterTreesB({ width: 1 }), null, 'a ground that is not plan B is not scattered');
});

test('forest "mass": one canopy in the pixels, trees only along its rim', () => {
  reset();
  const grove = scatterTreesB(computeB(options)).filter((t) => t.name !== 'rock');
  island.setIslandBView({ forest: 'mass' });
  const built = computeB(options);
  const mass = scatterTreesB(built).filter((t) => t.name !== 'rock');
  assert.ok(mass.length < grove.length * 0.8, `${mass.length} vs ${grove.length}`);
  const deepInside = (t) => island.coastAt(t.x, t.y) > 60 && Math.hypot(t.x - 30, t.y - 10) > 50 && Math.hypot(t.x, t.y + 48) > 40;
  assert.equal(mass.filter(deepInside).length, 0, 'none in the middle of the canopy');
  assert.ok(grove.filter(deepInside).length > 0, 'while groves fill it');
  // The canopy is baked in: its pixels are its own low-poly faces, not the grove's flat green.
  island.setIslandBView({ forest: 'grove' });
  const flat = computeB(options);
  assert.ok(!Buffer.from(built.pixels.buffer).equals(Buffer.from(flat.pixels.buffer)), 'the canopy is not the grove ground');
  // The payload's own choice is used when the view has none.
  reset({ forest: 'mass' });
  assert.equal(island.forestMode(), 'mass');
});

test('the same inputs give the same ground and the same trees', () => {
  reset();
  const a = computeB(options);
  const b = computeB(options);
  assert.deepEqual(a.pixels, b.pixels);
  assert.deepEqual(scatterTreesB(a), scatterTreesB(b));
});

test('flag off: terrain.js is the old ground, exactly', () => {
  const posts = [{ id: 'p1', x: 100, y: 100, energy: 120 }];
  const old = { posts, cells: [], region: { minX: 0, minY: 0, maxX: 200, maxY: 200 }, scale: 2, pixelRatio: 1 };
  island.setIslandB(null);
  setFlag(false);
  const before = detailPixels(old);
  // Island held but the flag off: nothing changes.
  island.setIslandB(payload());
  assert.deepEqual(detailPixels(old).pixels, before.pixels);
  // Flag on but no island: also the old one.
  island.setIslandB(null);
  setFlag(true);
  assert.deepEqual(detailPixels(old).pixels, before.pixels);
});

test('flag on: detailPixels and groundPixels are plan B, with trees for the whole map', () => {
  reset();
  const detail = detailPixels({ ...job, surf: true });
  assert.equal(detail.field, undefined, 'only pixels go back to the page');
  assert.ok(detail.coast && detail.coast.lines.length >= 1);
  assert.ok(['grass', 'square'].includes(nearest(rgbAt(detail, 30, 10))));
  const ground = groundPixels(job);
  assert.ok(ground.trees.length > 50);
  assert.equal(ground.field, undefined);
  assert.ok(ground.trees.filter((t) => t.name !== 'rock').every((t) => island.isLandB(t.x, t.y)));
  // The ?map=b address switches it on without the server's flag.
  setFlag(false);
  island.setIslandBView({ mapParam: 'b' });
  assert.ok(groundPixels(job).trees.length > 50);
  island.setIslandBView({ mapParam: null });
});

test('computeB guards its own posts and leaves the registered list alone', () => {
  reset();
  island.setIslandBPosts([]);
  const post = { id: 'q', x: -57, y: 0 };
  let drowned = 0;
  for (let key = 0; key < 40; key += 1) {
    island.setIslandBView({ communityKey: `community-${key}` });
    const before = [island.isLandB(post.x, post.y), island.coastAt(post.x, post.y), island.isLandB(30, 10)];
    const built = computeB({ ...options, posts: [post] });
    assert.deepEqual([island.isLandB(post.x, post.y), island.coastAt(post.x, post.y), island.isLandB(30, 10)], before, `${key}: unchanged`);
    assert.equal(rgbAt(built, post.x, post.y)[3], 255, `${key}: painted land`);
    assert.ok(!['sea', 'shallow'].includes(nearest(rgbAt(built, post.x, post.y))), `${key}`);
    if (!before[0]) drowned += 1;
  }
  assert.ok(drowned > 0, 'the page-side answer is only the registered posts');
});
