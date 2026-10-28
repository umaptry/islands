import test from 'node:test';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';

// No package.json "type" in this folder: load the module as a data: URL like the other tests.
const source = await readFile(new URL('../../web/js/chat-rules.js', import.meta.url), 'utf8');
const { sendsOnEnter, threadMessages, answeredName, threadAnswersMe } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

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

// ---------------------------------------------------------------- threads (2026-10-29)

const msg = (id, who, replyTo = null) => ({ id, body: id, reply_to: replyTo, author: { id: who, display_name: who } });

test('messages fall into threads: answers (and answers to answers) go under the message they start from', () => {
  const comments = [msg('a', 'haruka'), msg('a1', 'takumi', 'a'), msg('b', 'kenta'), msg('a2', 'haruka', 'a1'), msg('b1', 'takumi', 'b')];
  const threads = threadMessages(comments);
  assert.deepEqual(threads.map((t) => t.top.id), ['a', 'b']);
  assert.deepEqual(threads[0].replies.map((r) => r.id), ['a1', 'a2']);
  assert.deepEqual(threads[1].replies.map((r) => r.id), ['b1']);
});

test('an answer whose message is gone starts a thread of its own', () => {
  const threads = threadMessages([msg('x', 'haruka', 'deleted'), msg('x1', 'takumi', 'x')]);
  assert.deepEqual(threads.map((t) => t.top.id), ['x']);
  assert.deepEqual(threads[0].replies.map((r) => r.id), ['x1']);
});

test('a loop in reply_to cannot hang the thread', () => {
  const threads = threadMessages([msg('p', 'a', 'q'), msg('q', 'b', 'p')]);
  assert.equal(threads.reduce((n, t) => n + 1 + t.replies.length, 0), 2);
});

test('@名前 only for an answer to an answer', () => {
  const [thread] = threadMessages([msg('a', 'haruka'), msg('a1', 'takumi', 'a'), msg('a2', 'haruka', 'a1')]);
  assert.equal(answeredName(thread, thread.replies[0]), '');
  assert.equal(answeredName(thread, thread.replies[1]), 'takumi');
});

test('a thread opens by itself when somebody else answered me in it', () => {
  const [thread] = threadMessages([msg('a', 'haruka'), msg('a1', 'takumi', 'a'), msg('a2', 'haruka', 'a1')]);
  assert.equal(threadAnswersMe(thread, 'haruka'), true);
  assert.equal(threadAnswersMe(thread, 'takumi'), true);
  assert.equal(threadAnswersMe(thread, 'kenta'), false);
  assert.equal(threadAnswersMe(thread, null), false);
  const [own] = threadMessages([msg('m', 'me'), msg('m1', 'me', 'm')]);
  assert.equal(threadAnswersMe(own, 'me'), false);
});