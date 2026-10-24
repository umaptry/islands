// 「もっと話してみたい」 button: one part, used under a post card and on somebody's
// profile. Three states - the name, the name with 「（押しました）」, and 「DM を開く」 -
// and a small line under it that is there from the start and names the person.
// Pressing again on the second asks before taking it back. The state lives in
// state.talk (one record per person), so every copy on screen follows it.
//
// The button's name comes from /api/config (talk-rules.js builds every sentence);
// nothing here writes it.

import { config } from '../config.js';
import { subscribe } from '../state.js';
import { confirmAction, el } from '../ui.js';
import { talkLabelOf, talkButtonText, withdrawPrompt } from '../talk-rules.js';

// One subscription repaints every mounted button, on whichever screen it sits.
subscribe(() => {
  document.querySelectorAll('[data-talk]').forEach((node) => node._talkPaint && node._talkPaint());
});

/**
 * `talk` is { state, name, onPress, onWithdraw, onOpenDm } (see talkOptionsFor in
 * talk.js). Hidden while `state` is null: signed out, your own, no shared 会.
 */
export function talkButton(talk) {
  const label = talkLabelOf(config());
  const word = el('span', { className: 'pt-word' });
  const button = el('button', { className: 'post-talk-button', attrs: { type: 'button' } }, word);
  const note = el('p', { className: 'post-talk-note' });
  const wrap = el('div', { className: 'post-talk', attrs: { 'data-talk': '' } }, button, note);
  const current = () => (typeof talk.state === 'function' ? talk.state() : talk.state);

  const paint = () => {
    const now = current();
    wrap.hidden = !now;
    if (!now) return;
    const text = talkButtonText(now, label, talk.name);
    word.textContent = text.word;
    note.textContent = text.note;
    note.hidden = !text.note;
    button.dataset.state = now;
    button.setAttribute('aria-pressed', String(now === 'pressed'));
  };
  wrap._talkPaint = paint;

  button.addEventListener('click', async () => {
    if (button.dataset.busy) return;
    const now = current();
    button.dataset.busy = '1';
    button.disabled = true;
    try {
      if (now === 'none') {
        button.classList.remove('pop');
        void button.offsetWidth;
        button.classList.add('pop');
        await talk.onPress?.();
      } else if (now === 'pressed') {
        if (await confirmAction(withdrawPrompt(label))) await talk.onWithdraw?.();
      } else if (now === 'matched') {
        talk.onOpenDm?.();
      }
    } finally {
      delete button.dataset.busy;
      button.disabled = false;
      paint();
    }
  });
  paint();
  return wrap;
}
