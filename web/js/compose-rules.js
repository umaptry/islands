// The body of a post, counted and cut the way the server counts it. DOM-free, so the node tests can run it.
//
// The server measures the trimmed body in characters (Python's len), not in the UTF-16 units of
// String.length: an emoji is one character there and two here. Counting by code points keeps the
// counter, the red marker and the server's 60 the same number.

const chars = (text) => Array.from(String(text ?? ''));

/** How many characters the post will have (the body is trimmed before it is saved). */
export function bodyLength(text) {
  return chars(String(text ?? '').trim()).length;
}

/**
 * The body cut where it passes `max`: [kept, over]. `over` is what the screen paints red (as X does).
 * Blanks before the first character do not count (they are trimmed), and blanks alone after the limit
 * are not marked, since they are trimmed too and the post is not over.
 */
export function splitOverflow(text, max) {
  const list = chars(text);
  let counted = 0;
  let started = false;
  for (let index = 0; index < list.length; index += 1) {
    if (!started && /\s/.test(list[index])) continue;
    started = true;
    counted += 1;
    if (counted > max) {
      const over = list.slice(index).join('');
      return over.trim() ? [list.slice(0, index).join(''), over] : [list.join(''), ''];
    }
  }
  return [list.join(''), ''];
}

/** The step a back press leads to: the one before, or null when it leaves the screen. */
export function stepBefore(step) {
  return step > 1 ? step - 1 : null;
}
