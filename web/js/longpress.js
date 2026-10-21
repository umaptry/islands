// Press-and-hold on a button, without losing its ordinary tap.
//
// The rules (how long, how far a finger may drift) are plain functions so they
// can be tested; attachLongPress is the only part that touches the page.

export const HOLD_MS = 500;
export const SLOP_PX = 10;      // moving further than this is a scroll or a swipe, not a hold
const CLICK_GUARD_MS = 350;     // how long after a hold a stray click is still swallowed

/** Has the pointer wandered far enough from where it went down to give up the hold? */
export function movedTooFar(dx, dy, slop = SLOP_PX) {
  return Math.hypot(dx, dy) > slop;
}

/**
 * onHold(event) runs once per hold (or per right-click). The click that follows
 * a hold is swallowed, so holding いいね does not also toggle it; the phone's
 * own long-press menu (select text, save image) is suppressed on the button.
 * onPressing(true|false) lets the caller show that something is being held.
 */
/**
 * The finger that held lifts over whatever the hold opened (the list of people),
 * and a phone may still turn that lift into a click there: on a row, it would
 * open somebody's profile. The first click within `ms`, anywhere, is eaten.
 */
function swallowStrayClick(ms = CLICK_GUARD_MS) {
  const eat = (event) => {
    document.removeEventListener('click', eat, true);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener('click', eat, true);
  setTimeout(() => document.removeEventListener('click', eat, true), ms);
}

export function attachLongPress(node, { onHold, onPressing = () => {}, ms = HOLD_MS, slop = SLOP_PX }) {
  let timer = 0;
  let start = null;
  let held = false;
  let guard = 0;

  const stop = () => {
    clearTimeout(timer);
    timer = 0;
    start = null;
    onPressing(false);
  };
  const fire = (event) => {
    if (held) return;
    held = true;
    clearTimeout(guard);
    guard = setTimeout(() => { held = false; }, 600);
    onHold(event);
  };

  node.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    stop();
    held = false;
    start = { x: event.clientX, y: event.clientY };
    onPressing(true);
    timer = setTimeout(() => { timer = 0; onPressing(false); fire(event); }, ms);
  });
  node.addEventListener('pointermove', (event) => {
    if (start && movedTooFar(event.clientX - start.x, event.clientY - start.y, slop)) stop();
  });
  node.addEventListener('pointerup', () => {
    stop();
    if (held) {
      clearTimeout(guard);
      guard = setTimeout(() => { held = false; }, CLICK_GUARD_MS);
      swallowStrayClick();
    }
  });
  node.addEventListener('pointercancel', stop);
  node.addEventListener('pointerleave', stop);
  // Right-click on a computer, and the menu a phone raises on a long touch.
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    stop();
    fire(event);
  });
  // Capture phase and stopImmediatePropagation: this runs ahead of the button's
  // own click handler whichever order they were added in.
  node.addEventListener('click', (event) => {
    if (!held) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    held = false;
    clearTimeout(guard);
  }, true);
}
