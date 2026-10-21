import test from 'node:test';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';

// No package.json "type" in this folder: load the module as a data: URL like the other tests.
const source = await readFile(new URL('../../web/js/chat-rules.js', import.meta.url), 'utf8');
const { sendsOnEnter } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const key = (extra = {}) => ({ key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...extra });

test('a real keyboard: Enter sends, Shift+Enter starts a new line', () => {
  assert.equal(sendsOnEnter(key(), false), true);
  assert.equal(sendsOnEnter(key({ shiftKey: true }), false), false);
  assert.equal(sendsOnEnter(key({ altKey: true }), false), false);
});

test('a touch screen: return always starts a new line, the button sends', () => {
  assert.equal(sendsOnEnter(key(), true), false);
});

test('an Enter that confirms a Japanese conversion never sends', () => {
  assert.equal(sendsOnEnter(key({ isComposing: true }), false), false);
  assert.equal(sendsOnEnter(key({ keyCode: 229 }), false), false);
});

test('other keys do nothing', () => {
  assert.equal(sendsOnEnter({ key: 'a' }, false), false);
});
