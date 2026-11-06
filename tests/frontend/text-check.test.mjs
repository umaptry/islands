import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const load = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
// A fresh copy for each test: the answers it has seen are kept for the page's life.
const fresh = async () => import(`${dataUrl(await load('web/js/text-check.js'))}#${Math.random()}`);

/** Timers run by hand. */
function clock() {
  let next = 1;
  const due = new Map();
  return {
    setTimeout: (fn) => { const id = next++; due.set(id, fn); return id; },
    clearTimeout: (id) => { due.delete(id); },
    run: () => { const fns = [...due.values()]; due.clear(); fns.forEach((fn) => fn()); },
    pending: () => due.size,
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const NG = 'ことばが見つかりません';
const server = (asked) => async (text) => { asked.push(text); return text.includes('ok') ? { ok: true } : { ok: false, message: NG }; };

test('typing waits a beat, then says why the words would not be taken', async () => {
  const { textCheck } = await fresh();
  const timers = clock();
  const asked = [];
  const seen = [];
  const check = textCheck({ ask: server(asked), onChange: (s) => seen.push(s.status), timers });
  check.typed('あああ');
  assert.equal(check.state.status, 'typing');
  assert.deepEqual(asked, []);
  check.typed('ああああ');
  timers.run();
  await flush();
  assert.deepEqual(asked, ['ああああ'], 'only the last text is asked about');
  assert.deepEqual(check.state, { status: 'ng', message: NG });
  assert.deepEqual(seen, ['typing', 'checking', 'ng']);
});

test('a refusal stays until the next answer, so the button does not come back between two keys', async () => {
  const { textCheck } = await fresh();
  const timers = clock();
  const check = textCheck({ ask: server([]), timers });
  await check.settle('だめ');
  assert.equal(check.state.status, 'ng');
  check.typed('だめ ok');
  assert.equal(check.state.status, 'ng');
  timers.run();
  await flush();
  assert.deepEqual(check.state, { status: 'ok', message: '' });
});

test('leaving the box or pressing the button checks at once; the same text is asked once', async () => {
  const { textCheck } = await fresh();
  const timers = clock();
  const asked = [];
  const check = textCheck({ ask: server(asked), timers });
  check.typed('ok です');
  const said = await check.settle('ok です');
  assert.deepEqual(said, { ok: true, message: '' });
  assert.equal(timers.pending(), 0, 'the waiting check is dropped');
  await check.settle('  ok です ');
  assert.deepEqual(asked, ['ok です']);
});

test('an empty box is nothing to check, and a failed ask lets the text through (asked again later)', async () => {
  const { textCheck } = await fresh();
  const timers = clock();
  let calls = 0;
  const check = textCheck({ ask: async () => { calls += 1; throw new Error('offline'); }, timers });
  assert.deepEqual(await check.settle('   '), { ok: true, message: '' });
  assert.equal(check.state.status, 'idle');
  assert.deepEqual(await check.settle('なにか'), { ok: true, message: '' });
  assert.equal(check.state.status, 'ok');
  await check.settle('なにか');
  assert.equal(calls, 2);
});

test('an answer for words that were changed meanwhile does not paint over the new ones', async () => {
  const { textCheck } = await fresh();
  const timers = clock();
  let release;
  const check = textCheck({ ask: () => new Promise((resolve) => { release = resolve; }), timers });
  const first = check.settle('はじめ');
  check.typed('');
  await flush();
  release({ ok: false, message: NG });
  assert.deepEqual(await first, { ok: false, message: NG });
  assert.equal(check.state.status, 'idle');
});
