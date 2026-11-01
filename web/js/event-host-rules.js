// 会（イベント）の主催者とメンバーの画面の「判断」だけをここに置く（画面に触らない。node で試せる）。
// 2026-11-01 第2回a。取り決めは 設計_イベント申し込み/D_関数の取り決め.md（2-3 と 8章）。
// import は無し：tests/frontend がこのファイル単体を読む。
//
//   会を作る   validateEventDraft / questionPayload / QUESTION_CHOICES
//   時刻       formatWhen / toLocalInput / fromLocalInput（日本時間で決め打ち）
//   名簿       countsView / rosterSections / statusChip / rowTags / rowActions / declineConfirm / quotaText
//   メンバー   memberAction（投稿カードのボタン）/ needsFullnameFirst / applyConfirm / cancelConfirm
//   通知       noticeTarget

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const pad = (n) => String(n).padStart(2, '0');

export const TERMS_NEXT = '/terms/next';
export const PRIVACY_NEXT = '/privacy/next';

/** 質問は固定で3つ（今・過去・これから）。4問目「当日話したいこと」は無い（11/1 決定）。 */
export const QUESTION_CHOICES = Object.freeze([
  Object.freeze({ prompt: 'now', label: '今やってること', hint: '仕事でも趣味でも' }),
  Object.freeze({ prompt: 'past', label: '昔やってたこと', hint: '仕事でも趣味でも' }),
  Object.freeze({ prompt: 'future', label: 'やってみたいこと', hint: '仕事でも趣味でも' }),
]);

export const HOST_WORDS = Object.freeze({
  eventToggle: '申し込みのある「会」にする',
  eventToggleNote: '申し込みページができます。名簿や、前日までのお知らせもつきます。',
  eventNext: '次へ（会の中身）',
  stepWhen: 'いつ、どこでやる会？',
  stepWhenNote: '申し込みページに、そのまま載ります。',
  stepQuestions: '申し込む人に聞きたいことは？',
  stepQuestionsNote: 'メンバーは質問なしで申し込めます。公開にしたとき、申し込む人は2問以上答えます。',
  doneTitle: '申し込みページができました',
  consent: '作ると、新しい利用規約とプライバシーポリシーに同意したことになります。',
});

// ---------------------------------------------------------------- 時刻（日本時間）

/** ISO の日時を日本時間の部品にする。読めなければ null。 */
export function jstParts(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + JST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), week: WEEK[shifted.getUTCDay()],
  };
}

const dayText = (p) => `${p.month}/${p.day}(${p.week})`;
const clockText = (p) => `${p.hour}:${pad(p.minute)}`;

/** 「11/21(金) 19:00〜22:00」。日をまたぐときは終わりにも日付を付ける。読めないときは ''。 */
export function formatWhen(startsAt, endsAt) {
  const a = jstParts(startsAt);
  if (!a) return '';
  const b = jstParts(endsAt);
  const start = `${dayText(a)} ${clockText(a)}`;
  if (!b) return start;
  if (a.year === b.year && a.month === b.month && a.day === b.day) return `${start}〜${clockText(b)}`;
  return `${start}〜${dayText(b)} ${clockText(b)}`;
}

/** <input type="datetime-local"> の値（'2026-11-21T19:00'）に直す。日本時間で。 */
export function toLocalInput(iso) {
  const p = jstParts(iso);
  return p ? `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}` : '';
}

/** 入力欄の値を、サーバーに送る ISO（日本時間 +09:00）にする。読めなければ ''。 */
export function fromLocalInput(value) {
  const text = String(value || '').trim();
  const found = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!found) return '';
  const iso = `${found[1]}-${found[2]}-${found[3]}T${found[4]}:${found[5]}:00+09:00`;
  return Number.isFinite(Date.parse(iso)) ? iso : '';
}

// ---------------------------------------------------------------- 会を作る

/** 質問の ON/OFF（prompt の配列）→ サーバーに送る [{prompt,label,hint}]（固定の順）。 */
export function questionPayload(enabled) {
  const on = new Set(enabled || []);
  return QUESTION_CHOICES.filter((item) => on.has(item.prompt))
    .map(({ prompt, label, hint }) => ({ prompt, label, hint }));
}

const limitOf = (cfg, key, fallback) => {
  const value = Number(cfg && cfg.limits && cfg.limits[key]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/**
 * 会の中身の入力を検める。{ ok, message, field, event }。
 * raw: { title, place, start, end, visibility, questions: ['now', …] }（start・end は datetime-local の値）
 * opts: { now, cfg, isAdmin, capacity }。サーバー（core/events.py clean_event）と同じ決まり。
 */
export function validateEventDraft(raw, { now = new Date(), cfg = null, isAdmin = false, capacity = null } = {}) {
  const fail = (field, message) => ({ ok: false, field, message });
  const titleMax = limitOf(cfg, 'event_title_max', 40);
  const placeMax = limitOf(cfg, 'event_place_max', 60);
  const answersMin = limitOf(cfg, 'event_answers_min', 2);
  const title = String((raw && raw.title) || '').replace(/\s+/g, ' ').trim();
  if (!title) return fail('title', '会の名前を入力してください。');
  if (Array.from(title).length > titleMax) return fail('title', `会の名前は${titleMax}字以内で入力してください。`);
  const place = String((raw && raw.place) || '').replace(/\s+/g, ' ').trim();
  if (!place) return fail('place', '場所を入力してください。');
  if (Array.from(place).length > placeMax) return fail('place', `場所は${placeMax}字以内で入力してください。`);
  const starts = fromLocalInput(raw && raw.start);
  if (!starts) return fail('start', '開始の日時を入力してください。');
  const ends = fromLocalInput(raw && raw.end);
  if (!ends) return fail('end', '終了の日時を入力してください。');
  if (Date.parse(ends) <= Date.parse(starts)) return fail('end', '終了は開始より後にしてください。');
  if (Date.parse(starts) <= now.getTime()) return fail('start', '開始は今より後の日時にしてください。');
  const visibility = (raw && raw.visibility) === 'public' ? 'public' : 'community';
  if (visibility === 'public' && !isAdmin) return fail('visibility', '公開の会は、コミュニティの管理者だけが作れます。');
  if (capacity !== null && capacity !== undefined && !(Number.isInteger(capacity) && capacity >= 1)) {
    return fail('capacity', '先着人数は、前の画面で1〜999の整数で入れてください。');
  }
  const questions = questionPayload(raw && raw.questions);
  if (visibility === 'public' && questions.length < answersMin) {
    return fail('questions', `公開の会には、質問を${answersMin}つ以上入れてください。`);
  }
  return { ok: true, event: { title, place, starts_at: starts, ends_at: ends, visibility, questions } };
}

/**
 * 会を直すときの入力を検める（サーバーの clean_event の「変更」と同じ）。{ ok, message, field, fields }。
 * raw: { title, place, start, end }。current: GET の event（starts_at・ends_at は ISO）。
 * 「開始は今より後」は、開始を変えたときだけ（場所だけ直せるように）。場所は空でもよい。
 */
export function validateEventEdit(raw, current, { now = new Date(), cfg = null } = {}) {
  const fail = (field, message) => ({ ok: false, field, message });
  const titleMax = limitOf(cfg, 'event_title_max', 40);
  const placeMax = limitOf(cfg, 'event_place_max', 60);
  const title = String((raw && raw.title) || '').replace(/\s+/g, ' ').trim();
  if (!title) return fail('title', '会の名前を入力してください。');
  if (Array.from(title).length > titleMax) return fail('title', `会の名前は${titleMax}字以内で入力してください。`);
  const place = String((raw && raw.place) || '').replace(/\s+/g, ' ').trim();
  if (Array.from(place).length > placeMax) return fail('place', `場所は${placeMax}字以内で入力してください。`);
  const starts = fromLocalInput(raw && raw.start);
  if (!starts) return fail('start', '開始の日時を入力してください。');
  const ends = fromLocalInput(raw && raw.end);
  if (!ends) return fail('end', '終了の日時を入力してください。');
  if (Date.parse(ends) <= Date.parse(starts)) return fail('end', '終了は開始より後にしてください。');
  const startMoved = Date.parse(starts) !== Date.parse(current && current.starts_at);
  if (startMoved && Date.parse(starts) <= now.getTime()) return fail('start', '開始は今より後の日時にしてください。');
  const fields = changedFields(current || {}, { title, place, starts_at: starts, ends_at: ends });
  return { ok: true, fields };
}

/** 会を直すとき：変わった項目だけを PATCH の本文にする。変わりがなければ空のオブジェクト。 */
export function changedFields(current, next) {
  const out = {};
  for (const key of ['title', 'place']) {
    if (String(next[key] ?? '') !== String(current[key] ?? '')) out[key] = next[key];
  }
  for (const key of ['starts_at', 'ends_at']) {
    if (Date.parse(next[key]) !== Date.parse(current[key])) out[key] = next[key];
  }
  return out;
}

/** 会の中止を確かめる文。人数が分かれば、その人たちに知らせると伝える。 */
export function cancelEventConfirm(title, appliedCount = 0) {
  const who = appliedCount > 0
    ? `申し込んでいる${appliedCount}人の申し込みは取り消され、LINE の人には中止が届きます。`
    : 'まだ申し込んでいる人はいません。';
  return {
    title: `「${title}」を中止しますか？`,
    body: `会の投稿が消え、申し込みページも閉じます。${who}元には戻せません。`,
    confirmLabel: '会を中止する',
  };
}

// ---------------------------------------------------------------- 名簿とお断り

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** 画像5 の数の帯：申し込み・来場・遅れる・取り消し・お断り。 */
export function countsView(roster) {
  const counts = (roster && roster.counts) || {};
  const people = (roster && roster.people) || [];
  const late = people.filter((row) => row.status === 'applied' && row.late_minutes).length;
  return [
    { key: 'applied', label: '申し込み', n: num(counts.applied) + num(counts.attended) },
    { key: 'attended', label: '来場', n: num(counts.attended) },
    { key: 'late', label: '遅れる', n: late },
    { key: 'cancelled', label: '取り消し', n: num(counts.cancelled) },
    { key: 'declined', label: 'お断り', n: num(counts.declined) },
  ];
}

/** 名簿の並び：受付待ち → 申し込み中 → 受付済み → 取り消し・お断り。空の組は出さない。 */
export function rosterSections(roster) {
  const people = (roster && roster.people) || [];
  const waiting = (roster && roster.waiting) || [];
  const groups = [
    { key: 'waiting', title: '受付待ち', rows: waiting.map((row) => ({ ...row, status: 'waiting' })) },
    { key: 'applied', title: '申し込み', rows: people.filter((row) => row.status === 'applied') },
    { key: 'attended', title: '受付済み', rows: people.filter((row) => row.status === 'attended') },
    { key: 'closed', title: '取り消し・お断り', rows: people.filter((row) => row.status === 'cancelled' || row.status === 'declined') },
  ];
  return groups.filter((group) => group.rows.length);
}

/** 1人の状態の札。 */
export function statusChip(row) {
  switch (row && row.status) {
    case 'attended': return { text: '受付済み', tone: 'good' };
    case 'cancelled': return { text: '取り消し', tone: 'quiet' };
    case 'declined': return { text: 'お断り', tone: 'quiet' };
    case 'waiting': return { text: '受付待ち', tone: 'warn' };
    default:
      return row && row.late_minutes
        ? { text: `${row.late_minutes}分遅れ`, tone: 'warn' }
        : { text: '申し込み済み', tone: 'plain' };
  }
}

const VIA_TEXT = Object.freeze({ founder: '作った人', invite: '招待', approval: '承認', event: '会から' });

/** 名前の下の小さな札：入り方・きっかけ・前に外された人など。 */
export function rowTags(row) {
  const tags = [];
  if (!row) return tags;
  tags.push({ text: row.joined_via ? (VIA_TEXT[row.joined_via] || 'メンバー') : 'ゲスト', tone: 'plain' });
  if (row.referral) tags.push({ text: row.referral, tone: 'plain' });
  if (row.banned_before) tags.push({ text: '前に外された人', tone: 'warn' });
  return tags;
}

/** 行の「•••」から出せる操作。お断りは、申し込み中の人にだけ（受付済みの人は断れない）。 */
export function rowActions(row) {
  return row && row.status === 'applied' ? ['decline'] : [];
}

/** お断りを確かめる文（D 8章）。本人に届く文はサーバー（core/line.py）と同じ。 */
export function declineConfirm(row) {
  const name = String((row && row.display_name) || '').trim() || 'この人';
  const how = row && row.channel === 'line'
    ? 'LINE で届きます'
    : '申し込みページ（ゲスト用のページ）に表示されます';
  return {
    title: `${name}さんをお断りしますか？`,
    body: `本人には「定員などの都合により、今回はご参加をお受けできないことになりました。またの機会にぜひお越しください」と${how}。受付の QR も使えなくなります。`,
    confirmLabel: 'お断りする',
  };
}

/** LINE の今月の残り通数（取れないときは ''）。 */
export function quotaText(quota) {
  if (!quota || !Number.isFinite(Number(quota.remaining))) return '';
  return `LINE の今月の残り通数：${quota.remaining}／${quota.limit} 通`;
}

// ---------------------------------------------------------------- メンバーの1タップ申し込み

/**
 * 投稿カードの会のボタン。view は GET /api/events/by-post/{post_id} の返り。
 * kind: apply（押せる）／applied（申し込み済み。押すと取り消しを聞く）／attended／declined／waiting／closed／cancelled／host
 */
export function memberAction(view) {
  if (!view || !view.event) return null;
  const event = view.event;
  if (event.cancelled || event.closed === 'cancelled') {
    return { kind: 'cancelled', label: 'この会は中止になりました', disabled: true };
  }
  if (view.is_host) return { kind: 'host', label: '', disabled: false };
  switch (view.me && view.me.status) {
    case 'applied': return { kind: 'applied', label: '✓ 申し込み済み', disabled: false };
    case 'attended': return { kind: 'attended', label: '✓ 受付済み', disabled: true };
    case 'waiting': return { kind: 'waiting', label: '受付を待っています', disabled: true };
    case 'declined': return { kind: 'declined', label: '今回はお受けできません', disabled: true };
    default: break;
  }
  if (event.closed === 'full') return { kind: 'closed', label: '満員', disabled: true };
  if (event.closed === 'deadline') return { kind: 'closed', label: '受付終了', disabled: true };
  return { kind: 'apply', label: '申し込む', disabled: false };
}

/** サーバーは、フルネームが未確認のメンバーの申し込みを断る。その前に #/fullname を出すか。 */
export function needsFullnameFirst(account) {
  if (!account) return false;
  if (account.name_confirmed_at) return false;
  return true;
}

/** 申し込みの確認（画像 4 の B）。 */
export function applyConfirm(event) {
  return {
    title: 'この会に申し込みますか？',
    name: String((event && event.title) || ''),
    when: formatWhen(event && event.starts_at, event && event.ends_at),
    place: event && event.place ? `場所：${event.place}` : '',
    note: '質問はありません。1週間前と当日に LINE でお知らせが届きます。',
    consent: '新しい利用規約とプライバシーポリシーに同意して申し込みます。',
    confirmLabel: '同意して申し込む',
  };
}

/** 申し込みを取り消す確認。 */
export function cancelConfirm(event) {
  return {
    title: '申し込みを取り消しますか？',
    body: `「${(event && event.title) || '会'}」への申し込みを取り消します。主催者に知らせが届きます。また申し込むこともできます。`,
    confirmLabel: '取り消す',
  };
}

/** 申し込みが断られた理由の文。名前が未確認なら画面は #/fullname へ送る。 */
export function applyFailure(error) {
  const message = String((error && error.message) || '');
  if (message.includes('フルネームと所属')) return { kind: 'name', message };
  return { kind: 'error', message: message || 'うまくいきませんでした。もう一度お試しください。' };
}

// ---------------------------------------------------------------- 通知

/** 通知を押したときの行き先。主催者への遅れ・取り消しは名簿、中止は地図。 */
export function noticeTarget(entry) {
  if (!entry) return { kind: 'none' };
  if (entry.type === 'event_cancelled') return { kind: 'map' };
  if ((entry.type === 'event_late' || entry.type === 'event_cancel') && entry.post_id) {
    return { kind: 'host', postId: entry.post_id };
  }
  return { kind: 'none' };
}

/** 会の共有リンク（/e/<code>）。origin は location.origin。 */
export function applyLink(origin, code) {
  return `${String(origin || '').replace(/\/+$/, '')}/e/${encodeURIComponent(code)}`;
}

export function checkinLink(origin, code) {
  return `${String(origin || '').replace(/\/+$/, '')}/c/${encodeURIComponent(code)}`;
}

/** 主催者の画面の道。 */
export const hostHash = (code, { fresh = false } = {}) =>
  `#/e/${encodeURIComponent(code)}/host${fresh ? '?new=1' : ''}`;
