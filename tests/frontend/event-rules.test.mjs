import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const load = async (name) => {
  const source = await readFile(new URL(`../../web/js/${name}`, import.meta.url), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};
const rules = await load('event-rules.js');

const memory = () => {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
};

test('アドレス：/e/<code> は申し込み、/c/<code> は受付。変な文字は読まない', () => {
  assert.deepEqual(rules.parseEventPath('/e/abcDEF123_-xyz'), { kind: 'apply', code: 'abcDEF123_-xyz' });
  assert.deepEqual(rules.parseEventPath('/c/abcDEF123'), { kind: 'checkin', code: 'abcDEF123' });
  assert.deepEqual(rules.parseEventPath('/e/abcDEF123/'), { kind: 'apply', code: 'abcDEF123' });
  assert.equal(rules.parseEventPath('/'), null);
  assert.equal(rules.parseEventPath('/e/'), null);
  assert.equal(rules.parseEventPath('/e/abc'), null);                    // 短すぎる
  assert.equal(rules.parseEventPath('/e/abcdef/me'), null);
  assert.equal(rules.parseEventPath('/e/<script>alert(1)</script>'), null);
  assert.equal(rules.parseEventPath('/x/abcdefgh'), null);
});

test('hash を作る：申し込み・ゲスト・受付。コードが変なら地図', () => {
  assert.equal(rules.eventHashFor('abcdefgh'), '#/e/abcdefgh');
  assert.equal(rules.eventHashFor('abcdefgh', 'me'), '#/e/abcdefgh/me');
  assert.equal(rules.eventHashFor('abcdefgh', 'checkin'), '#/c/abcdefgh');
  assert.equal(rules.eventHashFor('a b', 'me'), '#/map');
  assert.equal(rules.isEventPattern('#/e/:code'), true);
  assert.equal(rules.isEventPattern('#/e/:code/me'), true);
  assert.equal(rules.isEventPattern('#/c/:code'), true);
  assert.equal(rules.isEventPattern('#/map'), false);
  assert.equal(rules.isEventPattern('#/event/:code'), false);
});

test('日時は日本時間で出す', () => {
  // 2026-11-21 10:00Z = 19:00 JST（土曜）
  const event = { starts_at: '2026-11-21T10:00:00+00:00', ends_at: '2026-11-21T13:00:00+00:00' };
  assert.equal(rules.dayText(event.starts_at), '11/21(土)');
  assert.equal(rules.clockText(event.starts_at), '19:00');
  assert.equal(rules.windowText(event), '11/21(土) 19:00〜22:00');
  // 日をまたぐ会は、終わりにも日付
  assert.equal(rules.windowText({ starts_at: '2026-11-21T14:00:00Z', ends_at: '2026-11-21T17:00:00Z' }), '11/21(土) 23:00〜11/22(日) 02:00');
  assert.equal(rules.windowText(null), '');
  assert.equal(rules.dayText('x'), '');
});

test('会の前・最中・あと', () => {
  const event = { starts_at: '2026-11-21T10:00:00Z', ends_at: '2026-11-21T13:00:00Z' };
  assert.equal(rules.phaseOf(event, Date.parse('2026-11-20T00:00:00Z')), 'before');
  assert.equal(rules.phaseOf(event, Date.parse('2026-11-21T11:00:00Z')), 'during');
  assert.equal(rules.phaseOf(event, Date.parse('2026-11-21T13:00:01Z')), 'after');
});

test('申し込みページの状態：中止・満員・期限・ふつう', () => {
  assert.deepEqual(rules.applyView({ closed: null }), { state: 'open', canApply: true, band: '' });
  assert.equal(rules.applyView({ closed: 'cancelled' }).canApply, false);
  assert.equal(rules.applyView({ closed: 'cancelled' }).band, 'この会は中止になりました');
  assert.equal(rules.applyView({ closed: 'full' }).state, 'full');
  assert.equal(rules.applyView({ closed: 'deadline' }).state, 'deadline');
});

test('内訳：3人未満は「ほか」にまとめ直す。「ほか」は最後。空の区分は出さない', () => {
  const rows = rules.breakdownRows({
    age: [{ label: '20代', count: 6 }, { label: 'ほか', count: 1 }, { label: '30代', count: 8 }, { label: '40代', count: 2 }],
    job: [],
    genre: [{ label: 'アウトドア', count: 2 }, { label: '食', count: 1 }],
  });
  assert.deepEqual(rows.map((row) => row.key), ['age', 'genre']);
  assert.deepEqual(rows[0].items, [{ label: '30代', count: 8 }, { label: '20代', count: 6 }, { label: 'ほか', count: 3 }]);
  // 2人と1人は、どちらも「ほか」に入る（誰がどれかを当てられない）
  assert.deepEqual(rows[1].items, [{ label: 'ほか', count: 3 }]);
  assert.deepEqual(rules.breakdownRows(undefined), []);
  // 3人ちょうどは出す
  assert.deepEqual(rules.breakdownRows({ job: [{ label: 'デザイナー', count: 3 }] })[0].items, [{ label: 'デザイナー', count: 3 }]);
  // 数字でない・マイナス・名前なしは数えない
  assert.deepEqual(rules.breakdownRows({ age: [{ label: '', count: 5 }, { label: '30代', count: -1 }, { label: '20代', count: 'x' }] }), []);
});

test('参加予定の数：0人なら空', () => {
  assert.deepEqual(rules.countView({ applied_count: 0, capacity: 20 }), { count: 0, empty: true, capacityText: '定員 20人' });
  assert.equal(rules.countView({ applied_count: 18, capacity: null }).capacityText, '');
  assert.equal(rules.countView({}).count, 0);
});

test('近い人が来るか：0＝まだいません、1〜2＝少し、3以上＝数字', () => {
  assert.equal(rules.probeView({ level: 'none', count: null }).number, 'まだ');
  assert.equal(rules.probeView({ level: 'none', count: null }).tail, 'いません');
  assert.equal(rules.probeView({ level: 'few', count: null }).number, '少し');
  assert.deepEqual(rules.probeView({ level: 'many', count: 7 }), { level: 'many', number: '7', unit: '人', lead: 'あなたと近そうな人が', tail: '参加予定です' });
  // 数が壊れていたら数字は出さない
  assert.equal(rules.probeView({ level: 'many', count: null }).level, 'none');
  assert.equal(rules.probeView(null).level, 'none');
});

test('興味は1〜2個、30字まで', () => {
  assert.deepEqual(rules.cleanInterests([' キャンプ飯 ', '陶芸']), ['キャンプ飯', '陶芸']);
  assert.equal(rules.cleanInterests([]), null);
  assert.equal(rules.cleanInterests(['a', 'b', 'c']), null);
  assert.equal(rules.cleanInterests(['あ'.repeat(31)]), null);
  assert.deepEqual(rules.cleanInterests(['あ'.repeat(30)]), ['あ'.repeat(30)]);
  assert.equal(rules.cleanInterests(['', '  ']), null);
});

const event = { starts_at: '2099-11-21T10:00:00Z', ends_at: '2099-11-21T13:00:00Z', cancelled: false };

test('ゲスト用ページ：申し込み済みは遅れる・取り消せる。近い人の欄はここだけ', () => {
  const view = rules.statusView({ status: 'applied', line_friend: false }, event, Date.parse('2099-11-01T00:00:00Z'));
  assert.equal(view.tone, 'ok');
  assert.equal(view.canLate, true);
  assert.equal(view.canCancel, true);
  assert.equal(view.showNear, true);
  assert.equal(view.showFriend, true);
  assert.equal(rules.statusView({ status: 'applied', line_friend: true }, event).showFriend, false);
});

test('ゲスト用ページ：会が終わったら遅れる・取り消すは出ない', () => {
  const view = rules.statusView({ status: 'applied' }, event, Date.parse('2099-11-22T00:00:00Z'));
  assert.equal(view.canLate, false);
  assert.equal(view.canCancel, false);
});

test('ゲスト用ページ：中止のときは赤い帯の文だけ。近い人は出さない（申し込み状態に関わらず）', () => {
  for (const status of ['applied', 'cancelled', 'attended', 'none']) {
    const view = rules.statusView({ status }, { ...event, cancelled: true });
    assert.equal(view.tone, 'cancelled', status);
    assert.equal(view.showNear, false, status);
    assert.equal(view.canLate, false, status);
    assert.equal(view.canCancel, false, status);
    assert.equal(view.title, 'この会は中止になりました');
    assert.equal(view.note, '申し込みは取り消されています。');
    assert.equal(/またお知らせ/.test(view.title + view.note), false);
  }
});

test('ゲスト用ページ：お断りの文。近い人・遅れる・取り消すは出ない', () => {
  const view = rules.statusView({ status: 'declined' }, event);
  assert.equal(view.tone, 'declined');
  assert.equal(view.note, '定員などの都合により、今回はご参加をお受けできないことになりました。またの機会にぜひお越しください。');
  assert.equal(view.showNear, false);
  assert.equal(view.canLate || view.canCancel, false);
});

test('ゲスト用ページ：取り消したあとは、もう一度申し込める（会の前だけ）。受付済みは取り消せない', () => {
  assert.equal(rules.statusView({ status: 'cancelled' }, event, Date.parse('2099-11-01T00:00:00Z')).canReapply, true);
  assert.equal(rules.statusView({ status: 'cancelled' }, event, Date.parse('2099-11-30T00:00:00Z')).canReapply, false);
  const attended = rules.statusView({ status: 'attended' }, event);
  assert.equal(attended.title, '受付しました');
  assert.equal(attended.canCancel, false);
  assert.equal(attended.canLate, false);
  assert.equal(rules.statusView({ status: 'waiting' }, event).title, '受付を待っています');
});

test('ゲスト用ページの文に「島」を使わない', () => {
  const all = [...Object.values(rules.EVENT_WORDS), ...Object.values(rules.LATE_LABELS)].join('');
  assert.equal(all.includes('島'), false);
});

test('遅れる：10・30・60 分、選んだものに印', () => {
  const choices = rules.lateChoices(30);
  assert.deepEqual(choices.map((c) => c.minutes), [10, 30, 60]);
  assert.deepEqual(choices.map((c) => c.selected), [false, true, false]);
  assert.deepEqual(choices.map((c) => c.label), ['10分くらい遅れる', '30分くらい遅れる', '1時間以上遅れる']);
  assert.equal(rules.lateChoices(null).some((c) => c.selected), false);
});

test('カレンダーと地図のリンク', () => {
  const url = rules.calendarUrl({ code: 'abcdefgh', title: 'BAR #2', place: '渋谷', starts_at: '2026-11-21T10:00:00Z', ends_at: '2026-11-21T13:00:00Z' }, 'https://x.test');
  assert.match(url, /^https:\/\/calendar\.google\.com\/calendar\/render\?/);
  assert.match(url, /dates=20261121T100000Z%2F20261121T130000Z/);
  assert.equal(rules.calendarUrl({ title: 'x' }), '');
  assert.match(rules.mapUrl('渋谷 ○○ビル'), /^https:\/\/www\.google\.com\/maps\/search\/\?/);
  assert.equal(rules.mapUrl('  '), '');
});

test('LINE ログインの戻り先：覚えて、30分以内なら一度だけ取り出せる', () => {
  const storage = memory();
  assert.equal(rules.rememberApplyReturn(storage, 'abcdefgh', 1000), true);
  assert.equal(rules.peekApplyReturn(storage, 2000), 'abcdefgh');
  assert.equal(rules.peekApplyReturn(storage, 2000), 'abcdefgh');       // 見るだけでは消えない
  assert.equal(rules.takeApplyReturn(storage, 2000), 'abcdefgh');
  assert.equal(rules.takeApplyReturn(storage, 2000), null);
  rules.rememberApplyReturn(storage, 'abcdefgh', 1000);
  assert.equal(rules.takeApplyReturn(storage, 1000 + 31 * 60 * 1000), null);   // 古い
  assert.equal(rules.rememberApplyReturn(storage, 'x y', 1), false);
  assert.equal(rules.takeApplyReturn(null), null);
});

test('興味の下書き：端末のタブの中だけ。壊れていても落ちない', () => {
  const storage = memory();
  assert.deepEqual(rules.probeDraft(storage, 'abcdefgh'), []);
  rules.saveProbeDraft(storage, 'abcdefgh', ['キャンプ飯', '陶芸']);
  assert.deepEqual(rules.probeDraft(storage, 'abcdefgh'), ['キャンプ飯', '陶芸']);
  assert.deepEqual(rules.probeDraft(storage, 'otherothr'), []);
  storage.setItem('islands-event-probe:abcdefgh', '{broken');
  assert.deepEqual(rules.probeDraft(storage, 'abcdefgh'), []);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(rules.probeDraft(broken, 'abcdefgh'), []);
  assert.equal(rules.saveProbeDraft(broken, 'abcdefgh', ['a']), false);
});

test('エラーの文：サーバーの日本語をそのまま。つながらないときは通信の文', () => {
  assert.equal(rules.errorText({ message: 'この会は中止になりました。', status: 409 }), 'この会は中止になりました。');
  assert.match(rules.errorText({ status: 0, message: '' }), /接続/);
  assert.match(rules.errorText(null), /もう一度/);
});
