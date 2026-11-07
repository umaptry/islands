// 会（イベント）の主催者とメンバーの画面の「判断」だけをここに置く（画面に触らない。node で試せる）。
// 2026-11-01 第2回a。取り決めは 設計_イベント申し込み/D_関数の取り決め.md（2-3 と 8章）。
// import は無し：tests/frontend がこのファイル単体を読む。
//
//   会を作る   validateEventDraft / questionPayload / QUESTION_CHOICES / stepOfField
//   開催の条件 goState / cancelNote / joinNote / cardLine / decideRange / JOIN_CHOICES（第2回b。最小人数・判定日・キャンセル期限・入り方）
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
  stepGoal: '開催の条件は？',
  stepGoalNote: '空欄のままなら、人数に関係なく開催します。',
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

// ---------------------------------------------------------------- 開催の条件（最小人数・判定日・キャンセル期限・入り方）

/**
 * 会のあと、メンバーでない参加者（コミュニティの外から申し込んだ人）がどうなるか。
 * 2026-11-07：「希望したら、管理者が承認して加入」（approve）を足して初期値に（入ってきてほしくない人が希望しても、管理者が断れる）。
 */
export const JOIN_CHOICES = Object.freeze([
  Object.freeze({ value: 'approve', label: '希望したら、管理者が承認して加入', note: '本人が希望 → 管理者が承認するとメンバーに' }),
  Object.freeze({ value: 'ask', label: '希望したら、そのまま加入', note: '本人が「参加する」を押すとメンバーに' }),
  Object.freeze({ value: 'auto', label: '受付したら自動で加入', note: '受付をすると、そのままメンバーに' }),
  Object.freeze({ value: 'none', label: '加入させない', note: 'この会の参加者どうしだけでつながります' }),
]);
export const JOIN_DEFAULT = 'approve';

export const GO_WORDS = Object.freeze({
  minLabel: '最小開催人数', minNote: '空欄なら、人数に関係なく開催します。',
  decideLabel: '判定日', decideNote: 'この日の終わりに、最小人数に届いていれば開催、届いていなければ中止です。',
  cancelLabel: 'キャンセル期限', cancelNote: '空欄なら、開始まで取り消せます。',
  joinLabel: '会のあと、メンバーでない参加者は？',
  joinHint: 'コミュニティの外から申し込んだ人のことです。',
  locked: '判定のあとは変えられません',
  hostBand: '人数が集まらず中止になりました',
  publicBand: '人数が集まらなかったため、この会は中止になりました。',
  lateCancel: '期限後のキャンセルは主催者に連絡してください',
});

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' を UTC の0時にして返す。実在しない日・読めない値は null。 */
function dateParts(text) {
  const found = DATE_ONLY.exec(String(text || '').trim());
  if (!found) return null;
  const ms = Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3]));
  const back = new Date(ms);
  if (back.getUTCMonth() !== Number(found[2]) - 1 || back.getUTCDate() !== Number(found[3])) return null;
  return { ms, month: Number(found[2]), day: Number(found[3]), week: WEEK[back.getUTCDay()] };
}

/** 日本時間の日付 'YYYY-MM-DD'（ISO でも Date でも）。読めなければ ''。 */
export function jstDate(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + JST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 'YYYY-MM-DD' → '11月10日(火)'。読めなければ ''。 */
export function dateText(text) {
  const p = dateParts(text);
  return p ? `${p.month}月${p.day}日(${p.week})` : '';
}

/** ISO → '11月12日(木) 18:00'（日本時間）。読めなければ ''。 */
export function dateTimeText(iso) {
  const p = jstParts(iso);
  return p ? `${p.month}月${p.day}日(${p.week}) ${p.hour}:${pad(p.minute)}` : '';
}

/** 判定日の入力欄に付ける min（今日）と max（開始日の前の日）。start は datetime-local の値。 */
export function decideRange(start, now = new Date()) {
  const startDay = dateParts(jstDate(fromLocalInput(start)));
  return { min: jstDate(now), max: startDay ? jstDate(new Date(startDay.ms - DAY_MS)) : '' };
}

const phaseOfEvent = (event) => {
  if (event && event.closed === 'not_held') return 'not_held';
  return event && (event.phase === 'held' || event.phase === 'not_held') ? event.phase : 'recruiting';
};

/** 会の GET に、名簿の counts（phase・min・needed・decide_on）の新しい値を重ねる。 */
export function mergeGoal(event, counts = null) {
  const out = { ...(event || {}) };
  if (counts && counts.phase) {
    out.phase = counts.phase;
    if (Number.isInteger(counts.min)) out.min_participants = counts.min;
    if (counts.needed !== null && counts.needed !== undefined && Number.isFinite(Number(counts.needed))) out.needed = Number(counts.needed);
    if (counts.decide_on) out.decide_on = counts.decide_on;
  }
  return out;
}

/**
 * 最小人数がある会の状態の見せ方。最小人数が無い会（古いサーバーも）は null。
 * { phase, label, tone, min, applied, needed, countText, conditionText, band }
 */
export function goState(event, counts = null) {
  const e = mergeGoal(event, counts);
  const min = Number(e.min_participants);
  if (e.min_participants === null || e.min_participants === undefined || !Number.isInteger(min) || min < 2) return null;
  const phase = phaseOfEvent(e);
  const applied = num(e.applied_count);
  const hasNeeded = e.needed !== null && e.needed !== undefined && Number.isFinite(Number(e.needed));
  const needed = hasNeeded ? Math.max(0, Number(e.needed)) : Math.max(0, min - applied);
  const day = dateText(e.decide_on);
  const countText = phase === 'recruiting' ? `現在${applied}人申込／あと${needed}人で開催決定`
    : phase === 'held' ? `現在${applied}人申込／開催決定` : `現在${applied}人申込`;
  const conditionText = phase === 'held' ? `${min}人が集まり、開催が決まりました`
    : day ? `${day}までに${min}人集まれば開催` : `${min}人集まれば開催`;
  return {
    phase, min, applied, needed, countText, conditionText,
    label: { recruiting: '募集中', held: '開催決定', not_held: '中止' }[phase],
    tone: { recruiting: 'plain', held: 'good', not_held: 'bad' }[phase],
    band: phase === 'not_held' ? GO_WORDS.hostBand : '',
  };
}

/** 地図の会のカードの一行。最小人数が無い会は ''。 */
export function cardLine(event) {
  const state = goState(event);
  if (!state) return '';
  if (state.phase === 'held') return '開催決定';
  if (state.phase === 'not_held') return '中止';
  return `あと${state.needed}人で開催決定`;
}

/** キャンセル期限の一行。期限が無ければ ''。過ぎていれば「期限後は主催者に連絡」。 */
export function cancelNote(event, now = Date.now()) {
  if (!event || !event.cancel_deadline) return '';
  const deadline = Date.parse(event.cancel_deadline);
  if (!Number.isFinite(deadline)) return '';
  const open = typeof event.cancel_open === 'boolean' ? event.cancel_open : now <= deadline;
  return open ? `キャンセルは${dateTimeText(event.cancel_deadline)}まで` : GO_WORDS.lateCancel;
}

/** 申し込みページの、会のあとの入り方の一言。自動で加入は今までどおり何も出さない。 */
export function joinNote(policy) {
  if (policy === 'approve') return '会のあと、希望するとコミュニティへの参加を申し込めます（管理者が承認します）';
  if (policy === 'ask') return '会のあと、コミュニティに参加するかを選べます';
  if (policy === 'none') return 'この会の参加者どうしだけでつながります';
  return '';
}

/** 会を作る画面の項目が、何ステップ目にあるか（エラーのときにそこへ戻す）。 */
export function stepOfField(field) {
  if (['min', 'decide', 'cancel', 'join'].includes(field)) return 2;
  if (field === 'questions') return 3;
  return 1;
}

/**
 * 開催の条件の入力を検める。{ ok, field, message, fields }。
 * raw: { min, decide, cancel, join }（文字列。decide は日付、cancel は datetime-local）。
 * fields は送る項目：最小人数が空なら min_participants・decide_on は null（消す）、cancel_deadline も空なら null。
 * locked（判定のあと）のときは最小人数と判定日を見ず、fields にも入れない。
 */
function checkGoals(raw, { startIso, now, capacity, isNew, locked = false }) {
  const fail = (field, message) => ({ ok: false, field, message });
  const fields = {};
  const minText = String((raw && raw.min) ?? '').trim();
  if (!locked) {
    if (minText) {
      const min = /^\d+$/.test(minText) ? Number(minText) : NaN;
      if (!Number.isInteger(min) || min < 2) return fail('min', '最小開催人数は2人以上の整数で入力してください。');
      if (capacity && min > capacity) return fail('min', `最小開催人数は先着人数（${capacity}人）以下にしてください。`);
      const decide = String((raw && raw.decide) || '').trim();
      if (!decide) return fail('decide', '判定日を入力してください。');
      if (!dateParts(decide)) return fail('decide', '判定日は日付で入力してください。');
      if (isNew && decide < jstDate(now)) return fail('decide', '判定日は今日以降にしてください。');
      const startDay = jstDate(startIso);
      if (startDay && decide >= startDay) return fail('decide', '判定日は会の開始日より前の日にしてください。');
      fields.min_participants = min;
      fields.decide_on = decide;
    } else {
      fields.min_participants = null;
      fields.decide_on = null;
    }
  }
  const cancelText = String((raw && raw.cancel) || '').trim();
  if (cancelText) {
    const iso = fromLocalInput(cancelText);
    if (!iso) return fail('cancel', 'キャンセル期限は日時で入力してください。');
    if (startIso && Date.parse(iso) >= Date.parse(startIso)) return fail('cancel', 'キャンセル期限は会の開始より前にしてください。');
    if (isNew && Date.parse(iso) <= now.getTime()) return fail('cancel', 'キャンセル期限は今より後の日時にしてください。');
    fields.cancel_deadline = iso;
  } else {
    fields.cancel_deadline = null;
  }
  const join = String((raw && raw.join) || '');
  fields.join_policy = JOIN_CHOICES.some((item) => item.value === join) ? join : JOIN_DEFAULT;
  return { ok: true, fields };
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
 * raw: { title, place, start, end, visibility, questions: ['now', …], min, decide, cancel, join }
 *   （start・end・cancel は datetime-local の値、decide は日付。min 以降は開催の条件で、無くてもよい）
 * opts: { now, cfg, isAdmin, capacity }。サーバー（core/events.py clean_event）と同じ決まり。
 */
export function validateEventDraft(raw, { now = new Date(), cfg = null, isAdmin = false, capacity = null } = {}) {
  const fail = (field, message) => ({ ok: false, field, message });
  const titleMax = limitOf(cfg, 'event_title_max', 40);
  const placeMax = limitOf(cfg, 'event_place_max', 60);
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
  const goals = checkGoals(raw, { startIso: starts, now, capacity, isNew: true });
  if (!goals.ok) return goals;
  // 2026-11-07：質問は 0〜3 個。公開の会も 0 個でよい（申し込む人は答えずに申し込む）
  const questions = questionPayload(raw && raw.questions);
  // 空欄の項目（null）は送らない：サーバーは「送られた項目だけ」を決めに使う
  const settings = Object.fromEntries(Object.entries(goals.fields).filter(([, value]) => value !== null));
  return { ok: true, event: { title, place, starts_at: starts, ends_at: ends, visibility, questions, ...settings } };
}

/**
 * 会を直すときの入力を検める（サーバーの clean_event の「変更」と同じ）。{ ok, message, field, fields }。
 * raw: { title, place, start, end, min?, decide?, cancel?, join? }。current: GET の event（starts_at・ends_at は ISO）。
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
  const next = { title, place, starts_at: starts, ends_at: ends };
  // 開催の条件：画面が渡したときだけ（判定のあとは最小人数と判定日を見ない）
  if (raw && ['min', 'decide', 'cancel', 'join'].some((key) => key in raw)) {
    const goals = checkGoals(raw, { startIso: starts, now, capacity: current && current.capacity, isNew: false, locked: goalLocked(current) });
    if (!goals.ok) return goals;
    Object.assign(next, goals.fields);
  }
  const fields = changedFields(current || {}, next);
  return { ok: true, fields };
}

/** 判定が出たあと（開催決定・中止）は、最小人数と判定日を変えられない。 */
export function goalLocked(event) {
  return Boolean(event) && (event.phase === 'held' || event.phase === 'not_held' || event.closed === 'not_held');
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
  // 開催の条件：最小人数と判定日は組で送る（null で消す）
  if ('min_participants' in next) {
    const minNow = current.min_participants ?? null;
    const dayNow = current.decide_on ?? null;
    if ((next.min_participants ?? null) !== minNow || (next.decide_on ?? null) !== dayNow) {
      out.min_participants = next.min_participants ?? null;
      out.decide_on = next.decide_on ?? null;
    }
  }
  if ('cancel_deadline' in next) {
    const before = current.cancel_deadline ? Date.parse(current.cancel_deadline) : null;
    const after = next.cancel_deadline ? Date.parse(next.cancel_deadline) : null;
    if (before !== after) out.cancel_deadline = next.cancel_deadline ?? null;
  }
  if ('join_policy' in next && next.join_policy !== (current.join_policy || 'auto')) out.join_policy = next.join_policy;
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
  return groups.filter((group) => group.rows.length)
    .map((group) => ({ ...group, label: group.key === 'waiting' ? `受付待ち ${group.rows.length}人` : `${group.title}（${group.rows.length}）` }));
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
  tags.push({ text: row.joined_via ? (VIA_TEXT[row.joined_via] || 'メンバー') : (row.is_member ? 'メンバー' : 'ゲスト'), tone: 'plain' });
  if (row.status === 'attended' && row.is_member) tags.push({ text: 'メンバーになった', tone: 'good' });
  if (row.referral) tags.push({ text: row.referral, tone: 'plain' });
  if (row.banned_before) tags.push({ text: '前に外された人', tone: 'warn' });
  return tags;
}

/**
 * 行から出せる操作。申し込み中の人は「受付する」（受付時間に関係なく）とお断り（受付済みの人は断れない）。
 * 受付待ちの人は「受付する」と「却下」。
 */
export function rowActions(row) {
  if (!row) return [];
  if (row.status === 'applied') return ['checkin', 'decline'];
  if (row.status === 'waiting') return ['checkin', 'reject'];
  return [];
}

/** 受付待ちの人を却下する確認。却下が3回たまると、その人は飛び入りの受付ができなくなる。 */
export function rejectConfirm(row) {
  const name = String((row && row.display_name) || '').trim() || 'この人';
  return {
    title: `${name}さんを却下しますか？`,
    body: '本人には「受付できませんでした。主催者に声をかけてください」と出ます。',
    confirmLabel: '却下する',
  };
}

/** 受付したあとの一言。joined はコミュニティのメンバーになったか。 */
export function checkinToast(row, result) {
  const name = String((row && row.display_name) || '').trim() || 'その人';
  return result && result.joined ? `${name}さんを受付しました。コミュニティのメンバーになりました。` : `${name}さんを受付しました。`;
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
  if (event.closed === 'not_held' || event.phase === 'not_held') {
    return { kind: 'cancelled', label: '人数が集まらず中止になりました', disabled: true };
  }
  switch (view.me && view.me.status) {
    case 'applied':
      // 期限後は取り消せない（キーが無い古いサーバーは今までどおり押せる）
      return { kind: 'applied', label: '✓ 申し込み済み', disabled: view.me.can_cancel === false };
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
