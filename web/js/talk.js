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
  afterPress, buildTalkIndex, dmHashFor, emptyTalkIndex, introPrompt, introSeen, markIntroSeen,
  roomIdFor, talkLabelOf, talkOn, talkStateFor,
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
 * Read who shares a 会 with me and what I pressed. Asked at sign-in, when I join
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

// ---------------------------------------------------------------- the button

/**
 * `options.talk` for a card, or null where there is no button: signed out,
 * your own post, or the feature off. `state()` is read on every repaint, so the
 * button follows state.talk without the card being built again.
 */
export function talkOptionsFor(post) {
  if (!post) return null;
  return talkOptionsForPerson(post.author_id, post.display_name);
}

/** The same options for a person (the profile screen uses this: one button, one
 * state, whichever screen it is on). */
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
