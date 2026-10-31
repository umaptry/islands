import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// No package.json "type" in this folder: load the module as a data: URL like the other tests.
const source = await readFile(new URL('../../web/js/talk-rules.js', import.meta.url), 'utf8');
const rules = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const ME = '11111111-1111-4111-8111-111111111111';
const AKI = '22222222-2222-4222-8222-222222222222';
const BEN = '33333333-3333-4333-8333-333333333333';
const CHI = '44444444-4444-4444-8444-444444444444';
const ROOM = '55555555-5555-4555-8555-555555555555';
const LABEL = 'もっと話してみたい';
const NAME = 'あき';

const cfg = (talk, label = LABEL) => ({ features: { talk }, talk: { label } });

// ---------------------------------------------------------------- availability

test('nothing shows unless features.talk is exactly true and a label arrived', () => {
  assert.equal(rules.talkOn(cfg(true)), true);
  assert.equal(rules.talkOn(cfg(false)), false);
  assert.equal(rules.talkOn(cfg('yes')), false);
  assert.equal(rules.talkOn(cfg(true, '')), false);
  assert.equal(rules.talkOn(cfg(true, '   ')), false);
  assert.equal(rules.talkOn({ features: {} }), false);
  assert.equal(rules.talkOn({ features: { talk: true } }), false, 'no talk.label: nothing to call the button');
  assert.equal(rules.talkOn(null), false);
  assert.equal(rules.talkLabelOf(cfg(true, ' なまえ ')), 'なまえ');
  assert.equal(rules.talkLabelOf(cfg(false)), '');
});

test('the label is never written in the rules: every sentence takes it as input', () => {
  const code = source.replace(/\/\/.*$/gm, '');
  assert.ok(!code.includes(LABEL), 'the name もっと話してみたい must come from /api/config');
  assert.ok(rules.talkButtonText('none', 'ほげ').word === 'ほげ');
  assert.ok(rules.talkButtonText('pressed', 'ほげ').word.startsWith('ほげ'));
  assert.ok(rules.introPrompt('ほげ').title.includes('ほげ'));
  assert.ok(rules.afterPress({ matched: true, room_id: ROOM }, 'ほげ').message.includes('ほげ'));
});

// ---------------------------------------------------------------- the index and the button state

test('the index reads both server shapes and ignores states it does not know', () => {
  const index = rules.buildTalkIndex(
    [{ account_id: AKI }, BEN, { account_id: null }, null],
    [
      { target: AKI, state: 'pressed', room_id: null },
      { target: BEN, state: 'matched', room_id: ROOM },
      { target: CHI, state: 'weird', room_id: null },
      { state: 'pressed' },
    ], 42);
  assert.deepEqual([...index.peers].sort(), [AKI, BEN].sort());
  assert.deepEqual([...index.byTarget.keys()].sort(), [AKI, BEN].sort());
  assert.deepEqual(index.byTarget.get(BEN), { state: 'matched', room_id: ROOM });
  assert.equal(index.at, 42);
  const empty = rules.buildTalkIndex(undefined, 'nope');
  assert.equal(empty.peers.size + empty.byTarget.size, 0);
});

test('the button: none / pressed / matched for a person I share a 会 with, nothing for anybody else', () => {
  const index = rules.buildTalkIndex([AKI, BEN], [
    { target: AKI, state: 'pressed', room_id: null },
    { target: BEN, state: 'matched', room_id: ROOM },
  ]);
  const quiet = rules.buildTalkIndex([BEN], []);
  assert.equal(rules.talkStateFor(AKI, index), 'pressed');
  assert.equal(rules.talkStateFor(BEN, index), 'matched');
  assert.equal(rules.talkStateFor(BEN, quiet), 'none');
  assert.equal(rules.talkStateFor(CHI, index), null, 'not a peer: no button');
  assert.equal(rules.talkStateFor(AKI, index, { mine: true }), null, 'never on my own post');
  assert.equal(rules.talkStateFor(AKI, index, { signedIn: false }), null);
  assert.equal(rules.talkStateFor(null, index), null);
  assert.equal(rules.talkStateFor(AKI, null), null);
});

test('an open DM stays reachable from the card even when the 会 is no longer shared', () => {
  const index = rules.buildTalkIndex([], [{ target: BEN, state: 'matched', room_id: ROOM }]);
  assert.equal(rules.talkStateFor(BEN, index), 'matched');
  // ...but a press that is waiting cannot be pressed or taken back from a card of a stranger.
  const waiting = rules.buildTalkIndex([], [{ target: AKI, state: 'pressed', room_id: null }]);
  assert.equal(rules.talkStateFor(AKI, waiting), null);
});

test('nothing in the index says whether somebody pressed ME', () => {
  const index = rules.buildTalkIndex([AKI], [{ target: AKI, state: 'pressed', room_id: null, pressed_you: true, from: AKI }]);
  assert.deepEqual(Object.keys(index.byTarget.get(AKI)).sort(), ['room_id', 'state']);
});

test('the words on the button, per state: the small line before the first press names nobody', () => {
  assert.deepEqual(rules.talkButtonText('none', LABEL, NAME), {
    word: 'もっと話してみたい',
    note: '押したことは相手には見えず、お互いに押すと DM が開きます',
  });
  assert.deepEqual(rules.talkButtonText('pressed', LABEL, NAME), {
    word: 'もっと話してみたい（押しました）',
    note: 'あきさんも押すと DM が開きます。もう一度押すと取り消せます',
  });
  assert.deepEqual(rules.talkButtonText('matched', LABEL, NAME), {
    word: 'DM を開く',
    note: 'あきさんと、お互いに押しました',
  });
});

test('without a name the line still reads as aimed at a person', () => {
  assert.equal(rules.personCall(''), 'この人');
  assert.equal(rules.personCall('  '), 'この人');
  assert.equal(rules.personCall(null), 'この人');
  assert.equal(rules.personCall(' ベン '), 'ベンさん');
  assert.equal(rules.personCall('たなかさん'), 'たなかさん');
  assert.equal(rules.talkButtonText('none', LABEL).note, rules.talkButtonText('none', LABEL, NAME).note, 'before the first press the line names nobody');
  assert.ok(rules.talkButtonText('pressed', LABEL).note.startsWith('この人も'));
  assert.ok(rules.talkButtonText('matched', LABEL).note.startsWith('この人と、'));
});

test('the sentences after a press', () => {
  assert.equal(rules.afterPress({ matched: false, room_id: null }, LABEL).message, '『もっと話してみたい』を押しました');
  assert.equal(rules.afterPress({ matched: true, room_id: ROOM }, LABEL).message, 'お互いに『もっと話してみたい』でした。DMが開きました');
});

test('the one-time explanation and the take-back question', () => {
  const intro = rules.introPrompt(LABEL);
  assert.ok(intro.title.includes(LABEL));
  assert.equal(intro.body, 'お互いに押したときだけ DM が開通します。押したことは相手には見えません。');
  const back = rules.withdrawPrompt(LABEL);
  assert.ok(back.title.includes(LABEL) && back.title.includes('取り消'));
  assert.ok(back.body.includes('相手には何も知らされません'));
});

test('no romantic wording on screen', () => {
  const banned = /恋|好き|片思い|両思い|愛|デート|カップル|告白|彼氏|彼女|モテ/;
  const lines = [
    ...['none', 'pressed', 'matched'].flatMap((s) => Object.values(rules.talkButtonText(s, LABEL, NAME))),
    ...Object.values(rules.introPrompt(LABEL)),
    ...Object.values(rules.withdrawPrompt(LABEL)),
    rules.afterPress({ matched: true, room_id: ROOM }, LABEL).message,
    rules.afterPress({ matched: false, room_id: null }, LABEL).message,
    rules.dmIntro({ event_excerpt: 'ボードゲームの会' }, LABEL),
    rules.dmIntro({}, LABEL),
    rules.talkRefusal('', 'talk'), rules.talkRefusal('42501', 'dm'),
  ];
  lines.forEach((line) => assert.ok(!banned.test(line), line));
});

// ---------------------------------------------------------------- pressing

test('press_talk answers are read in one shape; a match needs a room', () => {
  assert.deepEqual(rules.readPress({ matched: true, room_id: ROOM }), { matched: true, room_id: ROOM });
  assert.deepEqual(rules.readPress({ matched: false, room_id: null }), { matched: false, room_id: null });
  assert.deepEqual(rules.readPress({ matched: true, room_id: null }), { matched: false, room_id: null });
  assert.deepEqual(rules.readPress({ matched: 'true', room_id: ROOM }), { matched: false, room_id: null });
  assert.deepEqual(rules.readPress(null), { matched: false, room_id: null });
});

test('after a press the screen shows the same thing whether or not it was already there', () => {
  const first = rules.afterPress(rules.readPress({ matched: false, room_id: null }), LABEL);
  const again = rules.afterPress(rules.readPress({ matched: false, room_id: null }), LABEL);
  assert.deepEqual(first, again);
  assert.deepEqual(first, { state: 'pressed', roomId: null, message: `『${LABEL}』を押しました` });
  const match = rules.afterPress(rules.readPress({ matched: true, room_id: ROOM }), LABEL);
  assert.equal(match.state, 'matched');
  assert.equal(match.roomId, ROOM);
  assert.equal(match.message, `お互いに『${LABEL}』でした。DMが開きました`);
});

test('the DM address', () => {
  assert.equal(rules.dmHashFor(ROOM), `#/dm/${ROOM}`);
  assert.equal(rules.dmHashFor(null), '#/dm');
  assert.equal(rules.dmHashFor('a b'), '#/dm/a%20b');
});

// ---------------------------------------------------------------- errors

test('errors: the database\'s Japanese is shown, technical words become a sentence', () => {
  assert.equal(rules.talkRefusal('Map maintenance in progress'), 'いま調整中です。少し待ってからもう一度どうぞ。');
  assert.equal(rules.talkRefusal('同じ会の参加者にだけ押せます'), '同じ会の参加者にだけ押せます');
  assert.equal(rules.talkRefusal('うまくいきませんでした (400)'), 'うまくいきませんでした (400)');
  assert.equal(rules.talkRefusal('new row violates row-level security policy for table "dm_messages"', 'dm'),
    'この DM には、いまメッセージを送れません。');
  assert.equal(rules.talkRefusal('permission denied for table dm_messages', 'talk'), 'いまは押せません。');
  assert.equal(rules.talkRefusal('JWT expired'), 'ログインし直してください。');
  assert.match(rules.talkRefusal('Internal Server Error'), /うまくいきませんでした/);
  assert.match(rules.talkRefusal(undefined), /うまくいきませんでした/);
  // A refusal never explains WHY a person cannot be pressed beyond what the database says.
  assert.ok(!rules.talkRefusal('new row violates row-level security policy', 'dm').includes('ブロック'));
});

test('the daily limit is said with the button name from the config, and only then', () => {
  const dbWords = '今日はここまでです。「もっと話してみたい」を押せるのは1日20人までで、明日（0時すぎ）からまた押せます。';
  assert.equal(rules.talkRefusal(dbWords, 'talk', LABEL), dbWords);
  assert.equal(rules.talkRefusal(dbWords, 'talk', 'ほげ'),
    '今日はここまでです。「ほげ」を押せるのは1日20人までで、明日（0時すぎ）からまた押せます。');
  assert.equal(rules.talkRefusal(dbWords), dbWords, 'no label: the database own sentence');
  assert.equal(rules.dailyLimitText('ほげ', 20), rules.talkRefusal(dbWords, 'talk', 'ほげ'));
  // Nothing about the limit is on the button or the intro before it is hit.
  const quiet = [...['none', 'pressed', 'matched'].flatMap((s) => Object.values(rules.talkButtonText(s, LABEL, NAME))),
    ...Object.values(rules.introPrompt(LABEL)), rules.afterPress({ matched: false, room_id: null }, LABEL).message];
  quiet.forEach((line) => assert.ok(!/1日|人まで/.test(line), line));
});

// ---------------------------------------------------------------- rooms

const room = (id, other, last, created = '2026-10-30T10:00:00Z') =>
  ({ room_id: id, other_id: other, last_at: last, created_at: created });

test('rooms: newest conversation first, an unused room counts from when it opened', () => {
  const sorted = rules.sortRooms([
    room('a', AKI, '2026-10-30T11:00:00Z'),
    room('b', BEN, null, '2026-10-30T12:30:00Z'),
    room('c', CHI, '2026-10-30T12:00:00Z'),
  ]);
  assert.deepEqual(sorted.map((entry) => entry.room_id), ['b', 'c', 'a']);
  assert.deepEqual(rules.sortRooms(null), []);
});

test('the list shows the last message, or says there is none yet', () => {
  assert.equal(rules.dmPreview({ last_body: 'こんにちは' }), 'こんにちは');
  assert.equal(rules.dmPreview({ last_body: null }), 'まだメッセージはありません');
});

test('the top of a room names the 会 and says who can read it', () => {
  const clip = (text) => (text.length > 6 ? `${text.slice(0, 6)}…` : text);
  assert.equal(rules.dmIntro({ event_excerpt: 'ボードゲームの会' }, LABEL, clip),
    `「ボードゲーム…」で、お互いに『${LABEL}』を押しました。この DM は2人だけが見られます`);
  assert.equal(rules.dmIntro({ event_excerpt: null }, LABEL),
    `同じコミュニティで、お互いに『${LABEL}』を押しました。この DM は2人だけが見られます`);
  assert.equal(rules.dmEventLine({ event_excerpt: ' 朝ラン ' }), '朝ラン の会');
  assert.equal(rules.dmEventLine({ event_excerpt: null }), '');
});

test('the room behind a notification: from the room list, else from my_talk_state', () => {
  const rooms = [{ room_id: 'r1', other_id: AKI }];
  const talkRows = [{ target: BEN, state: 'matched', room_id: 'r2' }, { target: CHI, state: 'pressed', room_id: null }];
  assert.equal(rules.roomIdFor(AKI, { rooms, talkRows }), 'r1');
  assert.equal(rules.roomIdFor(BEN, { rooms, talkRows }), 'r2');
  assert.equal(rules.roomIdFor(CHI, { rooms, talkRows }), null, 'a pending press has no room');
  assert.equal(rules.roomIdFor(null, { rooms, talkRows }), null);
  assert.equal(rules.roomIdFor(AKI, {}), null);
});

// ---------------------------------------------------------------- messages

const message = (id, at, body = 'x', sender = AKI) => ({ id, room_id: ROOM, sender_id: sender, body, created_at: at });

test('merging messages: once each, oldest first, even when a poll repeats one', () => {
  const have = [message('m2', '2026-10-30T10:00:02.000000+00:00'), message('m1', '2026-10-30T10:00:01.000000+00:00')];
  const merged = rules.mergeMessages(have, [message('m2', '2026-10-30T10:00:02.000000+00:00'), message('m3', '2026-10-30T10:00:03.000000+00:00')]);
  assert.deepEqual(merged.map((entry) => entry.id), ['m1', 'm2', 'm3']);
  assert.deepEqual(rules.mergeMessages(null, undefined), []);
  assert.deepEqual(rules.mergeMessages([message('m1', 't')], [null, {}]).map((entry) => entry.id), ['m1']);
});

test('the newer copy of a message wins; equal times fall back to the id', () => {
  const a = message('a', '2026-10-30T10:00:00+00:00', 'old');
  const b = message('b', '2026-10-30T10:00:00+00:00', 'tie');
  const merged = rules.mergeMessages([b, a], [{ ...a, body: 'new' }]);
  assert.deepEqual(merged.map((entry) => entry.id), ['a', 'b']);
  assert.equal(merged[0].body, 'new');
});

test('"after" is the newest created_at exactly as the server wrote it', () => {
  const stamp = '2026-10-30T10:00:03.123456+00:00';
  assert.equal(rules.lastStamp([message('m1', '2026-10-30T10:00:01+00:00'), message('m2', stamp)]), stamp);
  assert.equal(rules.lastStamp([]), null);
  assert.equal(rules.lastStamp(null), null);
});

test('a sent message in either shape: a row, a one-row array, or the local {message}', () => {
  const row = message('m9', '2026-10-30T10:00:09+00:00');
  assert.deepEqual(rules.readSent(row), row);
  assert.deepEqual(rules.readSent([row]), row);
  assert.deepEqual(rules.readSent({ message: row }), row);
  assert.equal(rules.readSent([]), null);
  assert.equal(rules.readSent(null), null);
});

test('limits: a DM is 1000 characters and is looked for every five seconds', () => {
  assert.equal(rules.DM_MAX, 1000);
  assert.equal(rules.DM_POLL_MS, 5000);
});

// ---------------------------------------------------------------- the first-time note

const fakeStorage = (fail = false) => {
  const map = new Map();
  return {
    getItem: (key) => { if (fail) throw new Error('blocked'); return map.has(key) ? map.get(key) : null; },
    setItem: (key, value) => { if (fail) throw new Error('blocked'); map.set(key, String(value)); },
    map,
  };
};

test('the explanation is shown once per browser, and only once per page without storage', () => {
  rules.resetIntroMemory();
  const storage = fakeStorage();
  assert.equal(rules.introSeen(storage), false);
  rules.markIntroSeen(storage);
  assert.equal(storage.map.get(rules.INTRO_KEY), '1');
  rules.resetIntroMemory();
  assert.equal(rules.introSeen(storage), true, 'remembered by the browser');

  rules.resetIntroMemory();
  const blocked = fakeStorage(true);
  assert.equal(rules.introSeen(blocked), false);
  assert.doesNotThrow(() => rules.markIntroSeen(blocked));
  assert.equal(rules.introSeen(blocked), true, 'remembered for this page load');
  assert.equal(rules.introSeen(null), true);
  rules.resetIntroMemory();
  assert.equal(rules.introSeen(null), false);
  assert.doesNotThrow(() => rules.markIntroSeen(null));
  rules.resetIntroMemory();
});

// ---------------------------------------------------------------- DM: what is unread

const dmStorage = ({ failRead = false, failWrite = false } = {}) => {
  const map = new Map();
  return {
    getItem: (key) => { if (failRead) throw new Error('blocked'); return map.has(key) ? map.get(key) : null; },
    setItem: (key, value) => { if (failWrite) throw new Error('blocked'); map.set(key, String(value)); },
    map,
  };
};

const dmRoom = (id, other, lastAt, extra = {}) => ({ room_id: id, other_id: other, last_at: lastAt, created_at: '2026-10-01T00:00:00Z', ...extra });
const T1 = '2026-10-24T10:00:00.000000+00:00';
const T2 = '2026-10-24T11:00:00.000000+00:00';
const T3 = '2026-10-24T12:00:00.000000+00:00';

test.beforeEach(() => rules.resetDmSeenMemory());

test('a room is unread when its newest message is later than the time I last saw it', () => {
  const rooms = [dmRoom('r1', AKI, T2), dmRoom('r2', BEN, T2), dmRoom('r3', CHI, T1)];
  const seen = { r1: T1, r2: T2, r3: T3 };
  assert.deepEqual(rules.unreadRooms(rooms, seen).map((entry) => entry.room_id), ['r1']);
});

test('a room with no message yet, or one I blocked, is never unread', () => {
  const rooms = [dmRoom('r1', AKI, null), dmRoom('r2', BEN, T2, { blocked_by_me: true })];
  assert.deepEqual(rules.unreadRooms(rooms, { r2: T1 }), []);
  assert.deepEqual(rules.unreadRooms(rooms, {}, { unreadFrom: new Set([AKI, BEN]) }), []);
});

test('a room with no last-seen time (a new browser) is unread only while the server still holds an unread notice', () => {
  const rooms = [dmRoom('r1', AKI, T2), dmRoom('r2', BEN, T2)];
  assert.deepEqual(rules.unreadRooms(rooms, {}).map((entry) => entry.room_id), []);
  assert.deepEqual(rules.unreadRooms(rooms, {}, { unreadFrom: new Set([BEN]) }).map((entry) => entry.room_id), ['r2']);
  // once there is a last-seen time, the time decides and the notice no longer matters
  assert.deepEqual(rules.unreadRooms(rooms, { r2: T2 }, { unreadFrom: new Set([BEN]) }), []);
});

test('bad input reads as nothing unread', () => {
  assert.deepEqual(rules.unreadRooms(null, null), []);
  assert.deepEqual(rules.unreadRooms([null, {}, { room_id: 'x' }], {}), []);
  assert.deepEqual(rules.unreadRooms([dmRoom('r1', AKI, 'not a time')], { r1: T1 }), []);
});

test('the last-seen time is kept per account, only moves forward, and survives a reload', () => {
  const storage = dmStorage();
  rules.markDmSeen(storage, ME, 'r1', T2);
  rules.markDmSeen(storage, ME, 'r1', T1);
  assert.equal(rules.readDmSeen(storage, ME).r1, T2, 'an older time does not move it back');
  rules.markDmSeen(storage, ME, 'r1', T3);
  assert.equal(rules.readDmSeen(storage, ME).r1, T3);
  assert.deepEqual(rules.readDmSeen(storage, AKI), {}, 'somebody else on this browser has their own');
  rules.resetDmSeenMemory();
  assert.equal(rules.readDmSeen(storage, ME).r1, T3, 'read back from the browser');
  assert.deepEqual(rules.readDmSeen(storage, null), {});
});

test('without usable storage the last-seen time lives in memory for this page load', () => {
  for (const storage of [null, dmStorage({ failRead: true, failWrite: true }), dmStorage({ failWrite: true })]) {
    rules.resetDmSeenMemory();
    assert.doesNotThrow(() => rules.markDmSeen(storage, ME, 'r1', T2));
    assert.equal(rules.readDmSeen(storage, ME).r1, T2);
  }
});

test('garbage in storage is ignored, and only the newest rooms are kept', () => {
  const storage = dmStorage();
  storage.map.set(rules.DM_SEEN_PREFIX + ME, 'not json');
  assert.deepEqual(rules.readDmSeen(storage, ME), {});
  storage.map.set(rules.DM_SEEN_PREFIX + ME, JSON.stringify([1, 2]));
  assert.deepEqual(rules.readDmSeen(storage, ME), {});
  for (let i = 0; i < rules.DM_SEEN_MAX + 5; i += 1) {
    const stamp = new Date(Date.UTC(2026, 9, 1) + i * 60000).toISOString();
    rules.markDmSeen(storage, ME, `room-${i}`, stamp);
  }
  const kept = rules.readDmSeen(storage, ME);
  assert.equal(Object.keys(kept).length, rules.DM_SEEN_MAX);
  assert.ok(kept[`room-${rules.DM_SEEN_MAX + 4}`], 'the newest stays');
  assert.equal(kept['room-0'], undefined, 'the oldest goes');
});

// ---------------------------------------------------------------- reactions to a message

const MSG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MSG2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('the six reactions have keys, emoji and Japanese names, in this order', () => {
  assert.deepEqual(rules.REACTIONS.map((entry) => entry.kind), ['heart', 'thumbs', 'laugh', 'wow', 'sad', 'pray']);
  assert.deepEqual(rules.REACTIONS.map((entry) => entry.label),
    ['ハート', 'いいね', '笑い', 'びっくり', '悲しい', 'ありがとう']);
  assert.equal(rules.reactionOf('heart').emoji, '❤️');
  assert.equal(rules.reactionOf('party'), null);
  assert.equal(rules.reactionOf('❤️'), null);   // the emoji itself is not a key
});

test('chips: one per kind, two people on the same kind is one chip with 2, mine is marked', () => {
  const rows = [
    { message_id: MSG, account_id: ME, kind: 'heart' },
    { message_id: MSG, account_id: AKI, kind: 'heart' },
    { message_id: MSG2, account_id: AKI, kind: 'pray' },
  ];
  assert.deepEqual(rules.reactionChips(rows, MSG, ME).map((chip) => [chip.kind, chip.count, chip.mine]),
    [['heart', 2, true]]);
  assert.deepEqual(rules.reactionChips(rows, MSG2, ME).map((chip) => [chip.kind, chip.count, chip.mine]),
    [['pray', 1, false]]);
  const both = rules.reactionChips([
    { message_id: MSG, account_id: ME, kind: 'pray' },
    { message_id: MSG, account_id: AKI, kind: 'thumbs' },
  ], MSG, ME);
  assert.deepEqual(both.map((chip) => chip.kind), ['thumbs', 'pray']);   // the order of the six, not of arrival
  assert.deepEqual(rules.reactionChips(null, MSG, ME), []);
  assert.deepEqual(rules.reactionChips([{ message_id: MSG, account_id: ME, kind: 'bogus' }], MSG, ME), []);
});

test('pressing: add, swap, and the same one again takes it off (one per person per message)', () => {
  let rows = [{ message_id: MSG, account_id: AKI, kind: 'wow' }];
  assert.equal(rules.myReaction(rows, MSG, ME), null);
  rows = rules.withMyReaction(rows, MSG, ME, 'heart');
  assert.equal(rules.myReaction(rows, MSG, ME), 'heart');
  assert.equal(rows.length, 2);
  rows = rules.withMyReaction(rows, MSG, ME, 'sad');
  assert.equal(rules.myReaction(rows, MSG, ME), 'sad');
  assert.equal(rows.length, 2);
  rows = rules.withMyReaction(rows, MSG, ME, 'sad');
  assert.equal(rules.myReaction(rows, MSG, ME), null);
  assert.deepEqual(rows, [{ message_id: MSG, account_id: AKI, kind: 'wow' }]);   // the other person's stays
  assert.deepEqual(rules.withMyReaction(rows, MSG, ME, 'party'), rows);          // an unknown key adds nothing
});

test('the signature changes only when a reaction changes', () => {
  const a = [{ message_id: MSG, account_id: ME, kind: 'heart' }, { message_id: MSG2, account_id: AKI, kind: 'pray' }];
  const same = [a[1], a[0]];
  assert.equal(rules.reactionSignature(a), rules.reactionSignature(same));
  assert.notEqual(rules.reactionSignature(a), rules.reactionSignature([a[0]]));
  assert.equal(rules.reactionSignature(null), '');
});

test('the answer of react_dm is read in either shape', () => {
  assert.equal(rules.readReact({ kind: 'heart' }), 'heart');
  assert.equal(rules.readReact([{ kind: 'pray' }]), 'pray');
  assert.equal(rules.readReact({ kind: null }), null);
  assert.equal(rules.readReact(null), null);
});

test('a missing table is told from an ordinary failure', () => {
  assert.equal(rules.reactionsMissing({ status: 404, message: 'x' }), false);
  assert.equal(rules.reactionsMissing({ status: 404, message: 'x' }, { rpc: true }), true);
  assert.equal(rules.reactionsMissing({ status: 404, message: 'PGRST205 relation public.dm_reactions' }), true);
  assert.equal(rules.reactionsMissing({ status: 400, message: 'x' }, { rpc: true }), false);
  assert.equal(rules.reactionsMissing({ status: 400, message: 'Could not find the table public.dm_reactions' }), true);
  assert.equal(rules.reactionsMissing({ status: 0, message: '接続できませんでした。' }), false);
  assert.equal(rules.reactionsMissing({ status: 500, message: 'boom' }), false);
  assert.equal(rules.reactionsMissing(null), false);
});

test('missing read-mark functions are told from an ordinary failure', () => {
  assert.equal(rules.dmReadMissing({ status: 404, message: 'x' }), true);
  assert.equal(rules.dmReadMissing({ status: 404, message: 'PGRST202 Could not find the function public.mark_dm_read' }), true);
  assert.equal(rules.dmReadMissing({ status: 400, message: 'Could not find the function public.dm_partner_read_at(room)' }), true);
  assert.equal(rules.dmReadMissing({ status: 500, message: 'boom' }), false);
  assert.equal(rules.dmReadMissing({ status: 0, message: '接続できませんでした。' }), false);
  assert.equal(rules.dmReadMissing(null), false);
});

test('the lifted message keeps its place when there is room, and moves in from the edges when there is not', () => {
  const mid = rules.liftLayout({ top: 300, height: 80 }, 800);
  assert.equal(mid.bubbleTop, 300);
  assert.equal(mid.barTop, 300 - 56 - 8);
  assert.equal(mid.copyTop, 300 + 80 + 8);
  const high = rules.liftLayout({ top: 20, height: 80 }, 800);      // no room above: everything moves down
  assert.equal(high.barTop, 12);
  assert.equal(high.bubbleTop, 12 + 56 + 8);
  const low = rules.liftLayout({ top: 760, height: 60 }, 800);      // no room below: everything moves up
  assert.equal(low.copyTop + 44, 800 - 12);
  assert.equal(low.bubbleHeight, 60);
  const tall = rules.liftLayout({ top: 100, height: 2000 }, 800);   // taller than the screen: cut to fit
  assert.equal(tall.barTop, 12);
  assert.equal(tall.copyTop + 44, 800 - 12);
  const plain = rules.liftLayout({ top: 300, height: 80 }, 800, { bar: 0 });   // no emoji row
  assert.equal(plain.bubbleTop, 300);
});

test('setting my reaction replaces mine and leaves the other person\'s alone', () => {
  const rows = [{ message_id: MSG, account_id: AKI, kind: 'wow' }, { message_id: MSG, account_id: ME, kind: 'sad' }];
  assert.equal(rules.myReaction(rules.setMyReaction(rows, MSG, ME, 'pray'), MSG, ME), 'pray');
  assert.equal(rules.setMyReaction(rows, MSG, ME, null).length, 1);
  assert.equal(rules.setMyReaction(rows, MSG, ME, 'sad').length, 2);
});

// ---------------------------------------------------------------- times, days and read marks in the thread

// Local-clock dates, so the tests pass in any time zone.
const at = (y, m, d, h = 12, mi = 0) => new Date(y, m - 1, d, h, mi, 0).toISOString();
const NOW = new Date(2026, 9, 31, 9, 30).getTime();   // 2026-10-31 (Sat) 9:30

test('clockText is the 24-hour clock with no zero before the hour', () => {
  assert.equal(rules.clockText(at(2026, 10, 31, 0, 53)), '0:53');
  assert.equal(rules.clockText(at(2026, 10, 31, 0, 0)), '0:00');
  assert.equal(rules.clockText(at(2026, 10, 31, 9, 5)), '9:05');
  assert.equal(rules.clockText(at(2026, 10, 30, 22, 41)), '22:41');
  assert.equal(rules.clockText(at(2026, 10, 30, 23, 59)), '23:59');
  assert.equal(rules.clockText('nonsense'), '');
  assert.equal(rules.clockText(null), '');
});

test('dayLabel: 今日, 昨日, month/day with the weekday, and the year when it is not this one', () => {
  assert.equal(rules.dayLabel(at(2026, 10, 31, 0, 1), NOW), '今日');
  assert.equal(rules.dayLabel(at(2026, 10, 31, 23, 59), NOW), '今日');
  assert.equal(rules.dayLabel(at(2026, 10, 30, 23, 59), NOW), '昨日');
  assert.equal(rules.dayLabel(at(2026, 10, 30, 0, 0), NOW), '昨日');
  assert.equal(rules.dayLabel(at(2026, 10, 29, 23, 59), NOW), '10/29(木)');
  assert.equal(rules.dayLabel(at(2026, 1, 3), NOW), '1/3(土)');
  assert.equal(rules.dayLabel(at(2025, 10, 30), NOW), '2025/10/30(木)');
  assert.equal(rules.dayLabel('nonsense', NOW), '');
  // across a year end: 昨日 is still 昨日
  assert.equal(rules.dayLabel(at(2025, 12, 31, 23, 0), new Date(2026, 0, 1, 0, 10).getTime()), '昨日');
  assert.equal(rules.dayLabel(at(2025, 12, 30, 23, 0), new Date(2026, 0, 1, 0, 10).getTime()), '2025/12/30(火)');
});

test('threadRows: a day mark first and at every change of day, close lines for the same speaker', () => {
  const m = (id, sender, stamp) => ({ id, sender_id: sender, body: id, created_at: stamp });
  const rows = rules.threadRows([
    m('a', AKI, at(2026, 10, 30, 22, 41)),
    m('b', ME, at(2026, 10, 31, 0, 51)),     // past midnight: a new day mark
    m('c', ME, at(2026, 10, 31, 0, 52)),
    m('d', AKI, at(2026, 10, 31, 0, 55)),
  ], { me: ME, now: NOW });
  assert.deepEqual(rows.map((row) => (row.type === 'day' ? row.label : `${row.message.id}${row.cont ? '+' : ''}${row.mine ? 'm' : ''}`)),
    ['昨日', 'a', '今日', 'b m', 'c+m', 'd'].map((x) => x.replace(' ', '')));
  assert.equal(rows.find((row) => row.message?.id === 'b').time, '0:51');
  assert.equal(rows.find((row) => row.message?.id === 'a').time, '22:41');
});

test('threadRows: the same speaker does not stay "close" across a day mark; an empty list is empty', () => {
  const m = (id, stamp) => ({ id, sender_id: AKI, body: id, created_at: stamp });
  const rows = rules.threadRows([m('a', at(2026, 10, 30, 23, 59)), m('b', at(2026, 10, 31, 0, 1))], { me: ME, now: NOW });
  assert.equal(rows.filter((row) => row.type === 'message')[1].cont, false);
  assert.deepEqual(rules.threadRows([], { me: ME, now: NOW }), []);
  assert.deepEqual(rules.threadRows(null, { me: ME }), []);
});

test('threadRows: 既読 only on my messages sent at or before partner_read_at', () => {
  const stamps = [at(2026, 10, 31, 8, 0), at(2026, 10, 31, 8, 5), at(2026, 10, 31, 8, 10)];
  const messages = [
    { id: 'a', sender_id: ME, created_at: stamps[0] },
    { id: 'b', sender_id: AKI, created_at: stamps[1] },
    { id: 'c', sender_id: ME, created_at: stamps[2] },
  ];
  const read = (partnerReadAt) => rules.threadRows(messages, { me: ME, now: NOW, partnerReadAt })
    .filter((row) => row.type === 'message').map((row) => row.read);
  assert.deepEqual(read(stamps[1]), [true, false, false]);
  assert.deepEqual(read(stamps[2]), [true, false, true]);
  assert.deepEqual(read(stamps[0]), [true, false, false], 'the same instant counts as read');
  assert.deepEqual(read(null), [false, false, false]);
  assert.deepEqual(read('nonsense'), [false, false, false]);
});

test('readToRecord: first time always (even an empty room), later only for something new, never while hidden', () => {
  const t1 = at(2026, 10, 31, 8, 5);
  const t2 = at(2026, 10, 31, 8, 9);
  const mine = { id: 'a', sender_id: ME, created_at: at(2026, 10, 31, 8, 0) };
  const theirs = (id, stamp) => ({ id, sender_id: AKI, created_at: stamp });
  assert.equal(rules.readToRecord({ messages: [], me: ME }), '', 'first time, empty room: goes, with nothing to remember');
  assert.equal(rules.readToRecord({ messages: [mine], me: ME }), '');
  assert.equal(rules.readToRecord({ messages: [mine, theirs('b', t1)], me: ME }), t1);
  assert.equal(rules.readToRecord({ messages: [mine, theirs('b', t1)], me: ME, marked: t1 }), null, 'nothing new');
  assert.equal(rules.readToRecord({ messages: [mine], me: ME, marked: '' }), null);
  assert.equal(rules.readToRecord({ messages: [mine, theirs('b', t1), theirs('c', t2)], me: ME, marked: t1 }), t2);
  assert.equal(rules.readToRecord({ messages: [theirs('b', t1)], me: ME, visible: false }), null, 'hidden: wait');
  assert.equal(rules.readToRecord({ messages: [theirs('b', t1)], me: ME, marked: null, visible: true }), t1);
});
