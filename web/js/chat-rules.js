// What a key press in the message box does (2026-10-21), and how the messages
// fall into threads (2026-10-29). Kept apart from components/chat.js, which
// needs the DOM, so that it can be tested in node.

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

/**
 * The messages under a post as threads (2026-10-29, YouTube's comments): a message that answers nobody
 * starts one, and every answer - to it, or to another answer in it - goes under it, one step in. Both in
 * the order they came. An answer whose message is gone starts a thread of its own (it says so itself).
 * `comments` come oldest first; returns [{ top, replies }].
 */
export function threadMessages(comments) {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootOf = (comment) => {
    let node = comment;
    const seen = new Set([node.id]);
    while (node.reply_to && byId.has(node.reply_to)) {
      const parent = byId.get(node.reply_to);
      if (seen.has(parent.id)) return comment;   // a loop cannot come from the database; stand alone
      seen.add(parent.id);
      node = parent;
    }
    return node;
  };
  const threads = new Map();
  comments.forEach((comment) => {
    const top = rootOf(comment);
    if (!threads.has(top.id)) threads.set(top.id, { top, replies: [] });
    if (top !== comment) threads.get(top.id).replies.push(comment);
  });
  return [...threads.values()];
}

/** Whom an answer in a thread answers, when that is not the message the thread starts from (shown as @名前). */
export function answeredName(thread, reply) {
  if (!reply.reply_to || reply.reply_to === thread.top.id) return '';
  const parent = thread.replies.find((other) => other.id === reply.reply_to);
  return parent?.author?.display_name || '';
}

/** A thread opens by itself when somebody else answered me in it: the 「返信がありました」 notice leads here. */
export function threadAnswersMe(thread, meId) {
  if (!meId) return false;
  const all = [thread.top, ...thread.replies];
  return thread.replies.some((reply) => {
    if (reply.author?.id === meId) return false;
    const parent = all.find((other) => other.id === reply.reply_to);
    return parent?.author?.id === meId;
  });
}
