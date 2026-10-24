import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const load = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const palette = await load('web/js/map/palette.js');
const tone = (await load('web/js/screen-tone.js')).replace("'./map/palette.js'", `'${dataUrl(palette)}'`);
const { seaFor, pageSeaFor, whiteContrast } = await import(dataUrl(tone));
const { searchClosesOnTouch } = await import(dataUrl(await load('web/js/screens/map-extras-logic.js')));

test('the day sea is the plain sea; night is darker, every time reads white text', () => {
  assert.equal(seaFor('day'), '#46AEE6');
  assert.ok(whiteContrast(seaFor('night')) > whiteContrast(seaFor('day')));
  for (const t of ['morning', 'day', 'evening', 'night']) {
    assert.match(pageSeaFor(t), /^#[0-9A-F]{6}$/);
    assert.ok(whiteContrast(pageSeaFor(t)) >= whiteContrast('#46AEE6') - 0.01, t);
  }
  assert.notEqual(pageSeaFor('night'), pageSeaFor('morning'));
});

test('an empty open search closes on a touch outside the header; typed text or a touch inside keeps it', () => {
  assert.equal(searchClosesOnTouch({ open: true, value: '', query: '', inside: false }), true);
  assert.equal(searchClosesOnTouch({ open: true, value: '  ', inside: false }), true);
  assert.equal(searchClosesOnTouch({ open: true, value: 'ねこ', inside: false }), false);
  assert.equal(searchClosesOnTouch({ open: true, value: '', query: 'ねこ', inside: false }), false);
  assert.equal(searchClosesOnTouch({ open: true, value: '', inside: true }), false);
  assert.equal(searchClosesOnTouch({ open: false, value: '', inside: false }), false);
});
