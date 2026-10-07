// The 通知 screen.
//
// islands generated notifications in the browser, which meant they existed on
// one device and the read state was a lie everywhere else - and it cheerfully
// notified you about your own taps. These are rows written by database triggers
// when somebody else reacts to or comments on your post, so a phone and a
// laptop agree, and nothing you did yourself ever appears.

import { data } from '../net.js';
import { activeScreen, navigate, screen } from '../router.js';
import { state } from '../state.js';
import { openOnMap } from './map.js';
import { icon } from '../icons.js';
import { moment } from '../feedback.js';
import { $, avatar, clear, clip, el, timeAgo } from '../ui.js';

const ARRIVAL_MS = 5000;
let seenIds = null;        // ids already known, so only new rows announce themselves
let seenFor = null;        // whose ids they are
let arrivalTimer = 0;

const KINDS = {
  like: { icon: '♥', tone: 'like', text: 'あなたの投稿に「いいね」しました。' },
  help: { icon: '✋', tone: 'help', text: 'あなたの投稿に「手伝えるかも」と反応しました。' },
  join: { icon: '➕', tone: 'join', text: 'あなたの投稿に「参加」と反応しました。' },
  comment: { icon: '💬', tone: 'comment', text: 'あなたの投稿にメッセージを送りました。' },
  reply: { icon: '💬', tone: 'comment', text: 'あなたのメッセージに返信しました。' },
  connection: { icon: '➕', tone: 'join', text: '初めてやりとりしました。地図に線が引かれます。' },
  similar: { icon: '✋', tone: 'help', text: '話題や目標が近い人が参加しました。' },
  island: { icon: '📍', tone: 'join', text: '島が変わりました。' },
};
const ICONS = { like: 'heart', help: 'help', join: 'hand', comment: 'message', reply: 'message',
  connection: 'hand', similar: 'user', island: 'pin' };

// An island change has nobody behind it: the island's name stands in for a
// person, and the recorded cause says what happened.
function headline(row) {
  if (row.type !== 'island') return (row.actor || {}).display_name || 'だれか';
  const name = (row.payload || {}).name;
  return name ? `島「${name}」` : '島';
}

function message(row, kind) {
  const cause = row.type === 'island' && (row.payload || {}).cause;
  return cause ? `${cause}。` : kind.text;
}

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
  announce(state.notifications);
}

/**
 * Something new arrived while the app was open: a band near the bottom, a
 * quiet sound and a buzz (items 20 and 21). The first load after signing in
 * only learns what is already there - a pile of old news is not an arrival.
 */
function announce(rows) {
  const ids = new Set(rows.map((row) => row.id));
  const fresh = seenIds && seenFor === state.account.id
    ? rows.filter((row) => !row.read_at && !seenIds.has(row.id))
    : [];
  seenIds = ids;
  seenFor = state.account.id;
  if (!fresh.length) return;
  if (activeScreen() === 'notifications') paintList();
  const row = fresh[0];
  const kind = KINDS[row.type] || KINDS.like;
  moment(fresh.some((entry) => entry.type === 'connection') ? 'connect' : 'notify');
  if (activeScreen() === 'notifications') return;
  $('arrivalIcon').textContent = kind.icon;
  const text = $('arrivalText');
  text.textContent = clip(`${headline(row)}　${message(row, kind)}`, 38);
  if (fresh.length > 1) text.append(el('span', { className: 'arrival-more', text: `（ほか${fresh.length - 1}件）` }));
  const band = $('arrival');
  band.hidden = false;
  requestAnimationFrame(() => band.classList.add('on'));
  clearTimeout(arrivalTimer);
  arrivalTimer = setTimeout(hideArrival, ARRIVAL_MS);
}

function hideArrival() {
  const band = $('arrival');
  band.classList.remove('on');
  clearTimeout(arrivalTimer);
  arrivalTimer = setTimeout(() => { band.hidden = true; }, 250);
}

export function paintBadge() {
  const badge = $('navBadge');
  badge.hidden = state.unread === 0;
  badge.textContent = state.unread > 9 ? '9+' : String(state.unread);

  const header = $('notifUnreadBadge');
  header.hidden = state.unread === 0;
  header.textContent = `未読 ${state.unread}件`;
}

function paintList() {
  const list = clear($('notifList'));
  $('notifReadAll').hidden = state.unread === 0;

  if (!state.notifications.length) {
    list.append(el('div', { className: 'empty-panel' },
      el('div', { className: 'empty-icon', text: '🔔' }),
      el('p', { text: '通知はありません' }),
      el('p', { className: 'empty-sub', text: 'いいね・手伝えるかも・参加したい・メッセージが届くと、ここに表示されます。' }),
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
      el('span', { className: 'notif-icon' }, icon(ICONS[row.type])),
      avatar(actor, 34),
      el('span', { className: 'notif-body' },
        el('span', { className: 'notif-head' },
          el('b', { text: headline(row) }),
          el('span', { className: 'notif-time', text: timeAgo(row.created_at) }),
        ),
        el('span', { className: 'notif-text', text: message(row, kind) }),
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
  await openOnMap(row.post_id);
}

export function setupNotifications() {
  $('arrival').addEventListener('click', () => {
    hideArrival();
    navigate('#/notifications');
  });
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
