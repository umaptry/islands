// What a key press in the message box does (2026-10-21). Kept apart from
// components/chat.js, which needs the DOM, so that it can be tested in node.

/**
 * True when this keydown should send the message rather than start a new line.
 * Enter sends with a real keyboard; Shift+Enter, or any Enter on a touch screen
 * (whose keyboard has no Shift+Enter), starts a new line. An Enter that only
 * confirms a Japanese conversion (IME) never sends.
 */
export function sendsOnEnter(event, touch) {
  if (event.key !== 'Enter') return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (touch) return false;
  return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}
