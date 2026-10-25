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
import { membersOnly } from '../config.js';
import { communityIdOfPost, communityNameFor } from '../communities.js';
import { communityNameIn } from '../community-rules.js';
import { openOnMap } from './map.js';
import {
  openDmForNotification, recomputeDmUnread, refreshDmRooms, refreshTalk, talkAvailable, talkLabel,
} from '../talk.js';
import { icon } from '../icons.js';
import { setupCatchup } from '../catchup.js';
import { moment } from '../feedback.js';
import { $, avatar, clear, clip, el, timeAgo } from '../ui.js';
import {
  arrivals, bodyText, defaultSettings, dmMessageRows, headline, knownIds, listable, matchSignature, mergeSettings,
  communityIdOf, isResident, isTalkType, rowIds, unreadCount,
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
let arrivalTarget = '#/notifications';   // where the band goes when tapped
let dmNoticeSeen = '';     // the DM-message rows known, so a new one re-reads the rooms at once

const TONES = { like: 'like', help: 'help', join: 'join', comment: 'comment', reply: 'comment',
  connection: 'join', similar: 'help', island: 'join', quiet_post: 'help',
  talk_wish: 'join', talk_match: 'join', dm: 'comment' };
const BAND_ICONS = { like: '♥', help: '✋', join: '➕', comment: '💬', reply: '💬',
  connection: '➕', similar: '✋', island: '📍', quiet_post: '✋',
  talk_wish: '💬', talk_match: '💬', dm: '💬' };
const ICONS = { like: 'heart', help: 'help', join: 'hand', comment: 'message', reply: 'message',
  connection: 'hand', similar: 'user', island: 'pin', quiet_post: 'user',
  talk_wish: 'user', talk_match: 'message', dm: 'message' };
let matchSeen = null;      // the 「お互いに」 rows known, so the buttons re-read when a new one arrives

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
    state.dmNotices = [];
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
  // DM messages live in the DM tab: the list and its badge leave them out (a push is not affected).
  state.dmNotices = dmMessageRows(entries);
  state.notifications = listable(entries);
  state.unread = unreadCount(state.notifications, settings);
  paintBadge();
  followTalk(entries);
  if (activeScreen() === 'notifications' && signature(state.notifications) !== painted) paintList();
  announce(entries, settings, account.id);
}

/** A new 「お互いに」 row means a DM has opened: re-read what the cards show. A new
 * DM message while the list or a room is open is passed on to dm.js. */
function followTalk(entries) {
  if (!talkAvailable()) return;
  const matches = matchSignature(entries);
  if (matches !== matchSeen) {
    matchSeen = matches;
    refreshTalk();
  }
  // The DM tab's badge: a new message notice means a room has something new, so read the rooms now.
  const notices = dmMessageRows(entries).flatMap(rowIds).sort().join(',');
  const changed = notices !== dmNoticeSeen;
  dmNoticeSeen = notices;
  recomputeDmUnread();
  refreshDmRooms({ maxAge: changed ? 0 : 20000 });
  if (['dmList', 'dmRoom'].includes(activeScreen())) document.dispatchEvent(new CustomEvent('dm:maybe-new'));
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
  // The DM screens already show the message itself; a band for it would only repeat it.
  const shown = ['dmList', 'dmRoom'].includes(activeScreen()) ? fresh.filter((row) => row.type !== 'dm') : fresh;
  if (!shown.length) return;
  const entry = shown[0];
  arrivalTarget = entry.type === 'dm' ? '#/dm' : '#/notifications';
  $('arrivalIcon').textContent = BAND_ICONS[entry.type] || '🔔';
  const text = $('arrivalText');
  text.textContent = clip(`${headline(entry, talkLabel())}　${bodyText(entry, talkLabel())}`, 38);
  if (shown.length > 1) text.append(el('span', { className: 'arrival-more', text: `（ほか${shown.length - 1}件）` }));
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

// 投稿が0件の人にだけ「投稿する」を見せる。投稿数がまだ分からないときは調べてから決める。
let postsCheckedFor = null;
let postsChecking = false;

async function checkMyPosts() {
  const account = state.account;
  if (postsChecking) return;
  postsChecking = true;
  try {
    const posts = await data.postsByAuthor(account.id);
    if (state.account?.id !== account.id) return;
    state.myPosts = posts;
    postsCheckedFor = account.id;
  } catch {
    return;
  } finally {
    postsChecking = false;
  }
  const button = document.getElementById('notifEmptyPost');
  if (button) button.hidden = state.myPosts.length > 0;
}

// 確認が済んで0件と分かったときだけ「投稿する」を出す（ちらつき防止）。
function postsKnownEmpty() {
  return Boolean(state.account) && postsCheckedFor === state.account.id && !state.myPosts?.length;
}

/**
 * Under a row: which community it is about, small. The row's own community when it says one, else the community
 * of its post. A 「話してみたい」 row is anonymous on purpose and never says (nor do the DM rows: they belong to
 * two people, not to a community). Quiet when unknown: a name is only a label.
 */
function communityLine(entry) {
  if (!membersOnly() || isTalkType(entry.type)) return null;
  const node = el('span', { className: 'notif-community', hidden: true });
  const set = (name) => {
    if (!name || !node.isConnected) return false;
    node.textContent = name;
    node.hidden = false;
    return true;
  };
  const known = {};
  const onScreen = state.postsById.get(entry.post_id) || state.myPosts.find((post) => post.id === entry.post_id);
  if (entry.post_id && onScreen && onScreen.community_id) known[entry.post_id] = onScreen.community_id;
  const id = communityIdOf(entry, known);
  const name = communityNameIn(state.communities, id);
  if (name) {
    node.textContent = name;
    node.hidden = false;
    return node;
  }
  if (!id && !entry.post_id) return node;
  (async () => {
    const found = id || await communityIdOfPost(entry.post_id);
    set(await communityNameFor(found));
  })();
  return node;
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
      el('p', { className: 'empty-sub', text: 'メッセージや反応、島の変化が届くと、ここに表示されます。気になる投稿に「いいね」やメッセージを送ってみましょう。' }),
      el('div', { className: 'empty-actions' },
        el('button', {
          className: 'btn btn-small', attrs: { type: 'button', id: 'notifEmptyMap' },
          text: 'マップを見る', on: { click: () => navigate('#/map') },
        }),
        el('button', {
          className: 'btn btn-small', attrs: { type: 'button', id: 'notifEmptyPost' },
          text: '投稿する', hidden: !postsKnownEmpty(), on: { click: () => navigate('#/post') },
        }),
      ),
    ));
    if (state.account && postsCheckedFor !== state.account.id) checkMyPosts();
    return;
  }

  entries.forEach((entry) => {
    const card = el('button', {
      className: `notif ${TONES[entry.type] || 'like'}${entry.unread ? '' : ' read'}${isResident(entry) ? ' resident' : ''}`,
      attrs: { type: 'button' },
      on: { click: () => open(entry) },
    },
      // A new resident shows their own face; the rest show the icon of their kind.
      el('span', { className: 'notif-icon' }, isResident(entry) && entry.actors && entry.actors[0]
        ? avatar(entry.actors[0], 36) : icon(ICONS[entry.type] || 'bell')),
      el('span', { className: 'notif-body' },
        el('span', { className: 'notif-head' },
          el('b', { text: headline(entry, talkLabel()) }),
          el('span', { className: 'notif-time', text: timeAgo(entry.created_at) }),
        ),
        el('span', { className: 'notif-text', text: bodyText(entry, talkLabel()) }),
        communityLine(entry),
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
  // 「話してみたい」 rows lead somewhere of their own; the rest open their post.
  if (entry.type === 'talk_wish') {
    // The row carries no post on purpose (it would reveal who pressed), so it goes to the map.
    await navigate('#/map');
    return;
  }
  if (entry.type === 'talk_match' || entry.type === 'dm') {
    await openDmForNotification(entry);
    return;
  }
  if (!entry.post_id) return;
  await openOnMap(entry.post_id);
}

/** These rows were seen somewhere else (the catch-up): read them, the dot and the badge go with it. */
function markRowsRead(rows) {
  const unread = rows.filter((entry) => entry.unread);
  if (!unread.length) return;
  unread.forEach((entry) => { entry.unread = false; });
  state.unread = unreadCount(state.notifications, state.notifySettings);
  paintBadge();
  data.markNotificationsRead(unread.flatMap(rowIds)).catch(() => {
    // The next refresh corrects a lost read mark.
  });
}

/** Opening a room reads that person's DM rows: the dot and the badge go with it. */
export function markDmNotificationsRead(otherId) {
  const rows = [...state.notifications, ...state.dmNotices].filter((entry) => entry.unread
    && entry.actor_id === otherId && (entry.type === 'dm' || entry.type === 'talk_match'));
  if (!rows.length) return;
  rows.forEach((entry) => { entry.unread = false; });
  state.unread = unreadCount(state.notifications, state.notifySettings);
  paintBadge();
  recomputeDmUnread();
  data.markNotificationsRead(rows.flatMap(rowIds)).catch(() => {
    // The next refresh corrects a lost read mark.
  });
}

export function setupNotifications() {
  setupCatchup({
    refresh: refreshNotifications,
    markRead: markRowsRead,
    openPost: (postId) => openOnMap(postId),
  });
  $('arrival').addEventListener('click', () => {
    hideArrival();
    navigate(arrivalTarget);
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
