import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/notify-rules.js', import.meta.url), 'utf8');
const rules = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const config = await readFile(new URL('../../core/config.py', import.meta.url), 'utf8');
const app = await readFile(new URL('../../app.py', import.meta.url), 'utf8');

const UID = '11111111-1111-4111-8111-111111111111';
const TOPIC = rules.topicFor(UID);

// ---------------------------------------------------------------- kinds and switches

test('every kind belongs to the category the server files it under', () => {
  const block = config.match(/NOTIFICATION_CATEGORY_OF\s*=\s*\{([\s\S]*?)\}/)[1];
  const server = Object.fromEntries([...block.matchAll(/"(\w+)":\s*"(\w+)"/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual({ ...rules.CATEGORY_OF }, server);
  assert.equal(rules.categoryOf('quiet_post'), 'island');
  assert.equal(rules.categoryOf('island'), 'island');
});

test('the list says what the lock screen says', () => {
  const block = app.match(/PUSH_TEXT = \{([\s\S]*?)\n\}/)[1];
  const pushed = Object.fromEntries([...block.matchAll(/"(\w+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
  for (const [kind, text] of Object.entries(pushed)) assert.equal(rules.KIND_TEXT[kind], text, kind);
  assert.equal(rules.GROUP_TEXT, app.match(/PUSH_GROUP_TEXT = "([^"]+)"/)[1]);
  assert.ok(!/反応がない|反応がありません|だれも/.test(rules.KIND_TEXT.quiet_post));
});

test('three switches, all on until somebody turns one off', () => {
  assert.deepEqual(rules.CATEGORIES.map((c) => c.id), ['reply', 'reaction', 'island']);
  const settings = rules.defaultSettings();
  for (const { id } of rules.CATEGORIES) assert.deepEqual(settings[id], { push: true, in_app: true });
});

test('saved settings override the defaults, and odd shapes do not break anything', () => {
  const merged = rules.mergeSettings({ reaction: { push: false, in_app: true }, island: { in_app: false }, bogus: {} });
  assert.deepEqual(merged.reaction, { push: false, in_app: true });
  assert.deepEqual(merged.island, { push: true, in_app: false });
  assert.deepEqual(merged.reply, { push: true, in_app: true });
  assert.equal('bogus' in merged, false);
  assert.deepEqual(rules.mergeSettings(null), rules.defaultSettings());
  assert.deepEqual(rules.mergeSettings('nope'), rules.defaultSettings());
  const rows = rules.settingsRows(merged);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find((row) => row.category === 'island'), { category: 'island', push: true, in_app: false });
});

test('a kind switched off in the app stays listed but never interrupts', () => {
  const settings = rules.mergeSettings({ reaction: { push: true, in_app: false } });
  assert.equal(rules.interrupts({ type: 'like' }, settings), false);
  assert.equal(rules.interrupts({ type: 'join' }, settings), false);
  assert.equal(rules.interrupts({ type: 'comment' }, settings), true);
});

test('quiet_post follows the island switch, and a saved similar-off row holds it back', () => {
  const quiet = { type: 'quiet_post' };
  assert.equal(rules.interrupts(quiet, rules.mergeSettings(null)), true);
  assert.equal(rules.interrupts(quiet, rules.mergeSettings({ island: { in_app: false } })), false);
  assert.equal(rules.interrupts(quiet, rules.mergeSettings({ island: { in_app: true }, similar: { push: true, in_app: false } })), false);
  assert.equal(rules.interrupts(quiet, rules.mergeSettings({ island: { in_app: true }, similar: { push: false, in_app: true } })), true);
  assert.equal(rules.interrupts(quiet, {}), true);
  assert.match(rules.CATEGORIES.find((c) => c.id === 'island').note, /近くの投稿/);
});

test('the server verdict quiet_post:false holds nearby posts back, in the real API shape', () => {
  // GET /api/notification-settings: three rows, no similar, quiet_post on top.
  const rows = {
    reply: { push: true, in_app: true }, reaction: { push: true, in_app: true },
    island: { push: true, in_app: true },
  };
  const quiet = { type: 'quiet_post', unread: true, id: 'q1' };
  const like = { type: 'like', unread: true, id: 'l1' };
  const off = rules.mergeSettings(rows, false);
  assert.equal(rules.interrupts(quiet, off), false);
  assert.equal(rules.interrupts(like, off), true);
  assert.equal(rules.unreadCount([quiet, like], off), 1);
  // true / missing: the island switch alone decides.
  assert.equal(rules.interrupts(quiet, rules.mergeSettings(rows, true)), true);
  assert.equal(rules.interrupts(quiet, rules.mergeSettings(rows)), true);
  // Island off: off either way, and nothing is invented.
  const islandOff = { ...rows, island: { push: true, in_app: false } };
  assert.equal(rules.interrupts(quiet, rules.mergeSettings(islandOff, false)), false);
  assert.equal(rules.mergeSettings(islandOff, false).similar, undefined);
  // A later edit of another switch keeps the verdict.
  const again = rules.mergeSettings(off);
  again.reaction.in_app = false;
  assert.equal(rules.interrupts(quiet, again), false);
});

test('kinds that lost their switch: old rows only list', () => {
  const settings = rules.mergeSettings({ reaction: { push: false, in_app: false } });
  assert.equal(rules.interrupts({ type: 'quiet_post' }, settings), true);
  assert.equal(rules.interrupts({ type: 'connection' }, settings), false);
  assert.equal(rules.interrupts({ type: 'similar' }, settings), false);
  // The text of an old row is still there to be read.
  assert.ok(rules.bodyText({ type: 'connection', payload: {} }));
});

// ---------------------------------------------------------------- the list

const like = (fields) => ({ id: 'n1', type: 'like', category: 'reaction', post_id: 'p1', payload: {},
  actors: [{ id: 'a', display_name: 'あおい' }], others: 0, unread: true, ids: ['n1'], ...fields });

test('a group names the newest person and counts the rest', () => {
  assert.equal(rules.headline(like()), 'あおい');
  assert.equal(rules.bodyText(like()), rules.KIND_TEXT.like);
  const group = like({ others: 2, actors: [{ display_name: 'あおい' }, { display_name: 'b' }, { display_name: 'c' }] });
  assert.equal(rules.headline(group), 'あおい ほか2人');
  assert.equal(rules.bodyText(group), 'あなたの投稿に反応しました。');
  assert.equal(rules.headline(like({ actors: [] })), 'だれか');
});

test('an island names itself and says what happened to it', () => {
  const island = { type: 'island', payload: { name: 'キャンプ島', cause: '2つの島がつながりました' }, actors: [] };
  assert.equal(rules.headline(island), '島「キャンプ島」');
  assert.equal(rules.bodyText(island), '2つの島がつながりました。');
  assert.equal(rules.headline({ type: 'island', payload: {} }), '島');
  assert.equal(rules.bodyText({ type: 'island', payload: {} }), '島が変わりました。');
});

test('a quiet post reads as a recommendation', () => {
  const quiet = { type: 'quiet_post', payload: { message: '近くの島に、話が合いそうな投稿があります。' }, actors: [] };
  assert.equal(rules.bodyText(quiet), '近くの島に、話が合いそうな投稿があります。');
  assert.equal(rules.bodyText({ type: 'quiet_post', payload: {} }), rules.KIND_TEXT.quiet_post);
});

test('the feed carries only the newest actor id; the face is put on afterwards', () => {
  const rows = [{ id: 'n1', actor_id: 'a' }, { id: 'n2', actor_id: 'gone' }, { id: 'n3', actor_id: null },
    { id: 'n4', actors: [{ id: 'z' }] }];
  const faced = rules.attachActors(rows, [{ id: 'a', display_name: 'あおい' }]);
  assert.deepEqual(faced[0].actors, [{ id: 'a', display_name: 'あおい' }]);
  assert.deepEqual(faced[1].actors, []);
  assert.deepEqual(faced[2].actors, []);
  assert.deepEqual(faced[3].actors, [{ id: 'z' }]);
});

test('the badge counts unread entries that may interrupt, not rows', () => {
  const settings = rules.mergeSettings({ island: { in_app: false } });
  const entries = [like({ ids: ['n1', 'n2', 'n3'] }), like({ id: 'n4', ids: ['n4'], unread: false }),
    { id: 'n5', type: 'island', unread: true, ids: ['n5'] }, { id: 'n6', type: 'comment', unread: true }];
  assert.equal(rules.unreadCount(entries, settings), 2);
  assert.deepEqual([...rules.knownIds(entries)].sort(), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
});

test('only rows not seen before arrive, and the first load arrives nothing', () => {
  const settings = rules.defaultSettings();
  const before = [like({ ids: ['n1'] })];
  assert.deepEqual(rules.arrivals(before, null, settings), []);
  const seen = rules.knownIds(before);
  assert.deepEqual(rules.arrivals(before, seen, settings), []);
  // A second like joins the group: the same entry, with a new row in it.
  const after = [like({ id: 'n2', ids: ['n2', 'n1'], others: 1 })];
  assert.equal(rules.arrivals(after, seen, settings).length, 1);
  // Read elsewhere, or switched off in the app: no band.
  assert.equal(rules.arrivals([like({ id: 'n2', ids: ['n2'], unread: false })], seen, settings).length, 0);
  const off = rules.mergeSettings({ reaction: { in_app: false } });
  assert.equal(rules.arrivals(after, seen, off).length, 0);
});

// ---------------------------------------------------------------- realtime

test('the socket address and the channel are this person’s', () => {
  assert.equal(rules.socketUrl('https://abc.supabase.co/', 'anon key'),
    'wss://abc.supabase.co/realtime/v1/websocket?apikey=anon%20key&vsn=1.0.0');
  assert.equal(rules.socketUrl('http://127.0.0.1:54321', 'k'),
    'ws://127.0.0.1:54321/realtime/v1/websocket?apikey=k&vsn=1.0.0');
  const join = rules.joinFrame(TOPIC, UID, 'jwt', 1);
  assert.equal(join.event, 'phx_join');
  assert.equal(join.ref, '1');
  assert.equal(join.join_ref, '1');
  assert.equal(join.payload.access_token, 'jwt');
  assert.deepEqual(join.payload.config.postgres_changes,
    [{ event: 'INSERT', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${UID}` }]);
  assert.deepEqual(rules.heartbeatFrame(7), { topic: 'phoenix', event: 'heartbeat', payload: {}, ref: '7' });
  assert.deepEqual(rules.tokenFrame(TOPIC, 't2', 8).payload, { access_token: 't2' });
});

test('frames from the socket are read as what they mean', () => {
  const read = (frame) => rules.readFrame(JSON.stringify(frame), TOPIC, '1');
  assert.deepEqual(read({ topic: TOPIC, event: 'phx_reply', ref: '1', payload: { status: 'ok', response: {} } }),
    { kind: 'joined' });
  assert.equal(read({ topic: TOPIC, event: 'phx_reply', ref: '1',
    payload: { status: 'error', response: { reason: 'unauthorized' } } }).reason, 'unauthorized');
  assert.equal(read({ topic: TOPIC, event: 'phx_reply', ref: '9', payload: { status: 'ok' } }).kind, 'ignore');
  const record = { id: 'n1', recipient_id: UID, type: 'like' };
  assert.deepEqual(read({ topic: TOPIC, event: 'postgres_changes', ref: null,
    payload: { data: { type: 'INSERT', table: 'notifications', schema: 'public', record } } }),
  { kind: 'insert', record });
  assert.equal(read({ topic: TOPIC, event: 'postgres_changes',
    payload: { data: { type: 'UPDATE', table: 'notifications' } } }).kind, 'ignore');
  assert.equal(read({ topic: TOPIC, event: 'system',
    payload: { status: 'ok', message: 'Subscribed to PostgreSQL' } }).kind, 'ignore');
  assert.equal(read({ topic: TOPIC, event: 'system',
    payload: { status: 'error', message: 'Token has expired' } }).kind, 'failed');
  assert.equal(read({ topic: TOPIC, event: 'phx_close', payload: {} }).kind, 'closed');
  assert.equal(read({ topic: TOPIC, event: 'phx_error', payload: {} }).kind, 'closed');
  assert.deepEqual(read({ topic: 'phoenix', event: 'phx_reply', ref: '5', payload: { status: 'ok' } }),
    { kind: 'heartbeat', ref: '5' });
  assert.equal(read({ topic: 'realtime:other', event: 'phx_close', payload: {} }).kind, 'ignore');
  assert.equal(read({ topic: TOPIC, event: 'presence_state', payload: {} }).kind, 'ignore');
  assert.equal(rules.readFrame('not json', TOPIC, '1').kind, 'ignore');
  assert.equal(rules.readFrame('null', TOPIC, '1').kind, 'ignore');
});

test('reconnecting waits longer each time, up to a minute', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(rules.retryDelay), [2000, 5000, 15000, 30000, 60000, 60000, 60000]);
  assert.equal(rules.retryDelay(-1), 2000);
});

// ---------------------------------------------------------------- push

const IPHONE_17 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPHONE_16_3 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const MAC_SAFARI = IPAD_DESKTOP;
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const able = { hasWorker: true, hasPush: true, permission: 'default' };

test('an iPhone needs the app on its Home Screen, and iOS 16.4 or later', () => {
  assert.equal(rules.pushSupport({ userAgent: IPHONE_17, maxTouchPoints: 5 }), 'ios-install');
  assert.equal(rules.pushSupport({ userAgent: IPHONE_17, maxTouchPoints: 5, standalone: true, ...able }), 'ready');
  assert.equal(rules.pushSupport({ userAgent: IPHONE_16_3, maxTouchPoints: 5, standalone: true, ...able }), 'ios-old');
  // An iPad asking for the desktop page still says which Safari it is.
  assert.equal(rules.pushSupport({ userAgent: IPAD_DESKTOP, maxTouchPoints: 5 }), 'ios-install');
  // The same words on a Mac, with no touch: a desktop browser like any other.
  assert.equal(rules.pushSupport({ userAgent: MAC_SAFARI, maxTouchPoints: 0, ...able }), 'ready');
  assert.equal(rules.iosVersion(IPHONE_17), 17.04);
  assert.equal(rules.iosVersion(ANDROID), null);
});

test('elsewhere it is down to the browser and the permission', () => {
  assert.equal(rules.pushSupport({ userAgent: ANDROID, ...able }), 'ready');
  assert.equal(rules.pushSupport({ userAgent: ANDROID, ...able, permission: 'denied' }), 'blocked');
  assert.equal(rules.pushSupport({ userAgent: ANDROID, hasWorker: true, hasPush: false }), 'unsupported');
  assert.equal(rules.pushSupport({}), 'unsupported');
});

test('an iPhone browser that is not Safari gets pointed at Safari', () => {
  assert.equal(rules.iosOtherBrowser(IPHONE_CHROME), true);
  assert.equal(rules.iosOtherBrowser(`${IPHONE_17} Line/14.5.0`), true);
  assert.equal(rules.iosOtherBrowser(IPHONE_17), false);
});

test('the server key turns into bytes, and a subscription knows its key', () => {
  const bytes = rules.keyBytes('BAEC_-8');
  assert.deepEqual([...bytes], [4, 1, 2, 255, 239]);
  assert.equal(rules.sameKey(new Uint8Array([4, 1, 2, 255, 239]).buffer, bytes), true);
  assert.equal(rules.sameKey(new Uint8Array([4, 1, 2]).buffer, bytes), false);
  assert.equal(rules.sameKey(null, bytes), false);
});

// ---------------------------------------------------------------- presence

test('on screen only when signed in, visible and in front', () => {
  assert.equal(rules.presenceSeconds({ signedIn: true, visible: true, focused: true }, 75), 75);
  assert.equal(rules.presenceSeconds({ signedIn: true, visible: true, focused: false }, 75), 0);
  assert.equal(rules.presenceSeconds({ signedIn: true, visible: false, focused: true }, 75), 0);
  assert.equal(rules.presenceSeconds({ signedIn: false, visible: true, focused: true }, 75), 0);
});

test('presence is sent when it changes and repeated before it runs out', () => {
  const every = 30000;
  assert.equal(rules.shouldSendPresence(75, null, 0, 0, every), true);
  assert.equal(rules.shouldSendPresence(0, null, 0, 0, every), false);
  assert.equal(rules.shouldSendPresence(75, 75, 0, every - 1, every), false);
  assert.equal(rules.shouldSendPresence(75, 75, 0, every, every), true);
  assert.equal(rules.shouldSendPresence(0, 75, 0, 1, every), true);
  assert.equal(rules.shouldSendPresence(0, 0, 0, every * 10, every), false);
  assert.equal(rules.shouldSendPresence(75, 0, 0, 1, every), true);
});
