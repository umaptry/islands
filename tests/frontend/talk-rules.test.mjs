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
const LABEL = '話してみたい';

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
  assert.ok(!code.includes(LABEL), 'the name 話してみたい must come from /api/config');
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

test('the words on the button, per state', () => {
  assert.deepEqual(rules.talkButtonText('none', LABEL), { word: LABEL, note: '' });
  const pressed = rules.talkButtonText('pressed', LABEL);
  assert.equal(pressed.word, `${LABEL}（押しました）`);
  assert.equal(pressed.note, '押したことは相手には見えません。お互いに押すと DM が開きます');
  assert.deepEqual(rules.talkButtonText('matched', LABEL), { word: 'DM を開く', note: '' });
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
    rules.PRESSED_NOTE,
    ...Object.values(rules.talkButtonText('pressed', LABEL)),
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
    `同じ会で、お互いに『${LABEL}』を押しました。この DM は2人だけが見られます`);
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
