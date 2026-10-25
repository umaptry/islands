// The rules behind communities, invite links and the per-community map, kept free
// of the page so they can be tested in node. No imports on purpose:
// tests/frontend loads this file on its own.
//
// What the words mean here:
//   community  a group with its own map. One account can be in several.
//   invite     a link a community's admin makes (#/invite/<code>); the only way a
//              NEW account can be created once the server says invite_only.
//
// Everything is silent when features.communities is false: the code can ship
// before the database has the tables (the same arrangement as features.talk).
// With it off, communitiesOn() is false and every screen behaves as it did.

// ---------------------------------------------------------------- availability

/** features.communities is the server's verdict (false until the tables exist). */
export const communitiesOn = (cfg) => Boolean(cfg && cfg.features && cfg.features.communities === true);

/** features.members_only: posts are readable by the members of their community only (the server's switch).
 * Meaningful only with communities on; the code ships before the switch and behaves as before while it is off. */
export const membersOnlyOn = (cfg) => communitiesOn(cfg) && cfg.features.members_only === true;

/** New accounts only through an invite. Meaningless while communities are off. */
export const inviteOnlyOn = (cfg) => communitiesOn(cfg) && cfg.invite_only === true;

// ---------------------------------------------------------------- the words

export const INVITE_ONLY_NOTE = 'islands は招待制です。コミュニティの招待リンクから登録してください。';
export const NOT_MEMBER_NOTE = 'まだコミュニティに入っていません。招待リンクから参加してください。';
export const NEW_ACCOUNT_NOTE = 'このアカウントはまだ登録されていません。コミュニティの招待リンクから登録してください。';
// Members only: one sentence for every case where a person cannot read a community (a link to a post of it,
// signed out, not a member, a former member, a post that is gone). "Missing" and "not allowed" read the same.
export const MEMBERS_ONLY_TITLE = 'このコミュニティのメンバーだけが見られます';
export const MEMBERS_ONLY_SUB_SIGNED_IN = 'メンバーの人からもらった招待リンクを開くと、参加できます。';
export const MEMBERS_ONLY_SUB_SIGNED_OUT = 'ログインするか、メンバーの人からもらった招待リンクを開いてください。';
export const MEMBERS_ONLY_MAP_TITLE = '地図は、コミュニティのメンバーだけが見られます';
export const WELCOME_MEMBERS_NOTE = 'islands は、コミュニティの人から届く招待リンクから参加します。';
export const SHARED_ONLY_NOTE = '共通のコミュニティの投稿だけが表示されます';
export const ASK_ADMIN = 'コミュニティの管理者に、新しいリンクをもらってください。';

const REASON_TEXT = {
  expired: 'この招待リンクは期限が切れています。',
  revoked: 'この招待リンクは止められています。',
  unknown: 'この招待リンクが見つかりません。',
};

// ---------------------------------------------------------------- the address

// Codes are long random strings (22+ characters); a short fixed one exists on a
// development machine. Never anything that could be markup or a path.
const CODE = /^[A-Za-z0-9_-]{4,128}$/;
const POST = /^[A-Za-z0-9_-]{1,64}$/;

export const validInviteCode = (code) => typeof code === 'string' && CODE.test(code);
const validPost = (id) => typeof id === 'string' && POST.test(id);

/** "#/invite/CODE" or "#/invite/CODE?post=ID" -> { code, post } ; null for anything else. */
export function parseInviteHash(hash) {
  const [path, query = ''] = String(hash || '').split('?');
  const found = /^#\/invite\/([^/]+)$/.exec(path);
  if (!found) return null;
  let code;
  try {
    code = decodeURIComponent(found[1]);
  } catch {
    return null;
  }
  if (!validInviteCode(code)) return null;
  const post = new URLSearchParams(query).get('post');
  return { code, post: validPost(post) ? post : null };
}

/** The address of an invite (hash only). */
export function inviteHashFor(code, post = null) {
  if (!validInviteCode(code)) return '#/welcome';
  return `#/invite/${encodeURIComponent(code)}${validPost(post) ? `?post=${encodeURIComponent(post)}` : ''}`;
}

/** The whole URL an admin hands out. */
export const inviteUrlFor = (origin, code, post = null) =>
  `${String(origin || '').replace(/\/+$/, '')}/${inviteHashFor(code, post)}`;

// ---------------------------------------------------------------- remembering an invite
//
// Why it is kept in storage and not in the address: signing in with Google leaves
// the page and comes back to a bare address (session.adoptRedirect clears the
// hash), and a new person then goes through name, photo, guidance and a first
// post. The code (and the post to open at the end) has to survive all of that.
// Every storage access is wrapped: private windows throw. Without storage it is
// held in memory for this page load, which still covers the e-mail flow.

export const INVITE_KEY = 'islands-invite-pending';
export const INVITE_TTL_MS = 6 * 3600 * 1000;

let inviteMemory = null;

/** Remember an invite (and the post that came with it). True when something was kept. */
export function savePendingInvite(storage, { code, post = null }, now = Date.now()) {
  if (!validInviteCode(code)) return false;
  inviteMemory = { code, post: validPost(post) ? post : null, at: now };
  try {
    if (storage) storage.setItem(INVITE_KEY, JSON.stringify(inviteMemory));
  } catch { /* memory only */ }
  return true;
}

function parseInvite(raw) {
  try {
    const value = JSON.parse(raw);
    return value && validInviteCode(value.code) && Number.isFinite(value.at)
      ? { code: value.code, post: validPost(value.post) ? value.post : null, at: value.at } : null;
  } catch {
    return null;
  }
}

/** { code, post } or null (nothing saved, a bad value, or too old). */
export function readPendingInvite(storage, now = Date.now()) {
  let held = null;
  try {
    held = storage ? parseInvite(storage.getItem(INVITE_KEY)) : null;
  } catch { /* fall back to memory */ }
  if (!held) held = inviteMemory;
  if (!held || now - held.at > INVITE_TTL_MS || held.at - now > INVITE_TTL_MS) return null;
  return { code: held.code, post: held.post };
}

export function clearPendingInvite(storage) {
  inviteMemory = null;
  try {
    if (storage) storage.removeItem(INVITE_KEY);
  } catch { /* nothing to clear */ }
}

/** Read it and forget it. */
export function takePendingInvite(storage, now = Date.now()) {
  const held = readPendingInvite(storage, now);
  clearPendingInvite(storage);
  return held;
}

/** For tests. */
export function resetInviteMemory() {
  inviteMemory = null;
}

// ---------------------------------------------------------------- the server's answers

/** check_invite -> { valid, name, reason }. Anything odd reads as "not found". */
export function readInviteCheck(raw) {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== 'object') return { valid: false, name: '', reason: 'unknown' };
  if (row.valid === true) {
    return { valid: true, name: String(row.community_name || '').trim(), reason: null };
  }
  // The name is kept for a link that is no longer usable: "which community's
  // link ran out" is the first thing a person wants to know.
  const reason = row.reason in REASON_TEXT ? row.reason : 'unknown';
  return { valid: false, name: String(row.community_name || '').trim(), reason };
}

/** claim_invite -> { id, name } or null. */
export function readClaim(raw) {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== 'object' || !row.community_id) return null;
  return { id: String(row.community_id), name: String(row.community_name || '').trim() };
}

/** my_communities / the local list -> [{ id, slug, name, role }] (no duplicates). */
export function normalizeCommunities(rows) {
  const seen = new Set();
  const list = [];
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const id = row && (row.community_id || row.id);
    if (!id || seen.has(String(id))) return;
    seen.add(String(id));
    list.push({
      id: String(id),
      slug: String(row.slug || ''),
      name: String(row.name || '').trim() || 'コミュニティ',
      role: row.role === 'admin' ? 'admin' : 'member',
    });
  });
  return list;
}

/** Put a community just joined into the list (no duplicate). */
export function withJoined(list, joined) {
  if (!joined || !joined.id) return list;
  const rest = (list || []).filter((entry) => entry.id !== joined.id);
  const had = (list || []).find((entry) => entry.id === joined.id);
  return rest.concat(had || { id: joined.id, slug: '', name: joined.name || 'コミュニティ', role: 'member' });
}

export const adminOf = (list) => (list || []).filter((entry) => entry.role === 'admin');

// ---------------------------------------------------------------- the invite page

/** What the invite screen says. `check` is readInviteCheck's result, or null if it could not be read. */
export function inviteView(check) {
  if (!check) {
    return { state: 'error', title: '招待を確認できませんでした', lede: 'つながりませんでした。通信環境を確かめて、もう一度開いてください。' };
  }
  if (check.valid) {
    const name = check.name || 'コミュニティ';
    return {
      state: 'valid',
      title: `${name} への招待です`,
      lede: 'アカウントを作ると、このコミュニティの地図に入れます。',
    };
  }
  return { state: 'invalid', title: check.name ? `${check.name} への招待は使えません` : '招待を使えませんでした', lede: `${REASON_TEXT[check.reason] || REASON_TEXT.unknown}${ASK_ADMIN}` };
}

/** Which buttons the invite page offers. */
export function inviteActions({ valid, signedIn, providers = [] }) {
  if (!valid) return { join: false, register: false, login: false, providers: [] };
  // Signed in is enough to join: somebody who stopped half way through naming themselves (hasAccount
  // is false) is sent on to finish after joining. Showing "register" to a signed-in person would
  // sign them out.
  if (signedIn) return { join: true, register: false, login: false, providers: [] };
  return { join: false, register: true, login: true, providers: providers.slice() };
}

/**
 * A failure that says nothing about the invite itself: the network was down (status 0) or the
 * server was unhappy (5xx). The invite is then kept and nobody is turned away; only an answer
 * from the database ("expired", "stopped", "not found" - a 4xx) ends an invite.
 */
export function transientFailure(error) {
  const status = error && error.status;
  return !Number.isFinite(status) || status === 0 || status >= 500;
}

export const RETRY_LATER_NOTE = '通信がうまくいきませんでした。電波のよい所で、もう一度開いてください。';

// ---------------------------------------------------------------- the front door

/**
 * What welcome and the sign-in screen show. With invite_only, "create an account"
 * and "register with Google" go away and a note takes their place - unless an
 * invite is in hand (the person came through a link).
 */
export function entryView({ cfg, hasInvite = false }) {
  const closed = inviteOnlyOn(cfg) && !hasInvite;
  return { canRegister: !closed, note: closed ? INVITE_ONLY_NOTE : '' };
}

/**
 * The welcome screen's way to look around without an account. Members only: there is nothing to look at,
 * so the button is gone and a short line says that islands is joined through an invite link instead.
 */
export function browseView(cfg) {
  const members = membersOnlyOn(cfg);
  return { canBrowse: !members, note: members ? WELCOME_MEMBERS_NOTE : '' };
}

/**
 * A person signed in who has no account yet and holds no invite, where accounts
 * come only through an invite: they cannot be let in (Google signs anybody in).
 */
export function registrationBlocked({ cfg, hasAccount, claimed }) {
  return inviteOnlyOn(cfg) && !hasAccount && !claimed;
}

// ---------------------------------------------------------------- the current community

const CURRENT_PREFIX = 'islands-community:';
const currentMemory = new Map();

/** The community this account was last looking at, or null. */
export function recallCommunity(storage, accountId) {
  if (!accountId) return null;
  try {
    const value = storage ? storage.getItem(CURRENT_PREFIX + accountId) : null;
    if (value) return value;
  } catch { /* memory */ }
  return currentMemory.get(accountId) || null;
}

export function rememberCommunity(storage, accountId, communityId) {
  if (!accountId || !communityId) return false;
  currentMemory.set(accountId, communityId);
  try {
    if (storage) storage.setItem(CURRENT_PREFIX + accountId, communityId);
  } catch { /* memory only */ }
  return true;
}

export function forgetCommunity(storage, accountId) {
  if (!accountId) return;
  currentMemory.delete(accountId);
  try {
    if (storage) storage.removeItem(CURRENT_PREFIX + accountId);
  } catch { /* nothing to clear */ }
}

/** For tests. */
export function resetCommunityMemory() {
  currentMemory.clear();
}

/** Which of my communities is "current": the remembered one while I am still in it, else the first. */
export function chooseCommunity(list, remembered) {
  if (!list || !list.length) return null;
  return list.find((entry) => entry.id === remembered) || list[0];
}

/**
 * What the map should show.
 *   { mode: 'legacy' }                       communities are off: everybody's map
 *   { mode: 'community', id, name }          a community I am in
 *   { mode: 'viewing',   id, name }          read only: a linked post's community that I am not in
 *   { mode: 'none', reason }                 'signed-out' | 'not-member': a notice instead of a map
 * `linked` is the community of the post a link opened ({ id, name } or null);
 * `viewing` the one a visitor is already looking at.
 */
export function mapScope({ on, communities, current, linked = null, viewing = null, membersOnly = false, closed = false }) {
  if (!on) return { mode: 'legacy' };
  const list = communities || [];
  // Members only: a link to something I cannot read (a post that is missing and one that is not for me
  // look alike) is a notice, and so is a community I am not in. The 'viewing' look is retired.
  if (membersOnly && closed) return { mode: 'none', reason: 'closed' };
  if (linked && linked.id) {
    const mine = list.find((entry) => entry.id === linked.id);
    if (mine) return { mode: 'community', id: mine.id, name: mine.name };
    if (membersOnly) return { mode: 'none', reason: 'closed' };
    return { mode: 'viewing', id: linked.id, name: linked.name || 'コミュニティ' };
  }
  const chosen = chooseCommunity(list, current);
  if (chosen) return { mode: 'community', id: chosen.id, name: chosen.name };
  if (!membersOnly && viewing && viewing.id) return { mode: 'viewing', id: viewing.id, name: viewing.name || 'コミュニティ' };
  return { mode: 'none', reason: 'not-member' };
}

/**
 * A link to a post could not be read (members only). `status` is the failure's HTTP status, null when
 * the read answered with nothing. A dropped connection (0) or a server error (5xx) says nothing about
 * the post: it is not "closed", the page just could not look.
 */
export function linkIsClosed({ signedIn, found, status = null, listKnown = true, mine = false }) {
  if (found) return false;
  if (!signedIn) return true;
  // My own post that has no community: only I can read it, and no community's map holds it.
  if (mine) return false;
  // My communities could not be read: whether I am a member is not known, so nothing is "closed" yet.
  if (!listKnown) return false;
  if (status === null || status === undefined) return true;
  // 401: the session ran out (the app signs out by itself); that is not "members only" either.
  return !(status === 0 || status === 401 || status >= 500);
}

/**
 * The away digest holds the changes of every community I am in. A community's map shows only its own
 * (members only); with the switch off there is one map and nothing is dropped.
 */
export function changesInScope(changes, { membersOnly = false, communityId = null } = {}) {
  const list = changes || [];
  if (!membersOnly) return list;
  if (!communityId) return [];
  return list.filter((change) => change.community_id === communityId);
}

export const COMMUNITIES_UNREAD_NOTE = 'コミュニティを読み込めませんでした。';
export const LOGIN_OR_INVITE_NOTE = 'ログインするか、招待リンクから参加してください。';

/**
 * The notice that takes a map's place.
 *   known       whether my communities were read. When the read failed, "you are in none" is
 *               NOT known: say so and offer a retry instead of telling a member they have no place.
 *   inviteOnly  whether accounts need an invite right now. Before the switch is flipped (the
 *               release has gone out but invite_only is still false), "invite only" would be untrue.
 */
export function mapNotice(scope, { signedIn, known = true, inviteOnly = true, membersOnly = false }) {
  if (!scope || scope.mode !== 'none') return null;
  if (membersOnly && scope.reason === 'closed') {
    return {
      title: MEMBERS_ONLY_TITLE,
      sub: signedIn ? MEMBERS_ONLY_SUB_SIGNED_IN : MEMBERS_ONLY_SUB_SIGNED_OUT,
      login: !signedIn, retry: false, home: signedIn,
    };
  }
  if (membersOnly && !signedIn) {
    return {
      title: MEMBERS_ONLY_MAP_TITLE,
      sub: MEMBERS_ONLY_SUB_SIGNED_OUT,
      login: true, retry: false, home: false,
    };
  }
  if (signedIn && !known) {
    return { title: COMMUNITIES_UNREAD_NOTE, sub: '通信を確かめて、もう一度お試しください。', login: false, retry: true, home: false };
  }
  if (signedIn) {
    return { title: NOT_MEMBER_NOTE, sub: '管理者からもらった招待リンクを開くと、そのコミュニティの地図に入れます。', login: false, retry: false, home: false };
  }
  return {
    title: inviteOnly ? INVITE_ONLY_NOTE : LOGIN_OR_INVITE_NOTE,
    sub: 'アカウントをお持ちの場合はログインしてください。',
    login: true,
    retry: false,
    home: false,
  };
}

// Measured in half-width units: a Japanese character is 2, a Latin letter 1. So 12 Japanese
// characters, or 24 Latin ones (「Saturday Morning Run」 fits whole).
const NAME_MAX = 24;
const charWidth = (char) => (/^[\x20-\x7e｡-ﾟ]$/.test(char) ? 1 : 2);
const clipName = (name) => {
  const chars = Array.from(String(name || '').trim());
  let used = 0;
  for (let i = 0; i < chars.length; i += 1) {
    used += charWidth(chars[i]);
    if (used > NAME_MAX) return `${chars.slice(0, i).join('')}…`;
  }
  return chars.join('');
};

/** The community button at the left of the map's header: 「{name} ▾」. The arrow is there whenever the
 * button opens the sheet - with one community too, since the sheet is also where an admin edits it. */
export function communityButtonText(scope, count) {
  if (!scope || (scope.mode !== 'community' && scope.mode !== 'viewing')) return '';
  const name = clipName(scope.name) || 'コミュニティ';
  return count >= 1 && scope.mode === 'community' ? `${name} ▾` : name;
}

/** Whether the button opens the community sheet: signed in with at least one community. */
export const canSwitch = (scope, count) => Boolean(scope && scope.mode === 'community' && count >= 1);

export const HEADER_BRAND = 'islands';

/** What the left of the header says: the community button, or just the name of the app (signed out,
 * in no community, a read-only look, communities off). `tappable` is whether it opens the sheet. */
export function headerTitle(scope, count) {
  const text = communityButtonText(scope, count);
  return { text: text || HEADER_BRAND, brand: !text, tappable: canSwitch(scope, count) };
}

/** Whether the round 「投稿する」 button shows on the map: signed in, and looking at a map I may write on
 * (not in the read-only look at a community I am not in, not with no community at all). */
export const canPostFromMap = ({ signedIn, scope }) =>
  Boolean(signedIn && scope && scope.mode !== 'none' && scope.mode !== 'viewing');

// ---------------------------------------------------------------- renaming

export const COMMUNITY_NAME_MAX = 40;
export const COMMUNITY_NAME_NOTE = 'コミュニティの名前は1〜40文字で入力してください。';

/** The same rule as rename_community / create_community: trimmed, then 1 to 40 characters. */
export function checkCommunityName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  const length = Array.from(name).length;
  if (length < 1 || length > COMMUNITY_NAME_MAX) return { ok: false, name, message: COMMUNITY_NAME_NOTE };
  return { ok: true, name, message: '' };
}

const JAPANESE = /[぀-ヿ一-鿿]/;

/** A refusal from rename_community said for a person: the database's own Japanese sentence as it is,
 * anything technical (a PostgREST code, an English policy message) as a plain one. */
export function communityRefusal(message) {
  const text = String(message || '').trim();
  if (text && JAPANESE.test(text)) return text;
  if (/row-level security|permission denied|42501/i.test(text)) return 'このコミュニティの名前は、管理者だけが変えられます。';
  return 'うまくいきませんでした。少し待ってからもう一度お試しください。';
}

/** rename_community's answer (a string; the local route answers { name }) -> the name, or ''. */
export function readRenamed(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const name = value && typeof value === 'object' ? value.name : value;
  return typeof name === 'string' ? name.trim() : '';
}

/** My communities with one renamed (the list on screen follows without a reload). */
export const withRenamed = (list, id, name) =>
  (list || []).map((entry) => (entry.id === id ? { ...entry, name } : entry));

/**
 * The small line over the composer. `known` is whether my communities were read: if the read
 * failed, nothing is posted (a post with no community is on nobody's map) and nobody is sent away.
 */
export function postingTarget({ on, editing, scope, known = true }) {
  if (!on || editing) return { show: false, text: '', blocked: false, unknown: false, message: '' };
  if (scope && scope.mode === 'community') {
    return { show: true, text: `${scope.name} に投稿`, blocked: false, unknown: false, message: '' };
  }
  if (!known) {
    return { show: true, text: '', blocked: true, unknown: true, message: `${COMMUNITIES_UNREAD_NOTE}通信を確かめて、もう一度開いてください。` };
  }
  return { show: true, text: '', blocked: true, unknown: false, message: 'コミュニティに入っていないので、投稿できません。招待リンクから参加してください。' };
}

/** The bounding box of a set of posts, in world units, or null (nothing to frame). */
export function postsExtent(posts, radiusOf) {
  const valid = (posts || []).filter((post) => Number.isFinite(post.x) && Number.isFinite(post.y));
  if (!valid.length) return null;
  const radius = (post) => { const r = radiusOf ? Number(radiusOf(post)) : 0; return Number.isFinite(r) ? r : 0; };
  return [
    Math.min(...valid.map((post) => post.x - radius(post))),
    Math.min(...valid.map((post) => post.y - radius(post))),
    Math.max(...valid.map((post) => post.x + radius(post))),
    Math.max(...valid.map((post) => post.y + radius(post))),
  ];
}

// ---------------------------------------------------------------- making invites

// 今日中 is "until 23:59 today (Japan)". The server may take until_end_of_day; the
// remaining minutes are sent as well, so it works whichever the server reads.
export const EXPIRY_CHOICES = [
  { key: '1h', label: '1時間', minutes: 60 },
  { key: '3h', label: '3時間', minutes: 180 },
  { key: 'today', label: '今日中', untilEndOfDay: true, note: '会場の QR におすすめ' },
  { key: '1d', label: '1日', minutes: 1440 },
  { key: '7d', label: '7日', minutes: 10080 },
];
export const DEFAULT_EXPIRY = 'today';

const JST_MS = 9 * 3600 * 1000;

/** Minutes from `now` to 23:59 JST of the same day (at least 1). */
export function minutesUntilEndOfDayJst(now = Date.now()) {
  const jst = new Date(now + JST_MS);
  const end = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), 23, 59, 0) - JST_MS;
  return Math.max(1, Math.ceil((end - now) / 60000));
}

/** The body create_invite is called with. */
export function createInviteBody(communityId, choiceKey, now = Date.now()) {
  const choice = EXPIRY_CHOICES.find((entry) => entry.key === choiceKey) || EXPIRY_CHOICES.find((entry) => entry.key === DEFAULT_EXPIRY);
  return {
    community_id: communityId,
    minutes: choice.untilEndOfDay ? minutesUntilEndOfDayJst(now) : choice.minutes,
    until_end_of_day: Boolean(choice.untilEndOfDay),
  };
}

/** "M/D HH:mm" in Japan time. */
export function jstStamp(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const jst = new Date(at + JST_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
}

/** "あと2時間30分" for the time left, '' when it is over. */
export function timeLeft(iso, now = Date.now()) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at <= now) return '';
  const minutes = Math.ceil((at - now) / 60000);
  if (minutes < 60) return `あと${minutes}分`;
  if (minutes < 1440) {
    const rest = minutes % 60;
    return `あと${Math.floor(minutes / 60)}時間${rest ? `${rest}分` : ''}`;
  }
  const hours = Math.floor((minutes % 1440) / 60);
  return `あと${Math.floor(minutes / 1440)}日${hours ? `${hours}時間` : ''}`;
}

/**
 * The posts that may travel with an invite to this community. A post of another community would
 * open, for the new person, on a map they cannot get into.
 */
export const postsOfCommunity = (rows, communityId) =>
  (Array.isArray(rows) ? rows : []).filter((post) => post && communityId && post.community_id === communityId);

/** Invites that can still be used, newest first. */
export function activeInvites(rows, now = Date.now()) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.id && row.code && !row.revoked_at && Date.parse(row.expires_at) > now)
    .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
}

/** One line of the list: the time left, the date, how many used it. */
export function inviteRowText(row, now = Date.now()) {
  const left = timeLeft(row.expires_at, now);
  const until = jstStamp(row.expires_at);
  const uses = Number(row.uses) || 0;
  return {
    expiry: left ? `${left}（${until} まで）` : `${until} に終了`,
    uses: uses ? `${uses}人が使いました` : 'まだ使われていません',
  };
}

/** The one link of a community: the newest invite that still works (or none). */
export const currentInvite = (rows, now = Date.now()) => activeInvites(rows, now)[0] || null;

/** The line under the QR: "あと4時間（10/25 23:59 まで）・3人が使いました". */
export function inviteLineText(row, now = Date.now()) {
  const text = inviteRowText(row, now);
  return `${text.expiry}・${text.uses}`;
}

/** What the share sheet gets. */
export const inviteShareData = (name, url) => ({
  title: `${name} への招待`,
  text: `islands の「${name}」に招待します`,
  url,
});

/** The saved picture: its file name, and the two lines printed under the QR. */
export function inviteImageName(name) {
  const safe = String(name || '').replace(/[\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return `islands_招待_${safe || 'コミュニティ'}.png`;
}
export const inviteImageLines = (name, expiresAt) => ({
  title: `${name} への招待`,
  until: `${jstStamp(expiresAt)} まで`,
});

/** The post that travels with the link: only while the switch is on and a post is picked. */
export const invitePostFor = (on, postId) => (on && validPost(postId) ? postId : null);

// ---------------------------------------------------------------- islands in a community map

/**
 * /api/islands names landmasses from EVERY post, so on a community map it would
 * also name islands made only of other communities posts. Keep an island when at
 * least one of its posts is on this map. When the read hit its limit (saturated)
 * not every post is known, so nothing is dropped.
 */
export function islandsInScope(islands, postIds, saturated) {
  const list = Array.isArray(islands) ? islands : [];
  if (saturated) return list;
  // An island that does not say which posts it holds cannot be judged: it stays.
  return list.filter((island) => !Array.isArray(island.post_ids) || island.post_ids.some((id) => postIds.has(id)));
}


// ---------------------------------------------------------------- profiles and community names (members only)

/**
 * Posts of other people's pages: only those in a community I am in (the server and the database already
 * leave the rest out; this keeps the page right whatever it is handed). My own page keeps every post of mine.
 */
export function visiblePostsOf(posts, { own, communities, membersOnly }) {
  const rows = Array.isArray(posts) ? posts : [];
  if (!membersOnly || own) return rows;
  const mine = new Set((communities || []).map((entry) => entry.id));
  return rows.filter((post) => post && post.community_id && mine.has(post.community_id));
}

/** What a profile says about the limit on what it shows: a small line on other people's pages. */
export const profileNote = ({ own, membersOnly }) => (membersOnly && !own ? SHARED_ONLY_NOTE : '');

/** The name of a community from my list, or '' when it is not there (a name is only a label). */
export function communityNameIn(communities, id) {
  if (!id) return '';
  const found = (communities || []).find((entry) => entry.id === id);
  return found ? found.name : '';
}
