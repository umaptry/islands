import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/event-host-rules.js', import.meta.url), 'utf8');
const rules = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const notifySource = await readFile(new URL('../../web/js/notify-rules.js', import.meta.url), 'utf8');
const notify = await import(`data:text/javascript;base64,${Buffer.from(notifySource).toString('base64')}`);

const NOW = new Date('2026-11-01T00:00:00+09:00');
const draft = (extra = {}) => ({
  title: 'The Night Office BAR #2', place: '渋谷 ○○ビル 3F', start: '2026-11-13T19:00', end: '2026-11-13T22:00',
  visibility: 'community', questions: ['now', 'past', 'future'], ...extra,
});

// ---------------------------------------------------------------- 時刻

test('日時は日本時間で数える（端末の時刻帯に左右されない）', () => {
  assert.equal(rules.fromLocalInput('2026-11-13T19:00'), '2026-11-13T19:00:00+09:00');
  assert.equal(rules.fromLocalInput('2026-11-13 19:00'), '');
  assert.equal(rules.fromLocalInput(''), '');
  assert.equal(rules.toLocalInput('2026-11-13T10:00:00+00:00'), '2026-11-13T19:00');
  assert.equal(rules.toLocalInput('なにか'), '');
});

test('formatWhen：同じ日は「19:00〜22:00」、日をまたぐと終わりにも日付', () => {
  assert.equal(rules.formatWhen('2026-11-13T10:00:00+00:00', '2026-11-13T13:00:00+00:00'), '11/13(金) 19:00〜22:00');
  assert.equal(rules.formatWhen('2026-11-13T10:00:00+00:00', '2026-11-13T17:30:00+00:00'), '11/13(金) 19:00〜11/14(土) 2:30');
  assert.equal(rules.formatWhen('', ''), '');
});

// ---------------------------------------------------------------- 会を作る

test('質問は固定の3つ（今・過去・これから）で、4問目は無い', () => {
  assert.deepEqual(rules.QUESTION_CHOICES.map((item) => item.prompt), ['now', 'past', 'future']);
  assert.equal(rules.questionPayload(['future', 'now']).length, 2);
  assert.deepEqual(rules.questionPayload(['future', 'now']).map((q) => q.prompt), ['now', 'future']);
  assert.deepEqual(rules.questionPayload(['talk', 'help']), []);
});

test('会の入力：ふつうは通り、日時・名前・場所・公開の決まりで断る', () => {
  const ok = rules.validateEventDraft(draft(), { now: NOW, isAdmin: false, capacity: 20 });
  assert.equal(ok.ok, true);
  assert.equal(ok.event.starts_at, '2026-11-13T19:00:00+09:00');
  assert.equal(ok.event.visibility, 'community');
  assert.equal(ok.event.questions.length, 3);
  const bad = (extra, opts = {}) => rules.validateEventDraft(draft(extra), { now: NOW, isAdmin: false, capacity: 20, ...opts });
  assert.equal(bad({ title: '  ' }).field, 'title');
  assert.equal(bad({ title: 'あ'.repeat(41) }).field, 'title');
  assert.equal(bad({ place: '' }).field, 'place');
  assert.equal(bad({ start: '' }).field, 'start');
  assert.equal(bad({ end: '2026-11-13T18:00' }).message, '終了は開始より後にしてください。');
  assert.equal(bad({ start: '2026-10-31T19:00', end: '2026-10-31T22:00' }).message, '開始は今より後の日時にしてください。');
  assert.equal(bad({ visibility: 'public' }).message, '公開の会は、コミュニティの管理者だけが作れます。');
  assert.equal(bad({ visibility: 'public' }, { isAdmin: true }).ok, true);
  assert.equal(bad({}, { capacity: 0 }).field, 'capacity');
});

test('公開の会は質問が2つ以上要る。コミュニティの中だけなら0でもよい', () => {
  const pub = (questions) => rules.validateEventDraft(draft({ visibility: 'public', questions }), { now: NOW, isAdmin: true, capacity: 5 });
  assert.equal(pub(['now']).ok, false);
  assert.equal(pub(['now']).field, 'questions');
  assert.equal(pub(['now', 'future']).ok, true);
  assert.equal(rules.validateEventDraft(draft({ questions: [] }), { now: NOW, capacity: 5 }).ok, true);
});

test('会を直す：開始を変えたときだけ「今より後」。場所だけなら過去の会でも直せる', () => {
  const current = { title: 'BAR', place: 'A', starts_at: '2026-10-20T19:00:00+09:00', ends_at: '2026-10-20T22:00:00+09:00' };
  const raw = { title: 'BAR', place: 'B', start: '2026-10-20T19:00', end: '2026-10-20T22:00' };
  const placeOnly = rules.validateEventEdit(raw, current, { now: NOW });
  assert.equal(placeOnly.ok, true);
  assert.deepEqual(placeOnly.fields, { place: 'B' });
  const moved = rules.validateEventEdit({ ...raw, start: '2026-10-21T19:00', end: '2026-10-21T22:00' }, current, { now: NOW });
  assert.equal(moved.ok, false);
  const later = rules.validateEventEdit({ ...raw, start: '2026-11-20T19:00', end: '2026-11-20T22:00' }, current, { now: NOW });
  assert.deepEqual(Object.keys(later.fields).sort(), ['ends_at', 'place', 'starts_at']);
  assert.deepEqual(rules.validateEventEdit({ ...raw, place: 'A' }, current, { now: NOW }).fields, {});
  assert.equal(rules.validateEventEdit({ ...raw, place: 'あ'.repeat(61) }, current, { now: NOW }).field, 'place');
});

test('中止の確認は、申し込んでいる人数に合わせて言う', () => {
  assert.match(rules.cancelEventConfirm('BAR', 3).body, /3人/);
  assert.match(rules.cancelEventConfirm('BAR', 0).body, /いません/);
  assert.equal(rules.cancelEventConfirm('BAR', 3).confirmLabel, '会を中止する');
});

// ---------------------------------------------------------------- 名簿とお断り

const roster = {
  counts: { applied: 2, attended: 1, waiting: 1, cancelled: 1, declined: 1, capacity: 20 },
  line_quota: { remaining: 148, limit: 200 },
  waiting: [{ account_id: 'w', display_name: '鈴木 一郎', affiliation: '△△', rejects: 0 }],
  people: [
    { account_id: 'a', display_name: '山田 花子', status: 'applied', late_minutes: null, joined_via: null, referral: '友だちに聞いた', channel: 'line' },
    { account_id: 'b', display_name: '佐藤 健', status: 'applied', late_minutes: 30, joined_via: 'invite', banned_before: true, channel: 'email' },
    { account_id: 'c', display_name: '森 彩', status: 'attended', joined_via: 'event' },
    { account_id: 'd', display_name: '高橋', status: 'cancelled' },
    { account_id: 'e', display_name: '中村', status: 'declined' },
  ],
};

test('数の帯：申し込み・来場・遅れる・キャンセル・お断り', () => {
  const view = rules.countsView(roster);
  assert.deepEqual(view.map((item) => [item.key, item.n]),
    [['applied', 3], ['attended', 1], ['late', 1], ['cancelled', 1], ['declined', 1]]);
  assert.deepEqual(rules.countsView(null).map((item) => item.n), [0, 0, 0, 0, 0]);
});

test('名簿の並び：受付待ち → 申し込み → 受付済み → 取り消し・お断り。空の組は出さない', () => {
  assert.deepEqual(rules.rosterSections(roster).map((group) => [group.key, group.rows.length]),
    [['waiting', 1], ['applied', 2], ['attended', 1], ['closed', 2]]);
  assert.deepEqual(rules.rosterSections({ people: [{ status: 'applied' }] }).map((group) => group.key), ['applied']);
  assert.deepEqual(rules.rosterSections(null), []);
});

test('札：状態・遅れ・入り方・きっかけ・前に外された人', () => {
  assert.deepEqual(rules.statusChip({ status: 'applied' }), { text: '申し込み済み', tone: 'plain' });
  assert.equal(rules.statusChip({ status: 'applied', late_minutes: 30 }).text, '30分遅れ');
  assert.equal(rules.statusChip({ status: 'attended' }).text, '受付済み');
  assert.equal(rules.statusChip({ status: 'declined' }).text, 'お断り');
  const tags = rules.rowTags(roster.people[1]).map((tag) => tag.text);
  assert.deepEqual(tags, ['招待', '前に外された人']);
  assert.deepEqual(rules.rowTags(roster.people[0]).map((tag) => tag.text), ['ゲスト', '友だちに聞いた']);
  assert.equal(rules.rowTags(roster.people[2])[0].text, '会から');
});

test('行の操作：申し込み中は受付・お断り、受付待ちは受付・却下、そのほかは無し', () => {
  assert.deepEqual(rules.rowActions({ status: 'applied' }), ['checkin', 'decline']);
  assert.deepEqual(rules.rowActions({ status: 'waiting' }), ['checkin', 'reject']);
  for (const status of ['attended', 'cancelled', 'declined']) assert.deepEqual(rules.rowActions({ status }), []);
  assert.deepEqual(rules.rowActions(null), []);
});

test('受付待ちの組の名前は「受付待ち N人」、ほかは「名前（N）」', () => {
  const labels = rules.rosterSections(roster).map((group) => group.label);
  assert.deepEqual(labels, ['受付待ち 1人', '申し込み（2）', '受付済み（1）', '取り消し・お断り（2）']);
});

test('受付済みでメンバーになった人には「メンバーになった」札', () => {
  const tags = rules.rowTags({ status: 'attended', joined_via: 'event', is_member: true }).map((tag) => tag.text);
  assert.deepEqual(tags, ['会から', 'メンバーになった']);
  assert.deepEqual(rules.rowTags({ status: 'attended', is_member: false }).map((tag) => tag.text), ['ゲスト']);
  assert.deepEqual(rules.rowTags({ status: 'applied', is_member: true }).map((tag) => tag.text), ['メンバー']);
});

test('却下の確認と、受付したあとの一言', () => {
  assert.equal(rules.rejectConfirm({ display_name: '鈴木 一郎' }).title, '鈴木 一郎さんを却下しますか？');
  assert.equal(rules.rejectConfirm(null).confirmLabel, '却下する');
  assert.equal(rules.checkinToast({ display_name: '鈴木' }, { joined: false }), '鈴木さんを受付しました。');
  assert.match(rules.checkinToast({ display_name: '鈴木' }, { joined: true }), /メンバーになりました/);
});

test('お断りの確認：名前と、本人に届く文（D の8章）', () => {
  const line = rules.declineConfirm({ display_name: '山田 瑞希', channel: 'line' });
  assert.equal(line.title, '山田 瑞希さんをお断りしますか？');
  assert.match(line.body, /定員などの都合により、今回はご参加をお受けできないことになりました/);
  assert.match(line.body, /LINE で届きます/);
  assert.match(line.body, /QR も使えなくなります/);
  assert.match(rules.declineConfirm({ display_name: '誰か', channel: 'email' }).body, /ゲスト用のページ/);
  assert.equal(line.confirmLabel, 'お断りする');
});

test('LINE の残り通数の文', () => {
  assert.equal(rules.quotaText({ remaining: 148, limit: 200 }), 'LINE の今月の残り通数：148／200 通');
  assert.equal(rules.quotaText(null), '');
});

// ---------------------------------------------------------------- メンバーの1タップ申し込み

const view = (patch = {}, me = {}) => ({
  event: { code: 'c1', title: 'BAR', starts_at: '2026-11-13T10:00:00+00:00', ends_at: '2026-11-13T13:00:00+00:00', closed: null, cancelled: false, ...patch },
  me: { status: 'none', ...me }, is_host: false,
});

test('カードのボタン：申し込む／申し込み済み／満員／受付終了／中止', () => {
  assert.equal(rules.memberAction(null), null);
  assert.deepEqual(rules.memberAction(view()), { kind: 'apply', label: '申し込む', disabled: false });
  assert.equal(rules.memberAction(view({}, { status: 'cancelled' })).kind, 'apply');
  const applied = rules.memberAction(view({}, { status: 'applied' }));
  assert.equal(applied.label, '✓ 申し込み済み');
  assert.equal(applied.disabled, false);
  assert.equal(rules.memberAction(view({}, { status: 'attended' })).disabled, true);
  assert.equal(rules.memberAction(view({}, { status: 'declined' })).kind, 'declined');
  assert.equal(rules.memberAction(view({ closed: 'full' })).label, '満員');
  assert.equal(rules.memberAction(view({ closed: 'deadline' })).label, '受付終了');
  const cancelled = rules.memberAction(view({ cancelled: true, closed: 'cancelled' }, { status: 'applied' }));
  assert.deepEqual(cancelled, { kind: 'cancelled', label: 'この会は中止になりました', disabled: true });
  assert.equal(rules.memberAction({ ...view(), is_host: true }).kind, 'host');
});

test('名前が未確認のメンバーは、先に #/fullname', () => {
  assert.equal(rules.needsFullnameFirst({ display_name: 'み', name_confirmed_at: null }), true);
  assert.equal(rules.needsFullnameFirst({ display_name: 'み', name_confirmed_at: '2026-11-02T00:00:00Z' }), false);
  assert.equal(rules.needsFullnameFirst(null), false);
  assert.equal(rules.applyFailure({ message: 'フルネームと所属を入力してください。' }).kind, 'name');
  assert.equal(rules.applyFailure({ message: '先着人数に達しています。' }).kind, 'error');
  assert.match(rules.applyFailure({}).message, /もう一度/);
});

test('申し込みの確認：質問なし・同意の文・ボタンの文', () => {
  const text = rules.applyConfirm(view().event);
  assert.equal(text.title, 'この会に申し込みますか？');
  assert.equal(text.name, 'BAR');
  assert.equal(text.when, '11/13(金) 19:00〜22:00');
  assert.match(text.note, /質問はありません/);
  assert.equal(text.confirmLabel, '同意して申し込む');
  assert.equal(rules.TERMS_NEXT, '/terms/next');
  assert.equal(rules.PRIVACY_NEXT, '/privacy/next');
});

// ---------------------------------------------------------------- 通知・道

test('通知の行き先：遅れる・取り消しは名簿、中止は地図', () => {
  assert.deepEqual(rules.noticeTarget({ type: 'event_late', post_id: 'p1' }), { kind: 'host', postId: 'p1' });
  assert.deepEqual(rules.noticeTarget({ type: 'event_cancel', post_id: 'p1' }), { kind: 'host', postId: 'p1' });
  assert.deepEqual(rules.noticeTarget({ type: 'event_cancelled', post_id: 'p1' }), { kind: 'map' });
  assert.deepEqual(rules.noticeTarget({ type: 'like' }), { kind: 'none' });
});

test('通知の文：遅れる分・中止の会の名前が入る', () => {
  assert.equal(notify.bodyText({ type: 'event_late', payload: { minutes: 30 } }), '30分ほど遅れます');
  assert.equal(notify.bodyText({ type: 'event_late', payload: { minutes: 60 } }), '1時間以上遅れます');
  assert.equal(notify.bodyText({ type: 'event_cancel', payload: {} }), '会の申し込みを取り消しました');
  assert.equal(notify.bodyText({ type: 'event_cancelled', payload: { title: 'BAR #2' } }), '「BAR #2」は中止になりました');
  assert.equal(notify.bodyText({ type: 'event_cancelled', payload: {} }), '「会」は中止になりました');
});

test('リンクと道', () => {
  assert.equal(rules.applyLink('https://islands.app/', 'abc'), 'https://islands.app/e/abc');
  assert.equal(rules.checkinLink('https://islands.app', 'xyz'), 'https://islands.app/c/xyz');
  assert.equal(rules.hostHash('abc'), '#/e/abc/host');
  assert.equal(rules.hostHash('abc', { fresh: true }), '#/e/abc/host?new=1');
});

// ---------------------------------------------------------------- 開催の条件（第2回b）

const goal = (extra = {}) => draft({ min: '5', decide: '2026-11-10', cancel: '2026-11-12T18:00', join: 'ask', ...extra });
const goalCheck = (extra = {}, opts = {}) => rules.validateEventDraft(goal(extra), { now: NOW, isAdmin: false, capacity: 20, ...opts });

test('条件を入れない会は今までどおり。入り方だけ「本人に確認」で送る', () => {
  const ok = rules.validateEventDraft(draft(), { now: NOW, capacity: 20 });
  assert.equal(ok.ok, true);
  assert.equal(ok.event.join_policy, 'ask');
  for (const key of ['min_participants', 'decide_on', 'cancel_deadline']) assert.equal(key in ok.event, false);
  assert.equal(rules.JOIN_DEFAULT, 'ask');
  assert.deepEqual(rules.JOIN_CHOICES.map((item) => item.value).sort(), ['ask', 'auto', 'none']);
});

test('最小人数・判定日・キャンセル期限・入り方が通ると、サーバーに送る形になる', () => {
  const ok = goalCheck({ join: 'none' });
  assert.equal(ok.ok, true);
  assert.equal(ok.event.min_participants, 5);
  assert.equal(ok.event.decide_on, '2026-11-10');
  assert.equal(ok.event.cancel_deadline, '2026-11-12T18:00:00+09:00');
  assert.equal(ok.event.join_policy, 'none');
  assert.equal(goalCheck({ join: 'なにか' }).event.join_policy, 'ask');
});

test('最小人数は2以上の整数・先着人数以下。空欄なら判定日は見ない', () => {
  assert.equal(goalCheck({ min: '1' }).field, 'min');
  assert.equal(goalCheck({ min: '2.5' }).field, 'min');
  assert.equal(goalCheck({ min: 'あ' }).field, 'min');
  assert.equal(goalCheck({ min: '21' }).message, '最小開催人数は先着人数（20人）以下にしてください。');
  assert.equal(goalCheck({ min: '20' }).ok, true);
  assert.equal(goalCheck({ min: '2' }).ok, true);
  const empty = goalCheck({ min: '', decide: 'ごみ' });
  assert.equal(empty.ok, true);
  assert.equal('decide_on' in empty.event, false);
});

test('判定日：最小人数があれば必須。今日以降で、会の開始日より前の日だけ', () => {
  assert.equal(goalCheck({ decide: '' }).message, '判定日を入力してください。');
  assert.equal(goalCheck({ decide: '2026-13-40' }).field, 'decide');
  assert.equal(goalCheck({ decide: '2026-10-31' }).message, '判定日は今日以降にしてください。');
  assert.equal(goalCheck({ decide: '2026-11-01' }).ok, true);
  assert.equal(goalCheck({ decide: '2026-11-12' }).ok, true);
  assert.equal(goalCheck({ decide: '2026-11-13' }).message, '判定日は会の開始日より前の日にしてください。');
  assert.equal(goalCheck({ decide: '2026-11-14' }).field, 'decide');
});

test('キャンセル期限：開始より前・今より後。空欄は期限なし', () => {
  assert.equal(goalCheck({ cancel: '2026-11-13T19:00' }).field, 'cancel');
  assert.equal(goalCheck({ cancel: '2026-11-14T10:00' }).field, 'cancel');
  assert.equal(goalCheck({ cancel: '2026-10-31T10:00' }).message, 'キャンセル期限は今より後の日時にしてください。');
  assert.equal(goalCheck({ cancel: '2026-11-13T18:59' }).ok, true);
  const none = goalCheck({ cancel: '' });
  assert.equal(none.ok, true);
  assert.equal('cancel_deadline' in none.event, false);
});

test('作る画面のステップ：項目がどのステップにあるか', () => {
  assert.equal(rules.stepOfField('title'), 1);
  assert.equal(rules.stepOfField('capacity'), 1);
  for (const field of ['min', 'decide', 'cancel', 'join']) assert.equal(rules.stepOfField(field), 2);
  assert.equal(rules.stepOfField('questions'), 3);
});

test('判定日の入力欄の範囲：今日から開始日の前の日まで（日本時間）', () => {
  assert.deepEqual(rules.decideRange('2026-11-13T19:00', NOW), { min: '2026-11-01', max: '2026-11-12' });
  assert.deepEqual(rules.decideRange('2026-12-01T00:30', NOW), { min: '2026-11-01', max: '2026-11-30' });
  assert.deepEqual(rules.decideRange('', NOW), { min: '2026-11-01', max: '' });
  assert.equal(rules.jstDate('2026-10-31T16:00:00Z'), '2026-11-01');
});

test('日付の文：「11月10日(火)」「11月12日(木) 18:00」', () => {
  assert.equal(rules.dateText('2026-11-10'), '11月10日(火)');
  assert.equal(rules.dateText('2026-02-30'), '');
  assert.equal(rules.dateTimeText('2026-11-12T18:00:00+09:00'), '11月12日(木) 18:00');
  assert.equal(rules.dateTimeText(''), '');
});

const goalEvent = (extra = {}) => ({
  min_participants: 5, decide_on: '2026-11-10', phase: 'recruiting', needed: 2, applied_count: 3,
  cancel_deadline: '2026-11-12T18:00:00+09:00', cancel_open: true, join_policy: 'ask', ...extra,
});

test('状態の見せ方：募集中・開催決定・中止', () => {
  const open = rules.goState(goalEvent());
  assert.equal(open.label, '募集中');
  assert.equal(open.countText, '現在3人申込／あと2人で開催決定');
  assert.equal(open.conditionText, '11月10日(火)までに5人集まれば開催');
  assert.equal(open.band, '');
  const held = rules.goState(goalEvent({ phase: 'held', needed: 0, applied_count: 5 }));
  assert.equal(held.label, '開催決定');
  assert.equal(held.tone, 'good');
  assert.equal(held.countText, '現在5人申込／開催決定');
  const off = rules.goState(goalEvent({ phase: 'not_held', needed: 0 }));
  assert.equal(off.label, '中止');
  assert.equal(off.band, '人数が集まらず中止になりました');
  assert.equal(rules.goState(goalEvent({ phase: null, closed: 'not_held' })).phase, 'not_held');
});

test('状態：最小人数が無い会・古いサーバー（キーなし）は出さない。needed が無ければ計算する', () => {
  assert.equal(rules.goState({ applied_count: 3 }), null);
  assert.equal(rules.goState(goalEvent({ min_participants: null, phase: null })), null);
  assert.equal(rules.goState(null), null);
  assert.equal(rules.goState(goalEvent({ needed: undefined })).needed, 2);
  assert.equal(rules.goState(goalEvent({ needed: undefined, applied_count: 9 })).needed, 0);
});

test('名簿の counts の新しい値が、会の GET より優先される', () => {
  const state = rules.goState(goalEvent(), { phase: 'held', min: 5, needed: 0, decide_on: '2026-11-10' });
  assert.equal(state.phase, 'held');
  assert.equal(state.needed, 0);
  assert.equal(rules.goState(goalEvent(), { applied: 1 }).phase, 'recruiting');
});

test('地図の会のカードの一行', () => {
  assert.equal(rules.cardLine(goalEvent()), 'あと2人で開催決定');
  assert.equal(rules.cardLine(goalEvent({ phase: 'held' })), '開催決定');
  assert.equal(rules.cardLine(goalEvent({ phase: 'not_held' })), '中止');
  assert.equal(rules.cardLine({ applied_count: 4 }), '');
});

test('キャンセル期限の文：期限内は「◯まで」、過ぎたら主催者に連絡。期限なしは出さない', () => {
  assert.equal(rules.cancelNote(goalEvent()), 'キャンセルは11月12日(木) 18:00まで');
  assert.equal(rules.cancelNote(goalEvent({ cancel_open: false })), '期限後のキャンセルは主催者に連絡してください');
  const now = Date.parse('2026-11-13T00:00:00+09:00');
  assert.equal(rules.cancelNote(goalEvent({ cancel_open: undefined }), now), '期限後のキャンセルは主催者に連絡してください');
  assert.equal(rules.cancelNote({ cancel_deadline: null }), '');
});

test('入り方の一言：自動で加入は何も出さない', () => {
  assert.equal(rules.joinNote('ask'), '会のあと、コミュニティに参加するかを選べます');
  assert.equal(rules.joinNote('none'), 'この会の参加者どうしだけでつながります');
  assert.equal(rules.joinNote('auto'), '');
  assert.equal(rules.joinNote(undefined), '');
});

test('会を直す（開催の条件）：変えた所だけ。最小人数と判定日は組で、空にすると null', () => {
  const current = {
    title: 'BAR', place: 'A', starts_at: '2026-11-13T19:00:00+09:00', ends_at: '2026-11-13T22:00:00+09:00', capacity: 20,
    min_participants: 5, decide_on: '2026-11-10', cancel_deadline: '2026-11-12T18:00:00+09:00', join_policy: 'ask', phase: 'recruiting',
  };
  const raw = {
    title: 'BAR', place: 'A', start: '2026-11-13T19:00', end: '2026-11-13T22:00',
    min: '5', decide: '2026-11-10', cancel: '2026-11-12T18:00', join: 'ask',
  };
  const edit = (patch, cur = current) => rules.validateEventEdit({ ...raw, ...patch }, cur, { now: NOW });
  assert.deepEqual(edit({}).fields, {});
  assert.deepEqual(edit({ min: '8' }).fields, { min_participants: 8, decide_on: '2026-11-10' });
  assert.deepEqual(edit({ decide: '2026-11-09' }).fields, { min_participants: 5, decide_on: '2026-11-09' });
  assert.deepEqual(edit({ min: '' }).fields, { min_participants: null, decide_on: null });
  assert.deepEqual(edit({ cancel: '' }).fields, { cancel_deadline: null });
  assert.deepEqual(edit({ cancel: '2026-11-12T20:00' }).fields, { cancel_deadline: '2026-11-12T20:00:00+09:00' });
  assert.deepEqual(edit({ join: 'auto' }).fields, { join_policy: 'auto' });
  assert.equal(edit({ min: '21' }).field, 'min');
  assert.equal(edit({ decide: '2026-11-13' }).field, 'decide');
  assert.equal(edit({ cancel: '2026-11-13T19:00' }).field, 'cancel');
  // 条件を持たない会に足す
  const plain = { ...current, min_participants: null, decide_on: null, cancel_deadline: null, join_policy: 'auto' };
  assert.deepEqual(edit({ min: '3', decide: '2026-11-05', cancel: '', join: 'auto' }, plain).fields, { min_participants: 3, decide_on: '2026-11-05' });
  assert.equal(edit({ min: '3', decide: '' }, plain).message, '判定日を入力してください。');
});

test('判定のあと（開催決定・中止）は、最小人数と判定日を送らない。キャンセル期限と入り方は変えられる', () => {
  const held = {
    title: 'BAR', place: 'A', starts_at: '2026-11-13T19:00:00+09:00', ends_at: '2026-11-13T22:00:00+09:00', capacity: 20,
    min_participants: 5, decide_on: '2026-11-10', cancel_deadline: null, join_policy: 'ask', phase: 'held',
  };
  const raw = {
    title: 'BAR', place: 'A', start: '2026-11-13T19:00', end: '2026-11-13T22:00', min: '9', decide: '2026-11-01', cancel: '2026-11-12T18:00', join: 'none',
  };
  assert.equal(rules.goalLocked(held), true);
  assert.equal(rules.goalLocked({ phase: 'recruiting' }), false);
  assert.equal(rules.goalLocked({ phase: null, closed: 'not_held' }), true);
  assert.equal(rules.goalLocked({}), false);
  const result = rules.validateEventEdit(raw, held, { now: NOW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.fields, { cancel_deadline: '2026-11-12T18:00:00+09:00', join_policy: 'none' });
});

test('会のカードのボタン：中止（人数不足）と、期限後は取り消せない', () => {
  const off = view({ closed: 'not_held', phase: 'not_held' });
  assert.deepEqual(rules.memberAction(off), { kind: 'cancelled', label: '人数が集まらず中止になりました', disabled: true });
  assert.equal(rules.memberAction({ ...off, is_host: true }).kind, 'host');
  assert.equal(rules.memberAction(view({}, { status: 'applied', can_cancel: false })).disabled, true);
  assert.equal(rules.memberAction(view({}, { status: 'applied', can_cancel: true })).disabled, false);
});
