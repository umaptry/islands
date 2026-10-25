// The rules behind the 「話してみたい」 button and the two-person DM, kept free
// of the page so they can be tested in node. No imports on purpose:
// tests/frontend loads this file on its own.
//
// The button's NAME is never written here. It is TALK_LABEL on the server
// (core/config.py), arrives as /api/config `talk.label`, and every sentence below
// takes it as a parameter. Changing the name is a one-line change on the server.
//
// Words to avoid on screen: anything that suggests romance (a legal condition).
// The screens say "押した" and "DM", never more than that.

export const DM_MAX = 1000;       // dm_messages.body: 1..1000 characters
export const DM_POLL_MS = 5000;   // only while a room is open on screen

const GENERIC = 'うまくいきませんでした。少し待ってからもう一度お試しください。';

// ---------------------------------------------------------------- availability

/** features.talk is the server's verdict (false until the tables exist). With it
 * off - or with no label - the screens show nothing at all. */
export function talkOn(cfg) {
  return Boolean(cfg && cfg.features && cfg.features.talk === true
    && cfg.talk && typeof cfg.talk.label === 'string' && cfg.talk.label.trim());
}

export const talkLabelOf = (cfg) => (talkOn(cfg) ? cfg.talk.label.trim() : '');

// ---------------------------------------------------------------- what I hold

/**
 * talk_peers() + my_talk_state() as one index.
 *   peers:    account ids that share a 会 with me
 *   byTarget: target id -> { state: 'pressed' | 'matched', room_id }
 * The server never tells me whether somebody pressed ME, so nothing here can.
 */
export function buildTalkIndex(peerRows, stateRows, now = Date.now()) {
  const peers = new Set();
  (Array.isArray(peerRows) ? peerRows : []).forEach((row) => {
    const id = typeof row === 'string' ? row : row && row.account_id;
    if (id) peers.add(String(id));
  });
  const byTarget = new Map();
  (Array.isArray(stateRows) ? stateRows : []).forEach((row) => {
    if (!row || !row.target) return;
    if (row.state !== 'pressed' && row.state !== 'matched') return;
    byTarget.set(String(row.target), { state: row.state, room_id: row.room_id || null });
  });
  return { peers, byTarget, at: now };
}

export const emptyTalkIndex = () => ({ peers: new Set(), byTarget: new Map(), at: 0 });

/**
 * What the button on somebody's card should be: null (no button), 'none',
 * 'pressed' or 'matched'. Only for display - the database decides who may press.
 * An open DM stays reachable even when the 会 is no longer shared.
 */
export function talkStateFor(authorId, index, { signedIn = true, mine = false } = {}) {
  if (!signedIn || mine || !authorId || !index) return null;
  const held = index.byTarget && index.byTarget.get(authorId);
  if (held && held.state === 'matched') return 'matched';
  if (!index.peers || !index.peers.has(authorId)) return null;
  return held && held.state === 'pressed' ? 'pressed' : 'none';
}

// ---------------------------------------------------------------- the button

/** How the other person is named in the small lines: 「{name}さん」, or 「この人」
 * when no name came. The small line is there before the first press, so the button
 * is clearly aimed at a person. */
export const personCall = (name) => {
  const text = String(name || '').trim();
  if (!text) return 'この人';
  return text.endsWith('さん') ? text : `${text}さん`; // never 「たなかさんさん」
};

/** The words on the button and the small line under it, for one state.
 * `name` is the other person's display name (the small line before the first press
 * does not use it: the button sits under that person's own card or profile). */
export function talkButtonText(state, label, name = '') {
  const who = personCall(name);
  if (state === 'pressed') {
    return { word: `${label}（押しました）`, note: `${who}も押すと DM が開きます。もう一度押すと取り消せます` };
  }
  if (state === 'matched') return { word: 'DM を開く', note: `${who}と、お互いに押しました` };
  return { word: label, note: '押したことは相手には見えず、お互いに押すと DM が開きます' };
}

/** The one-time explanation, asked before the very first press. */
export function introPrompt(label) {
  return {
    title: `「${label}」を押しますか？`,
    body: 'お互いに押したときだけ DM が開通します。押したことは相手には見えません。',
    confirmLabel: '押す',
  };
}

/** Taking a press back. */
export function withdrawPrompt(label) {
  return {
    title: `「${label}」を取り消しますか？`,
    body: '取り消しても、相手には何も知らされません。',
    confirmLabel: '取り消す',
  };
}

/** press_talk's answer, whatever shape it came in. */
export function readPress(result) {
  const matched = Boolean(result && result.matched === true && result.room_id);
  return { matched, room_id: matched ? String(result.room_id) : null };
}

/** What to show after a press. A press that was already there reads the same as a
 * new one: nothing on screen may hint at what the other person did. */
export function afterPress(press, label) {
  if (press.matched) {
    return { state: 'matched', roomId: press.room_id, message: `お互いに『${label}』でした。DMが開きました` };
  }
  return { state: 'pressed', roomId: null, message: `『${label}』を押しました` };
}

/** Where "DM を開く" goes. */
export function dmHashFor(roomId) {
  return roomId ? `#/dm/${encodeURIComponent(roomId)}` : '#/dm';
}

// ---------------------------------------------------------------- errors

const JAPANESE = /[぀-ヿ一-鿿]/;

/**
 * An error from press_talk / withdraw_talk / the DM tables, said for a person.
 * The database raises its own Japanese sentences; those are shown as they are.
 * Anything technical (a PostgREST code, an English policy message) becomes a
 * plain sentence - the same idea as joinRefusal(), for a different set of words.
 * `context` is 'talk' or 'dm'.
 */
export function talkRefusal(message, context = 'talk') {
  const text = String(message || '').trim();
  if (!text) return GENERIC;
  if (/row-level security|permission denied|42501|violates/i.test(text)) {
    return context === 'dm' ? 'この DM には、いまメッセージを送れません。' : 'いまは押せません。';
  }
  if (/maintenance|55000/i.test(text)) return 'いま調整中です。少し待ってからもう一度どうぞ。';
  if (/jwt|not authenticated|unauthorized|401/i.test(text)) return 'ログインし直してください。';
  if (JAPANESE.test(text)) return text;
  return GENERIC;
}

// ---------------------------------------------------------------- DM rooms

/** Newest conversation first; a room with no message yet counts from when it opened. */
export function sortRooms(rooms) {
  const stamp = (room) => Date.parse(room.last_at || room.created_at || '') || 0;
  return [...(rooms || [])].sort((a, b) => stamp(b) - stamp(a));
}

/** The grey line under a name in the list. */
export function dmPreview(room) {
  if (room.last_body) return room.last_body;
  return 'まだメッセージはありません';
}

/** The first thing at the top of a room. */
export function dmIntro(room, label, clip = (text) => text) {
  const where = room && room.event_excerpt ? `「${clip(String(room.event_excerpt).trim())}」` : '同じコミュニティ';
  return `${where}で、お互いに『${label}』を押しました。この DM は2人だけが見られます`;
}

/** The event line under a room in the list ("" when the post is gone). */
export function dmEventLine(room, clip = (text) => text) {
  return room && room.event_excerpt ? `${clip(String(room.event_excerpt).trim())} の会` : '';
}

/** The room a person is in: from the room list, else from my_talk_state. */
export function roomIdFor(otherId, { rooms = [], talkRows = [] } = {}) {
  if (!otherId) return null;
  const room = (rooms || []).find((entry) => entry.other_id === otherId);
  if (room) return room.room_id;
  const held = (talkRows || []).find((row) => row.target === otherId && row.state === 'matched' && row.room_id);
  return held ? held.room_id : null;
}

// ---------------------------------------------------------------- DM messages

const byTime = (a, b) => {
  const left = Date.parse(a.created_at);
  const right = Date.parse(b.created_at);
  if (left !== right) return left - right;
  return String(a.id) < String(b.id) ? -1 : 1;
};

/** Messages already shown plus what a poll brought, once each, oldest first. */
export function mergeMessages(have, incoming) {
  const byId = new Map();
  [...(have || []), ...(incoming || [])].forEach((message) => {
    if (message && message.id !== undefined && message.id !== null) byId.set(String(message.id), message);
  });
  return [...byId.values()].sort(byTime);
}

/** The created_at to ask "after" with: the newest one, exactly as the server wrote
 * it (a Date would cut the microseconds and bring the same message back). */
export function lastStamp(messages) {
  if (!messages || !messages.length) return null;
  return messages[messages.length - 1].created_at || null;
}

/** send_dm's reply in either shape (a row, or the local {message}). */
export function readSent(result) {
  const row = Array.isArray(result) ? result[0] : result;
  return row && row.message ? row.message : row || null;
}

// ---------------------------------------------------------------- the first-time note

export const INTRO_KEY = 'islands-talk-intro-seen';
let introMemory = false;

/** Whether the explanation has been shown on this browser. */
export function introSeen(storage) {
  if (introMemory) return true;
  try {
    return Boolean(storage && storage.getItem(INTRO_KEY));
  } catch {
    return false;
  }
}

export function markIntroSeen(storage) {
  introMemory = true;
  try {
    if (storage) storage.setItem(INTRO_KEY, '1');
  } catch { /* shown once per page load instead */ }
}

/** For tests: forget the in-page memory. */
export function resetIntroMemory() {
  introMemory = false;
}

// ---------------------------------------------------------------- DM: what is unread

// The DM tab is across ALL communities, and the badge counts ROOMS with something new.
// dm_room_list() carries the newest message's time but not who sent it, so the rule is:
//   - a room I have a last-seen time for is unread when its newest message is later than that
//     (opening the room, and sending in it, move the time up to the newest message), and
//   - a room I have none for (a new browser) is unread only when the server still holds an unread
//     DM notice from that person - the server's own read state - so a new browser does not
//     light up every old room.
// A message I sent from another device can show up as unread here until I open the room; the
// list has no sender to tell it apart.

export const DM_SEEN_PREFIX = 'islands-dm-seen:';
export const DM_SEEN_MAX = 200;      // rooms remembered per account
const dmSeenMemory = new Map();      // account id -> { room id: ISO time }

const stampOf = (value) => {
  const at = Date.parse(value || '');
  return Number.isFinite(at) ? at : 0;
};

/** { room id: ISO time } for this account. Storage may refuse (private windows); memory then. */
export function readDmSeen(storage, accountId) {
  if (!accountId) return {};
  const held = { ...(dmSeenMemory.get(accountId) || {}) };
  try {
    const raw = storage ? storage.getItem(DM_SEEN_PREFIX + accountId) : null;
    const value = raw ? JSON.parse(raw) : null;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.entries(value).forEach(([room, stamp]) => {
        if (typeof stamp === 'string' && stampOf(stamp) > stampOf(held[room])) held[room] = stamp;
      });
    }
  } catch { /* memory only */ }
  return held;
}

/** Remember that the room was seen up to `stamp` (never moves backwards). Returns the new map. */
export function markDmSeen(storage, accountId, roomId, stamp) {
  if (!accountId || !roomId || !stampOf(stamp)) return readDmSeen(storage, accountId);
  const seen = readDmSeen(storage, accountId);
  if (stampOf(stamp) > stampOf(seen[roomId])) seen[roomId] = stamp;
  const newest = Object.entries(seen).sort((a, b) => stampOf(b[1]) - stampOf(a[1])).slice(0, DM_SEEN_MAX);
  const kept = Object.fromEntries(newest);
  dmSeenMemory.set(accountId, kept);
  try {
    if (storage) storage.setItem(DM_SEEN_PREFIX + accountId, JSON.stringify(kept));
  } catch { /* memory only */ }
  return kept;
}

/**
 * The rooms with something new in them. `seen` is readDmSeen's map; `unreadFrom` the ids of people
 * whose DM notice is still unread on the server (used only for a room with no last-seen time).
 */
export function unreadRooms(rooms, seen = {}, { unreadFrom = new Set() } = {}) {
  return (Array.isArray(rooms) ? rooms : []).filter((room) => {
    if (!room || !room.room_id || !room.last_at) return false;   // no message yet: nothing new
    if (room.blocked_by_me) return false;
    const mark = seen && seen[room.room_id];
    if (mark) return stampOf(room.last_at) > stampOf(mark);
    return unreadFrom.has(room.other_id);
  });
}

/** For tests: forget what this page load remembered. */
export function resetDmSeenMemory() {
  dmSeenMemory.clear();
}
