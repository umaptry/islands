import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const load = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { isTextEntry, isShrunk, SHRUNK_RATIO } = await import(dataUrl(await load('web/js/keyboard.js')));

test('text fields raise the keyboard; checkboxes, sliders, files and buttons do not', () => {
  assert.equal(isTextEntry({ tag: 'TEXTAREA' }), true);
  for (const type of ['', 'text', 'search', 'email', 'url', 'tel', 'number', 'password', 'TEXT']) {
    assert.equal(isTextEntry({ tag: 'INPUT', type }), true, type);
  }
  for (const type of ['checkbox', 'radio', 'range', 'file', 'button', 'submit', 'color']) {
    assert.equal(isTextEntry({ tag: 'INPUT', type }), false, type);
  }
  assert.equal(isTextEntry({ tag: 'BUTTON' }), false);
  assert.equal(isTextEntry({ tag: 'DIV', editable: true }), true);
  assert.equal(isTextEntry({ tag: 'TEXTAREA', readOnly: true }), false);
  assert.equal(isTextEntry({ tag: 'INPUT', type: 'text', disabled: true }), false);
  assert.equal(isTextEntry(), false);
});

test('the visual viewport counts as shrunk only well below the usual height', () => {
  assert.equal(isShrunk(844, 844), false);
  assert.equal(isShrunk(844, 844 * SHRUNK_RATIO + 1), false);
  assert.equal(isShrunk(844, 500), true);
  assert.equal(isShrunk(0, 500), false);
  assert.equal(isShrunk(844, 0), false);
});

test('the nav is hidden while the keyboard is up', async () => {
  const css = await load('web/style.css');
  assert.match(css, /body\.kb-open \.bottom-nav\s*\{\s*display:\s*none/);
  assert.match(css, /body\.kb-open\.has-nav \.screen\.tinted\s*\{\s*padding-bottom:\s*0/);
});

test('the foot is made smaller only with the keyboard up on a short screen (iPhone SE, 13 mini)', async () => {
  const { isShortWithKeyboard, SHORT_HEIGHT } = await import(dataUrl(await load('web/js/keyboard.js')));
  assert.equal(isShortWithKeyboard(true, 300), true);
  assert.equal(isShortWithKeyboard(true, SHORT_HEIGHT - 1), true);
  assert.equal(isShortWithKeyboard(true, SHORT_HEIGHT), false);
  assert.equal(isShortWithKeyboard(false, 300), false);
  assert.equal(isShortWithKeyboard(true, 0), false);
});
