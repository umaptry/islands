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
  assert.equal(rules.eventHashFor('abcdefgh', 'after'), '#/e/abcdefgh/after');
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

test('ゲスト用ページ：人数が集まらず中止の会は、遅れる・会場・友だち追加・申し込み済みの札を出さない', () => {
  for (const stopped of [{ ...event, closed: 'not_held' }, { ...event, phase: 'not_held' }]) {
    const view = rules.statusView({ status: 'applied', line_friend: false }, stopped, Date.parse('2099-11-01T00:00:00Z'));
    assert.equal(view.tone, 'notHeld');
    assert.equal(view.title, '');
    assert.equal(view.canLate, false);
    assert.equal(view.canCancel, false);
    assert.equal(view.showFriend, false);
  }
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

// ---- レビュー指摘の直し（第2回a）

test('コミュニティの中だけの会：メンバーではないと分かったら手順を止める', () => {
  assert.deepEqual(rules.communityOnlyView({ visibility: 'public' }, false), { communityOnly: false, mustStop: false, note: '' });
  const only = rules.communityOnlyView({ visibility: 'community' }, false);
  assert.equal(only.mustStop, true);
  assert.equal(only.note, 'この会は、コミュニティのメンバーだけが申し込めます');
  assert.equal(rules.communityOnlyView({ visibility: 'community' }, true).mustStop, false);
  assert.equal(rules.communityOnlyView({ visibility: 'community' }, null).mustStop, false);   // まだ分からない
  assert.equal(rules.communityOnlyView(null, false).mustStop, false);
});

test('ゲスト用ページ：申し込んでいない人は公開ページ、主催者は主催者の画面へ', () => {
  const event = { cancelled: false };
  assert.equal(rules.meRedirect({ event, me: { status: 'none' } }, 'abcdef'), '#/e/abcdef');
  assert.equal(rules.meRedirect({ event, me: { status: 'none' }, is_host: true }, 'abcdef'), '#/e/abcdef/host');
  assert.equal(rules.meRedirect({ event, me: { status: 'applied' } }, 'abcdef'), null);
  assert.equal(rules.meRedirect({ event, me: { status: 'cancelled' } }, 'abcdef'), null);
  assert.equal(rules.meRedirect({ event: { cancelled: true }, me: { status: 'none' } }, 'abcdef'), null);   // 中止の会は帯を出す
});

test('ゲストの戻り先：生きている申し込みが先、なければ最後の会', () => {
  const list = [
    { code: 'aaaaaa', starts_at: '2026-11-01T10:00:00Z', status: 'cancelled' },
    { code: 'bbbbbb', starts_at: '2026-12-01T10:00:00Z', status: 'declined' },
  ];
  assert.equal(rules.guestEntry(list).code, 'bbbbbb');
  assert.equal(rules.guestEntry([...list, { code: 'cccccc', starts_at: '2027-01-01T00:00:00Z', status: 'applied' }]).code, 'cccccc');
  assert.equal(rules.guestEntry([]), null);
});

test('主催者の画面から来たログインの戻り先：覚えて一度だけ取り出す', () => {
  const storage = memory();
  assert.equal(rules.rememberHostReturn(storage, 'abcdef'), true);
  assert.equal(rules.takeHostReturn(storage), '#/e/abcdef/host');
  assert.equal(rules.takeHostReturn(storage), null);
  rules.rememberHostReturn(storage, 'abcdef', 0);
  assert.equal(rules.takeHostReturn(storage, rules.RETURN_HOLD_MS + 1), null);
  assert.equal(rules.rememberHostReturn(storage, 'x'), false);
});

// ---------------------------------------------------------------- 第2回b（画面B）

test('開催の状態：決定・中止・募集中・最小人数なし', () => {
  assert.deepEqual(rules.eventStageView({ phase: 'held' }), { phase: 'held', label: '開催決定', tone: 'ok', note: '' });
  assert.equal(rules.eventStageView({ phase: 'not_held' }).tone, 'bad');
  const wait = rules.eventStageView({ phase: 'recruiting', needed: 3, min_participants: 8, decide_on: '2026-11-10' });
  assert.equal(wait.label, '募集中');
  assert.equal(wait.note, 'あと3人で開催決定／11月10日までに8人集まれば開催');
  assert.equal(rules.eventStageView({ phase: null }), null);
  assert.equal(rules.eventStageView({}), null);
});

test('キャンセル：期限を具体的に、期限後はボタンなしの案内', () => {
  const event = { starts_at: '2026-11-13T10:00:00Z', ends_at: '2026-11-13T13:00:00Z', cancel_deadline: '2026-11-12T09:00:00Z' };   // 11/12 18:00 JST
  const before = Date.parse('2026-11-10T00:00:00Z');
  assert.deepEqual(rules.cancelView({ status: 'applied', can_cancel: true }, event, before), { canCancel: true, note: 'キャンセルは11月12日(木) 18:00まで' });
  const late = Date.parse('2026-11-12T10:00:00Z');
  assert.deepEqual(rules.cancelView({ status: 'applied', can_cancel: false }, event, late), { canCancel: false, note: '期限後のキャンセルは主催者に連絡してください' });
  // 期限のない会：ボタンだけ。キーが無い（古いサーバー）ときは今までの判断
  assert.deepEqual(rules.cancelView({ status: 'applied', can_cancel: true }, { starts_at: event.starts_at, ends_at: event.ends_at }, before), { canCancel: true, note: '' });
  assert.equal(rules.cancelView({ status: 'applied' }, { starts_at: event.starts_at, ends_at: event.ends_at }, before).canCancel, true);
  // 受付済み・中止の会・申し込みなしにはボタンなし
  assert.equal(rules.cancelView({ status: 'attended', can_cancel: false }, event, late).note, '');
  assert.equal(rules.cancelView({ status: 'applied', can_cancel: true }, { ...event, cancelled: true }, before).canCancel, false);
});

test('「このコミュニティに参加する」は me.can_join のときだけ', () => {
  assert.equal(rules.joinView({ can_join: true }, { community_name: 'Night BAR' }).show, true);
  assert.equal(rules.joinView({ can_join: false }, {}).show, false);
  assert.equal(rules.joinView({}, {}).show, false);
  const view = rules.joinView({ can_join: true }, { community_name: 'Night BAR' });
  assert.equal(view.lead, '「Night BAR」のメンバーになると、地図やほかの人の投稿が見られます');
  assert.equal(view.done, '「Night BAR」のメンバーになりました');
  assert.match(rules.joinView({ can_join: true }, {}).lead, /^このコミュニティのメンバー/);
});

test('参加者リスト：中止の会は出さない・近い3人を上に・年代は出ない', () => {
  const people = [
    { account_id: 'a', name: '山田', is_me: false, state: 'attended', near: { level: 'high', reason: 'どちらも「キャンプ」の話題です' } },
    { account_id: 'm', name: '自分', is_me: true, state: 'applied', age_band: '30代' },
    { account_id: 'h', name: '主催', is_me: false, state: 'host' },
    { account_id: 'b', name: '佐藤', is_me: false, state: 'applied', near: { level: 'mid', reason: 'x' } },
    { account_id: 'c', name: '鈴木', is_me: false, state: 'applied' },
  ];
  const view = rules.participantsView({ people, near3: ['a', 'b', 'm'] }, { phase: 'held' });
  assert.deepEqual(view.near.map((p) => p.account_id), ['a', 'b']);
  assert.deepEqual(view.rest.map((p) => p.account_id), ['m', 'h', 'c']);
  assert.equal(view.count, 5);
  assert.equal(rules.participantsView({ people, near3: [] }, { cancelled: true }), null);
  assert.equal(rules.participantsView({ people, near3: [] }, { phase: 'not_held' }), null);
  assert.equal(rules.participantsView(null, {}), null);
  const one = rules.personView({ ...people[1], affiliation: '○○', job_title: 'デザイナー', answers: [{ label: '最近', body: '陶芸' }, { label: 'x', body: ' ' }] });
  assert.equal(one.sub, '○○・デザイナー');
  assert.deepEqual(one.badges.map((b) => b.text), ['あなた']);
  assert.equal(one.answers.length, 1);
  assert.equal('age_band' in one, false);
  assert.equal(rules.personView(people[0]).reason, 'どちらも「キャンプ」の話題です');
  assert.deepEqual(rules.personView(people[0]).badges.map((b) => b.text), ['受付済み']);
  assert.deepEqual(rules.personView(people[2]).badges.map((b) => b.text), ['主催者']);
});

test('会が終わったあとの「会った人を選ぶ」は受付済みの人だけ', () => {
  const event = { starts_at: '2026-11-21T10:00:00Z', ends_at: '2026-11-21T13:00:00Z' };
  const after = Date.parse('2026-11-21T14:00:00Z');
  assert.equal(rules.afterLinkShown({ status: 'attended' }, event, after), true);
  assert.equal(rules.afterLinkShown({ status: 'applied' }, event, after), false);
  assert.equal(rules.afterLinkShown({ status: 'attended' }, event, Date.parse('2026-11-21T11:00:00Z')), false);
  assert.equal(rules.afterLinkShown({ status: 'attended' }, { ...event, cancelled: true }, after), false);
});

test('受付の画面の出し分け', () => {
  const k = (info) => rules.checkinView(info).kind;
  assert.equal(k({ window: 'open', me: 'applied' }), 'ready');
  assert.equal(k({ window: 'open', me: 'none', is_member: true }), 'ready');
  assert.equal(k({ window: 'open', me: 'none', is_member: false }), 'walkin');
  assert.equal(k({ window: 'early', me: 'applied' }), 'early');
  assert.equal(k({ window: 'closed', me: 'none' }), 'closed');
  assert.equal(k({ window: 'closed', me: 'attended' }), 'attended');
  assert.equal(k({ window: 'open', me: 'waiting' }), 'waiting');
  assert.equal(k({ window: 'open', me: 'rejected', rejects: 1 }), 'rejected');
  assert.equal(k({ window: 'open', me: 'rejected', rejects: 3 }), 'blocked');
  assert.equal(k({ window: 'open', me: 'banned' }), 'blocked');
  assert.equal(k({ window: 'open', me: 'cancelled' }), 'walkin');   // 取り消した人も受付待ちから主催者が選ぶ
  assert.equal(rules.checkinView({ me: 'rejected', rejects: 1 }).text, '受付できませんでした。主催者に声をかけてください');
});

test('受付できたあとの文：自動加入ならコミュニティ名（会の名前ではない）', () => {
  const event = { title: 'BAR #2', community_name: 'The Night Office BAR' };
  assert.equal(rules.checkinDoneView({ joined: true }, event, '佐々木 花').note, 'ようこそ、佐々木 花さん。「The Night Office BAR」のメンバーになりました。');
  const plain = rules.checkinDoneView({ joined: false }, event, '');
  assert.equal(plain.title, '受付しました');
  assert.equal(plain.joined, false);
});

test('飛び入りの入力：フルネームと会社が要る', () => {
  assert.equal(rules.cleanWalkin('', '○○').ok, false);
  assert.equal(rules.cleanWalkin('佐々木 花', '').ok, false);
  assert.equal(rules.cleanWalkin('x'.repeat(40), '○○').ok, false);
  assert.deepEqual(rules.cleanWalkin(' 佐々木  花 ', '株式会社 ミナト').body, { display_name: '佐々木 花', affiliation: '株式会社 ミナト', agree_terms: true });
});

test('受付の戻り先：覚える・一度だけ取り出す・30分で切れる', () => {
  const storage = memory();
  assert.equal(rules.rememberCheckinReturn(storage, 'abcdefgh', 0), true);
  assert.equal(rules.peekCheckinReturn(storage, 1000), 'abcdefgh');
  assert.equal(rules.takeCheckinReturn(storage, 1000), 'abcdefgh');
  assert.equal(rules.takeCheckinReturn(storage, 1000), null);
  rules.rememberCheckinReturn(storage, 'abcdefgh', 0);
  assert.equal(rules.peekCheckinReturn(storage, rules.RETURN_HOLD_MS + 1), null);
  assert.equal(rules.rememberCheckinReturn(storage, 'x'), false);
});

test('ゲストが開けるのは限定ページ・公開ページ・会のあと・受付だけ', () => {
  for (const pattern of ['#/e/:code', '#/e/:code/me', '#/e/:code/after', '#/c/:code']) assert.equal(rules.guestMayOpen(pattern), true);
  for (const pattern of ['#/map', '#/e/:code/host', '#/dm', '']) assert.equal(rules.guestMayOpen(pattern), false);
  assert.equal(rules.isEventPattern('#/e/:code/after'), true);
});

test('会のあと：2人ともメンバーのときだけ「もっと話してみたい」、ask の会には参加の案内', () => {
  const people = [{ account_id: 'a', display_name: '山田', is_member: true, met: true }, { account_id: 'b', display_name: '佐藤', is_member: false, met: false }];
  const member = rules.afterView({ people, me_is_member: true, join_policy: 'ask' });
  assert.deepEqual(member.people.map((p) => p.canTalk), [true, false]);
  assert.equal(member.askJoin, false);
  const guest = rules.afterView({ people, me_is_member: false, join_policy: 'ask' });
  assert.deepEqual(guest.people.map((p) => p.canTalk), [false, false]);
  assert.equal(guest.askJoin, true);
  assert.equal(guest.note, 'コミュニティに参加すると「もっと話してみたい」も押せます');
  assert.equal(rules.afterView({ people: [], me_is_member: false, join_policy: 'none' }).askJoin, false);
  assert.equal(rules.afterView(null).empty, true);
});
