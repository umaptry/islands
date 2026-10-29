// Pure rules for the extra prompts and for 参加者募集中's deadline / capacity.
// No imports on purpose: tests/frontend loads this file on its own.
//
// Dates are Japan time (the server's rule), whatever the phone's own zone is:
// a deadline of 2026-12-31 is open until the end of that day in Tokyo.

const DAY_MS = 86400000;
const JST_MS = 9 * 3600000;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" for today in Japan. */
export function jstToday(now = new Date()) {
  return new Date(now.getTime() + JST_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" plus whole days (calendar arithmetic, no zones involved). */
export function addDays(ymd, days) {
  const match = YMD.exec(ymd || '');
  if (!match) return null;
  const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

/** The <input type=date> limits for a new deadline: today .. 365 days ahead.
 * Editing a post whose own deadline has already passed keeps that value valid. */
export function deadlineRange(now = new Date(), current = null) {
  const today = jstToday(now);
  const min = current && YMD.test(current) && current < today ? current : today;
  return { min, max: addDays(today, 365) };
}

/** "2026-12-31" -> "2026/12/31" (null when it is not a date). */
export function formatDeadline(ymd) {
  const match = YMD.exec(ymd || '');
  return match ? `${match[1]}/${match[2]}/${match[3]}` : null;
}

/** The capacity as an integer 1..999, or null. */
export function parseCapacity(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const number = Number(text);
  return number >= 1 && number <= 999 ? number : null;
}

/** null (open), "deadline" or "full". The server's recruit_closed can be stale
 * once somebody joins, so the numbers win; the flag is for rows without them. */
export function recruitState(post, now = new Date()) {
  if (!post) return null;
  if (post.recruit_closed === 'deadline') return 'deadline';
  const deadline = YMD.test(post.recruit_deadline || '') ? post.recruit_deadline : null;
  if (deadline && now.getTime() >= Date.parse(`${addDays(deadline, 1)}T00:00:00+09:00`)) return 'deadline';
  const capacity = Number(post.recruit_capacity);
  if (capacity > 0) return joinCount(post) >= capacity ? 'full' : null;
  return post.recruit_closed === 'full' ? 'full' : null;
}

/** "2026-10-31" -> "10月31日まで" (with the year when it is not this year, Japan time). */
export function formatDeadlineShort(ymd, now = new Date()) {
  const match = YMD.exec(ymd || '');
  if (!match) return null;
  const day = `${Number(match[2])}月${Number(match[3])}日まで`;
  return Number(match[1]) === Number(jstToday(now).slice(0, 4)) ? day : `${Number(match[1])}年${day}`;
}

/** The terms before "現在N人参加" on the 参加 button, e.g.
 * "申込期限 10月31日まで・先着10人・" (only the values that exist; "" when none). */
export function joinTerms(post, now = new Date()) {
  const parts = [];
  const deadline = formatDeadlineShort(post?.recruit_deadline, now);
  if (deadline) parts.push(`申込期限 ${deadline}`);
  if (Number(post?.recruit_capacity) > 0) {
    // Put on several communities: say that the number below counts the others too (only once it does).
    const others = joinCount(post) > Number(post?.join_count || 0);
    parts.push(`先着${Number(post.recruit_capacity)}人${others ? '（ほかのコミュニティの参加も含む）' : ''}`);
  }
  return parts.map((part) => `${part}・`).join('');
}

/** What the 参加 button says: the state word (first line) and whether it is
 * pressable. 受付終了 / 満員 only stop somebody who has not joined: taking
 * your own join back is always allowed. */
export function joinWord(post, { joined = false, extras = true, now = new Date() } = {}) {
  const closed = extras ? recruitState(post, now) : null;
  if (joined) return { word: '参加済み（タップで取り消し）', ended: false, closed };
  if (closed) return { word: RECRUIT_STATE_LABEL[closed], ended: true, closed };
  return { word: '参加する', ended: false, closed };
}

export const RECRUIT_STATE_LABEL = { deadline: '受付終了', full: '満員' };

/** Toast text for a refused join (PostgREST message, or the local 409 detail). */
export function joinRefusal(message) {
  const text = String(message || '');
  if (text.includes('recruit_closed')) return '受付は終了しました';
  if (text.includes('recruit_full')) return '先着人数に達しました';
  return null;
}

/** The tag a post asks for help with. */
export const HELP_TAG = '助けてほしい';

/** Whether a post shows 手伝えるかも: only on a 「助けてほしい」 post, or where the viewer already pressed it
 * (so it can be taken back), or on their own post once somebody has. `reacted`: the viewer pressed it. */
export function showHelp(post, meId, { reacted = false } = {}) {
  if (!post) return false;
  if (Array.isArray(post.tags) && post.tags.includes(HELP_TAG)) return true;
  if (reacted) return true;
  return Boolean(meId) && post.author_id === meId && (post.help_count || 0) >= 1;
}

/** Extra prompt keys the person has already posted with. */
export function usedPromptKeys(posts) {
  return new Set((posts || []).map((post) => post?.prompt).filter(Boolean));
}

/** What the body says while it is empty: an example sentence for an extra
 * prompt ("例：…"), the weekly prompt itself, or the plain hint. */
export function promptPlaceholder({ selected, weekly, extraPrompts }) {
  if (selected === 'weekly' && weekly?.text) return `お題：${weekly.text}`;
  const extra = selected ? (extraPrompts || []).find((item) => item?.key === selected) : null;
  if (extra?.example) return `例：${extra.example}`;
  if (extra?.text) return `お題：${extra.text}`;
  return BODY_PLACEHOLDER;
}

/** The box's words with no prompt chosen (2026-10-27). A question, as X asks 「いまどうしてる？」, but about
 * what a person likes or wants to try, so it does not ask for 「ラーメン食べてるなう」. The limit is on the counter. */
export const BODY_PLACEHOLDER = '好きなこと、やってみたいことは？';

/** The extra prompts on offer: all of them every time (using one does not hide it), none when the feature
 * is off. `posts` is no longer read. */
export function availablePrompts(extraPrompts, posts, enabled) {
  if (!enabled) return [];
  return (extraPrompts || []).filter(Boolean);
}

/** The new fields of a create / edit request. Nothing at all when the feature is
 * off (the server would ignore them, but the old schema should never see them). */
export function extrasPayload({ enabled, editing, recruiting, prompt, deadline, capacity }) {
  if (!enabled) return {};
  const out = {};
  const limit = recruiting ? parseCapacity(capacity) : null;
  const day = recruiting && YMD.test(deadline || '') ? deadline : null;
  if (editing) {
    // PATCH: null clears, so an emptied field really is emptied.
    out.recruit_deadline = day;
    out.recruit_capacity = limit;
  } else {
    if (day) out.recruit_deadline = day;
    if (limit) out.recruit_capacity = limit;
    if (prompt) out.prompt = prompt;
  }
  return out;
}

/** The joins a first-come capacity is counted against: on a post put on several communities, everybody who
 * joined any copy (each person once, the server's group_join_count); otherwise this post's own joins. */
export function joinCount(post) {
  const own = Number(post?.join_count || 0);
  if (Number(post?.recruit_capacity) > 0 && post?.group_join_count != null) return Number(post.group_join_count) || 0;
  return own;
}
