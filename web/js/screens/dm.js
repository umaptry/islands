// The DM: a list of the rooms that have opened (#/dm) and one room (#/dm/:id).
//
// A room opens only when two people have pressed 「話してみたい」 for each other
// (talk.js); from then on it is a plain two-person conversation. The input is the
// comment box (components/chat.js) pointed at the DM; new messages are looked for
// every five seconds, only while a room is open on screen and the tab is visible,
// and only for messages after the newest one already shown.
//
// Blocking: either person can block the other. A blocked room cannot send from
// either side, and the other person is told nothing - their send simply fails.

import { data } from '../net.js';
import { activeScreen, navigate, screen } from '../router.js';
import { state } from '../state.js';
import { $, avatar, clear, clip, confirmAction, el, timeAgo, toast } from '../ui.js';
import { chatInput } from '../components/chat.js';
import { talkLabel, refreshTalk } from '../talk.js';
import { markDmNotificationsRead } from './notifications.js';
import { unreadDmCount } from '../notify-rules.js';
import {
  DM_MAX, DM_POLL_MS, dmEventLine, dmIntro, dmPreview, lastStamp, mergeMessages, sortRooms,
} from '../talk-rules.js';

const faceOf = (room) => ({ icon_id: room.other_icon_id, avatar_path: room.other_avatar_path });
const nameOf = (room) => room.other_name || '名前のない人';

// ---------------------------------------------------------------- the list

let listRequest = 0;

async function paintList() {
  const body = $('dmListBody');
  const request = ++listRequest;
  if (!body.firstChild) clear(body).append(el('p', { className: 'empty-note', text: '読み込み中…' }));
  let rooms;
  try {
    rooms = sortRooms(await data.dmRooms());
  } catch (error) {
    if (request !== listRequest) return;
    clear(body).append(el('p', { className: 'empty-note', text: error.message }));
    return;
  }
  if (request !== listRequest) return;
  clear(body);
  if (!rooms.length) {
    body.append(el('div', { className: 'empty-panel' },
      el('p', { text: 'まだ DM はありません' }),
      el('p', {
        className: 'empty-sub',
        text: `同じ会に参加した人と、お互いに「${talkLabel()}」を押すと、ここに DM が開きます。`,
      })));
    return;
  }
  rooms.forEach((room) => {
    const unread = unreadDmCount(state.notifications, room.other_id) > 0;
    const event = dmEventLine(room, (text) => clip(text, 22));
    body.append(el('button', {
      className: 'list-row dm-row', attrs: { type: 'button' },
      on: { click: () => navigate(`#/dm/${encodeURIComponent(room.room_id)}`) },
    },
      avatar(faceOf(room), 44),
      el('div', { className: 'list-row-body' },
        el('div', { className: 'list-row-title', text: nameOf(room) }),
        el('div', { className: 'list-row-sub', text: room.blocked_by_me ? 'ブロック中' : dmPreview(room) }),
        event ? el('div', { className: 'list-row-sub dm-row-event', text: event }) : null),
      el('div', { className: 'dm-row-side' },
        el('span', { className: 'dm-row-time', text: timeAgo(room.last_at || room.created_at) }),
        unread ? el('i', { className: 'notif-dot', attrs: { 'aria-label': '未読' } }) : null),
    ));
  });
}

// ---------------------------------------------------------------- one room

let room = null;
let messages = [];
let timer = 0;
let request = 0;      // which opening of a room the answers on the way belong to
let input = null;

function stopRoom() {
  request += 1;
  clearInterval(timer);
  timer = 0;
  room = null;
  messages = [];
  input = null;
}

function paintTop() {
  const who = clear($('dmRoomWho'));
  const block = $('dmRoomBlock');
  if (!room) {
    block.hidden = true;
    return;
  }
  who.append(avatar(faceOf(room), 32), el('span', { className: 'dm-who-name', text: nameOf(room) }));
  who.setAttribute('aria-label', `${nameOf(room)}さんのプロフィール`);
  block.hidden = false;
  block.textContent = room.blocked_by_me ? 'ブロックを解除' : 'ブロック';
}

function paintMessages({ stick = false } = {}) {
  const thread = $('dmThread');
  if (!room) return;
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
  clear(thread).append(el('p', {
    className: 'dm-intro',
    text: dmIntro(room, talkLabel(), (text) => clip(text, 24)),
  }));
  const list = el('div', { className: 'dm-list' });
  messages.forEach((message) => {
    const mine = message.sender_id === state.account?.id;
    list.append(el('div', { className: `dm-line${mine ? ' mine' : ''}` },
      el('p', { className: 'dm-bubble', text: message.body }),
      el('span', { className: 'dm-time', text: timeAgo(message.created_at) })));
  });
  thread.append(list);
  if (stick || atBottom) requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
}

function paintFoot() {
  const foot = clear($('dmFoot'));
  input = null;
  if (!room) return;
  if (room.blocked_by_me) {
    foot.append(el('div', { className: 'dm-blocked' },
      el('p', { text: 'ブロック中です。解除するまで、お互いにメッセージを送れません。' }),
      el('button', { className: 'btn btn-small', attrs: { type: 'button' }, text: 'ブロックを解除', on: { click: toggleBlock } })));
    return;
  }
  const own = room.room_id;
  input = chatInput(own, {
    send: (body) => data.sendDm(own, body),
    limit: DM_MAX,
    placeholder: 'メッセージを入力...',
    quiet: true,
    onSent: (message) => {
      if (!room || room.room_id !== own || !message) return;
      messages = mergeMessages(messages, [message]);
      paintMessages({ stick: true });
    },
  });
  foot.append(input.node);
}

/** Ask for what came after the newest message shown. */
async function poll({ first = false } = {}) {
  if (!room || (document.hidden && !first)) return;
  const mine = request;
  const id = room.room_id;
  let rows;
  try {
    rows = await data.dmMessages(id, first ? null : lastStamp(messages));
  } catch (error) {
    if (first && mine === request) {
      clear($('dmThread')).append(el('p', { className: 'empty-note', text: error.message }));
    }
    return;   // a missed poll is not worth telling anyone about
  }
  if (mine !== request || !room || room.room_id !== id) return;
  const before = messages.length;
  messages = mergeMessages(messages, rows);
  if (!first && messages.length === before) return;
  paintMessages({ stick: first });
  if (rows.some((row) => row.sender_id !== state.account?.id)) markDmNotificationsRead(room.other_id);
}

async function openRoom(id) {
  stopRoom();
  const mine = request;
  $('dmRoomWho').replaceChildren();
  $('dmRoomBlock').hidden = true;
  clear($('dmFoot'));
  clear($('dmThread')).append(el('p', { className: 'empty-note', text: '読み込み中…' }));
  let rooms;
  try {
    rooms = await data.dmRooms();
  } catch (error) {
    if (mine === request) clear($('dmThread')).append(el('p', { className: 'empty-note', text: error.message }));
    return;
  }
  if (mine !== request) return;
  room = rooms.find((entry) => entry.room_id === id) || null;
  if (!room) {
    paintTop();
    clear($('dmThread')).append(
      el('p', { className: 'empty-note', text: 'この DM は見つかりませんでした。' }),
      el('button', {
        className: 'btn btn-small btn-quiet dm-missing', attrs: { type: 'button' },
        text: 'DM の一覧へ', on: { click: () => navigate('#/dm') },
      }));
    return;
  }
  paintTop();
  paintFoot();
  markDmNotificationsRead(room.other_id);
  await poll({ first: true });
  if (mine !== request) return;
  timer = setInterval(() => poll(), DM_POLL_MS);
}

async function toggleBlock() {
  if (!room) return;
  const target = room;
  if (target.blocked_by_me) {
    try {
      await data.unblock(target.other_id);
    } catch (error) {
      toast(error.message);
      return;
    }
    target.blocked_by_me = false;
    toast('ブロックを解除しました');
  } else {
    const ok = await confirmAction({
      title: 'この人をブロックしますか？',
      body: 'ブロックすると、どちらからもメッセージを送れなくなります。ブロックしたことは相手には知らせません。あとで解除できます。',
      confirmLabel: 'ブロックする',
      danger: true,
    });
    if (!ok) return;
    try {
      await data.block(target.other_id);
    } catch (error) {
      toast(error.message);
      return;
    }
    target.blocked_by_me = true;
    toast('ブロックしました');
  }
  if (room !== target) return;
  paintTop();
  paintFoot();
  refreshTalk();   // who I may press for follows the block
}

// ---------------------------------------------------------------- wiring

export function setupDm() {
  $('dmListBack').addEventListener('click', () => navigate('#/me'));
  $('dmRoomBack').addEventListener('click', () => navigate('#/dm'));
  $('dmRoomBlock').addEventListener('click', toggleBlock);
  $('dmRoomWho').addEventListener('click', () => {
    if (room) navigate(`#/u/${room.other_id}`);
  });

  // A new DM notification arrived while the list or a room is open.
  document.addEventListener('dm:maybe-new', () => {
    if (activeScreen() === 'dmList') paintList();
    else if (activeScreen() === 'dmRoom') poll();
  });
  // Back from another tab: catch up now rather than at the next tick.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && activeScreen() === 'dmRoom') poll();
  });

  screen('dmList', {
    enter: () => paintList(),
    leave: () => { listRequest += 1; },
  });
  screen('dmRoom', {
    enter: (params) => openRoom(params.id),
    leave: () => stopRoom(),
  });
}
