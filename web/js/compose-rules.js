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
 * How many characters count toward the 15-character floor: the server makes each run of blanks one
 * space before it saves, so line breaks and spaces cannot fill the floor (2026-10-31). The counter
 * ("5 / 60") and the 60 limit still use bodyLength.
 */
export function floorLength(text) {
  return chars(String(text ?? '').replace(/\s+/g, ' ').trim()).length;
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

// ---------------------------------------------------------------- the 15-character floor (2026-10-31)

/**
 * The fewest characters ① accepts. A new post needs `limits.compose_min` (15); an edit keeps the server's
 * own floor (`body_min`, 1) so an old short post can still be fixed. A server that does not send
 * compose_min (an older one) leaves the floor where it was.
 */
export function composeFloor({ editing, limits }) {
  const base = Number(limits?.body_min) || 1;
  if (editing) return base;
  return Math.max(base, Number(limits?.compose_min) || 0);
}

/** The words on 次へ at ①: the floor named before anything is written, then how many more it takes
 * (the button sits right on top of the keyboard, where the note under the words is out of sight). */
export function nextLabel({ length, floor }) {
  if (floor <= 1 || length >= floor) return '次へ';
  return length < 1 ? `${floor}字から投稿できます` : `あと${floor - length}字で投稿できます`;
}

/** The small note under the words while 1 to floor-1 characters are written; null otherwise (nothing at 0).
 * The count itself is on 次へ. */
export function shortNote({ length, floor }) {
  if (floor <= 1 || length < 1 || length >= floor) return null;
  return 'どんなことを・どうして を足すと、近い人が見つけやすくなります';
}

/** The counter beside the words: "5 / 60". */
export function counterLabel(length, max) {
  return `${length} / ${max}`;
}

// ---------------------------------------------------------------- 話題の確かめ (2026-10-31)

/**
 * What 次へ does at ①, from the last text the server was asked about: `last` is
 * { body, topics, accepted } or null. 'ask' when this text was not asked about yet; 'go' when it was and
 * the person chose このまま次へ (or there was nothing to choose); 'sheet' when it was asked, two or more
 * topics came back and they have not chosen yet (書き直す, then 次へ again: the sheet comes back
 * without another call).
 */
export function topicPlan({ last, body }) {
  const text = String(body ?? '').trim();
  if (!last || last.body !== text) return 'ask';
  if ((last.topics || []).length >= 2 && !last.accepted) return 'sheet';
  return 'go';
}

/** The sheet's heading. */
export function topicHeading(count) {
  return `話題が${count}つ入っているみたいです`;
}

/** What the server returned, as the list the sheet shows: only 2 or more names count, at most 4. */
export function usableTopics(list) {
  const names = (Array.isArray(list) ? list : []).filter((name) => typeof name === 'string' && name.trim()).slice(0, 4);
  return names.length >= 2 ? names : [];
}
