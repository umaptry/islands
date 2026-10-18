import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const load = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { PALETTE, pinColor, PIN } = await import(dataUrl(await load('web/js/map/palette.js')));
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
