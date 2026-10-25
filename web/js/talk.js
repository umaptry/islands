// 「話してみたい」 on the page: what I hold (state.talk), pressing and taking back,
// and the way into a DM. The rules are in talk-rules.js; this file is the part
// that touches the network and the screen.
//
// Everything here is silent when features.talk is false: the code can ship before
// the database has the tables (the same arrangement as features.post_extras).

import { config } from './config.js';
import { data } from './net.js';
import { buzz } from './feedback.js';
import { navigate } from './router.js';
import { closeSheet, confirmAction, toast } from './ui.js';
import { refreshNotifications } from './screens/notifications.js';
import { notify, state } from './state.js';
import {
  afterPress, buildTalkIndex, dmHashFor, emptyTalkIndex, introPrompt, introSeen, markDmSeen, markIntroSeen,
  readDmSeen, roomIdFor, talkLabelOf, talkOn, talkStateFor, unreadRooms,
} from './talk-rules.js';

/** localStorage, or null where the browser refuses it (private windows throw). */
export function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Whether this deployment shows 「話してみたい」 at all. */
export const talkAvailable = () => {
  try {
    return talkOn(config());
  } catch {
    return false;
  }
};

/** The button's name, from /api/config; '' when the feature is off. */
export const talkLabel = () => {
  try {
    return talkLabelOf(config());
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------- what I hold

let loading = null;

/**
 * Read who I can press (the same community) and what I pressed. Asked at sign-in, when I join
 * or leave, when a notification arrives and when a card opens. `maxAge` skips the
 * read when the last one is recent enough.
 */
export function refreshTalk({ maxAge = 0 } = {}) {
  if (!talkAvailable() || !state.account) {
    clearTalk();
    return Promise.resolve();
  }
  if (maxAge && Date.now() - (state.talk.at || 0) < maxAge) return Promise.resolve();
  if (loading) return loading;
  const owner = state.account.id;
  loading = (async () => {
    try {
      const [peers, rows] = await Promise.all([data.talkPeers(), data.talkState()]);
      if (state.account?.id !== owner) return;   // signed out or switched meanwhile
      state.talk = buildTalkIndex(peers, rows);
      notify('talk');
    } catch {
      /* a missed read keeps what is on screen; the next trigger tries again */
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function clearTalk() {
  if (!state.talk.peers.size && !state.talk.byTarget.size && !state.talk.at) return;
  state.talk = emptyTalkIndex();
  notify('talk');
}

// ---------------------------------------------------------------- the DM tab

/** The DM tab is there when signed in and 「話してみたい」 is on. */
export const dmTabVisible = () => Boolean(state.account) && talkAvailable();

export function paintDmBadge() {
  const badge = document.getElementById('dmBadge');
  if (!badge) return;
  badge.hidden = state.dmUnread === 0;
  badge.textContent = state.dmUnread > 9 ? '9+' : String(state.dmUnread);
}

/** The room ids with something new (see unreadRooms in talk-rules.js for the rule). */
export function unreadRoomIds(rooms = state.dmRooms) {
  if (!state.account) return new Set();
  const unreadFrom = new Set((state.dmNotices || []).filter((row) => row.unread && row.actor_id)
    .map((row) => row.actor_id));
  const seen = readDmSeen(browserStorage(), state.account.id);
  return new Set(unreadRooms(rooms, seen, { unreadFrom }).map((room) => room.room_id));
}

/** Count again from what is held (after the rooms or the notices changed, or a room was seen). */
export function recomputeDmUnread() {
  state.dmUnread = dmTabVisible() ? unreadRoomIds().size : 0;
  paintDmBadge();
  return state.dmUnread;
}

/** The DM list screen (or a poll) has just read the rooms. */
export function useDmRooms(rooms) {
  state.dmRooms = Array.isArray(rooms) ? rooms : [];
  return recomputeDmUnread();
}

/** This room has been seen up to `stamp` (its newest message): opened, or sent into. */
export function seeDmRoom(roomId, stamp) {
  if (!state.account) return;
  markDmSeen(browserStorage(), state.account.id, roomId, stamp);
  recomputeDmUnread();
}

let dmLoading = null;
let dmReadAt = 0;

/** Read the rooms for the badge. `maxAge` skips the read when the last one is recent enough. */
export function refreshDmRooms({ maxAge = 0 } = {}) {
  if (!dmTabVisible()) {
    clearDm();
    return Promise.resolve();
  }
  if (maxAge && Date.now() - dmReadAt < maxAge) return Promise.resolve();
  if (dmLoading) return dmLoading;
  const owner = state.account.id;
  dmLoading = (async () => {
    try {
      const rooms = await data.dmRooms();
      if (state.account?.id !== owner) return;   // signed out or switched meanwhile
      dmReadAt = Date.now();
      useDmRooms(rooms);
    } catch {
      /* a missed read keeps the badge as it is */
    } finally {
      dmLoading = null;
    }
  })();
  return dmLoading;
}

export function clearDm() {
  dmReadAt = 0;
  state.dmRooms = [];
  state.dmNotices = [];
  state.dmUnread = 0;
  paintDmBadge();
}

// ---------------------------------------------------------------- the button

/**
 * The button's options for a person, or null where there is no button: signed out,
 * yourself, or the feature off. Only the profile screen uses it: the button is about
 * a person, never a post. `state()` is read on every repaint, so the button follows
 * state.talk without being built again.
 */
export function talkOptionsForPerson(target, name = '') {
  if (!talkAvailable() || !state.account || !target || target === state.account.id) return null;
  return {
    name,
    state: () => talkStateFor(target, state.talk, { signedIn: Boolean(state.account) }),
    onPress: () => press(target),
    onWithdraw: () => withdraw(target),
    onOpenDm: () => openDmWith(target),
  };
}

/** The very first press on this browser is explained once. */
async function explainOnce() {
  const storage = browserStorage();
  if (introSeen(storage)) return true;
  if (!await confirmAction(introPrompt(talkLabel()))) return false;
  markIntroSeen(storage);
  return true;
}

async function press(target) {
  if (!await explainOnce()) return false;
  let result;
  try {
    result = await data.pressTalk(target);
  } catch (error) {
    toast(error.message);
    refreshTalk();
    return false;
  }
  const shown = afterPress(result, talkLabel());
  state.talk.byTarget.set(target, { state: shown.state, room_id: shown.roomId });
  notify('talk');
  buzz('react');
  toast(shown.message);
  // A match writes a notification for me too; fetch it now instead of at the next poll.
  if (shown.state === 'matched') refreshNotifications();
  return true;
}

async function withdraw(target) {
  try {
    await data.withdrawTalk(target);
  } catch (error) {
    toast(error.message);
    refreshTalk();
    return false;
  }
  const held = state.talk.byTarget.get(target);
  if (held && held.state === 'pressed') state.talk.byTarget.delete(target);
  notify('talk');
  toast('取り消しました');
  return true;
}

/** "DM を開く" on a card. */
export function openDmWith(target) {
  const held = state.talk.byTarget.get(target);
  closeSheet();
  return navigate(dmHashFor(held && held.room_id));
}

/**
 * A 両思い or DM notification was tapped: find the room with that person. The
 * notification names the sender; the room comes from my_talk_state (a match) or
 * the room list (a message). Falls back to the list.
 */
export async function openDmForNotification(entry) {
  const other = entry.actor_id;
  let roomId = roomIdFor(other, { talkRows: [...state.talk.byTarget].map(([target, held]) => ({ target, ...held })) });
  if (!roomId) {
    try {
      roomId = roomIdFor(other, { rooms: await data.dmRooms() });
    } catch { /* the list is the fallback */ }
  }
  return navigate(dmHashFor(roomId));
}
