// While a phone's on-screen keyboard is up, the bottom nav steps out of the way.
//
// index.html asks for interactive-widget=resizes-content, so the keyboard
// shrinks the layout itself and a fixed bottom bar rides up on top of it - and
// the form a person is typing into loses its room. Hiding the bar (body.kb-open)
// gives that room back. The map's message box is a sheet with its own handling
// (--keyboard-inset in ui.js) and is not touched here.

// <input> types that bring a keyboard up; checkbox, range, file, buttons do not.
const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number', 'password']);
// The visual viewport counts as "keyboard up" below this share of the tallest
// height seen with no text field focused.
export const SHRUNK_RATIO = 0.75;

/** Whether focusing this kind of field raises the keyboard. DOM-free on purpose. */
export function isTextEntry({ tag = '', type = '', editable = false, readOnly = false, disabled = false } = {}) {
  if (readOnly || disabled) return false;
  const name = String(tag).toLowerCase();
  if (name === 'textarea') return true;
  if (name === 'input') return TEXT_TYPES.has(String(type).toLowerCase());
  return Boolean(editable);
}

/** Has the visible height dropped far enough below the usual height to be a keyboard? */
export function isShrunk(baseline, height) {
  return baseline > 0 && height > 0 && height < baseline * SHRUNK_RATIO;
}

const describe = (node) => (node instanceof Element ? {
  tag: node.tagName, type: node.getAttribute('type') || '',
  editable: node.isContentEditable, readOnly: node.readOnly === true, disabled: node.disabled === true,
} : null);

export function setupKeyboardGuard() {
  const touch = window.matchMedia('(hover: none) and (pointer: coarse)');
  const body = document.body;
  let baseline = window.innerHeight;
  let shrunkSeen = false;
  let timer = 0;

  const focused = () => {
    const info = describe(document.activeElement);
    return Boolean(info) && isTextEntry(info);
  };
  const set = (on) => body.classList.toggle('kb-open', on && touch.matches);

  document.addEventListener('focusin', (event) => {
    clearTimeout(timer);
    const info = describe(event.target);
    if (info && isTextEntry(info)) { shrunkSeen = false; set(true); }
  });
  // Moving from one field to the next fires focusout first; wait a beat so the
  // bar does not flicker back in between.
  document.addEventListener('focusout', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!focused()) set(false); }, 120);
  });
  // A field removed from the page while focused may never send focusout.
  new MutationObserver(() => {
    if (body.classList.contains('kb-open') && !focused()) { clearTimeout(timer); timer = setTimeout(() => { if (!focused()) set(false); }, 120); }
  }).observe(body, { childList: true, subtree: true });
  window.addEventListener('hashchange', () => { clearTimeout(timer); set(false); });
  window.addEventListener('orientationchange', () => { baseline = 0; shrunkSeen = false; setTimeout(() => { baseline = window.innerHeight; }, 400); });

  // Closing the keyboard with the back gesture leaves the focus where it was;
  // the viewport growing back is the only sign.
  window.visualViewport?.addEventListener('resize', () => {
    const height = window.visualViewport.height;
    if (!focused()) {
      baseline = Math.max(baseline, window.innerHeight, height);
      return;
    }
    if (isShrunk(baseline, height)) shrunkSeen = true;
    else if (shrunkSeen) { shrunkSeen = false; set(false); }
  });
}
