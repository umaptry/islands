// The 通知 screen.
//
// islands generated notifications in the browser, which meant they existed on
// one device and the read state was a lie everywhere else - and it cheerfully
// notified you about your own taps. These are rows written by database triggers
// when somebody else reacts to or comments on your post, so a phone and a
// laptop agree, and nothing you did yourself ever appears.

import { data } from '../net.js';
import { navigate, screen } from '../router.js';
import { state } from '../state.js';
import { $, avatar, clear, el, timeAgo } from '../ui.js';

const KINDS = {
  like: { icon: '♥', tone: 'like', text: 'あなたの投稿に「いいね」しました。' },
  help: { icon: '✋', tone: 'help', text: 'あなたの投稿に「手伝えるかも」と反応しました。' },
  join: { icon: '➕', tone: 'join', text: 'あなたの投稿に「参加したい」と反応しました。' },
  comment: { icon: '💬', tone: 'comment', text: 'あなたの投稿にメッセージを送りました。' },
};

export async function refreshNotifications() {
  if (!state.account) {
    state.notifications = [];
    state.unread = 0;
    paintBadge();
    return;
  }
  try {
    state.notifications = await data.listNotifications();
  } catch {
    return;
  }
  state.unread = state.notifications.filter((row) => !row.read_at).length;
  paintBadge();
}

export function paintBadge() {
  const badge = $('navBadge');
  badge.hidden = state.unread === 0;
  badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
}

function paintList() {
  const list = clear($('notifList'));
  $('notifReadAll').hidden = state.unread === 0;

  if (!state.notifications.length) {
    list.append(el('div', { className: 'empty-panel' },
      el('div', { className: 'empty-icon', text: '🔔' }),
      el('p', { text: '通知はありません' }),
      el('p', { className: 'empty-sub', text: 'あなたの投稿に反応があると、ここに出ます。' }),
    ));
    return;
  }

  state.notifications.forEach((row) => {
    const kind = KINDS[row.type] || KINDS.like;
    const actor = row.actor || {};
    const card = el('button', {
      className: `notif ${kind.tone}${row.read_at ? ' read' : ''}`,
      attrs: { type: 'button' },
      on: { click: () => open(row) },
    },
      el('span', { className: 'notif-icon', text: kind.icon }),
      avatar(actor, 34),
      el('span', { className: 'notif-body' },
        el('span', { className: 'notif-head' },
          el('b', { text: actor.display_name || 'だれか' }),
          el('span', { className: 'notif-time', text: timeAgo(row.created_at) }),
        ),
        el('span', { className: 'notif-text', text: kind.text }),
      ),
      row.read_at ? null : el('i', { className: 'notif-dot' }),
    );
    list.append(card);
  });
}

async function open(row) {
  if (!row.read_at) {
    row.read_at = new Date().toISOString();
    state.unread = Math.max(0, state.unread - 1);
    paintBadge();
    paintList();
    data.markNotificationsRead([row.id]).catch(() => {
      // Losing a read mark is a small enough thing that a failed request is not
      // worth interrupting anybody over; the next poll corrects it either way.
    });
  }
  if (!row.post_id) return;
  navigate('#/map');
  setTimeout(() => {
    document.dispatchEvent(new CustomEvent('map:focus', { detail: { postId: row.post_id } }));
    document.dispatchEvent(new CustomEvent('map:open', { detail: { postId: row.post_id } }));
  }, 80);
}

export function setupNotifications() {
  $('notifReadAll').addEventListener('click', async () => {
    const unread = state.notifications.filter((row) => !row.read_at);
    const stamp = new Date().toISOString();
    unread.forEach((row) => { row.read_at = stamp; });
    state.unread = 0;
    paintBadge();
    paintList();
    try {
      await data.markNotificationsRead(unread.map((row) => row.id));
    } catch {
      await refreshNotifications();
      paintList();
    }
  });

  screen('notifications', {
    async enter() {
      paintList();
      await refreshNotifications();
      paintList();
    },
  });
}
