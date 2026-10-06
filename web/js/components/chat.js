// islands' PostChat: the message list under a post, and the input pinned to the
// bottom of the expanded sheet.
//
// Polled rather than realtime. A websocket per open sheet is a connection per
// viewer for a feature that is a handful of messages a minute, and Supabase
// Realtime is a service to be down; five seconds while the sheet is open reads
// as live and costs one small request. The poll stops the moment the sheet
// closes, and never runs while the tab is hidden.

import { config } from '../config.js';
import { data } from '../net.js';
import { state } from '../state.js';
import { avatar, clear, clip, confirmAction, el, timeAgo, toast } from '../ui.js';

const POLL_MS = 5000;

export function postChat(postId, { onCountChange, onReply } = {}) {
  const list = el('div', { className: 'chat-list' });
  const wrap = el('div', { className: 'chat' }, list);
  let timer = 0;
  let known = -1;
  let destroyed = false;

  async function refresh() {
    if (destroyed) return;
    let comments;
    try {
      comments = await data.listComments(postId);
    } catch {
      return;   // a missed poll is not worth telling anyone about
    }
    if (destroyed) return;
    if (comments.length === known) return;
    known = comments.length;
    paint(comments);
    if (onCountChange) onCountChange(comments.length);
  }

  function paint(comments) {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    clear(list);
    if (!comments.length) {
      list.append(el('p', {
        className: 'chat-empty',
        text: 'まだメッセージはありません。最初のメッセージを送ってみましょう！',
      }));
      return;
    }
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    comments.forEach((comment) => {
      const author = comment.author || {};
      const mine = state.account && author.id === state.account.id;
      list.append(el('div', { className: `chat-line${mine ? ' mine' : ''}` },
        avatar(author, 30),
        el('div', { className: 'chat-bubble' },
          el('div', { className: 'chat-meta' },
            el('span', { className: 'chat-name', text: author.display_name || '' }),
            el('span', { className: 'chat-time', text: timeAgo(comment.created_at) }),
            replyButton(comment, mine),
          ),
          quote(comment, byId),
          el('p', { className: 'chat-text', text: comment.body }),
        ),
        action(comment, mine),
      ));
    });
    if (atBottom) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  /** A reply shows one line of what it answers; a withdrawn message says so. */
  function quote(comment, byId) {
    if (!comment.reply_to) return null;
    const parent = byId.get(comment.reply_to);
    if (!parent) return el('p', { className: 'chat-quote gone', text: '元のメッセージは削除されました' });
    return el('p', { className: 'chat-quote',
      text: `${parent.author?.display_name || ''}：${clip(parent.body, 28)}` });
  }

  function replyButton(comment, mine) {
    if (!state.account || !onReply || mine) return null;
    return el('button', {
      className: 'chat-reply',
      attrs: { type: 'button', 'aria-label': `${comment.author?.display_name || ''}さんに返信` },
      text: '返信',
      on: { click: () => onReply(comment) },
    });
  }

  /** The one thing you can do to a message: take yours back, or report theirs.
   *
   * Both halves already existed everywhere except here - the `deleted_at` grant
   * and the trigger that puts the count back, the `reports.comment_id` column,
   * and the two methods in net.js, which had no caller at all. A thread on a
   * public map with no way to withdraw a message is not something to ship.
   */
  function action(comment, mine) {
    if (!state.account) return null;
    return el('button', {
      className: 'chat-action',
      attrs: { type: 'button', 'aria-label': mine ? 'このメッセージを削除' : 'このメッセージを報告' },
      text: '⋯',
      on: { click: () => (mine ? remove(comment) : report(comment)) },
    });
  }

  async function remove(comment) {
    const ok = await confirmAction({
      title: 'このメッセージを削除しますか？',
      body: '相手の画面からも消えます。',
      confirmLabel: '削除する',
      danger: true,
    });
    if (!ok) return;
    try {
      await data.deleteComment(comment.id);
      await refresh();
      toast('削除しました。');
    } catch (error) {
      toast(error.message);
    }
  }

  async function report(comment) {
    const ok = await confirmAction({
      title: 'このメッセージを報告しますか？',
      body: '内容を確認します。報告したことは相手には伝わりません。',
      confirmLabel: '報告する',
    });
    if (!ok) return;
    try {
      await data.report({ commentId: comment.id });
      toast('報告しました。ありがとうございます。');
    } catch (error) {
      toast(error.message);
    }
  }

  function start() {
    refresh();
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.hidden) return;
      refresh();
    }, POLL_MS);
  }

  function destroy() {
    destroyed = true;
    clearInterval(timer);
  }

  start();
  return { node: wrap, refresh, destroy };
}

/** The input under a thread. `draft` starts it with a first line to send or
 * rewrite (Q44); replyTo(comment) makes the next message an answer to one. */
export function chatInput(postId, { onSent, draft = '' } = {}) {
  const limit = config().limits.comment_max;
  const field = el('input', {
    className: 'chat-input',
    attrs: {
      type: 'text', placeholder: 'メッセージを入力...', maxlength: limit,
      enterkeyhint: 'send', autocomplete: 'off',
    },
  });
  const send = el('button', {
    className: 'chat-send',
    attrs: { type: 'button', 'aria-label': '送信', disabled: true },
    text: '➤',
  });

  const barText = el('span', { className: 'chat-reply-text' });
  const barClose = el('button', {
    className: 'chat-reply-close',
    attrs: { type: 'button', 'aria-label': '取り消す' },
    text: '×',
  });
  const bar = el('div', { className: 'chat-reply-bar', attrs: { hidden: true } }, barText, barClose);
  let answering = null;   // the comment the next message replies to
  let drafted = false;    // the field holds the suggested first line

  function showBar(text) {
    barText.textContent = text;
    bar.hidden = !text;
  }
  barClose.addEventListener('click', () => {
    if (drafted) field.value = '';
    answering = null;
    drafted = false;
    showBar('');
    sync();
    field.focus();
  });

  function replyTo(comment) {
    answering = comment;
    if (drafted) field.value = '';
    drafted = false;
    showBar(`${comment.author?.display_name || ''}さんへ返信`);
    sync();
    field.focus();
  }

  const sync = () => { send.disabled = !field.value.trim(); };
  field.addEventListener('input', sync);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
  send.addEventListener('click', submit);

  let sending = false;
  async function submit() {
    const body = field.value.trim();
    if (!body || sending) return;
    if (!state.account) {
      toast('メッセージを送るにはログインしてください。');
      return;
    }
    sending = true;
    send.disabled = true;
    // Cleared before the request, not after: a slow network should not make it
    // look as though the tap did nothing, and a failure puts the text back.
    field.value = '';
    const answer = answering;
    answering = null;
    drafted = false;
    showBar('');
    try {
      await data.addComment(postId, body, answer?.id || null);
      if (onSent) onSent();
    } catch (error) {
      field.value = body;
      if (answer) replyTo(answer);
      toast(error.message);
    } finally {
      sending = false;
      sync();
    }
  }

  if (draft) {
    field.value = draft;
    drafted = true;
    showBar('声かけの候補です。直して送れます');
    sync();
  }

  const node = el('div', { className: 'chat-compose' }, bar, el('div', { className: 'chat-input-row' }, field, send));
  return { node, replyTo, focus: () => field.focus() };
}
