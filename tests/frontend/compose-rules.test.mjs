import test from 'node:test';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';

// No package.json "type" in this folder: load the module as a data: URL like the other tests.
const source = await readFile(new URL('../../web/js/compose-rules.js', import.meta.url), 'utf8');
const { bodyLength, followPromptTag, splitOverflow, stepBefore } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('bodyLength counts characters as the server does: trimmed, an emoji is one', () => {
  assert.equal(bodyLength(''), 0);
  assert.equal(bodyLength('  映画  '), 2);
  assert.equal(bodyLength('🎬映画'), 3);
  assert.equal(bodyLength(null), 0);
});

test('splitOverflow: what passes the limit is cut off to be painted red', () => {
  assert.deepEqual(splitOverflow('あいうえお', 5), ['あいうえお', '']);
  assert.deepEqual(splitOverflow('あいうえおかき', 5), ['あいうえお', 'かき']);
  // blanks before the first character are trimmed, so they do not count
  assert.deepEqual(splitOverflow('  あいうえおか', 5), ['  あいうえお', 'か']);
  // blanks alone after the limit are trimmed too: nothing is over
  assert.deepEqual(splitOverflow('あいうえお  ', 5), ['あいうえお  ', '']);
  // an emoji is one character, and is never cut in half
  assert.deepEqual(splitOverflow('🎬🎬🎬', 2), ['🎬🎬', '🎬']);
  // a new line counts like the server counts it
  assert.deepEqual(splitOverflow('あい\nうえ', 4), ['あい\nう', 'え']);
});

test('stepBefore: ← goes one step back, and from the first it leaves', () => {
  assert.equal(stepBefore(3), 2);
  assert.equal(stepBefore(2), 1);
  assert.equal(stepBefore(1), null);
});

test('followPromptTag: 困ってること ticks 助けてほしい, and the tick goes with the prompt', () => {
  const HELP = '助けてほしい';
  // chosen: ticked by the prompt
  assert.deepEqual(followPromptTag({ ticked: null, want: HELP, on: [] }), { untick: null, tick: HELP, ticked: HELP });
  // unchosen, or another prompt chosen: the prompt's tick goes again, other tags stay
  assert.deepEqual(followPromptTag({ ticked: HELP, want: null, on: [HELP, '仲間募集中'] }), { untick: HELP, tick: null, ticked: null });
  // pressed again while chosen (nothing changed): nothing to do
  assert.deepEqual(followPromptTag({ ticked: HELP, want: HELP, on: [HELP] }), { untick: null, tick: null, ticked: HELP });
  // a prompt without a tag: nothing ticked
  assert.deepEqual(followPromptTag({ ticked: null, want: null, on: [] }), { untick: null, tick: null, ticked: null });
});

test('followPromptTag: a tag the person set themselves is never changed', () => {
  const HELP = '助けてほしい';
  // ticked by the person before the prompt was chosen: not the prompt's, so unchoosing keeps it
  assert.deepEqual(followPromptTag({ ticked: null, want: HELP, on: [HELP] }), { untick: null, tick: null, ticked: null });
  assert.deepEqual(followPromptTag({ ticked: null, want: null, on: [HELP] }), { untick: null, tick: null, ticked: null });
  // ticked by the prompt, then unticked by the person (the screen forgets `ticked`): unchoosing does nothing
  assert.deepEqual(followPromptTag({ ticked: null, want: null, on: [] }), { untick: null, tick: null, ticked: null });
  // the prompt's tick, already gone some other way: nothing to untick
  assert.deepEqual(followPromptTag({ ticked: HELP, want: null, on: [] }), { untick: null, tick: null, ticked: null });
});
