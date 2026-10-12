// The 通知 screen.
//
// islands generated notifications in the browser, which meant they existed on
// one device and the read state was a lie everywhere else - and it cheerfully
// notified you about your own taps. These are rows written by database triggers
// when somebody else reacts to or comments on your post, so a phone and a
// laptop agree, and nothing you did yourself ever appears.
//
// Stage 6 (items 22 and 23): the list comes grouped from notification_feed() -
// reactions to one post within ten minutes are one entry - and each of the three
// kinds can be kept out of the band and the badge. A kind switched off still
// lists; it just never interrupts. The rules live in notify-rules.js.

import { api, data } from '../net.js';
import { activeScreen, navigate, screen } from '../router.js';
import { state } from '../state.js';
import { openOnMap } from './map.js';
import { icon } from '../icons.js';
import { moment } from '../feedback.js';
import { $, clear, clip, el, timeAgo } from '../ui.js';
import {
  arrivals, bodyText, defaultSettings, headline, knownIds, mergeSettings, rowIds, unreadCount,
} from '../notify-rules.js';

const ARRIVAL_MS = 5000;
const FEED_LIMIT = 50;
let seenIds = null;        // row ids already known, so only new rows announce themselves
let seenFor = null;        // whose ids they are
let settingsFor = null;    // whose switches state.notifySettings holds
let painted = '';          // what the list last showed, to repaint only on a change
let arrivalTimer = 0;
let loading = null;        // the refresh in flight
let again = false;         // asked for once more while it was in flight

const TONES = { like: 'like', help: 'help', join: 'join', comment: 'comment', reply: 'comment',
  connection: 'join', similar: 'help', island: 'join', quiet_post: 'help' };
const BAND_ICONS = { like: '♥', help: '✋', join: '➕', comment: '💬', reply: '💬',
  connection: '➕', similar: '✋', island: '📍', quiet_post: '✋' };
const ICONS = { like: 'heart', help: 'help', join: 'hand', comment: 'message', reply: 'message',
  connection: 'hand', similar: 'user', island: 'pin', quiet_post: 'user' };

/**
 * This person's three switches. Read once per account; a failed read leaves
 * everything on and is tried again on the next refresh.
 */
export async function loadNotifySettings({ force = false } = {}) {
  const id = state.account?.id || null;
  if (!id) return defaultSettings();
  if (!force && settingsFor === id && state.notifySettings) return state.notifySettings;
  try {
    const { settings, quiet_post: quietPost } = await api.get('/api/notification-settings');
    if (state.account?.id !== id) return defaultSettings();
    useNotifySettings(settings, quietPost);
  } catch {
    return state.notifySettings && settingsFor === id ? state.notifySettings : defaultSettings();
  }
  return state.notifySettings;
}

/** After the settings screen saved: the badge follows the switches at once. */
export function useNotifySettings(settings, quietPost) {
  if (quietPost !== undefined) state.quietPost = quietPost;
  state.notifySettings = mergeSettings(settings, state.quietPost);
  settingsFor = state.account?.id || null;
  state.unread = unreadCount(state.notifications, state.notifySettings);
  paintBadge();
}

/**
 * Read the list again. Realtime, the poll and the screen all ask; one read runs
 * at a time, and a request made during it runs once more right after.
 */
export function refreshNotifications() {
  if (loading) {
    again = true;
    return loading;
  }
  loading = (async () => {
    try {
      do {
        again = false;
        await load();
      } while (again);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

async function load() {
  const account = state.account;
  if (!account) {
    state.notifications = [];
    state.unread = 0;
    paintBadge();
    return;
  }
  let entries;
  let settings;
  try {
    [entries, settings] = await Promise.all([data.listNotificationFeed(FEED_LIMIT), loadNotifySettings()]);
  } catch {
    return;
  }
  if (state.account?.id !== account.id) return;   // signed out or switched meanwhile
  state.notifications = entries;
  state.unread = unreadCount(entries, settings);
  paintBadge();
  if (activeScreen() === 'notifications' && signature(entries) !== painted) paintList();
  announce(entries, settings, account.id);
}

const signature = (entries) =>
  entries.map((entry) => `${rowIds(entry).join('+')}${entry.unread ? '*' : ''}`).join(',');

/**
 * Something new arrived while the app was open: a band near the bottom, a
 * quiet sound and a buzz (items 20 and 21). The first load after signing in
 * only learns what is already there - a pile of old news is not an arrival.
 * While the app is on screen the server pushes nothing, so this band is the
 * only place it shows.
 */
function announce(entries, settings, accountId) {
  const fresh = arrivals(entries, seenFor === accountId ? seenIds : null, settings);
  seenIds = knownIds(entries);
  seenFor = accountId;
  if (!fresh.length) return;
  moment(fresh.some((entry) => entry.type === 'connection') ? 'connect' : 'notify');
  if (activeScreen() === 'notifications') return;
  const entry = fresh[0];
  $('arrivalIcon').textContent = BAND_ICONS[entry.type] || '🔔';
  const text = $('arrivalText');
  text.textContent = clip(`${headline(entry)}　${bodyText(entry)}`, 38);
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
  const entries = state.notifications;
  painted = signature(entries);
  const list = clear($('notifList'));
  $('notifReadAll').hidden = !entries.some((entry) => entry.unread);

  if (!entries.length) {
    list.append(el('div', { className: 'empty-panel' },
      el('div', { className: 'empty-icon' }, icon('bellOff', 40)),
      el('p', { text: '通知はありません' }),
      el('p', { className: 'empty-sub', text: 'メッセージ・反応・島の変化が届くと、ここに表示されます。' }),
    ));
    return;
  }

  entries.forEach((entry) => {
    const card = el('button', {
      className: `notif ${TONES[entry.type] || 'like'}${entry.unread ? '' : ' read'}`,
      attrs: { type: 'button' },
      on: { click: () => open(entry) },
    },
      el('span', { className: 'notif-icon' }, icon(ICONS[entry.type] || 'bell')),
      el('span', { className: 'notif-body' },
        el('span', { className: 'notif-head' },
          el('b', { text: headline(entry) }),
          el('span', { className: 'notif-time', text: timeAgo(entry.created_at) }),
        ),
        el('span', { className: 'notif-text', text: bodyText(entry) }),
      ),
      entry.unread ? el('i', { className: 'notif-dot' }) : null,
    );
    list.append(card);
  });
}

async function open(entry) {
  if (entry.unread) {
    entry.unread = false;
    state.unread = unreadCount(state.notifications, state.notifySettings);
    paintBadge();
    paintList();
    data.markNotificationsRead(rowIds(entry)).catch(() => {
      // Losing a read mark is a small enough thing that a failed request is not
      // worth interrupting anybody over; the next refresh corrects it either way.
    });
  }
  if (!entry.post_id) return;
  await openOnMap(entry.post_id);
}

export function setupNotifications() {
  $('arrival').addEventListener('click', () => {
    hideArrival();
    navigate('#/notifications');
  });
  $('notifSettings').addEventListener('click', () => navigate('#/me/edit?notify=1'));
  $('notifReadAll').addEventListener('click', async () => {
    const unread = state.notifications.filter((entry) => entry.unread);
    if (!unread.length) return;
    unread.forEach((entry) => { entry.unread = false; });
    state.unread = 0;
    paintBadge();
    paintList();
    try {
      await data.markNotificationsRead(unread.flatMap(rowIds));
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
