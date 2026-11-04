// The rules behind the public page of a 会 (/e/<code>, #/e/<code>) and the guest page (#/e/<code>/me), kept free of
// the page so they can be tested in node (tests/frontend/event-rules.test.mjs). No imports on purpose.
//
// What a person who is not signed in may see (E 8): the name, the time, the place, who hosts it, how many people are
// coming, and counts by age / job / genre where a group of two or fewer is folded into 「ほか」. Never a name, never
// the words of an answer. Words that name a 島 are not used on these pages (the genre is just 「アウトドア」).

export const HOKA = 'ほか';
export const BREAKDOWN_FLOOR = 3;          // a group smaller than this is folded into 「ほか」 (BREAKDOWN_MIN_COUNT on the server)
export const WEEKDAYS = '日月火水木金土';
export const LATE_MINUTES = Object.freeze([10, 30, 60]);
export const LATE_LABELS = Object.freeze({ 10: '10分くらい遅れる', 30: '30分くらい遅れる', 60: '1時間以上遅れる' });
const CODE_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export const EVENT_WORDS = Object.freeze({
  applyTo: '申し込みに進む',
  applyNow: 'すぐ申し込む',
  probe: 'あなたと近い人が来るか見てみる',
  cancelledBand: 'この会は中止になりました',
  cancelledNote: '申し込みは取り消されています。',
  fullBand: '先着人数に達しました',
  deadlineBand: '申し込みの期限が過ぎました',
  declined: '定員などの都合により、今回はご参加をお受けできないことになりました。またの機会にぜひお越しください。',
  attended: '受付しました',
  cancelledReg: '申し込みを取り消しました',
  communityOnly: 'この会は、コミュニティのメンバーだけが申し込めます',
  waiting: '受付を待っています',
  notFound: 'この会は見つかりません。',
  consentLead: '「申し込む」を押すと、',
  consentTail: 'に同意したことになります。',
  noQuestions: '質問はありません。',
  friendBand: 'LINE でお知らせが届きません',
  friendNote: 'islands の LINE を友だち追加すると届きます',
});

// ---------------------------------------------------------------- the address

/** "/e/<code>" or "/c/<code>" (the path a link opens) -> { kind: 'apply' | 'checkin', code }, or null. */
export function parseEventPath(pathname) {
  const found = /^\/([ec])\/([^/?#]+)\/?$/.exec(String(pathname || ''));
  if (!found) return null;
  let code = found[2];
  try { code = decodeURIComponent(code); } catch { return null; }
  if (!CODE_PATTERN.test(code)) return null;
  return { kind: found[1] === 'e' ? 'apply' : 'checkin', code };
}

export const validEventCode = (code) => CODE_PATTERN.test(String(code || ''));

/** The hash of a page of a 会. kind: 'apply' (the public page), 'me' (the guest page), 'after' (会のあと), 'checkin'. */
export function eventHashFor(code, kind = 'apply') {
  if (!validEventCode(code)) return '#/map';
  if (kind === 'checkin') return `#/c/${code}`;
  if (kind === 'host') return `#/e/${code}/host`;
  if (kind === 'after') return `#/e/${code}/after`;
  return kind === 'me' ? `#/e/${code}/me` : `#/e/${code}`;
}

/** Is this route pattern one of the pages of a 会 (they are open to people who are not members)? */
export const isEventPattern = (pattern) => /^#\/(e|c)\/:code(\/|$)/.test(String(pattern || ''));

// ---------------------------------------------------------------- when

function jst(value) {
  const stamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(stamp)) return null;
  return new Date(stamp + 9 * 3600 * 1000);       // read with the getUTC* of this shifted date: Japan time
}
const two = (n) => String(n).padStart(2, '0');

/** "11/21(金)" in Japan time, or ''. */
export function dayText(value) {
  const d = jst(value);
  return d ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAYS[d.getUTCDay()]})` : '';
}

/** "19:00" in Japan time, or ''. */
export function clockText(value) {
  const d = jst(value);
  return d ? `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}` : '';
}

/** "11/21(金) 19:00〜22:00" (the end only when it is the same day, otherwise with its own date). */
export function windowText(event) {
  if (!event || !event.starts_at) return '';
  const start = jst(event.starts_at);
  if (!start) return '';
  const head = `${dayText(event.starts_at)} ${clockText(event.starts_at)}`;
  if (!event.ends_at) return head;
  const end = jst(event.ends_at);
  if (!end) return head;
  const sameDay = start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth()
    && start.getUTCDate() === end.getUTCDate();
  return sameDay ? `${head}〜${clockText(event.ends_at)}` : `${head}〜${dayText(event.ends_at)} ${clockText(event.ends_at)}`;
}

/** Which registration the guest page is for: the soonest live one, else the last 会 (by start time). */
export function guestEntry(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byStart = (a, b) => String(a.starts_at).localeCompare(String(b.starts_at));
  const alive = list.filter((item) => ['applied', 'waiting', 'attended'].includes(item.status)).sort(byStart);
  if (alive.length) return alive[0];
  return [...list].sort(byStart).pop() || null;
}

/** 'before' | 'during' | 'after': where now stands against the 会 (the late and cancel buttons end with it). */
export function phaseOf(event, now = Date.now()) {
  const start = Date.parse(event && event.starts_at);
  const end = Date.parse(event && event.ends_at);
  if (Number.isFinite(end) && now > end) return 'after';
  if (Number.isFinite(start) && now >= start) return 'during';
  return 'before';
}

/** A link that puts the 会 in a person's calendar (Google Calendar's template). '' when the time cannot be read. */
export function calendarUrl(event, origin = '') {
  const start = Date.parse(event && event.starts_at);
  const end = Date.parse(event && event.ends_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const params = new URLSearchParams({
    action: 'TEMPLATE', text: event.title || 'islands の会', dates: `${stamp(start)}/${stamp(end)}`,
    location: event.place || '', details: origin ? `${origin}/e/${event.code}` : '',
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

/** A link to the place on a map. '' without a place. */
export function mapUrl(place) {
  const text = String(place || '').trim();
  return text ? `https://www.google.com/maps/search/?${new URLSearchParams({ api: '1', query: text })}` : '';
}

// ---------------------------------------------------------------- the public page

/**
 * What the public page does with its state. `info` is GET /api/public/events/<code>.
 * { state: 'open' | 'full' | 'deadline' | 'cancelled', canApply, band }
 */
export function applyView(info) {
  const closed = info && info.closed;
  if (closed === 'cancelled') return { state: 'cancelled', canApply: false, band: EVENT_WORDS.cancelledBand };
  // 人数が集まらず中止（判定のあと）。帯の文は申し込みページ側（event-apply.js）が出す
  if (closed === 'not_held' || (info && info.phase === 'not_held')) return { state: 'not_held', canApply: false, band: '' };
  if (closed === 'full') return { state: 'full', canApply: false, band: EVENT_WORDS.fullBand };
  if (closed === 'deadline') return { state: 'deadline', canApply: false, band: EVENT_WORDS.deadlineBand };
  return { state: 'open', canApply: true, band: '' };
}

/**
 * 「コミュニティの中だけ」の会（visibility が community）は、メンバーしか申し込めない。公開ページの返りから、
 * 申し込みの前に手順を止めるかを決める。isMember は GET /api/events/<code> の me.is_member（まだ分からないときは null）。
 * { communityOnly, mustStop, note }
 *   mustStop  メンバーではないと分かっている（ここから先の入力は無駄になる）
 */
export function communityOnlyView(info, isMember = null) {
  const communityOnly = Boolean(info) && info.visibility === 'community';
  return {
    communityOnly,
    mustStop: communityOnly && isMember === false,
    note: communityOnly ? EVENT_WORDS.communityOnly : '',
  };
}

/**
 * ゲスト用ページ（#/e/<code>/me）を開いたとき、そこにいる意味がない人をどこへ送るか。
 * 申し込んでいない人（状態 none）は、会が中止でなければ主催者は主催者の画面、ほかは公開ページ。null ならそのまま表示。
 */
export function meRedirect(result, code) {
  const status = (result && result.me && result.me.status) || 'none';
  const event = (result && result.event) || {};
  if (status !== 'none' || event.cancelled || event.closed === 'cancelled') return null;
  return eventHashFor(code, result && result.is_host ? 'host' : 'apply');
}

/** 「18人 参加予定」 and, when there is a limit, 「定員 20人」. Nothing is shown for a 会 nobody has applied to. */
export function countView(info) {
  const count = Number(info && info.applied_count) || 0;
  const capacity = Number.isInteger(info && info.capacity) ? info.capacity : null;
  return {
    count, empty: count === 0,
    capacityText: capacity ? `定員 ${capacity}人` : '',
  };
}

/**
 * The counts by age / job / genre, as rows: [{ key, title, items: [{ label, count }] }]. Groups below three
 * people are folded into 「ほか」 again here (the server has done it; a second check costs nothing and keeps the
 * promise even if a number comes through wrong), and 「ほか」 is always last. Empty groups are left out.
 */
export function breakdownRows(breakdown) {
  const titles = [['age', '年代'], ['job', '職種'], ['genre', 'ジャンル']];
  const rows = [];
  for (const [key, title] of titles) {
    const list = Array.isArray(breakdown && breakdown[key]) ? breakdown[key] : [];
    const kept = [];
    let other = 0;
    for (const item of list) {
      const count = Number(item && item.count) || 0;
      const label = String((item && item.label) || '');
      if (!label || count <= 0) continue;
      if (label === HOKA || count < BREAKDOWN_FLOOR) other += count; else kept.push({ label, count });
    }
    kept.sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1));
    if (other > 0) kept.push({ label: HOKA, count: other });
    if (kept.length) rows.push({ key, title, items: kept });
  }
  return rows;
}

/** The answer of 近い人が来るか見てみる: { level: none|few|many, count } -> the words. */
export function probeView(result) {
  const level = result && result.level;
  if (level === 'many' && Number.isFinite(result.count)) {
    return { level, number: String(result.count), unit: '人', lead: 'あなたと近そうな人が', tail: '参加予定です' };
  }
  if (level === 'few') return { level, number: '少し', unit: '', lead: 'あなたと近そうな人が', tail: '参加予定です' };
  return { level: 'none', number: 'まだ', unit: '', lead: 'あなたと近そうな人は', tail: 'いません' };
}

/** What was typed for the probe -> 1〜2 interests (30 characters at most each), or null. */
export function cleanInterests(list, max = 30) {
  const items = (Array.isArray(list) ? list : []).map((item) => String(item || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (items.length < 1 || items.length > 2) return null;
  if (items.some((item) => Array.from(item).length > max)) return null;
  return items;
}

// ---------------------------------------------------------------- the guest page

/**
 * What the guest page says. `event` is GET /api/events/<code> .event, `me` its `me`.
 * { tone, title, note, canLate, canCancel, canReapply, showFriend }
 *   tone: 'cancelled' (a red band) | 'declined' | 'ok' | 'attended' | 'waiting' | 'cancelledReg' | 'none'
 * A cancelled 会 shows no near people (E 12; the page leaves the section out when `showNear` is false).
 */
export function statusView(me, event, now = Date.now()) {
  const status = (me && me.status) || 'none';
  const cancelled = Boolean(event && event.cancelled);
  const phase = phaseOf(event, now);
  const base = { canLate: false, canCancel: false, canReapply: false, showNear: false, showFriend: false };
  if (cancelled) {
    return { ...base, tone: 'cancelled', title: EVENT_WORDS.cancelledBand, note: EVENT_WORDS.cancelledNote };
  }
  if (status === 'declined') return { ...base, tone: 'declined', title: '', note: EVENT_WORDS.declined };
  // 人数が集まらず中止（第2回b）：上の「中止」の札だけ。遅れる・会場への行き方・友だち追加は出さない
  if (event && (event.closed === 'not_held' || event.phase === 'not_held')) return { ...base, tone: 'notHeld', title: '', note: '' };
  if (status === 'attended') {
    return { ...base, tone: 'attended', title: EVENT_WORDS.attended, note: '', showNear: false };
  }
  if (status === 'waiting') return { ...base, tone: 'waiting', title: EVENT_WORDS.waiting, note: '' };
  if (status === 'cancelled') {
    return { ...base, tone: 'cancelledReg', title: EVENT_WORDS.cancelledReg, note: '', canReapply: phase !== 'after' };
  }
  if (status === 'applied') {
    const live = phase !== 'after';
    return {
      ...base, tone: 'ok', title: '申し込み済み', note: phase === 'after' ? '会は終了しました。' : '',
      canLate: live, canCancel: live, showNear: true, showFriend: !(me && me.line_friend),
    };
  }
  return { ...base, tone: 'none', title: '', note: '' };
}

/** "30分くらい遅れる" etc. for the three choices; `selected` marks the one that is set. */
export function lateChoices(selected, allowed = LATE_MINUTES) {
  return allowed.map((minutes) => ({ minutes, label: LATE_LABELS[minutes] || `${minutes}分遅れる`, selected: minutes === selected }));
}

/** The one-line reason of a near person (D 例 D `near`), without any strong words when the closeness is low. */
export function nearReasonText(near) {
  if (!near || !near.reason) return '';
  return String(near.reason);
}

/** An answer of the server -> a sentence for a person. Known words first; the server's own sentence otherwise. */
export function errorText(error) {
  const message = error && error.message ? String(error.message) : '';
  if (error && error.status === 0) return message || '接続できませんでした。通信環境をご確認ください。';
  return message || 'うまくいきませんでした。もう一度お試しください。';
}

// ---------------------------------------------------------------- where to come back to

const RETURN_KEY = 'islands-event-apply-return';
export const RETURN_HOLD_MS = 30 * 60 * 1000;

/** Before leaving for a sign-in (LINE opens another page): remember which 会 the person was applying to. */
export function rememberApplyReturn(storage, code, now = Date.now()) {
  if (!storage || !validEventCode(code)) return false;
  try {
    storage.setItem(RETURN_KEY, JSON.stringify({ code, at: now }));
    return true;
  } catch { return false; }
}

/** The same, without taking it (start-up looks first; the page of the 会 takes it). */
export function peekApplyReturn(storage, now = Date.now()) {
  if (!storage) return null;
  try {
    const saved = JSON.parse(storage.getItem(RETURN_KEY) || 'null');
    if (!saved || !validEventCode(saved.code) || !Number.isFinite(saved.at)) return null;
    return now - saved.at <= RETURN_HOLD_MS ? saved.code : null;
  } catch { return null; }
}

/** The 会 to go back to after a sign-in came back to a bare address, or null. Taken once. */
export function takeApplyReturn(storage, now = Date.now()) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(RETURN_KEY);
    storage.removeItem(RETURN_KEY);
    const saved = JSON.parse(raw || 'null');
    if (!saved || !validEventCode(saved.code) || !Number.isFinite(saved.at)) return null;
    return now - saved.at <= RETURN_HOLD_MS ? saved.code : null;
  } catch { return null; }
}

const PROBE_KEY = 'islands-event-probe';

/** The interests typed for the probe, kept for the tab only (the server keeps nothing). [] when none. */
export function probeDraft(storage, code) {
  if (!storage) return [];
  try {
    const saved = JSON.parse(storage.getItem(`${PROBE_KEY}:${code}`) || 'null');
    return cleanInterests(saved) || [];
  } catch { return []; }
}

export function saveProbeDraft(storage, code, interests) {
  if (!storage) return false;
  try {
    storage.setItem(`${PROBE_KEY}:${code}`, JSON.stringify(cleanInterests(interests) || []));
    return true;
  } catch { return false; }
}

const HOST_RETURN_KEY = 'islands-event-host-return';

/** ログインしないで主催者の画面を開いたとき：ログインのあとに戻る会を覚える。 */
export function rememberHostReturn(storage, code, now = Date.now()) {
  if (!storage || !validEventCode(code)) return false;
  try {
    storage.setItem(HOST_RETURN_KEY, JSON.stringify({ code, at: now }));
    return true;
  } catch { return false; }
}

/** 覚えていた会（主催者の画面）の道を一度だけ取り出す。なければ null。 */
export function takeHostReturn(storage, now = Date.now()) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(HOST_RETURN_KEY);
    storage.removeItem(HOST_RETURN_KEY);
    const saved = JSON.parse(raw || 'null');
    if (!saved || !validEventCode(saved.code) || !Number.isFinite(saved.at)) return null;
    return now - saved.at <= RETURN_HOLD_MS ? eventHashFor(saved.code, 'host') : null;
  } catch { return null; }
}

// ================================================================ 第2回b：限定ページ・受付・会のあと（画面B）
// 開催の段階・キャンセルの文・参加者リスト・「このコミュニティに参加する」・受付の出し分け・会のあと。
// どれもページに触らない関数（node のテストは tests/frontend/event-rules.test.mjs）。サーバーが新しい項目を返さない
// （SQL より先にコードが出ている）ときは、今までどおりの出し方に戻る。

export const EVENT_B_WORDS = Object.freeze({
  afterCancel: '期限後のキャンセルは主催者に連絡してください',
  joined: 'メンバーになりました',
  afterLink: '会った人を選ぶ',
  checkinBlocked: '受付できませんでした。主催者に声をかけてください',
  checkinCancelled: '申し込みを取り消しています。主催者に声をかけてください',
  waitingNote: '主催者に声をかけてください。受付が終わると、この画面が自動で変わります。',
  askJoinNote: 'コミュニティに参加すると「もっと話してみたい」も押せます',
  closedCheckin: '受付の時間ではありません',
  earlyCheckin: '受付はまだ始まっていません',
});

/** 受付の画面を数秒ごとに読み直す間隔（受付待ちのとき）。 */
export const CHECKIN_POLL_MS = 4000;
export const WALKIN_MAX = 32;

/** "11月12日(木) 18:00" in Japan time, or ''. (The year is left out: a deadline is always close.) */
export function deadlineText(value) {
  const d = jst(value);
  return d ? `${d.getUTCMonth() + 1}月${d.getUTCDate()}日(${WEEKDAYS[d.getUTCDay()]}) ${clockText(value)}` : '';
}

/** "11月12日" from a plain date ("2026-11-12"), or ''. */
export function plainDayText(value) {
  const found = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return found ? `${Number(found[2])}月${Number(found[3])}日` : '';
}

/** 参加者リストを出してよい会か（中止の会には出さない）。 */
export function listAllowed(event) {
  if (!event) return false;
  return !(event.cancelled || event.closed === 'cancelled' || event.closed === 'not_held' || event.phase === 'not_held');
}

/**
 * 限定ページの上の「開催の状態」。最小人数が無い会（phase が null や無し）は null（何も足さない）。
 * { phase, label, tone, note }  tone: 'ok' | 'wait' | 'bad'
 */
export function eventStageView(event) {
  const phase = event && event.phase;
  if (phase === 'held') return { phase, label: '開催決定', tone: 'ok', note: '' };
  if (phase === 'not_held') return { phase, label: '中止', tone: 'bad', note: '人数が集まらなかったため、この会は中止になりました' };
  if (phase !== 'recruiting') return null;
  const needed = Number(event.needed);
  const until = plainDayText(event.decide_on);
  const note = [Number.isFinite(needed) && needed > 0 ? `あと${needed}人で開催決定` : '',
    until && event.min_participants ? `${until}までに${event.min_participants}人集まれば開催` : ''].filter(Boolean).join('／');
  return { phase, label: '募集中', tone: 'wait', note };
}

/**
 * キャンセルの出し方。`me.can_cancel` があればそれに従い、無ければ（古いサーバー）今までの statusView の判断。
 * { canCancel, note }  note：期限の文、または期限後の案内（ボタンなし）。
 */
export function cancelView(me, event, now = Date.now()) {
  const status = (me && me.status) || 'none';
  const base = statusView(me, event, now);
  if (status !== 'applied' || base.tone === 'cancelled') return { canCancel: false, note: '' };
  const canCancel = me && typeof me.can_cancel === 'boolean' ? me.can_cancel : base.canCancel;
  const deadline = event && event.cancel_deadline;
  const stamp = Date.parse(deadline);
  if (canCancel) return { canCancel: true, note: Number.isFinite(stamp) ? `キャンセルは${deadlineText(deadline)}まで` : '' };
  const closed = Number.isFinite(stamp) && now > stamp;
  return { canCancel: false, note: closed ? EVENT_B_WORDS.afterCancel : '' };
}

/** 「このコミュニティに参加する」を出すか。me.can_join の通りで、無ければ出さない。 */
export function joinView(me, event) {
  const name = String((event && event.community_name) || '').trim();
  const quoted = name ? `「${name}」` : 'このコミュニティ';
  return {
    show: Boolean(me && me.can_join === true), name,
    lead: `${quoted}のメンバーになると、地図やほかの人の投稿が見られます`,
    confirm: { title: `${quoted}に参加しますか？`, body: '参加すると、地図やほかの人の投稿が見られるようになります。', confirmLabel: '参加する' },
    done: `${quoted}のメンバーになりました`,
  };
}

/** 参加者リストの1人：名前の下の一行（会社・職種）と札・回答。年代は出さない。 */
export function personView(person) {
  const p = person || {};
  const sub = [p.affiliation, p.job_title].map((v) => String(v || '').trim()).filter(Boolean).join('・');
  const badges = [];
  if (p.is_me) badges.push({ key: 'me', text: 'あなた' });
  if (p.state === 'host') badges.push({ key: 'host', text: '主催者' });
  if (p.state === 'attended') badges.push({ key: 'attended', text: '受付済み' });
  if (!p.is_me && p.late_minutes) badges.push({ key: 'late', text: `${p.late_minutes === 60 ? '1時間以上' : `${p.late_minutes}分`}遅れ` });
  const answers = (Array.isArray(p.answers) ? p.answers : [])
    .map((a) => ({ label: String((a && a.label) || ''), body: String((a && a.body) || '').trim() })).filter((a) => a.body);
  return { id: p.account_id, name: String(p.name || '名前なし'), sub, badges, answers, reason: nearReasonText(p.near), isMe: Boolean(p.is_me) };
}

/**
 * 参加者リストを「近いかも（最大3人）」と「みんな」に分ける。サーバーの並び（自分→主催者→近い順→申し込み順）を保ち、
 * near3 の人（自分以外）を上の組に移す。中止の会・リストが読めなかったときは null。
 * { count, near: [person], rest: [person] }
 */
export function participantsView(data, event) {
  if (!data || !Array.isArray(data.people) || !listAllowed(event)) return null;
  const order = (p) => (p.is_me ? 0 : p.state === 'host' ? 1 : 2);
  const sorted = data.people.map((p, i) => ({ p, i })).sort((a, b) => order(a.p) - order(b.p) || a.i - b.i).map((x) => x.p);
  const ids = new Set(Array.isArray(data.near3) ? data.near3 : []);
  const near = sorted.filter((p) => !p.is_me && ids.has(p.account_id)).slice(0, 3);
  const taken = new Set(near.map((p) => p.account_id));
  return { count: sorted.length, near, rest: sorted.filter((p) => !taken.has(p.account_id)) };
}

/** 会が終わったあとの「会った人を選ぶ」を、限定ページに出すか。 */
export function afterLinkShown(me, event, now = Date.now()) {
  return Boolean(me && me.status === 'attended') && listAllowed(event) && phaseOf(event, now) === 'after';
}

// ---------------------------------------------------------------- 受付（#/c/<checkin_code>）

/**
 * 受付の画面が何を出すか。`info` は GET /api/checkin/<code>（{ event, window, me, rejects, is_member }）。
 * kind: 'early' | 'closed' | 'attended' | 'waiting' | 'rejected'（入れ直せる）| 'blocked'（お断り・3回却下）|
 *       'cancelled' | 'ready'（「受付する」）| 'walkin'（名前と会社を入れる）
 */
export function checkinView(info) {
  const me = (info && info.me) || 'none';
  const rejects = Number(info && info.rejects) || 0;
  const window = info && info.window;
  if (me === 'attended') return { kind: 'attended' };
  // 中止の会は、押してから断られるのではなく、先に文だけを出す
  const event = (info && info.event) || {};
  if (event.cancelled) return { kind: 'cancelled', text: EVENT_WORDS.cancelledBand };
  if (event.phase === 'not_held') return { kind: 'cancelled', text: '人数が集まらなかったため、この会は中止になりました' };
  if (me === 'banned') return { kind: 'blocked', text: EVENT_B_WORDS.checkinBlocked };
  if (me === 'waiting') return { kind: 'waiting', text: EVENT_B_WORDS.waitingNote };
  if (me === 'rejected') return { kind: rejects >= 3 ? 'blocked' : 'rejected', text: EVENT_B_WORDS.checkinBlocked };
  if (window === 'early') return { kind: 'early', text: EVENT_B_WORDS.earlyCheckin };
  if (window === 'closed') return { kind: 'closed', text: EVENT_B_WORDS.closedCheckin };
  // 自分で取り消したあとに会場に来た人は、飛び入りと同じく受付待ちになり、主催者が名簿で選ぶ
  // （DB の event_walkin_request は取り消した行を waiting に戻す）
  if (me === 'cancelled') return { kind: 'walkin' };
  if (me === 'applied' || (me === 'none' && info && info.is_member)) return { kind: 'ready' };
  return { kind: 'walkin' };
}

/** 受付できたときの見出しと一行。joined（自動で加入）なら「『<コミュニティ名>』のメンバーになりました」（会の名前ではない）。 */
export function checkinDoneView(result, event, displayName = '') {
  const joined = Boolean(result && result.joined);
  const name = String((event && event.community_name) || '').trim();
  const who = String(displayName || '').trim();
  const hello = who ? `ようこそ、${who}さん。` : '';
  if (joined) return { title: EVENT_WORDS.attended, note: `${hello}${name ? `「${name}」` : 'コミュニティ'}のメンバーになりました。`, joined: true };
  return { title: EVENT_WORDS.attended, note: hello, joined: false };
}

/** 飛び入りの入力（フルネーム・会社）を検める：{ ok, body, message }。同意は「受付をお願いする」を押すことで取る。 */
export function cleanWalkin(name, affiliation) {
  const display = String(name || '').replace(/\s+/g, ' ').trim();
  const org = String(affiliation || '').replace(/\s+/g, ' ').trim();
  if (!display || !org) return { ok: false, message: 'フルネームと会社・所属を入力してください。' };
  if (Array.from(display).length > WALKIN_MAX || Array.from(org).length > WALKIN_MAX) {
    return { ok: false, message: `${WALKIN_MAX}文字までで入力してください。` };
  }
  return { ok: true, body: { display_name: display, affiliation: org, agree_terms: true } };
}

const CHECKIN_RETURN_KEY = 'islands-event-checkin-return';

/** ログインに出る前：どの受付の画面にいたかを覚える（メールのリンクは「/」に戻るため）。 */
export function rememberCheckinReturn(storage, code, now = Date.now()) {
  if (!storage || !validEventCode(code)) return false;
  try {
    storage.setItem(CHECKIN_RETURN_KEY, JSON.stringify({ code, at: now }));
    return true;
  } catch { return false; }
}

/** 覚えていた受付の画面を見るだけ（起動時）。 */
export function peekCheckinReturn(storage, now = Date.now()) {
  if (!storage) return null;
  try {
    const saved = JSON.parse(storage.getItem(CHECKIN_RETURN_KEY) || 'null');
    if (!saved || !validEventCode(saved.code) || !Number.isFinite(saved.at)) return null;
    return now - saved.at <= RETURN_HOLD_MS ? saved.code : null;
  } catch { return null; }
}

/** 同じものを一度だけ取り出す（受付の画面が使う）。 */
export function takeCheckinReturn(storage, now = Date.now()) {
  const code = peekCheckinReturn(storage, now);
  try { if (storage) storage.removeItem(CHECKIN_RETURN_KEY); } catch { /* nothing to do */ }
  return code;
}

/** ゲストが開けるページか：#/e/<code>・#/e/<code>/me・#/e/<code>/after・#/c/<code> だけ。 */
export const guestMayOpen = (pattern) => ['#/e/:code', '#/e/:code/me', '#/e/:code/after', '#/c/:code'].includes(String(pattern || ''));

// ---------------------------------------------------------------- 会のあと（#/e/<code>/after）

/**
 * 会のあとの画面。`data` は GET /api/events/<code>/after（{ people, me_is_member, join_policy }）。
 * 「もっと話してみたい」は2人ともメンバーのときだけ（canTalk）。メンバーでない人で ask の会には参加の案内。
 */
export function afterView(data) {
  const people = Array.isArray(data && data.people) ? data.people : [];
  const meMember = Boolean(data && data.me_is_member);
  const askJoin = !meMember && Boolean(data) && data.join_policy === 'ask';
  return {
    people: people.map((p) => ({
      id: p.account_id, name: String(p.display_name || p.name || '名前なし'),
      sub: [p.affiliation, p.job_title].map((v) => String(v || '').trim()).filter(Boolean).join('・'),
      met: Boolean(p.met), canTalk: meMember && Boolean(p.is_member), raw: p,
    })),
    empty: people.length === 0,
    askJoin,
    note: askJoin ? EVENT_B_WORDS.askJoinNote : '',
  };
}
