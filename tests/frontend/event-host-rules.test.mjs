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

test('お断りできるのは申し込み中の人だけ（受付済みの人は断れない）', () => {
  assert.deepEqual(rules.rowActions({ status: 'applied' }), ['decline']);
  for (const status of ['attended', 'cancelled', 'declined', 'waiting']) assert.deepEqual(rules.rowActions({ status }), []);
  assert.deepEqual(rules.rowActions(null), []);
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
