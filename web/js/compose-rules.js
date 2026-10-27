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

/**
 * Some prompts come with a tag at ③ (困ってること → 助けてほしい): choosing the prompt ticks it, and
 * choosing another prompt or none takes the tick away again. A tag the person ticked or unticked
 * themselves is theirs and is never changed. Called after the chosen prompt changed:
 * `ticked` is the tag a prompt ticked and the person has not touched since (or null), `want` the tag
 * of the prompt chosen now (or null), `on` the tags ticked now. Returns what to untick and to tick,
 * and the new `ticked`.
 */
export function followPromptTag({ ticked, want, on }) {
  const untick = ticked && ticked !== want && on.includes(ticked) ? ticked : null;
  if (!want) return { untick, tick: null, ticked: null };
  if (ticked === want) return { untick: null, tick: null, ticked };
  if (on.includes(want)) return { untick, tick: null, ticked: null };
  return { untick, tick: want, ticked: want };
}
