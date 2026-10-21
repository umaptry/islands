import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const load = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { PALETTE, pinColor, PIN, addressParam, timeOfDay } = await import(dataUrl(await load('web/js/map/palette.js')));
const { getHeatTier, HEAT_LIME, HEAT_ORANGE, HEAT_FLAME, HEAT_BLUE } = await import(dataUrl(await load('web/js/heat.js')));
const config = await load('core/config.py');

test('palette ground colours match core/config.py BIOME_COLORS', () => {
  const block = config.match(/BIOME_COLORS\s*=\s*\{([^}]*)\}/)[1];
  const biome = Object.fromEntries([...block.matchAll(/"(\w+)":\s*"(#[0-9A-Fa-f]{6})"/g)].map((m) => [m[1], m[2].toUpperCase()]));
  // palette name -> biome name
  const pairs = { sea: 'sea', shallow: 'shallow', sand: 'desert', grass: 'plains', forest: 'forest', peak: 'mountain' };
  for (const [name, biomeName] of Object.entries(pairs)) {
    assert.ok(biome[biomeName], `${biomeName} missing in BIOME_COLORS`);
    assert.equal(PALETTE[name].toUpperCase(), biome[biomeName], `${name} vs ${biomeName}`);
  }
});

test('pinColor changes colour at exactly the heat.js tier boundaries', () => {
  const byTier = { [HEAT_LIME]: PIN.low, [HEAT_ORANGE]: PIN.mid, [HEAT_FLAME]: PIN.flame.outer, [HEAT_BLUE]: PIN.top.outer };
  for (let v = -5; v <= 105; v += 1) {
    assert.equal(pinColor(v), byTier[getHeatTier(v)], `heat ${v}`);
  }
});

test('?tod= and ?tier= are read before the # and after the route alike', () => {
  const noon = new Date(2026, 9, 19, 12, 0, 0);
  assert.equal(timeOfDay(noon, { search: '?tod=night', hash: '#/map' }), 'night');
  assert.equal(timeOfDay(noon, { search: '', hash: '#/map?tod=night' }), 'night');
  assert.equal(timeOfDay(noon, { search: '', hash: '#/map?tod=sunset' }), 'day');
  assert.equal(timeOfDay(noon, { search: '', hash: '#/map' }), 'day');
  assert.equal(timeOfDay(noon, null), 'day');
  assert.equal(addressParam('tier', { search: '', hash: '#/map?tod=day&tier=4' }), '4');
  assert.equal(addressParam('tier', { search: '?tier=2', hash: '#/map?tier=4' }), '2');
  assert.equal(addressParam('tier', { search: '', hash: '' }), null);
});

test('--grass in style.css is the map grass, and the profile photo wears it', async () => {
  const css = await load('web/style.css');
  const token = css.match(/--grass:\s*(#[0-9A-Fa-f]{6})/)[1];
  assert.equal(token.toUpperCase(), PALETTE.grass.toUpperCase());
  assert.match(css, /\.avatar\.profile-avatar\s*\{[^}]*border:\s*6px solid var\(--grass\)/);
});

test('--sand in style.css is the map beach, ringed outside the grass on the profile photo', async () => {
  const css = await load('web/style.css');
  const token = css.match(/--sand:\s*(#[0-9A-Fa-f]{6})/)[1];
  assert.equal(token.toUpperCase(), PALETTE.sand.toUpperCase());
  assert.match(css, /\.avatar\.profile-avatar\s*\{[^}]*box-shadow:\s*0 0 0 6px var\(--sand\)/);
});
