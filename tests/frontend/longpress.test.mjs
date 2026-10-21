import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const load = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { movedTooFar, attachLongPress, HOLD_MS, SLOP_PX } = await import(dataUrl(await load('web/js/longpress.js')));

// A node with just enough of the DOM: listeners by name.
function fakeNode() {
  const handlers = {};
  return {
    handlers,
    addEventListener(type, fn, capture) { (handlers[type] ||= []).push({ fn, capture: Boolean(capture) }); },
    removeEventListener(type, fn) { handlers[type] = (handlers[type] || []).filter((entry) => entry.fn !== fn); },
    fire(type, event = {}) {
      const state = { prevented: false, stopped: false };
      const e = { pointerType: 'touch', button: 0, clientX: 0, clientY: 0, ...event,
        preventDefault() { state.prevented = true; }, stopImmediatePropagation() { state.stopped = true; } };
      for (const { fn } of handlers[type] || []) { fn(e); if (state.stopped) break; }
      return state;
    },
  };
}

// The page itself: where the lift after a hold may land as a click.
globalThis.document = fakeNode();

test('a hold is about half a second and may drift only a little', () => {
  assert.equal(HOLD_MS, 500);
  assert.equal(movedTooFar(0, 0), false);
  assert.equal(movedTooFar(SLOP_PX, 0), false);
  assert.equal(movedTooFar(8, 8), true);
});

test('holding fires once, swallows the next click, then taps work again', async () => {
  const node = fakeNode();
  let holds = 0;
  attachLongPress(node, { onHold: () => { holds += 1; }, ms: 20 });
  node.fire('pointerdown');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(holds, 1);
  node.fire('pointerup');
  assert.equal(node.fire('click').prevented, true);
  node.fire('pointerdown');
  node.fire('pointerup');
  assert.equal(node.fire('click').prevented, false);
  assert.equal(holds, 1);
});

test('the lift after a hold does not click what the hold opened (a phone)', async () => {
  globalThis.document = fakeNode();   // none left over from the test above
  const node = fakeNode();
  attachLongPress(node, { onHold: () => {}, ms: 20 });
  node.fire('pointerdown');
  await new Promise((r) => setTimeout(r, 40));
  node.fire('pointerup');
  // The list opened under the finger: its row gets the click, and must not act.
  assert.equal(document.fire('click').prevented, true);
  // Only that one: the next tap anywhere works.
  assert.equal(document.fire('click').prevented, false);
});

test('letting go early, or drifting, is just a tap', async () => {
  const node = fakeNode();
  let holds = 0;
  attachLongPress(node, { onHold: () => { holds += 1; }, ms: 20 });
  node.fire('pointerdown');
  node.fire('pointerup');
  await new Promise((r) => setTimeout(r, 40));
  node.fire('pointerdown', { clientX: 0, clientY: 0 });
  node.fire('pointermove', { clientX: 30, clientY: 0 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(holds, 0);
  assert.equal(node.fire('click').prevented, false);
});

test('a right-click fires at once and the page menu is refused', () => {
  const node = fakeNode();
  let holds = 0;
  attachLongPress(node, { onHold: () => { holds += 1; } });
  assert.equal(node.fire('contextmenu').prevented, true);
  assert.equal(holds, 1);
  // The touch menu that follows a hold does not fire it a second time.
  node.fire('contextmenu');
  assert.equal(holds, 1);
});
