import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// メンバー限定（members_only）の画面のきまり。スイッチが切れている間は、これまでと同じ答えになること。

const read = (url) => readFile(new URL(url, import.meta.url), 'utf8');
const source = await read('../../web/js/community-rules.js');
const rules = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const configSource = await read('../../web/js/config.js');
const configRules = await import(`data:text/javascript;base64,${Buffer.from(configSource).toString('base64')}`);
const notifySource = await read('../../web/js/notify-rules.js');
const notify = await import(`data:text/javascript;base64,${Buffer.from(notifySource).toString('base64')}`);

const A = { id: 'a', slug: 'a', name: 'A', role: 'member' };
const B = { id: 'b', slug: 'b', name: 'B', role: 'member' };

const off = { features: { communities: true, members_only: false }, invite_only: false };
const on = { features: { communities: true, members_only: true }, invite_only: false };
const noCommunities = { features: { communities: false, members_only: true } };

test('membersOnlyOn needs communities and the switch together', () => {
  assert.equal(rules.membersOnlyOn(on), true);
  assert.equal(rules.membersOnlyOn(off), false);
  assert.equal(rules.membersOnlyOn(noCommunities), false, 'the switch means nothing without communities');
  assert.equal(rules.membersOnlyOn({ features: { communities: true } }), false, 'an old server says nothing: off');
  assert.equal(rules.membersOnlyOn(null), false);
});

test('welcome: the browse button goes and a line about invite links takes its place, only when the switch is on', () => {
  assert.deepEqual(rules.browseView(off), { canBrowse: true, note: '' });
  const view = rules.browseView(on);
  assert.equal(view.canBrowse, false);
  assert.match(view.note, /招待リンク/);
  assert.match(view.note, /コミュニティの人/);
});

test('mapScope: switch off keeps the read-only look; on, a community I am not in is a notice', () => {
  const linkedZ = { id: 'z', name: 'Z' };
  assert.deepEqual(rules.mapScope({ on: true, communities: [A], current: 'a', linked: linkedZ }),
    { mode: 'viewing', id: 'z', name: 'Z' }, 'off: as before');
  assert.deepEqual(rules.mapScope({ on: true, communities: [A], current: 'a', linked: linkedZ, membersOnly: true }),
    { mode: 'none', reason: 'closed' });
  assert.deepEqual(rules.mapScope({ on: true, communities: [], linked: linkedZ, membersOnly: true }),
    { mode: 'none', reason: 'closed' });
  // a post of a community I am in is opened as before
  assert.deepEqual(rules.mapScope({ on: true, communities: [A, B], current: 'a', linked: { id: 'b', name: 'B' }, membersOnly: true }),
    { mode: 'community', id: 'b', name: 'B' });
  // 'viewing' is retired: a remembered one is not used
  assert.deepEqual(rules.mapScope({ on: true, communities: [], viewing: { id: 'z', name: 'Z' }, membersOnly: true }),
    { mode: 'none', reason: 'not-member' });
  assert.equal(rules.mapScope({ on: true, communities: [A], current: 'a', viewing: { id: 'z' }, membersOnly: true }).mode, 'community');
  // a link that could not be read (missing and not allowed alike)
  assert.deepEqual(rules.mapScope({ on: true, communities: [A], current: 'a', membersOnly: true, closed: true }),
    { mode: 'none', reason: 'closed' });
  assert.equal(rules.mapScope({ on: true, communities: [A], current: 'a', membersOnly: false, closed: true }).mode, 'community',
    'switch off: closed means nothing');
  assert.deepEqual(rules.mapScope({ on: false, communities: [], membersOnly: true, closed: true }), { mode: 'legacy' });
});

test('linkIsClosed: missing and not allowed look alike; a bad connection is not "closed"', () => {
  assert.equal(rules.linkIsClosed({ signedIn: true, found: true }), false);
  assert.equal(rules.linkIsClosed({ signedIn: true, found: false, status: null }), true, 'nothing came back');
  assert.equal(rules.linkIsClosed({ signedIn: true, found: false, status: 404 }), true);
  assert.equal(rules.linkIsClosed({ signedIn: true, found: false, status: 403 }), true);
  assert.equal(rules.linkIsClosed({ signedIn: true, found: false, status: 401 }), false, 'the session ran out: the app signs out by itself');
  assert.equal(rules.linkIsClosed({ signedIn: true, found: false, status: 422 }), true);
  assert.equal(rules.linkIsClosed({ signedIn: true, found: false, status: 0 }), false, 'offline');
  assert.equal(rules.linkIsClosed({ signedIn: true, found: false, status: 503 }), false, 'server trouble');
  assert.equal(rules.linkIsClosed({ signedIn: false, found: false }), true);
});

test('the notice for a closed link is the same sentence however it came to be, with a way in', () => {
  const closed = { mode: 'none', reason: 'closed' };
  const signedOut = rules.mapNotice(closed, { signedIn: false, membersOnly: true });
  const signedIn = rules.mapNotice(closed, { signedIn: true, membersOnly: true });
  assert.equal(signedOut.title, 'このコミュニティのメンバーだけが見られます');
  assert.equal(signedIn.title, 'このコミュニティのメンバーだけが見られます');
  assert.match(signedOut.sub, /ログイン/);
  assert.match(signedOut.sub, /招待リンク/);
  assert.match(signedIn.sub, /招待リンク/);
  assert.equal(signedOut.login, true);
  assert.equal(signedIn.login, false);
  assert.equal(signedIn.home, true, 'a member can go back to their own map');
  assert.equal(signedOut.home, false);
  // nothing in it says whether the post exists
  for (const notice of [signedOut, signedIn]) assert.doesNotMatch(`${notice.title}${notice.sub}`, /見つかりません|存在|削除/);
});

test('signed out on the map: a calm notice with sign-in (members only); off, the words it had', () => {
  const none = { mode: 'none', reason: 'not-member' };
  const notice = rules.mapNotice(none, { signedIn: false, membersOnly: true });
  assert.match(notice.title, /メンバーだけ/);
  assert.equal(notice.login, true);
  assert.equal(notice.home, false);
  const before = rules.mapNotice(none, { signedIn: false, inviteOnly: true });
  assert.equal(before.title, rules.INVITE_ONLY_NOTE);
  assert.equal(before.home, false);
  // signed in, in no community: unchanged
  assert.equal(rules.mapNotice(none, { signedIn: true, membersOnly: true }).title, rules.NOT_MEMBER_NOTE);
  // a failed read of my communities is still a retry, not a verdict
  assert.equal(rules.mapNotice(none, { signedIn: true, known: false, membersOnly: true }).retry, true);
  // no notice while there is a map
  assert.equal(rules.mapNotice({ mode: 'community', id: 'a', name: 'A' }, { signedIn: true, membersOnly: true }), null);
});

test('profiles: another person shows only posts of communities we share; my own page shows all', () => {
  const posts = [
    { id: '1', community_id: 'a' }, { id: '2', community_id: 'z' }, { id: '3', community_id: null }, { id: '4', community_id: 'b' },
  ];
  const mine = [A, B];
  assert.deepEqual(rules.visiblePostsOf(posts, { own: false, communities: mine, membersOnly: true }).map((p) => p.id), ['1', '4']);
  assert.deepEqual(rules.visiblePostsOf(posts, { own: true, communities: mine, membersOnly: true }).map((p) => p.id), ['1', '2', '3', '4']);
  assert.deepEqual(rules.visiblePostsOf(posts, { own: false, communities: mine, membersOnly: false }).map((p) => p.id), ['1', '2', '3', '4'],
    'switch off: not filtered');
  assert.deepEqual(rules.visiblePostsOf(posts, { own: false, communities: [], membersOnly: true }), []);
  assert.deepEqual(rules.visiblePostsOf(null, { own: false, communities: mine, membersOnly: true }), []);
});

test('profile note: other people\'s pages say it; my own page and the switch off do not', () => {
  assert.equal(rules.profileNote({ own: false, membersOnly: true }), '共通のコミュニティの投稿だけが表示されます');
  assert.equal(rules.profileNote({ own: true, membersOnly: true }), '');
  assert.equal(rules.profileNote({ own: false, membersOnly: false }), '');
});

test('communityNameIn finds a name in my list and is quiet otherwise', () => {
  assert.equal(rules.communityNameIn([A, B], 'b'), 'B');
  assert.equal(rules.communityNameIn([A, B], 'z'), '');
  assert.equal(rules.communityNameIn([A, B], null), '');
  assert.equal(rules.communityNameIn(null, 'a'), '');
});

test('notification rows: a 「話してみたい」 row never names a community; the DM rows do not either', () => {
  assert.equal(notify.communityIdOf({ type: 'talk_wish', community_id: 'a', post_id: 'p' }), '');
  assert.equal(notify.communityIdOf({ type: 'talk_match', community_id: 'a' }), '');
  assert.equal(notify.communityIdOf({ type: 'dm', community_id: 'a' }), '');
  assert.equal(notify.communityIdOf({ type: 'like', community_id: 'a', post_id: 'p' }), 'a', 'the row says');
  assert.equal(notify.communityIdOf({ type: 'island', community_id: 'b' }), 'b');
  assert.equal(notify.communityIdOf({ type: 'like', post_id: 'p' }, { p: 'c' }), 'c', 'else the post\'s');
  assert.equal(notify.communityIdOf({ type: 'like', post_id: 'p' }, { q: 'c' }), '');
  assert.equal(notify.communityIdOf({ type: 'like', post_id: 'p', community_id: 'a' }, { p: 'c' }), 'a', 'the row first');
  assert.equal(notify.communityIdOf(null), '');
});

test('the screens send the session on every read the server now gates', async () => {
  const map = await read('../../web/js/screens/map.js');
  const profile = await read('../../web/js/screens/profile.js');
  const compose = await read('../../web/js/screens/compose.js');
  const net = await read('../../web/js/net.js');
  // every read sends the session now: even the invite check, so a removed or refused person is told it needs approval
  for (const [name, text] of [['map.js', map], ['profile.js', profile], ['compose.js', compose]]) {
    assert.doesNotMatch(text, /auth:\s*false/, `${name} reads without the session`);
  }
  const unsent = [...net.matchAll(/^.*auth:\s*false.*$/gm)].map((m) => m[0].trim());
  assert.equal(unsent.length, 0, unsent.join('\n'));
  // terrain and islands say which community they are for
  assert.match(map, /scoped\(\) && membersOnly\(\)\) params\.set\('community', scope\.id\)/);
  assert.match(map, /\/api\/islands\?\$\{new URLSearchParams\(\{ community: scope\.id \}\)\}/);
  assert.match(compose, /\/api\/islands\?\$\{new URLSearchParams\(\{ community: scope\.id \}\)\}/);
});

// ---- 敵対レビューで見つかったもの

test('読めないリンク: 401（セッション切れ）・一覧が読めていない・自分の投稿は「メンバーだけ」にしない', () => {
  const base = { signedIn: true, found: false };
  assert.equal(rules.linkIsClosed({ ...base, status: 404 }), true, '普通の「読めない」は案内');
  assert.equal(rules.linkIsClosed({ ...base, status: 401 }), false, 'セッション切れは案内ではない');
  assert.equal(rules.linkIsClosed({ ...base, status: 0 }), false);
  assert.equal(rules.linkIsClosed({ ...base, status: 503 }), false);
  assert.equal(rules.linkIsClosed({ ...base, status: 404, listKnown: false }), false, '自分の一覧が読めていない間は決めない');
  assert.equal(rules.linkIsClosed({ ...base, status: null, mine: true }), false, 'コミュニティのない自分の投稿');
  assert.equal(rules.linkIsClosed({ signedIn: false, found: false }), true, 'ログインなしは今まで通り案内');
});

test('留守のあいだ: 「入」のときは、いま見ているコミュニティの出来事だけ。「切」は全部', () => {
  const rows = [{ id: 1, community_id: 'a' }, { id: 2, community_id: 'b' }, { id: 3, community_id: 'a' }];
  assert.deepEqual(rules.changesInScope(rows, { membersOnly: true, communityId: 'a' }).map((r) => r.id), [1, 3]);
  assert.deepEqual(rules.changesInScope(rows, { membersOnly: true, communityId: 'b' }).map((r) => r.id), [2]);
  assert.deepEqual(rules.changesInScope(rows, { membersOnly: true, communityId: null }), []);
  assert.equal(rules.changesInScope(rows, { membersOnly: false, communityId: 'a' }).length, 3);
  assert.deepEqual(rules.changesInScope(null, { membersOnly: true, communityId: 'a' }), []);
});

test('スイッチの入り切りが変わったかを見分ける（開いたままのページ用）', () => {
  assert.equal(configRules.switchChanged(off, on), true);
  assert.equal(configRules.switchChanged(on, off), true);
  assert.equal(configRules.switchChanged(on, on), false);
  assert.equal(configRules.switchChanged(off, off), false);
  assert.equal(configRules.switchChanged(null, on), false, '最初の読み込みは変化ではない');
  assert.equal(configRules.switchChanged(on, { features: {} }), true);
});
