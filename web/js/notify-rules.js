// The rules behind notifications in the browser, kept free of the page so they
// can be tested: what each kind says, which entries may interrupt, the frames
// of the Realtime socket, and whether this device needs the Home Screen steps
// before it can be told anything.
//
// Items 22 and 23 (stage 6). The server groups and pushes; these only decide
// how the list reads and when the open app speaks up. The wording matches
// PUSH_TEXT in app.py, so a lock screen and the list say the same thing.

/** Mirrors NOTIFICATION_CATEGORY_OF in core/config.py. */
export const CATEGORY_OF = Object.freeze({
  like: 'reaction', help: 'reaction', join: 'reaction',
  comment: 'reply', reply: 'reply',
  connection: 'connection', similar: 'similar', island: 'island',
  // Q34: a post nobody has answered yet, recommended to people nearby.
  // Follows the island switch (see interrupts() for the one exception).
  quiet_post: 'island',
  // 「話してみたい」 and the DM (2026-10-24). Mirrors core/config.py exactly.
  talk_wish: 'reaction', talk_match: 'reaction', dm: 'reply',
});

/** The three kinds that belong to 「話してみたい」 / DM. */
export const TALK_TYPES = Object.freeze(['talk_wish', 'talk_match', 'dm']);
export const isTalkType = (type) => TALK_TYPES.includes(type);

/** The three switches, in the order the settings list them.
 *
 * 「新しいつながり」 and 「おすすめ」 are gone (モック②): the server no longer
 * makes those rows, so there is nothing left for a switch to hold back. Rows
 * written before still list, under CATEGORY_OF above. */
export const CATEGORIES = Object.freeze([
  { id: 'reply', title: '返信・メッセージ', note: 'あなたの投稿へのメッセージと、あなたへの返信' },
  { id: 'reaction', title: '反応', note: 'いいね・手伝えるかも・参加（10分ぶんをまとめます）' },
  { id: 'island', title: '島の変化', note: 'あなたの投稿がある島の変化と、近くの投稿のお知らせ（島の変化は1つの島につき1日1件まで）' },
]);

export const KIND_TEXT = Object.freeze({
  like: 'あなたの投稿に「いいね」しました。',
  help: 'あなたの投稿に「手伝えるかも」と反応しました。',
  join: 'あなたの投稿に「参加」と反応しました。',
  comment: 'あなたの投稿にメッセージを送りました。',
  reply: 'あなたのメッセージに返信しました。',
  connection: '初めてやりとりしました。地図に線が引かれます。',
  similar: '話題や目標が近い人が参加しました。',
  island: '島が変わりました。',
  // Never "nobody answered": to the reader it is only a recommendation.
  quiet_post: '近くの島に、話が合いそうな投稿があります。',
  // Templates: {label} is the button's name from /api/config, {name} the other
  // person. The same words as PUSH_TEXT, so the lock screen and the list agree.
  talk_wish: '誰かが、あなたと{label}と言っています',
  talk_match: '{name}さんと、お互いに『{label}』でした。DMが開きました',
  dm: '{name}さんからメッセージが届きました',
});

/** The small line under a 「話してみたい」 / DM row. */
export const TALK_HINT = Object.freeze({
  talk_wish: '地図で参加者の投稿を見てみよう',
  talk_match: 'DMを開く',
  dm: 'DMを開く',
});

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
export const GROUP_TEXT = 'あなたの投稿に反応しました。';

export const categoryOf = (type) => CATEGORY_OF[type] || type;

/** Everything on: what somebody who never opened the settings has. */
export function defaultSettings() {
  return Object.fromEntries(CATEGORIES.map(({ id }) => [id, { push: true, in_app: true }]));
}

/** The API's settings over the defaults, trusting nothing about their shape.
 *
 * `quietPost` is the server's own verdict (最上位の quiet_post): false means
 * somebody who had turned 「おすすめ」 off, whose nearby-post notices stay off
 * even though the island switch is on. The API no longer sends a `similar`
 * row, so that verdict is put back here as one (see interrupts()). */
export function mergeSettings(saved, quietPost) {
  const settings = defaultSettings();
  if (!saved || typeof saved !== 'object') return settings;
  for (const { id } of CATEGORIES) {
    const entry = saved[id];
    if (entry && typeof entry === 'object') {
      settings[id] = { push: entry.push !== false, in_app: entry.in_app !== false };
    }
  }
  // No switch for it any more, but an old "similar" row still counts for
  // quiet_post (see interrupts()). Only kept when the server sent one.
  const similar = saved.similar;
  if (similar && typeof similar === 'object') {
    settings.similar = { push: similar.push !== false, in_app: similar.in_app !== false };
  }
  if (quietPost === false && settings.island.in_app) {
    settings.similar = { push: true, in_app: false };
  }
  return settings;
}

/** Settings as the PUT body wants them: one row per category. */
export function settingsRows(settings) {
  return CATEGORIES.map(({ id }) => ({
    category: id, push: Boolean(settings[id]?.push), in_app: Boolean(settings[id]?.in_app),
  }));
}

/** A kind switched off for in_app stays in the list but never interrupts.
 *
 * A kind with no switch any more does not interrupt. The server sorts old
 * connection / similar rows the same way: it no longer pushes them, they only
 * list. A nearby post (quiet_post) follows the island switch, and is also held
 * back when the "similar" row has in_app off (mergeSettings() puts it there when
 * the server says quiet_post is false). With no similar row, the island switch
 * alone decides; with no island row either, it is shown. */
export function interrupts(entry, settings) {
  const all = settings || {};
  if (entry.type === 'quiet_post') {
    if (all.similar && all.similar.in_app === false) return false;
    return all.island ? Boolean(all.island.in_app) : true;
  }
  // Rows from the retired kinds (connection, similar) still list, but no
  // longer interrupt - the same as allows() on the server.
  const category = categoryOf(entry.type);
  if (!CATEGORIES.some((switchRow) => switchRow.id === category)) return false;
  const switches = all[category];
  if (!switches) return false;
  return Boolean(switches.in_app);
}

// ---------------------------------------------------------------- the list

/** notification_feed() rows carry only the newest actor's id; put a face on it. */
export function attachActors(entries, accounts) {
  const byId = new Map((accounts || []).map((account) => [account.id, account]));
  return (entries || []).map((entry) => {
    // Nobody is named on 「誰かが…」: not even a face, whatever the row holds.
    if (entry.type === 'talk_wish') return { ...entry, actor_id: null, actors: [] };
    if (Array.isArray(entry.actors)) return entry;
    const actor = entry.actor_id ? byId.get(entry.actor_id) : null;
    return { ...entry, actors: actor ? [actor] : [] };
  });
}

/** Who to name: the newest person, "ほか N人" for the rest. An island names itself. */
export function headline(entry, talkLabel = '') {
  if (isTalkType(entry.type)) return talkHeadline(entry, talkLabel);
  if (entry.type === 'island') {
    const name = (entry.payload || {}).name;
    return name ? `島「${name}」` : '島';
  }
  const first = (entry.actors && entry.actors[0]) || {};
  const name = first.display_name || 'だれか';
  return entry.others ? `${name} ほか${entry.others}人` : name;
}

export function bodyText(entry, talkLabel = '') {
  if (isTalkType(entry.type)) return talkLabel ? TALK_HINT[entry.type] : '';
  const payload = entry.payload || {};
  if (entry.type === 'island') return payload.cause ? `${payload.cause}。` : KIND_TEXT.island;
  if (entry.type === 'quiet_post') return payload.message || KIND_TEXT.quiet_post;
  if (entry.others) return GROUP_TEXT;
  return KIND_TEXT[entry.type] || GROUP_TEXT;
}

/** The sentence for a 「話してみたい」 / DM row. "誰か" never comes from the row:
 * talk_wish is anonymous by design, so nothing but the label is read. */
function talkHeadline(entry, label) {
  if (!label) return 'お知らせが届いています';
  const first = (entry.actors && entry.actors[0]) || {};
  // The templates add 「さん」, so a name that already ends in it is trimmed first.
  // (A missing name is 「相手」 here and 「だれか」 on the lock screen; talk-rules.js says
  // 「この人」 under the button: each is the natural word for its place.)
  const shown = String(first.display_name || '').trim().replace(/さん$/, '');
  const name = entry.type === 'talk_wish' ? '' : (shown || '相手');
  return fill(KIND_TEXT[entry.type], { label, name });
}

/** Unread rows that a DM list would show a dot for: from this person, or all. */
export function unreadDmCount(entries, otherId = null) {
  return (entries || []).filter((entry) => entry.unread
    && (entry.type === 'dm' || entry.type === 'talk_match')
    && (!otherId || entry.actor_id === otherId)).length;
}

/** Ids of the matched-DM rows, to notice a new one (the buttons then re-read). */
export const matchSignature = (entries) =>
  (entries || []).filter((entry) => entry.type === 'talk_match').flatMap(rowIds).sort().join(',');

export function rowIds(entry) {
  return Array.isArray(entry.ids) && entry.ids.length ? entry.ids : [entry.id];
}

/** Every row id the list holds, to tell an arrival from old news. */
export function knownIds(entries) {
  return new Set((entries || []).flatMap(rowIds));
}

/** What the badge counts: unread, and allowed to interrupt. */
export function unreadCount(entries, settings) {
  return (entries || []).filter((entry) => entry.unread && interrupts(entry, settings)).length;
}

/**
 * Entries holding a row that was not there last time. `seen` is null on the
 * first load after signing in: a pile of old news is not an arrival.
 */
export function arrivals(entries, seen, settings) {
  if (!seen) return [];
  return (entries || []).filter((entry) => entry.unread && interrupts(entry, settings)
    && rowIds(entry).some((id) => !seen.has(id)));
}

// ---------------------------------------------------------------- realtime

export const HEARTBEAT_MS = 25000;
const RETRY_MS = [2000, 5000, 15000, 30000, 60000];

/** Wait before reconnect attempt `n` (0-based): quick at first, then patient. */
export function retryDelay(attempt) {
  return RETRY_MS[Math.max(0, Math.min(attempt, RETRY_MS.length - 1))];
}

export function socketUrl(supabaseUrl, anonKey) {
  const base = String(supabaseUrl).replace(/^http/, 'ws').replace(/\/+$/, '');
  return `${base}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;
}

export const topicFor = (userId) => `realtime:notifications:${userId}`;

/** Join the channel: new notifications for this person only. RLS checks the token. */
export function joinFrame(topic, userId, token, ref) {
  return {
    topic,
    event: 'phx_join',
    ref: String(ref),
    join_ref: String(ref),
    payload: {
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: '' },
        private: false,
        postgres_changes: [{
          event: 'INSERT', schema: 'public', table: 'notifications',
          filter: `recipient_id=eq.${userId}`,
        }],
      },
      access_token: token,
    },
  };
}

export const heartbeatFrame = (ref) =>
  ({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(ref) });

export const tokenFrame = (topic, token, ref) =>
  ({ topic, event: 'access_token', payload: { access_token: token }, ref: String(ref) });

const IGNORE = Object.freeze({ kind: 'ignore' });

/**
 * One frame from the socket, as what it means here:
 * joined | failed | insert | closed | heartbeat | ignore.
 */
export function readFrame(text, topic, joinRef) {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return IGNORE;
  }
  if (!frame || typeof frame !== 'object') return IGNORE;
  const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload : {};
  if (frame.topic === 'phoenix') {
    return frame.event === 'phx_reply' ? { kind: 'heartbeat', ref: frame.ref ?? null } : IGNORE;
  }
  if (frame.topic !== topic) return IGNORE;
  switch (frame.event) {
    case 'phx_reply':
      if (String(frame.ref) !== String(joinRef)) return IGNORE;
      return payload.status === 'ok'
        ? { kind: 'joined' }
        : { kind: 'failed', reason: String(payload.response?.reason || payload.status || 'join') };
    case 'postgres_changes': {
      const change = payload.data || {};
      if (change.type !== 'INSERT' || change.table !== 'notifications') return IGNORE;
      return { kind: 'insert', record: change.record || null };
    }
    case 'system':
      return payload.status === 'error'
        ? { kind: 'failed', reason: String(payload.message || 'system') }
        : IGNORE;
    case 'phx_error':
    case 'phx_close':
      return { kind: 'closed' };
    default:
      return IGNORE;
  }
}

// ---------------------------------------------------------------- push

/** The VAPID public key as the bytes pushManager.subscribe() takes. */
export function keyBytes(base64url) {
  const text = String(base64url).replace(/-/g, '+').replace(/_/g, '/');
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

/** Whether a subscription was made with this key (a new key needs a new one). */
export function sameKey(buffer, bytes) {
  if (!buffer || !bytes) return false;
  const have = new Uint8Array(buffer);
  return have.length === bytes.length && have.every((value, index) => value === bytes[index]);
}

const IOS = /iPhone|iPad|iPod/;

export function isIos(userAgent = '', maxTouchPoints = 0) {
  // iPadOS asks for desktop pages and says Macintosh; only touch gives it away.
  return IOS.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** 17.4 for "CPU iPhone OS 17_4 like Mac OS X", or Version/17.4; null if neither. */
export function iosVersion(userAgent = '') {
  const found = userAgent.match(/OS (\d+)[_.](\d+)/) || userAgent.match(/Version\/(\d+)\.(\d+)/);
  return found ? Number(found[1]) + Number(found[2]) / 100 : null;
}

/** Chrome, LINE, Instagram and the like on an iPhone: Safari adds to Home Screen best. */
export function iosOtherBrowser(userAgent = '') {
  return /CriOS|FxiOS|EdgiOS|OPiOS|Line\/|Instagram|FBAN|FBAV|GSA\//.test(userAgent);
}

/**
 * What this device can do about push:
 * ready | blocked | ios-install | ios-old | unsupported.
 *
 * An iPhone can be told things only by a web app on its Home Screen (iOS 16.4
 * and later); in Safari itself there is no PushManager at all.
 */
export function pushSupport({
  userAgent = '', maxTouchPoints = 0, standalone = false,
  hasWorker = false, hasPush = false, permission = 'default',
} = {}) {
  if (isIos(userAgent, maxTouchPoints)) {
    const version = iosVersion(userAgent);
    if (version !== null && version < 16.04) return 'ios-old';
    if (!standalone) return 'ios-install';
  }
  if (!hasWorker || !hasPush) return 'unsupported';
  if (permission === 'denied') return 'blocked';
  return 'ready';
}

// ---------------------------------------------------------------- presence

/** On screen means seen and in front: a window behind another is not watched. */
export function presenceSeconds({ signedIn, visible, focused }, hold) {
  return signedIn && visible && focused ? hold : 0;
}

/** Say it when it changes, and repeat "on screen" before the last one runs out. */
export function shouldSendPresence(next, last, lastAt, now, everyMs) {
  if (last === null || next !== last) return next > 0 || last > 0;
  return next > 0 && now - lastAt >= everyMs;
}
