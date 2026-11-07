import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Map plan B's sharp texture made in strips (terrain.js detailPlan / detailPixels
// with `strip` / detailSurf, joined by offthread.js): the strips put together are
// byte for byte the picture made whole, and the surf made alone is the surf made
// with it. Loaded the way terrain-worker.test.mjs does, with the modules terrain-b.js
// needs as well (roads-b.js, mesh.js).
const asModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const read = (path) => readFile(new URL(`../../web/js/${path}`, import.meta.url), 'utf8');
const configUrl = asModule(await read('config.js'));
const coastUrl = asModule((await read('map/coast.js')).replace("'../config.js'", `'${configUrl}'`));
const surfUrl = asModule(await read('map/surf.js'));
const islandUrl = asModule(await read('map/island-b.js'));
const roadsUrl = asModule(await read('map/roads-b.js'));
const meshUrl = asModule(await read('map/mesh.js'));
const terrainBUrl = asModule((await read('map/terrain-b.js'))
  .replace("'./island-b.js'", `'${islandUrl}'`).replace("'./surf.js'", `'${surfUrl}'`)
  .replace("'./roads-b.js'", `'${roadsUrl}'`).replace("'./mesh.js'", `'${meshUrl}'`));
const terrainUrl = asModule((await read('map/terrain.js'))
  .replace("'../config.js'", `'${configUrl}'`).replace("'./coast.js'", `'${coastUrl}'`).replace("'./surf.js'", `'${surfUrl}'`)
  .replace("'./island-b.js'", `'${islandUrl}'`).replace("'./terrain-b.js'", `'${terrainBUrl}'`));
const { useConfig } = await import(configUrl);
const island = await import(islandUrl);
const { detailPixels, detailPlan, detailSurf } = await import(terrainUrl);

useConfig({
  energy: {
    energy_per_interaction: 5, radius_base: 30, radius_scale: 0.45, radius_trim: 2 / 3, radius_factor: 1,
    biome_order: ['shallow', 'desert', 'savanna', 'plains', 'forest', 'mountain'],
    biome_thresholds: { shallow: 0.05, desert: 30, savanna: 50, plains: 90, forest: 300, mountain: 700 },
    biome_colors: {
      sea: '#1F8FE8', shallow: '#63CDF9', desert: '#E6CF9B', savanna: '#C8B676',
      plains: '#81C784', forest: '#41A873', mountain: '#34806C',
    },
    coast_depth: 0.3, coast_waves: [[2, 1], [3, 0.8], [4, 0.5], [5, 0.35], [7, 0.2]],
  },
  features: { map_b: true },
});

// A made-up island: coast = 2 * (60 - distance from the middle), capped at 120.
const N = 40;
function payload() {
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
    regions: [], extent: { minX: -100, minY: -100, maxX: 100, maxY: 100 }, forest: 'mass',
  };
}
const POSTS = [{ id: 'p1', x: 30, y: 10 }, { id: 'p2', x: -20, y: -15 }, { id: 'p3', x: 5, y: 30 }];
const view = (extra = {}) => island.setIslandBView({
  communityKey: 'bar', postTotal: 3, forest: 'mass', mapParam: 'b', roads: null, ...extra,
});

// The strips put together, as offthread.js offThreadDetail does.
function joined(job, parts) {
  const plan = detailPlan({ region: job.region, scale: job.scale, pixelRatio: job.pixelRatio, parts });
  if (!plan) return null;
  const pixels = new Uint8ClampedArray(plan.width * plan.height * 4);
  for (const strip of plan.strips) {
    const built = detailPixels({ ...job, surf: false, strip });
    assert.equal(built.width, plan.width);
    assert.equal(built.height, strip.to - strip.from);
    assert.equal(built.pixels.length, built.width * built.height * 4);
    assert.equal(built.rowFrom, strip.from);
    pixels.set(built.pixels, built.rowFrom * plan.width * 4);
  }
  return { plan, pixels };
}
const cases = [
  { name: 'across the island, zoomed out', region: { minX: -90, minY: -90, maxX: 90, maxY: 90 }, scale: 3, pixelRatio: 2, parts: 4, extra: { relief: '0' } },
  { name: 'a village, zoomed in', region: { minX: 10, minY: -5, maxX: 45, maxY: 40 }, scale: 12, pixelRatio: 2, parts: 3, extra: { relief: '0' } },
  { name: 'the coast, a low pixel ratio', region: { minX: 20, minY: 30, maxX: 80, maxY: 100 }, scale: 6, pixelRatio: 1, parts: 5, extra: { relief: '0' } },
  { name: 'the north shore, with a road', region: { minX: -40, minY: -70, maxX: 40, maxY: 0 }, scale: 8, pixelRatio: 2, parts: 4, roads: [[-30, -40, 25, -20, 2], [25, -20, 30, 10, 1]], extra: { relief: '0' } },
  { name: 'the relief, the south shore and a road', region: { minX: -60, minY: 0, maxX: 60, maxY: 100 }, scale: 6, pixelRatio: 2, parts: 3, roads: [[-30, 20, 25, 40, 3]], extra: { relief: '1' } },
];

for (const c of cases) {
  test(`strips joined are the whole picture: ${c.name}`, () => {
    island.setIslandB(payload());
    view({ roads: c.roads || null, ...(c.extra || {}) });
    const job = { posts: POSTS, cells: [], region: c.region, scale: c.scale, pixelRatio: c.pixelRatio };
    const whole = detailPixels({ ...job, surf: true });
    const made = joined(job, c.parts);
    assert.ok(made, 'a plan');
    assert.ok(made.plan.strips.length >= 2, 'cut into more than one strip');
    assert.equal(made.plan.width, whole.width);
    assert.equal(made.plan.height, whole.height);
    assert.equal(made.plan.minX, whole.minX);
    assert.equal(made.plan.minY, whole.minY);
    assert.equal(made.plan.scale, whole.scale);
    let differing = 0;
    for (let i = 0; i < whole.pixels.length; i += 1) if (whole.pixels[i] !== made.pixels[i]) differing += 1;
    assert.equal(differing, 0, 'no byte differs');
    // The surf made alone is the one made with the picture.
    const coast = detailSurf(job);
    if (!c.name.includes('village')) assert.ok(whole.coast && whole.coast.lines.length >= 1, 'the surf is traced where there is coast');
    const lines = (found) => (found ? found.lines.map((l) => [l.closed, l.n, Array.from(l.data)]) : null);
    assert.deepEqual(lines(coast), lines(whole.coast));
  });
}

test('the strips cover every row once, in order', () => {
  island.setIslandB(payload());
  view();
  const plan = detailPlan({ region: { minX: -90, minY: -90, maxX: 90, maxY: 90 }, scale: 3, pixelRatio: 2, parts: 4 });
  assert.equal(plan.strips[0].from, 0);
  assert.equal(plan.strips[plan.strips.length - 1].to, plan.height);
  plan.strips.forEach((s, i) => {
    assert.ok(s.to > s.from);
    if (i) assert.equal(s.from, plan.strips[i - 1].to);
  });
});

test('no plan when the ground cannot be cut: plan B off, another forest, or too small', () => {
  island.setIslandB(payload());
  const region = { minX: -90, minY: -90, maxX: 90, maxY: 90 };
  view({ forest: 'grove' });
  assert.equal(detailPlan({ region, scale: 3, pixelRatio: 2, parts: 4 }), null, 'the grove is made whole');
  view();
  assert.equal(detailPlan({ region: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, scale: 1, pixelRatio: 1, parts: 4 }), null, 'a few rows are not worth cutting');
  useConfig({ features: { map_b: false } });
  island.setIslandBView({ mapParam: null });
  assert.equal(detailPlan({ region, scale: 3, pixelRatio: 2, parts: 4 }), null, 'plan A is made whole');
  useConfig({ features: { map_b: true } });
});
