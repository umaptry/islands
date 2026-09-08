import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const element = () => ({ hidden: false, classList: { toggle() {} } });
globalThis.window = { location: { hash: '#/map' } };
globalThis.history = {
  pushState(_a, _b, hash) { window.location.hash = hash; },
  replaceState(_a, _b, hash) { window.location.hash = hash; },
};
globalThis.document = { body: element(), dispatchEvent() {} };
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
let source = await readFile(new URL('../../web/js/router.js', import.meta.url), 'utf8');
source = source.replace("import { $, $$, closeSheet } from './ui.js';", () =>
  'const $ = () => ({ hidden: false }); const $$ = () => []; const closeSheet = () => {};');
const router = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('navigation during async entry waits for and reaches the latest destination', async () => {
  let release; const entered = [];
  router.route('#/slow', 'slow'); router.route('#/map', 'map'); router.route('#/profile', 'profile');
  router.screen('slow', { async enter() { entered.push('slow'); await new Promise(r => { release = r; }); } });
  router.screen('map', { enter() { entered.push('map'); } });
  router.screen('profile', { enter() { entered.push('profile'); } });
  const first = router.navigate('#/slow');
  const skipped = router.navigate('#/profile');
  const latest = router.navigate('#/map');
  release();
  assert.deepEqual(await Promise.all([first, skipped, latest]), [false, false, true]);
  assert.deepEqual(entered, ['slow', 'map']);
  assert.equal(router.activeScreen(), 'map');
});

test('failed entry does not leave the router locked', async () => {
  router.route('#/bad', 'bad');
  router.screen('bad', { enter() { throw new Error('offline'); } });
  await router.navigate('#/bad');
  assert.equal(await router.navigate('#/map'), true);
});
