// The DM: a list of the rooms that have opened (#/dm, the DM tab: every community's) and one room
// (#/dm/:id).
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
import { attachLongPress } from '../longpress.js';
import { refreshTalk, seeDmRoom, talkLabel, unreadRoomIds, useDmRooms } from '../talk.js';
import { markDmNotificationsRead } from './notifications.js';
import {
  DM_MAX, DM_POLL_MS, REACTIONS, dmEventLine, dmIntro, dmPreview, lastStamp, liftLayout, mergeMessages,
  myReaction, reactionChips, reactionSignature, reactionsMissing, readToRecord, setMyReaction, sortRooms, threadRows,
  withMyReaction,
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
  useDmRooms(rooms);   // the tab's badge follows what was just read
  if (!rooms.length) {
    body.append(el('div', { className: 'empty-panel', attrs: { id: 'dmEmpty' } },
      el('p', { text: 'まだ DM はありません' }),
      el('p', {
        className: 'empty-sub',
        text: `お互いに『${talkLabel()}』を押すと、ここに DM が開きます`,
      })));
    return;
  }
  const unreadIds = unreadRoomIds(rooms);
  rooms.forEach((room) => {
    const unread = unreadIds.has(room.room_id);
    const event = dmEventLine(room, (text) => clip(text, 22));
    body.append(el('button', {
      className: `list-row dm-row${unread ? ' unread' : ''}`, attrs: { type: 'button', 'data-room-id': room.room_id },
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
// Reactions (2026-10-31): everybody's in this room, kept as rows { message_id, account_id, kind }.
// `reactionsOn` goes false when the table is not there yet (the migration has not been run): the screen
// then offers 「コピー」 alone and says nothing. `reactEpoch` moves with every press of mine, so a poll that
// was already on its way back with older rows does not undo what is on screen.
let reactions = [];
let reactionsOn = true;
let reactEpoch = 0;
let reactPending = 0;
// Read marks (2026-10-31): `partnerReadAt` is when the other person last read this room (null: unknown, so no
// 「既読」 is drawn); `marked` is what I have told the database I read (null: not yet, see readToRecord).
// The two calls live on `data` (net.js) and are used only when they exist and work: a failure draws nothing.
// (Tests swap data.markDmRead / data.dmReadState, as they do for the other calls.)
let partnerReadAt = null;
let marked = null;
let markFailures = 0;
const READ_FAILURES_MAX = 3;

function stopRoom() {
  closeMenu();
  request += 1;
  clearInterval(timer);
  timer = 0;
  room = null;
  messages = [];
  reactions = [];
  reactionsOn = true;
  reactPending = 0;
  partnerReadAt = null;
  marked = null;
  markFailures = 0;
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
  const top = thread.scrollTop;
  const me = state.account?.id;
  clear(thread).append(el('p', {
    className: 'dm-intro',
    text: dmIntro(room, talkLabel(), (text) => clip(text, 24)),
  }));
  const list = el('div', { className: 'dm-list' });
  threadRows(messages, { me, partnerReadAt }).forEach((row) => {
    if (row.type === 'day') {
      list.append(el('div', { className: 'dm-day' }, el('span', { className: 'dm-day-label', text: row.label })));
      return;
    }
    const { message, mine } = row;
    const chips = reactionChips(reactions, message.id, me);
    const bubble = el('p', { className: 'dm-bubble', text: message.body, attrs: { 'data-message-id': message.id } });
    attachLongPress(bubble, { onHold: () => openMenu(message, bubble, mine) });
    // LINE's shape: the time (and 「既読」 above it, on mine) sits beside the bubble, on its bottom edge.
    const stamp = el('div', { className: 'dm-stamp' },
      row.read ? el('span', { className: 'dm-read', text: '既読' }) : null,
      row.time ? el('span', { className: 'dm-time', text: row.time }) : null);
    const wrap = el('div', { className: 'dm-bubble-wrap' },
      bubble,
      chips.length ? el('div', { className: 'dm-chips' }, ...chips.map((chip) => el('span', {
        className: 'dm-chip', attrs: {
          'data-kind': chip.kind, 'data-mine': chip.mine ? '1' : '0',
          'aria-label': `${chip.label}${chip.count > 1 ? ` ${chip.count}人` : ''}`,
        },
      }, el('span', { className: 'dm-chip-emoji', text: chip.emoji }),
      chip.count > 1 ? el('span', { className: 'dm-chip-count', text: String(chip.count) }) : null))) : null);
    list.append(el('div', {
      className: `dm-line${mine ? ' mine' : ''}${chips.length ? ' has-reactions' : ''}${row.cont ? ' cont' : ''}`,
    }, ...(mine ? [stamp, wrap] : [wrap, stamp])));
  });
  thread.append(list);
  if (stick || atBottom) requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
  else thread.scrollTop = top;   // a repaint for a new reaction must not move what is being read
}

// ---------------------------------------------------------------- holding a message

let menu = null;

function closeMenu() {
  if (!menu) return;
  document.removeEventListener('keydown', menu.onKey);
  menu.node.remove();
  menu = null;
}

/** Copy to the clipboard; the old select-and-copy is the fallback (a page without clipboard permission). */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* try the old way */ }
  const field = el('textarea', { attrs: { readonly: '', 'aria-hidden': 'true' } });
  field.value = text;
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(field);
  try {
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

/**
 * Long press on a bubble: the screen dims, the pressed message lifts, a row of six emoji sits above it
 * and 「コピー」 below. Tapping behind closes it. Without reactions (the table is missing, or I blocked
 * the other person) only 「コピー」 is offered.
 */
function openMenu(message, bubble, mine) {
  if (!room) return;
  closeMenu();
  // The 5-second poll may have painted the thread again during the half-second hold: the pressed bubble is
  // then off the page and measures as 0. Use the one on screen now, or open nothing.
  if (!bubble.isConnected) {
    bubble = [...$('dmThread').querySelectorAll('.dm-bubble[data-message-id]')]
      .find((node) => node.dataset.messageId === String(message.id));
    if (!bubble) return;
  }
  const rect = bubble.getBoundingClientRect();
  const canReact = reactionsOn && !room.blocked_by_me;
  const held = myReaction(reactions, message.id, state.account?.id);
  const where = liftLayout(rect, innerHeight, canReact ? {} : { bar: 0 });
  const lifted = el('p', { className: `dm-bubble dm-lifted${mine ? ' mine' : ''}`, text: message.body });
  lifted.style.cssText = `left:${rect.left}px;top:${where.bubbleTop}px;width:${rect.width}px;`
    + `max-height:${where.bubbleHeight}px;`;
  const side = (node, width) => {
    const left = mine ? rect.right - width : rect.left;
    node.style.left = `${Math.max(12, Math.min(left, innerWidth - 12 - width))}px`;
  };
  const copy = el('button', {
    className: 'dm-copy', attrs: { type: 'button' }, text: 'コピー',
    on: {
      click: async () => {
        closeMenu();
        toast((await copyText(message.body)) ? 'コピーしました' : 'コピーできませんでした');
      },
    },
  });
  copy.style.top = `${where.copyTop}px`;
  const parts = [lifted, copy];
  let bar = null;
  if (canReact) {
    bar = el('div', { className: 'dm-react-bar', attrs: { role: 'group', 'aria-label': '反応を選ぶ' } },
      ...REACTIONS.map((entry) => el('button', {
        className: 'dm-react-btn',
        attrs: { type: 'button', 'data-kind': entry.kind, 'aria-label': entry.label, 'aria-pressed': String(held === entry.kind) },
        text: entry.emoji,
        on: { click: () => pressReaction(message, entry.kind) },
      })));
    bar.style.top = `${where.barTop}px`;
    parts.push(bar);
  }
  const backdrop = el('div', { className: 'dm-menu-backdrop', on: { click: closeMenu } });
  const node = el('div', { className: 'dm-menu', attrs: { role: 'presentation' } }, backdrop, ...parts);
  const onKey = (event) => { if (event.key === 'Escape') closeMenu(); };
  document.addEventListener('keydown', onKey);
  document.body.append(node);
  menu = { node, onKey };
  side(copy, copy.offsetWidth);
  if (bar) side(bar, bar.offsetWidth);
  requestAnimationFrame(() => node.classList.add('on'));
}

/** Put my reaction on the screen at once; the database has the last word (and a refusal puts it back). */
async function pressReaction(message, kind) {
  closeMenu();
  if (!room) return;
  const own = room.room_id;
  const me = state.account?.id;
  const before = myReaction(reactions, message.id, me);
  reactions = withMyReaction(reactions, message.id, me, kind);
  reactEpoch += 1;
  reactPending += 1;
  paintMessages();
  let now = before;
  try {
    now = await data.reactDm(message.id, kind);
  } catch (error) {
    if (reactionsMissing(error, { rpc: true })) reactionsOn = false;   // the function went missing: quiet, like everywhere else
    else toast(error.message);
  } finally {
    reactPending -= 1;
  }
  if (!room || room.room_id !== own) return;
  reactEpoch += 1;
  if (myReaction(reactions, message.id, me) !== now) {
    reactions = setMyReaction(reactions, message.id, me, now);
    paintMessages();
  }
}

/** Everybody's reactions again, whole (the table is small). True when what is on screen changed. */
async function refreshReactions(mine, id) {
  if (!reactionsOn) return false;
  const epoch = reactEpoch;
  let rows;
  try {
    rows = await data.dmReactions(id);
  } catch (error) {
    if (reactionsMissing(error)) reactionsOn = false;
    return false;   // a missed poll is not worth telling anyone about
  }
  if (mine !== request || !room || room.room_id !== id) return false;
  if (epoch !== reactEpoch || reactPending > 0) return false;   // I pressed meanwhile: the screen is newer
  if (reactionSignature(rows) === reactionSignature(reactions)) return false;
  reactions = rows;
  return true;
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
      if (message.created_at) seeDmRoom(own, message.created_at);   // what I sent is not "new" to me
      paintMessages({ stick: true });
    },
  });
  foot.append(input.node);
}

/** Tell the database I have read up to here (only while the screen is visible, and only what is new). */
async function recordRead(mine, id) {
  if (typeof data.markDmRead !== 'function' || markFailures >= READ_FAILURES_MAX) return;
  const stamp = readToRecord({
    messages, me: state.account?.id, marked, visible: document.visibilityState === 'visible',
  });
  if (stamp === null) return;
  const before = marked;
  marked = stamp;
  try {
    await data.markDmRead(id);
    markFailures = 0;
  } catch {
    if (mine === request) {   // quiet: try again at the next poll, a few times
      marked = before;
      markFailures += 1;
    }
  }
}

/** When the other person last read this room. True when what is on screen changed. */
async function refreshPartnerRead(mine, id) {
  if (typeof data.dmReadState !== 'function') return false;
  let result = null;
  try {
    result = await data.dmReadState(id);
  } catch {
    return false;   // no read marks: draw none
  }
  if (mine !== request || !room || room.room_id !== id) return false;
  const next = (result && result.partner_read_at) || null;
  if (next === partnerReadAt) return false;
  partnerReadAt = next;
  return true;
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
  // Open on screen means seen: the tab's badge does not count what is in front of me.
  if (lastStamp(messages)) seeDmRoom(id, lastStamp(messages));
  const fromThem = rows.some((row) => row.sender_id !== state.account?.id);
  if (first) {
    // The first paint never waits for reactions or read marks: draw the messages now, add the rest when it arrives.
    paintMessages({ stick: true });
    if (fromThem) markDmNotificationsRead(room.other_id);
    const [reacted, readChanged] = await Promise.all([
      refreshReactions(mine, id), refreshPartnerRead(mine, id), recordRead(mine, id)]);
    if ((reacted || readChanged) && mine === request && room && room.room_id === id) paintMessages();
    return;
  }
  // Reactions can land on old messages, so they are fetched whole every time, after the messages
  // (a reaction to a message not yet on screen would have nothing to sit on).
  const [reacted, readChanged] = await Promise.all([
    refreshReactions(mine, id), refreshPartnerRead(mine, id), recordRead(mine, id)]);
  if (mine !== request || !room || room.room_id !== id) return;
  if (messages.length === before && !reacted && !readChanged) return;
  paintMessages();
  if (fromThem) markDmNotificationsRead(room.other_id);
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
