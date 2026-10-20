import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The sharp ground is built in a Web Worker (terrain-worker.js), which has no
// DOM: detailPixels must work from plain data, with the config handed over.
// Loaded as the worker loads them: the real modules, wired to each other.
const asModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const read = (path) => readFile(new URL(`../../web/js/${path}`, import.meta.url), 'utf8');
const configUrl = asModule(await read('config.js'));
const coastUrl = asModule((await read('map/coast.js')).replace("'../config.js'", `'${configUrl}'`));
const surfUrl = asModule(await read('map/surf.js'));
const terrainUrl = asModule((await read('map/terrain.js'))
  .replace("'../config.js'", `'${configUrl}'`).replace("'./coast.js'", `'${coastUrl}'`).replace("'./surf.js'", `'${surfUrl}'`));
const { config, setReachFactor, useConfig } = await import(configUrl);
const { PREVIEW_RATIO, detailPixels, groundPixels, sharpPlan } = await import(terrainUrl);

// The energy constants as /api/config serves them (core/energy.py).
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
});

const job = {
  posts: [{ id: 'p1', x: 100, y: 100, energy: 120 }],
  cells: [],
  region: { minX: 0, minY: 0, maxX: 200, maxY: 200 },
  scale: 2,
  pixelRatio: 1,
};

const alphaAt = (built, worldX, worldY) => {
  const x = Math.floor((worldX - built.minX) * built.scale);
  const y = Math.floor((worldY - built.minY) * built.scale);
  return built.pixels[(y * built.width + x) * 4 + 3];
};

test('detailPixels paints land under a post and leaves the far sea empty, without a DOM', () => {
  assert.equal(typeof document, 'undefined');
  const built = detailPixels(job);
  assert.ok(built.pixels instanceof Uint8ClampedArray);
  assert.equal(built.pixels.length, built.width * built.height * 4);
  assert.equal(built.width, 400);
  assert.equal(built.height, 400);
  assert.equal(built.field, undefined, 'only pixels go back to the page');
  assert.ok(alphaAt(built, 100, 100) > 0, 'land under the post');
  assert.equal(alphaAt(built, 5, 5), 0, 'open sea far from it');
});

test('the same job gives the same pixels (the page swaps them in as they come)', () => {
  const a = detailPixels(job);
  const b = detailPixels(job);
  assert.deepEqual(a.pixels, b.pixels);
});

test('nothing to paint over an empty region', () => {
  assert.equal(detailPixels({ ...job, region: { minX: 10, minY: 10, maxX: 10, maxY: 50 } }), null);
});

test('groundPixels gives the whole-map texture with its trees, as plain data', () => {
  const posts = [{ id: 'p1', x: 100, y: 100, energy: 900 }, { id: 'p2', x: 130, y: 110, energy: 900 }];
  const built = groundPixels({ posts, cells: [], region: { minX: 70, minY: 70, maxX: 160, maxY: 140 }, scale: 1 });
  assert.equal(built.pixels.length, built.width * built.height * 4);
  assert.equal(built.field, undefined);
  assert.ok(Array.isArray(built.trees) && built.trees.length > 0, 'a forest grows on that much energy');
  assert.deepEqual(Object.keys(built.trees[0]).sort(), ['k', 'name', 'x', 'y']);
  // Structured-cloneable, as postMessage needs.
  assert.deepEqual(structuredClone(built.trees), built.trees);
});

test('a new reach factor from the islands poll is a new config, and shrinks the land', () => {
  const land = (built) => built.pixels.filter((_, i) => i % 4 === 3 && built.pixels[i] > 0).length;
  const before = config();
  const wide = land(detailPixels(job));
  assert.equal(setReachFactor(1), false, 'the same factor changes nothing');
  assert.equal(config(), before);
  assert.equal(setReachFactor(0.5), true);
  assert.notEqual(config(), before, 'a new object, so the worker is handed it');
  assert.ok(land(detailPixels(job)) < wide * 0.5);
  assert.equal(setReachFactor('nonsense'), false);
  setReachFactor(1);
});

test('detailPixels hands back the coast for the surf only when asked, as plain numbers', () => {
  assert.equal(detailPixels(job).coast, null);
  const built = detailPixels({ ...job, surf: true });
  assert.ok(built.coast && built.coast.lines.length >= 1, 'a loop round the island');
  const { closed, n, data } = built.coast.lines[0];
  assert.equal(closed, true);
  assert.ok(data instanceof Float32Array && data.length === n * 6);
  // World units: every point is a stretch outside the land, inside the region.
  for (let k = 0; k < n; k += 1) {
    assert.ok(data[k * 6] > 0 && data[k * 6] < 200 && data[k * 6 + 1] > 0 && data[k * 6 + 1] < 200);
  }
  assert.deepEqual(detailPixels({ ...job, surf: true }).coast.lines[0].data, data, 'same job, same coast');
});

test('the preview (half the pixel ratio) has a quarter of the pixels and the same land', () => {
  const full = detailPixels(job);
  const preview = detailPixels({ ...job, pixelRatio: PREVIEW_RATIO });
  assert.equal(PREVIEW_RATIO, 0.5);
  assert.equal(preview.width * preview.height * 4, full.width * full.height);
  assert.ok(alphaAt(preview, 100, 100) > 0, 'land under the post');
  assert.equal(alphaAt(preview, 5, 5), 0, 'open sea far from it');
  assert.ok(!preview.coast, 'no surf in the preview');
});

// What the map holds of the sharp texture: made at rev 3 for these cells, 100..200 wide at 40 px/unit.
const cells = [];
const held = (extra = {}) => ({ minX: 0, minY: 0, width: 4000, height: 4000, scale: 40, rev: 3, cells, unit: 36, ...extra });
const screen = { minX: 20, minY: 20, maxX: 80, maxY: 80 };
const plan = (sharp, extra = {}) => sharpPlan({ sharp, rev: 3, cells, need: 36, view: screen, ...extra });

test('sharpPlan: a rebuilt whole-map ground changes nothing, the same revision is not asked again', () => {
  // The caller no longer passes the ground at all: only the revision counts.
  assert.equal(plan(held()).stage, 0);
});

test('sharpPlan: a new revision (posts, tryout) or other cells ask again, from the preview', () => {
  assert.equal(plan(held(), { rev: 4 }).stage, 1);
  assert.equal(plan(held(), { cells: [] }).stage, 1);
});

test('sharpPlan: nothing held, or not covering the screen, starts with the preview', () => {
  assert.equal(plan(null).stage, 1);
  assert.equal(plan(held({ minX: 50 })).stage, 1);
});

test('sharpPlan: too coarse (under 0.8 of what is needed) is asked again', () => {
  assert.equal(plan(held({ unit: 36 * 0.79 })).fine, false);
  assert.equal(plan(held({ unit: 36 * 0.8 })).fine, true);
  assert.equal(plan(held({ unit: 36 * 0.8 })).stage, 0);
});

test('sharpPlan: the surf coming into view asks for the full texture with it, once', () => {
  // Made while the surf was hidden: asked again (the full one, not the preview).
  assert.equal(plan(held({ traced: false }), { surf: true }).stage, 2);
  // Made with the surf asked for: done, even where no coast was found.
  assert.equal(plan(held({ traced: true, surf: undefined }), { surf: true }).stage, 0);
  // The surf hidden: a texture without it is fine.
  assert.equal(plan(held({ traced: false })).stage, 0);
});

test('sharpPlan: after the preview comes the full texture, and a preview is never fine', () => {
  const preview = held({ unit: 36 * PREVIEW_RATIO, preview: true });
  const state = plan(preview);
  assert.equal(state.fine, false, 'the preview is always under 0.8 of the need');
  assert.equal(state.stage, 2);
  // Very coarse stays on the preview first.
  assert.equal(plan(held({ unit: 36 * 0.3 })).stage, 1);
});
