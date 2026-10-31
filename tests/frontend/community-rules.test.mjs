import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/community-rules.js', import.meta.url), 'utf8');
const rules = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const CODE = 'Xk3v9QpL2mZr8TnA5bYc7WdE';   // 24 random-looking characters
const POST = '6f1c1b0e-5a53-4a43-9a52-3b8f0c2d9e11';
const HOUR = 3600 * 1000;

const fakeStorage = ({ failRead = false, failWrite = false } = {}) => {
  const map = new Map();
  return {
    getItem: (key) => { if (failRead) throw new Error('blocked'); return map.has(key) ? map.get(key) : null; },
    setItem: (key, value) => { if (failWrite) throw new Error('blocked'); map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    map,
  };
};

const on = { features: { communities: true }, invite_only: false };
const closed = { features: { communities: true }, invite_only: true };
const off = { features: { communities: false }, invite_only: true };

test.beforeEach(() => {
  rules.resetInviteMemory();
  rules.resetCommunityMemory();
});

// ---------------------------------------------------------------- availability

test('communities are on only when the server says so; invite_only means nothing without them', () => {
  assert.equal(rules.communitiesOn(on), true);
  assert.equal(rules.communitiesOn(off), false);
  assert.equal(rules.communitiesOn({ features: {} }), false);
  assert.equal(rules.communitiesOn(null), false);
  assert.equal(rules.communitiesOn({ features: { communities: 'yes' } }), false, 'only true counts');
  assert.equal(rules.inviteOnlyOn(closed), true);
  assert.equal(rules.inviteOnlyOn(on), false);
  assert.equal(rules.inviteOnlyOn(off), false, 'invite_only true but communities off: today\'s behaviour');
});

// ---------------------------------------------------------------- the address

test('#/invite/<code> and ?post= are read; anything else is not', () => {
  assert.deepEqual(rules.parseInviteHash(`#/invite/${CODE}`), { code: CODE, post: null });
  assert.deepEqual(rules.parseInviteHash(`#/invite/${CODE}?post=${POST}`), { code: CODE, post: POST });
  assert.deepEqual(rules.parseInviteHash(`#/invite/${CODE}?x=1&post=${POST}`), { code: CODE, post: POST });
  assert.equal(rules.parseInviteHash('#/map'), null);
  assert.equal(rules.parseInviteHash('#/invite/'), null);
  assert.equal(rules.parseInviteHash(`#/invite/${CODE}/x`), null);
  assert.equal(rules.parseInviteHash(`#/me?code=${CODE}`), null);
  assert.equal(rules.parseInviteHash(''), null);
  assert.equal(rules.parseInviteHash(undefined), null);
});

test('a code or post id that could be markup or a path is refused', () => {
  for (const bad of ['<script>', 'a/b', '../x', 'a b', 'abc', 'x'.repeat(129), 'あいうえおかき']) {
    assert.equal(rules.validInviteCode(bad), false, bad);
    assert.equal(rules.parseInviteHash(`#/invite/${encodeURIComponent(bad)}`), null, bad);
  }
  assert.equal(rules.parseInviteHash('#/invite/%E0%A4%A'), null, 'a broken escape is not a code');
  assert.deepEqual(rules.parseInviteHash(`#/invite/${CODE}?post=${encodeURIComponent('<x>')}`), { code: CODE, post: null },
    'a bad post id drops the post and keeps the invite');
  assert.equal(rules.validInviteCode(42), false);
});

test('the link an admin hands out round-trips', () => {
  assert.equal(rules.inviteHashFor(CODE), `#/invite/${CODE}`);
  assert.equal(rules.inviteHashFor(CODE, POST), `#/invite/${CODE}?post=${POST}`);
  assert.equal(rules.inviteHashFor('<x>', POST), '#/welcome');
  assert.equal(rules.inviteUrlFor('https://islands.example/', CODE, POST), `https://islands.example/#/invite/${CODE}?post=${POST}`);
  assert.equal(rules.inviteUrlFor('https://islands.example', CODE), `https://islands.example/#/invite/${CODE}`);
  assert.deepEqual(rules.parseInviteHash(`#${rules.inviteUrlFor('https://x.example', CODE, POST).split('#')[1]}`), { code: CODE, post: POST });
});

// ---------------------------------------------------------------- remembering an invite (Google round trip)

test('the invite and its post survive a Google round trip (a new page load)', () => {
  const storage = fakeStorage();
  assert.equal(rules.savePendingInvite(storage, { code: CODE, post: POST }, 1000), true);
  rules.resetInviteMemory();   // the page is gone; only the storage is left
  assert.deepEqual(rules.readPendingInvite(storage, 2000), { code: CODE, post: POST });
  assert.deepEqual(rules.readPendingInvite(storage, 2000), { code: CODE, post: POST }, 'reading does not use it up');
  assert.deepEqual(rules.takePendingInvite(storage, 3000), { code: CODE, post: POST });
  assert.equal(rules.readPendingInvite(storage, 3000), null, 'taken once');
  assert.equal(storage.map.size, 0);
});

test('an invite without a post is kept as such; a bad code is not kept', () => {
  const storage = fakeStorage();
  assert.equal(rules.savePendingInvite(storage, { code: CODE }, 1), true);
  assert.deepEqual(rules.readPendingInvite(storage, 2), { code: CODE, post: null });
  rules.clearPendingInvite(storage);
  assert.equal(rules.savePendingInvite(storage, { code: '<b>' }, 1), false);
  assert.equal(rules.readPendingInvite(storage, 2), null);
});

test('a stale or odd stored invite is ignored', () => {
  const storage = fakeStorage();
  rules.savePendingInvite(storage, { code: CODE }, 0);
  rules.resetInviteMemory();
  assert.equal(rules.readPendingInvite(storage, rules.INVITE_TTL_MS + 1), null, 'too old');
  assert.equal(rules.readPendingInvite(storage, -rules.INVITE_TTL_MS - 1), null, 'a clock far in the past');
  storage.setItem(rules.INVITE_KEY, 'not json');
  assert.equal(rules.readPendingInvite(storage, 1), null);
  storage.setItem(rules.INVITE_KEY, JSON.stringify({ code: '<x>', at: 1 }));
  assert.equal(rules.readPendingInvite(storage, 2), null);
  storage.setItem(rules.INVITE_KEY, JSON.stringify({ code: CODE, post: '../x', at: 1 }));
  assert.deepEqual(rules.readPendingInvite(storage, 2), { code: CODE, post: null });
});

test('with no usable storage the invite is held in memory for this page load', () => {
  for (const storage of [null, fakeStorage({ failWrite: true }), fakeStorage({ failRead: true })]) {
    rules.resetInviteMemory();
    assert.equal(rules.savePendingInvite(storage, { code: CODE, post: POST }, 5), true);
    assert.deepEqual(rules.readPendingInvite(storage, 6), { code: CODE, post: POST });
    rules.clearPendingInvite(storage);
    assert.equal(rules.readPendingInvite(storage, 6), null);
  }
});

// ---------------------------------------------------------------- the server's answers

test('check_invite is read into one shape (five keys), and anything odd reads as not found', () => {
  const none = { needs_approval: false, post_id: null };
  assert.deepEqual(rules.readInviteCheck({ valid: true, community_name: ' BAR ', reason: null }), { valid: true, name: 'BAR', reason: null, ...none },
    'an older database says three keys: no approval, no post');
  assert.deepEqual(rules.readInviteCheck({ valid: false, community_name: null, reason: 'expired' }), { valid: false, name: '', reason: 'expired', ...none });
  assert.deepEqual(rules.readInviteCheck({ valid: false, community_name: 'BAR', reason: 'expired' }), { valid: false, name: 'BAR', reason: 'expired', ...none },
    'the name of a link that ran out is kept');
  assert.deepEqual(rules.readInviteCheck({ valid: false, reason: 'revoked' }), { valid: false, name: '', reason: 'revoked', ...none });
  assert.deepEqual(rules.readInviteCheck([{ valid: true, community_name: 'A' }]), { valid: true, name: 'A', reason: null, ...none }, 'a one-row array');
  for (const odd of [null, undefined, 'x', {}, { valid: false, reason: 'weird' }, { valid: 'true' }]) {
    const read = rules.readInviteCheck(odd);
    assert.equal(read.valid, false);
    assert.equal(read.reason, 'unknown');
    assert.deepEqual(Object.keys(read).sort(), ['name', 'needs_approval', 'post_id', 'reason', 'valid']);
  }
});

test('check_invite says whether the link waits for an admin, and which meeting travels with it', () => {
  const read = rules.readInviteCheck({ valid: true, community_name: 'コクヨ', reason: null, needs_approval: true, post_id: POST });
  assert.deepEqual(read, { valid: true, name: 'コクヨ', reason: null, needs_approval: true, post_id: POST });
  assert.equal(rules.readInviteCheck({ valid: true, needs_approval: 'true' }).needs_approval, false, 'only a real true counts');
  assert.equal(rules.readInviteCheck({ valid: true, post_id: 5 }).post_id, null);
  assert.equal(rules.readInviteCheck({ valid: true, post_id: '  ' }).post_id, null);
  // A link that is no use asks for nothing, whatever the row holds.
  const dead = rules.readInviteCheck({ valid: false, reason: 'expired', needs_approval: true, post_id: POST });
  assert.equal(dead.needs_approval, false);
  assert.equal(dead.post_id, null);
});

test('claim_invite and my_communities are read', () => {
  assert.deepEqual(rules.readClaim({ community_id: 'c1', community_name: 'BAR' }),
    { id: 'c1', name: 'BAR', status: 'joined', post_id: null }, 'an older database let me in and said no status');
  assert.equal(rules.readClaim(null), null);
  assert.equal(rules.readClaim({}), null);
  assert.equal(rules.readClaim({ community_name: 'x' }), null);
  const list = rules.normalizeCommunities([
    { community_id: 'a', slug: 'a', name: 'A', role: 'admin' },
    { community_id: 'a', slug: 'a', name: 'A again', role: 'member' },
    { id: 'b', name: '', role: 'owner' },
    { name: 'no id' },
    null,
  ]);
  assert.deepEqual(list, [
    { id: 'a', slug: 'a', name: 'A', role: 'admin' },
    { id: 'b', slug: '', name: 'コミュニティ', role: 'member' },
  ]);
  assert.deepEqual(rules.normalizeCommunities(undefined), []);
  assert.deepEqual(rules.adminOf(list).map((entry) => entry.id), ['a']);
});

test('claim_invite: status and the meeting of the link are read; an unknown status is never "in"', () => {
  for (const status of ['joined', 'already', 'pending']) {
    const claim = rules.readClaim({ community_id: 'c1', community_name: ' コクヨ ', status, post_id: POST });
    assert.deepEqual(claim, { id: 'c1', name: 'コクヨ', status, post_id: POST });
  }
  assert.equal(rules.readClaim({ community_id: 'c1', status: 'banana' }).status, 'pending');
  assert.equal(rules.readClaim([{ community_id: 'c1', status: 'already' }]).status, 'already');
  assert.equal(rules.readClaim({ community_id: 'c1', post_id: 7 }).post_id, null);
  assert.equal(rules.claimedIn(rules.readClaim({ community_id: 'c1', status: 'pending' })), false);
  assert.equal(rules.claimedIn(rules.readClaim({ community_id: 'c1', status: 'already' })), true);
  assert.equal(rules.claimedIn(rules.readClaim({ community_id: 'c1' })), true);
  assert.equal(rules.claimedIn(null), false);
});

test('my_join_status is read into a list, most pressing first; "not known" stays null', () => {
  assert.equal(rules.readJoinStatus(null), null);
  assert.equal(rules.readJoinStatus(undefined), null);
  assert.deepEqual(rules.readJoinStatus([]), []);
  assert.deepEqual(rules.readJoinStatus('x'), []);
  const list = rules.readJoinStatus([
    { community_id: 'r', community_name: 'R', status: 'rejected', at: '2026-11-01T00:00:00Z' },
    { community_id: 'p', community_name: ' P ', status: 'pending', at: null },
    { community_id: 'p', community_name: 'again', status: 'pending' },
    { community_id: 'x', community_name: 'X', status: 'removed' },
    { community_id: 'y', status: 'nonsense' },
    { status: 'pending' },
    null,
  ]);
  assert.deepEqual(list.map((entry) => [entry.id, entry.status]), [['p', 'pending'], ['x', 'removed'], ['r', 'rejected']]);
  assert.equal(list[0].name, 'P');
  assert.equal(rules.readJoinStatus([{ community_id: 'q', status: 'pending' }])[0].name, 'コミュニティ');
});

test('who is kept on the waiting screen: only somebody in no community with something said about them', () => {
  const said = [{ id: 'p', name: 'P', status: 'pending' }];
  assert.equal(rules.mustWait({ communities: [], joinStatus: said }), true);
  assert.equal(rules.mustWait({ communities: [{ id: 'a' }], joinStatus: said }), false, 'a person in another community is not held');
  assert.equal(rules.mustWait({ communities: [], joinStatus: [] }), false);
  assert.equal(rules.mustWait({ communities: [], joinStatus: null }), false, 'not known: nobody is sent there');
  assert.equal(rules.mustWait({ communities: undefined, joinStatus: undefined }), false);
});

test('the waiting screen says pending, removed and rejected differently', () => {
  const pending = rules.waitingView({ id: 'p', name: 'コクヨ', status: 'pending' });
  assert.equal(pending.state, 'pending');
  assert.equal(pending.title, '参加の承認を待っています');
  assert.match(pending.lede, /「コクヨ」の管理者が確認しています/);
  assert.equal(pending.canCancel, true);
  const removed = rules.waitingView({ id: 'x', name: 'コクヨ', status: 'removed' });
  assert.equal(removed.state, 'removed');
  assert.equal(removed.canCancel, false);
  assert.ok(removed.title.includes('コクヨ'));
  const rejected = rules.waitingView({ id: 'r', name: 'コクヨ', status: 'rejected' });
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.title, '「コクヨ」に参加できませんでした');
  assert.match(rejected.note, /もう一度使うと、また申し込みになります/);
  assert.match(removed.note, /招待リンクから申し込めます/);
  assert.equal(rejected.canCancel, false);
  assert.equal(new Set([pending.title, removed.title, rejected.title]).size, 3);
  assert.equal(rules.waitingView(null), null);
  assert.equal(rules.waitingLabel({ name: 'コクヨ', status: 'pending' }), 'コクヨ（承認待ち）');
  assert.equal(rules.waitingLabel({ name: 'コクヨ', status: 'rejected' }), '');
  assert.equal(rules.waitingLabel(null), '');
});

test('a community just joined is added once and keeps what is known', () => {
  const had = [{ id: 'a', slug: 'a', name: 'A', role: 'admin' }];
  assert.deepEqual(rules.withJoined(had, { id: 'b', name: 'B' }).map((entry) => entry.id), ['a', 'b']);
  assert.equal(rules.withJoined(had, { id: 'a', name: 'A2' }).length, 1);
  assert.equal(rules.withJoined(had, { id: 'a', name: 'A2' })[0].role, 'admin', 'an admin who uses an invite is still an admin');
  assert.deepEqual(rules.withJoined(had, null), had);
  assert.equal(rules.withJoined([], { id: 'z' })[0].name, 'コミュニティ');
});

// ---------------------------------------------------------------- the invite page

test('the invite page says whose invitation it is, or why it cannot be used', () => {
  const ok = rules.inviteView({ valid: true, name: '朝ラン部', reason: null });
  assert.equal(ok.state, 'valid');
  assert.equal(ok.title, '朝ラン部 への招待です');
  for (const [reason, word] of [['expired', '期限が切れて'], ['revoked', '止められて'], ['unknown', '見つかりません']]) {
    const bad = rules.inviteView({ valid: false, name: '', reason });
    assert.equal(bad.state, 'invalid');
    assert.ok(bad.lede.includes(word), reason);
    assert.ok(bad.lede.includes('管理者'), 'asks for a new link');
  }
  assert.equal(rules.inviteView({ valid: false, name: 'BAR', reason: 'expired' }).title, 'BAR への招待は使えません');
  assert.equal(rules.inviteView(null).state, 'error', 'could not be read');
  assert.equal(rules.inviteView({ valid: true, name: '', reason: null }).title, 'コミュニティ への招待です');
});

test('the invite page offers the right buttons', () => {
  const out = rules.inviteActions({ valid: true, signedIn: false, hasAccount: false, providers: ['google'] });
  assert.deepEqual(out, { join: false, register: true, login: true, providers: ['google'] });
  const member = rules.inviteActions({ valid: true, signedIn: true, hasAccount: true, providers: ['google'] });
  assert.deepEqual(member, { join: true, register: false, login: false, providers: [] });
  const half = rules.inviteActions({ valid: true, signedIn: true, hasAccount: false, providers: [] });
  assert.deepEqual(half, { join: true, register: false, login: false, providers: [] },
    'signed in but no profile yet: they join (and then finish the profile), they are not asked to register');
  const bad = rules.inviteActions({ valid: false, signedIn: false, hasAccount: false, providers: ['google'] });
  assert.deepEqual(bad, { join: false, register: false, login: false, providers: [] });
});

// ---------------------------------------------------------------- the front door

test('invite-only closes registration, unless an invite is in hand', () => {
  const shut = rules.entryView({ cfg: closed });
  assert.equal(shut.canRegister, false);
  assert.equal(shut.note, 'islands は招待制です。コミュニティの招待リンクから登録してください。');
  assert.equal(rules.entryView({ cfg: closed, hasInvite: true }).canRegister, true);
  assert.equal(rules.entryView({ cfg: closed, hasInvite: true }).note, '');
  assert.equal(rules.entryView({ cfg: on }).canRegister, true, 'communities on, not invite-only');
  assert.deepEqual(rules.entryView({ cfg: off }), { canRegister: true, note: '' }, 'communities off: as it was');
  assert.deepEqual(rules.entryView({ cfg: null }), { canRegister: true, note: '' });
});

test('somebody new who signed in with no invite is turned away only when accounts need one', () => {
  assert.equal(rules.registrationBlocked({ cfg: closed, hasAccount: false, claimed: false }), true);
  assert.equal(rules.registrationBlocked({ cfg: closed, hasAccount: false, claimed: true }), false, 'claimed an invite');
  assert.equal(rules.registrationBlocked({ cfg: closed, hasAccount: true, claimed: false }), false, 'an existing account');
  assert.equal(rules.registrationBlocked({ cfg: on, hasAccount: false, claimed: false }), false, 'not invite-only yet');
  assert.equal(rules.registrationBlocked({ cfg: off, hasAccount: false, claimed: false }), false);
});

// ---------------------------------------------------------------- the current community

const A = { id: 'a', slug: 'a', name: 'A', role: 'admin' };
const B = { id: 'b', slug: 'b', name: 'B', role: 'member' };

test('the current community is remembered per account', () => {
  const storage = fakeStorage();
  assert.equal(rules.recallCommunity(storage, 'u1'), null);
  assert.equal(rules.rememberCommunity(storage, 'u1', 'b'), true);
  assert.equal(rules.rememberCommunity(storage, 'u2', 'a'), true);
  rules.resetCommunityMemory();
  assert.equal(rules.recallCommunity(storage, 'u1'), 'b');
  assert.equal(rules.recallCommunity(storage, 'u2'), 'a', 'another account on the same browser has its own');
  assert.equal(rules.rememberCommunity(storage, null, 'a'), false);
  assert.equal(rules.rememberCommunity(storage, 'u1', ''), false);
  rules.forgetCommunity(storage, 'u1');
  assert.equal(rules.recallCommunity(storage, 'u1'), null);
});

test('without storage the choice is held in memory', () => {
  for (const storage of [null, fakeStorage({ failWrite: true }), fakeStorage({ failRead: true })]) {
    rules.resetCommunityMemory();
    rules.rememberCommunity(storage, 'u1', 'b');
    assert.equal(rules.recallCommunity(storage, 'u1'), 'b');
  }
});

test('the remembered community is used while I am still in it, else the first', () => {
  assert.equal(rules.chooseCommunity([A, B], 'b').id, 'b');
  assert.equal(rules.chooseCommunity([A, B], 'gone').id, 'a', 'left or removed: the first');
  assert.equal(rules.chooseCommunity([A, B], null).id, 'a');
  assert.equal(rules.chooseCommunity([], 'a'), null);
  assert.equal(rules.chooseCommunity(null, 'a'), null);
});

// ---------------------------------------------------------------- which map

test('communities off: everybody\'s map, whatever else is passed', () => {
  assert.deepEqual(rules.mapScope({ on: false, communities: [A], current: 'a', linked: { id: 'z' } }), { mode: 'legacy' });
});

test('a member sees the current community; a link to another of mine switches to it', () => {
  assert.deepEqual(rules.mapScope({ on: true, communities: [A, B], current: 'b' }), { mode: 'community', id: 'b', name: 'B' });
  assert.deepEqual(rules.mapScope({ on: true, communities: [A, B], current: null }), { mode: 'community', id: 'a', name: 'A' });
  assert.deepEqual(rules.mapScope({ on: true, communities: [A, B], current: 'a', linked: { id: 'b', name: 'B' } }),
    { mode: 'community', id: 'b', name: 'B' });
});

test('a link to a community I am not in is read only, and so is a visitor\'s', () => {
  assert.deepEqual(rules.mapScope({ on: true, communities: [A], current: 'a', linked: { id: 'z', name: 'Z' } }),
    { mode: 'viewing', id: 'z', name: 'Z' });
  assert.deepEqual(rules.mapScope({ on: true, communities: [], current: null, linked: { id: 'z', name: 'Z' } }),
    { mode: 'viewing', id: 'z', name: 'Z' }, 'signed out, from a link');
  assert.equal(rules.mapScope({ on: true, communities: [], linked: { id: 'z' } }).name, 'コミュニティ', 'name unknown');
  // Moving on within the app keeps what a visitor was looking at.
  assert.deepEqual(rules.mapScope({ on: true, communities: [], viewing: { id: 'z', name: 'Z' } }), { mode: 'viewing', id: 'z', name: 'Z' });
  // ...but a member's own community comes first.
  assert.equal(rules.mapScope({ on: true, communities: [A], current: 'a', viewing: { id: 'z', name: 'Z' } }).mode, 'community');
});

test('a person in no community, and no link, gets a notice and not a map', () => {
  const scope = rules.mapScope({ on: true, communities: [], current: null });
  assert.deepEqual(scope, { mode: 'none', reason: 'not-member' });
  const signedIn = rules.mapNotice(scope, { signedIn: true });
  assert.equal(signedIn.title, 'まだコミュニティに入っていません。招待リンクから参加してください。');
  assert.equal(signedIn.login, false);
  const visitor = rules.mapNotice(scope, { signedIn: false });
  assert.ok(visitor.title.includes('招待制'));
  assert.equal(visitor.login, true, 'a visitor is offered the log-in');
  assert.equal(rules.mapNotice({ mode: 'community', id: 'a', name: 'A' }, { signedIn: true }), null);
  assert.equal(rules.mapNotice({ mode: 'legacy' }, { signedIn: false }), null);
});

test('the button at the map\'s top left', () => {
  assert.equal(rules.communityButtonText({ mode: 'community', name: 'BAR' }, 2), 'BAR ▾');
  assert.equal(rules.communityButtonText({ mode: 'community', name: 'BAR' }, 1), 'BAR ▾', 'one community: the sheet still opens (an admin edits there)');
  assert.equal(rules.communityButtonText({ mode: 'community', name: 'BAR' }, 0), 'BAR', 'none listed (not read yet): no arrow');
  assert.equal(rules.communityButtonText({ mode: 'viewing', name: 'Z' }, 2), 'Z', 'read only: no arrow');
  assert.equal(rules.communityButtonText({ mode: 'legacy' }, 3), '');
  assert.equal(rules.communityButtonText({ mode: 'none' }, 0), '');
  assert.equal(rules.communityButtonText({ mode: 'community', name: 'あ'.repeat(40) }, 2), `${'あ'.repeat(12)}… ▾`);
  // Latin letters are half as wide, so a Latin name may be twice as long before it is cut.
  assert.equal(rules.communityButtonText({ mode: 'community', name: 'Saturday Morning Run' }, 2), 'Saturday Morning Run ▾');
  assert.equal(rules.communityButtonText({ mode: 'community', name: 'a'.repeat(30) }, 1), `${'a'.repeat(24)}… ▾`);
  assert.equal(rules.communityButtonText({ mode: 'community', name: `${'あ'.repeat(11)}ab` }, 1), `${'あ'.repeat(11)}ab ▾`);
  assert.equal(rules.communityButtonText({ mode: 'community', name: `${'あ'.repeat(11)}abc` }, 1), `${'あ'.repeat(11)}ab… ▾`);
  assert.equal(rules.canSwitch({ mode: 'community' }, 2), true);
  assert.equal(rules.canSwitch({ mode: 'community' }, 1), true, 'one is enough: the sheet lists it and its 編集');
  assert.equal(rules.canSwitch({ mode: 'community' }, 0), false);
  assert.equal(rules.canSwitch({ mode: 'viewing' }, 5), false);
  assert.equal(rules.canSwitch(null, 5), false);
});

test('the line over the composer', () => {
  const member = { mode: 'community', id: 'a', name: 'BAR' };
  assert.deepEqual(rules.postingTarget({ on: true, editing: false, scope: member }), { show: true, text: 'BAR に投稿', blocked: false, unknown: false, message: '' });
  assert.equal(rules.postingTarget({ on: false, editing: false, scope: member }).show, false, 'communities off: nothing');
  assert.equal(rules.postingTarget({ on: true, editing: true, scope: member }).show, false, 'an edit does not move a post');
  for (const scope of [{ mode: 'none', reason: 'not-member' }, { mode: 'viewing', id: 'z', name: 'Z' }, null]) {
    const out = rules.postingTarget({ on: true, editing: false, scope });
    assert.equal(out.blocked, true);
    assert.ok(out.message.includes('招待リンク'));
  }
});

test('the box a community map is framed by', () => {
  const posts = [{ x: 10, y: 20 }, { x: 50, y: 5 }, { x: NaN, y: 1 }];
  assert.deepEqual(rules.postsExtent(posts, () => 2), [8, 3, 52, 22]);
  assert.deepEqual(rules.postsExtent(posts, null), [10, 5, 50, 20]);
  assert.equal(rules.postsExtent([], () => 1), null);
  assert.equal(rules.postsExtent(undefined, () => 1), null);
  assert.deepEqual(rules.postsExtent([{ x: 1, y: 1 }], () => NaN), [1, 1, 1, 1], 'an unreadable radius counts as none');
});

test('islands made only of other communities\' posts are not named on this map', () => {
  const islands = [
    { label: 'ここ', post_ids: ['p1', 'p2'] },
    { label: 'よそ', post_ids: ['p9'] },
    { label: 'まじり', post_ids: ['p9', 'p2'] },
    { label: 'ids無し' },
  ];
  const ids = new Set(['p1', 'p2']);
  assert.deepEqual(rules.islandsInScope(islands, ids, false).map((island) => island.label), ['ここ', 'まじり', 'ids無し'], 'an island with no list of posts cannot be judged, so it stays');
  assert.equal(rules.islandsInScope(islands, ids, true).length, 4, 'a saturated read cannot tell, so nothing is dropped');
  assert.deepEqual(rules.islandsInScope(null, ids, false), []);
});

// ---------------------------------------------------------------- making invites

test('the five lengths an admin can choose', () => {
  assert.deepEqual(rules.EXPIRY_CHOICES.map((choice) => choice.label), ['1時間', '3時間', '今日中', '1日', '7日']);
  assert.equal(rules.DEFAULT_EXPIRY, 'today', 'a venue QR: the whole evening');
  assert.ok(rules.EXPIRY_CHOICES.find((choice) => choice.key === 'today').note.includes('QR'));
});

test('create_invite is asked for the minutes, and for the end of the day when that is chosen', () => {
  const now = Date.UTC(2026, 9, 30, 10, 0, 0);   // 19:00 JST on 10/30
  assert.deepEqual(rules.createInviteBody('c1', '1h', now), { community_id: 'c1', minutes: 60, until_end_of_day: false, needs_approval: false });
  assert.deepEqual(rules.createInviteBody('c1', '3h', now), { community_id: 'c1', minutes: 180, until_end_of_day: false, needs_approval: false });
  assert.deepEqual(rules.createInviteBody('c1', '1d', now), { community_id: 'c1', minutes: 1440, until_end_of_day: false, needs_approval: false });
  assert.deepEqual(rules.createInviteBody('c1', '7d', now), { community_id: 'c1', minutes: 10080, until_end_of_day: false, needs_approval: false });
  assert.deepEqual(rules.createInviteBody('c1', 'today', now), { community_id: 'c1', minutes: 299, until_end_of_day: true, needs_approval: false });
  assert.equal(rules.createInviteBody('c1', 'nonsense', now).until_end_of_day, true, 'an unknown choice is the default');
});

test('create_invite carries the approval switch and the meeting only when they are held', () => {
  const now = Date.UTC(2026, 9, 30, 10, 0, 0);
  assert.deepEqual(rules.createInviteBody('c1', '1d', now, { needsApproval: true }),
    { community_id: 'c1', minutes: 1440, until_end_of_day: false, needs_approval: true });
  assert.deepEqual(rules.createInviteBody('c1', '1d', now, { needsApproval: true, post: POST }),
    { community_id: 'c1', minutes: 1440, until_end_of_day: false, needs_approval: true, post: POST });
  assert.deepEqual(rules.createInviteBody('c1', 'today', now, { post: POST }),
    { community_id: 'c1', minutes: 299, until_end_of_day: true, needs_approval: false, post: POST });
  assert.ok(!('post' in rules.createInviteBody('c1', '1d', now, { post: '' })), 'no meeting: no key');
  assert.equal(rules.createInviteBody('c1', '1d', now, { needsApproval: 'yes' }).needs_approval, true, 'always a boolean');
});

test('「今日中」 is 23:59 Japan time, wherever the browser is', () => {
  // 18:00 JST = 09:00 UTC -> 5h59m left
  assert.equal(rules.minutesUntilEndOfDayJst(Date.UTC(2026, 9, 30, 9, 0, 0)), 359);
  // 00:00 JST on the 31st = 15:00 UTC on the 30th -> 23h59m
  assert.equal(rules.minutesUntilEndOfDayJst(Date.UTC(2026, 9, 30, 15, 0, 0)), 1439);
  // 23:30 JST -> 29 minutes
  assert.equal(rules.minutesUntilEndOfDayJst(Date.UTC(2026, 9, 30, 14, 30, 0)), 29);
  // 23:59:30 JST: already past the minute -> still at least 1
  assert.equal(rules.minutesUntilEndOfDayJst(Date.UTC(2026, 9, 30, 14, 59, 30)), 1);
});

test('time left and the Japan-time stamp', () => {
  const now = Date.UTC(2026, 9, 30, 10, 0, 0);
  const at = (ms) => new Date(now + ms).toISOString();
  assert.equal(rules.timeLeft(at(25 * 60000), now), 'あと25分');
  assert.equal(rules.timeLeft(at(2 * HOUR), now), 'あと2時間');
  assert.equal(rules.timeLeft(at(2 * HOUR + 30 * 60000), now), 'あと2時間30分');
  assert.equal(rules.timeLeft(at(25 * HOUR), now), 'あと1日1時間');
  assert.equal(rules.timeLeft(at(7 * 24 * HOUR), now), 'あと7日');
  assert.equal(rules.timeLeft(at(-1000), now), '');
  assert.equal(rules.timeLeft('garbage', now), '');
  assert.equal(rules.jstStamp('2026-10-30T14:59:00Z'), '10/30 23:59');
  assert.equal(rules.jstStamp('2026-10-30T15:05:00Z'), '10/31 00:05');
  assert.equal(rules.jstStamp('nope'), '');
});

test('the list shows only invites that still work, newest first', () => {
  const now = Date.UTC(2026, 9, 30, 10, 0, 0);
  const row = (id, extra) => ({ id, code: `code-${id}-abcd`, created_at: '2026-10-30T09:00:00Z',
    expires_at: new Date(now + HOUR).toISOString(), revoked_at: null, uses: 0, ...extra });
  const rows = [
    row('old', { created_at: '2026-10-30T08:00:00Z' }),
    row('new', { created_at: '2026-10-30T09:30:00Z' }),
    row('gone', { expires_at: new Date(now - 1000).toISOString() }),
    row('stopped', { revoked_at: '2026-10-30T09:40:00Z' }),
    { id: 'nocode', expires_at: new Date(now + HOUR).toISOString() },
  ];
  assert.deepEqual(rules.activeInvites(rows, now).map((entry) => entry.id), ['new', 'old']);
  assert.deepEqual(rules.activeInvites(null, now), []);
});

test('one line of the list: time left, the date, how many used it', () => {
  const now = Date.UTC(2026, 9, 30, 10, 0, 0);
  const soon = rules.inviteRowText({ expires_at: '2026-10-30T14:59:00Z', uses: 3 }, now);
  assert.equal(soon.expiry, 'あと4時間59分（10/30 23:59 まで）');
  assert.equal(soon.uses, '3人が使いました');
  assert.equal(rules.inviteRowText({ expires_at: '2026-10-30T14:59:00Z', uses: 0 }, now).uses, 'まだ使われていません');
  assert.equal(rules.inviteRowText({ expires_at: '2026-10-30T09:00:00Z' }, now).expiry, '10/30 18:00 に終了');
});

test('the one link: the newest invite that still works, or none', () => {
  const now = Date.UTC(2026, 9, 30, 10, 0, 0);
  const row = (id, extra = {}) => ({ id, code: CODE, expires_at: new Date(now + HOUR).toISOString(), created_at: '2026-10-30T08:00:00Z', ...extra });
  const rows = [row('old'), row('new', { created_at: '2026-10-30T09:30:00Z' }), row('gone', { expires_at: new Date(now - 1000).toISOString() })];
  assert.equal(rules.currentInvite(rows, now).id, 'new');
  assert.equal(rules.currentInvite([rows[2]], now), null);
  assert.equal(rules.currentInvite(null, now), null);
});

test('the post switch: the link carries ?post= only while it is on and a post is picked', () => {
  assert.equal(rules.invitePostFor(true, POST), POST);
  assert.equal(rules.invitePostFor(false, POST), null);
  assert.equal(rules.invitePostFor(true, ''), null);
  assert.equal(rules.invitePostFor(true, 'not a post!'), null);
  const origin = 'https://islands.example';
  assert.equal(rules.inviteUrlFor(origin, CODE, rules.invitePostFor(false, POST)), `${origin}/#/invite/${CODE}`);
  assert.equal(rules.inviteUrlFor(origin, CODE, rules.invitePostFor(true, POST)), `${origin}/#/invite/${CODE}?post=${POST}`);
});

test('the line under the QR, the share text, the saved picture', () => {
  const now = Date.UTC(2026, 9, 30, 10, 0, 0);
  assert.equal(rules.inviteLineText({ expires_at: '2026-10-30T14:59:00Z', uses: 3 }, now), 'あと4時間59分（10/30 23:59 まで）・3人が使いました');
  assert.equal(rules.inviteLineText({ expires_at: '2026-10-30T14:59:00Z', uses: 0 }, now), 'あと4時間59分（10/30 23:59 まで）・まだ使われていません');
  assert.deepEqual(rules.inviteShareData('朝ラン会', 'https://x/#/invite/a'),
    { title: '朝ラン会 への招待', text: 'islands の「朝ラン会」に招待します', url: 'https://x/#/invite/a' });
  assert.equal(rules.inviteImageName('朝ラン会'), 'islands_招待_朝ラン会.png');
  assert.equal(rules.inviteImageName('a/b:c*?"<>|d'), 'islands_招待_a b c d.png');
  assert.equal(rules.inviteImageName('  '), 'islands_招待_コミュニティ.png');
  assert.deepEqual(rules.inviteImageLines('朝ラン会', '2026-10-30T14:59:00Z'), { title: '朝ラン会 への招待', until: '10/30 23:59 まで' });
});

test('inviteJoinNote: the 会 of the QR is named before anything is pressed', () => {
  assert.equal(rules.inviteJoinNote({ post: null }), null);
  // not a member yet: the post cannot be read, so no name
  assert.equal(rules.inviteJoinNote({ post: POST }), 'この QR の会にも参加した状態で始まります。あとで取り消せます');
  assert.equal(rules.inviteJoinNote({ post: POST, meeting: { body: '金曜の夜に\n集まります' } }),
    'この QR の会（金曜の夜に 集まります）にも参加した状態で始まります。あとで取り消せます');
  assert.equal(rules.inviteJoinNote({ post: POST, meeting: { body: 'あ'.repeat(30) } }),
    `この QR の会（${'あ'.repeat(18)}…）にも参加した状態で始まります。あとで取り消せます`);
  // read, and closed or no longer recruiting: it will not be joined
  assert.equal(rules.inviteJoinNote({ post: POST, meeting: { body: '会' }, open: false }), null);
});

// ---------------------------------------------------------------- the wiring (a guard against drift)

const read = (url) => readFile(new URL(url, import.meta.url), 'utf8');
const html = await read('../../web/index.html');
const net = await read('../../web/js/net.js');
const app = await read('../../web/js/app.js');

test('every id the community screens ask for exists in index.html', async () => {
  const files = ['map.js', 'invite.js', 'auth.js', 'compose.js', 'profile.js'];
  const ids = new Set();
  for (const file of files) {
    const text = await read(`../../web/js/screens/${file}`);
    for (const m of text.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)) ids.add(m[1]);
  }
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  assert.deepEqual(missing, []);
});

test('both backends in net.js have every community call', () => {
  const names = ['communityMapPosts', 'myCommunities', 'communityInfo', 'checkInvite', 'claimInvite',
    'createInvite', 'listInvites', 'revokeInvite'];
  const split = net.indexOf('const localBackend');
  assert.ok(split > 0);
  const [remote, local] = [net.slice(0, split), net.slice(split)];
  for (const name of names) {
    assert.match(remote, new RegExp(`\\b${name}\\b`), `supabase backend: ${name}`);
    assert.match(local, new RegExp(`\\b${name}\\b`), `local backend: ${name}`);
  }
});

test('net.js calls the agreed routes and functions', () => {
  for (const fn of ['check_invite', 'claim_invite', 'create_invite', 'list_invites', 'revoke_invite',
    'my_communities', 'community_map_posts']) {
    assert.ok(net.includes(`'${fn}'`), `rpc ${fn}`);
  }
  for (const route of ['/api/local/invites/check/', '/api/local/invites/claim', '/api/local/invites',
    '/api/local/communities/mine', '/map?', '/revoke']) {
    assert.ok(net.includes(route), route);
  }
  assert.ok(/community_id: community/.test(net) || /community_id/.test(net));
});

test('the invite route is registered and open to everybody', () => {
  assert.match(app, /route\('#\/invite\/:code', 'invite'\)/);
  assert.ok(!/NEEDS_ACCOUNT = new Set\([^)]*invite/s.test(app), 'a signed-out visitor must reach the invite page');
});

// ---------------------------------------------------------------- review fixes

test('when my communities could not be read, nobody is told they are in none', () => {
  const none = { mode: 'none', reason: 'not-member' };
  const unread = rules.mapNotice(none, { signedIn: true, known: false });
  assert.equal(unread.retry, true, 'a retry is offered');
  assert.equal(unread.title, rules.COMMUNITIES_UNREAD_NOTE);
  assert.ok(!unread.title.includes('入っていません'));
  assert.equal(rules.mapNotice(none, { signedIn: true, known: true }).retry, false);
  // posting: the box says so and does not send anybody away
  const target = rules.postingTarget({ on: true, editing: false, scope: none, known: false });
  assert.equal(target.blocked, true);
  assert.equal(target.unknown, true);
  assert.ok(target.message.includes('読み込めませんでした'));
  assert.equal(rules.postingTarget({ on: true, editing: false, scope: none, known: true }).unknown, false);
  // a member whose scope is known posts as usual, whatever "known" says
  assert.equal(rules.postingTarget({ on: true, editing: false, scope: { mode: 'community', id: 'a', name: 'BAR' }, known: false }).blocked, false);
});

test('before invite_only is switched on, a visitor is not told the place is invite only', () => {
  const none = { mode: 'none', reason: 'not-member' };
  const before = rules.mapNotice(none, { signedIn: false, inviteOnly: false });
  assert.ok(!before.title.includes('招待制'));
  assert.equal(before.login, true);
  assert.ok(rules.mapNotice(none, { signedIn: false, inviteOnly: true }).title.includes('招待制'));
  assert.ok(rules.mapNotice(none, { signedIn: false }).title.includes('招待制'), 'the default is the closed wording');
});

test('only a failure that says nothing about the invite keeps the invite', () => {
  assert.equal(rules.transientFailure({ status: 0 }), true, 'offline');
  assert.equal(rules.transientFailure({ status: 503 }), true, 'server unhappy');
  assert.equal(rules.transientFailure(new TypeError('x')), true, 'not even an answer');
  assert.equal(rules.transientFailure({ status: 400 }), false, 'the database said no (expired, stopped, unknown)');
  assert.equal(rules.transientFailure({ status: 403 }), false);
  assert.equal(rules.transientFailure({ status: 404 }), false);
  assert.equal(rules.transientFailure(null), true);
});

test('only the posts of the invites own community can travel with it', () => {
  const rows = [
    { id: 'p1', community_id: 'bar' }, { id: 'p2', community_id: 'book' },
    { id: 'p3', community_id: null }, { id: 'p4' }, null, { id: 'p5', community_id: 'bar' },
  ];
  assert.deepEqual(rules.postsOfCommunity(rows, 'bar').map((post) => post.id), ['p1', 'p5']);
  assert.deepEqual(rules.postsOfCommunity(rows, ''), []);
  assert.deepEqual(rules.postsOfCommunity(undefined, 'bar'), []);
});

test('the left of the header: the community button, or just the name of the app', () => {
  assert.deepEqual(rules.headerTitle({ mode: 'community', name: 'BAR' }, 1), { text: 'BAR ▾', brand: false, tappable: true });
  assert.deepEqual(rules.headerTitle({ mode: 'viewing', name: 'Z' }, 1), { text: 'Z', brand: false, tappable: false });
  assert.deepEqual(rules.headerTitle({ mode: 'none', reason: 'not-member' }, 0), { text: 'islands', brand: true, tappable: false });
  assert.deepEqual(rules.headerTitle({ mode: 'legacy' }, 0), { text: 'islands', brand: true, tappable: false });
  assert.deepEqual(rules.headerTitle(null, 0), { text: 'islands', brand: true, tappable: false });
});

test('the round post button shows only where I may write', () => {
  const member = { mode: 'community', id: 'a', name: 'BAR' };
  assert.equal(rules.canPostFromMap({ signedIn: true, scope: member }), true);
  assert.equal(rules.canPostFromMap({ signedIn: true, scope: { mode: 'legacy' } }), true, 'communities off: as before');
  assert.equal(rules.canPostFromMap({ signedIn: false, scope: member }), false, 'signed out');
  assert.equal(rules.canPostFromMap({ signedIn: true, scope: { mode: 'none', reason: 'not-member' } }), false, 'no community');
  assert.equal(rules.canPostFromMap({ signedIn: true, scope: { mode: 'viewing', id: 'z', name: 'Z' } }), false, 'read only');
  assert.equal(rules.canPostFromMap({ signedIn: true, scope: null }), false);
});

test('the community name rule is the one rename_community has: trimmed, 1 to 40 characters', () => {
  assert.deepEqual(rules.checkCommunityName('  週末の会 '), { ok: true, name: '週末の会', message: '' });
  assert.equal(rules.checkCommunityName('\u3000\u3000夜の会\u3000').name, '夜の会', 'full-width spaces too');
  assert.equal(rules.checkCommunityName('Saturday Morning Run').ok, true, 'a space in the middle stays');
  assert.equal(rules.checkCommunityName('あ').ok, true);
  assert.equal(rules.checkCommunityName('あ'.repeat(40)).ok, true);
  assert.equal(rules.checkCommunityName('あ'.repeat(41)).ok, false);
  assert.equal(rules.checkCommunityName(' '.repeat(3)).ok, false);
  assert.equal(rules.checkCommunityName('').message, 'コミュニティの名前は1〜40文字で入力してください。');
  assert.equal(rules.checkCommunityName(null).ok, false);
  // characters outside the BMP count once, like Postgres char_length
  assert.equal(rules.checkCommunityName('\u{1F3DD}'.repeat(40)).ok, true);
  assert.equal(rules.checkCommunityName('\u{1F3DD}'.repeat(41)).ok, false);
});

test('rename answers in either shape, and the list follows', () => {
  assert.equal(rules.readRenamed('新しい名前'), '新しい名前');
  assert.equal(rules.readRenamed({ name: ' 新しい名前 ' }), '新しい名前');
  assert.equal(rules.readRenamed(['新しい名前']), '新しい名前');
  assert.equal(rules.readRenamed(null), '');
  assert.equal(rules.readRenamed({}), '');
  const list = [{ id: 'a', name: 'BAR', role: 'admin' }, { id: 'b', name: '読書', role: 'member' }];
  assert.deepEqual(rules.withRenamed(list, 'a', '夜の BAR'), [{ id: 'a', name: '夜の BAR', role: 'admin' }, list[1]]);
  assert.equal(list[0].name, 'BAR', 'the old list is not changed');
  assert.deepEqual(rules.withRenamed(null, 'a', 'x'), []);
});

// ---- 承認制の画面（2026-11-01 第1回）

test('承認が要るリンクの招待画面：題は「参加の申し込み」。要らないリンクは今までどおり', () => {
  const needs = rules.inviteView(rules.readInviteCheck({ valid: true, community_name: 'コクヨ', needs_approval: true }));
  assert.equal(needs.state, 'valid');
  assert.equal(needs.approval, true);
  assert.equal(needs.title, '「コクヨ」への参加の申し込み');
  assert.match(needs.lede, /承認されるまで中は見られません/);
  const plain = rules.inviteView(rules.readInviteCheck({ valid: true, community_name: 'コクヨ' }));
  assert.equal(plain.approval, false);
  assert.equal(plain.title, 'コクヨ への招待です');
  // 使えないリンクは、承認が要るかどうかに関わらず使えない案内
  assert.equal(rules.inviteView(rules.readInviteCheck({ valid: false, reason: 'expired', needs_approval: true })).state, 'invalid');
});

test('取り消しと断るの確認の文は、会の名前・相手の名前を入れる', () => {
  assert.equal(rules.cancelQuestion('コクヨ').title, '「コクヨ」への申し込みを取り消しますか？');
  assert.match(rules.cancelQuestion('コクヨ').body, /同じ招待リンクからもう一度申し込めます/);
  assert.equal(rules.rejectQuestion('カンベ', 'コクヨ').title, 'カンベさんの参加を断りますか？');
  assert.match(rules.rejectQuestion('カンベ', 'コクヨ').body, /「コクヨ」の中を見られないまま/);
  assert.match(rules.rejectQuestion('カンベ', 'コクヨ').body, /参加できませんでした/);
});

test('管理者の枠の札：前に外した人・前にお断りした人・LINE（メールアドレスなし）', () => {
  const keys = (row) => rules.requestTags(row).map((tag) => tag.key);
  assert.deepEqual(keys({ email: 'a@example.com' }), []);
  assert.deepEqual(keys({ email: 'a@example.com', was_removed: true }), ['removed']);
  assert.deepEqual(keys({ email: 'a@example.com', rejected_before: true }), ['rejected']);
  assert.deepEqual(keys({ email: null }), ['line']);
  assert.deepEqual(keys({ email: '  ' }), ['line']);
  assert.deepEqual(keys({ email: '', was_removed: true, rejected_before: true }), ['removed', 'rejected', 'line']);
});

test('申し込んだ時刻：今日なら時刻だけ、前の日なら月日', () => {
  const now = Date.parse('2026-11-01T03:30:00Z');   // 日本では 12:30
  assert.equal(rules.requestedText('2026-11-01T03:04:00Z', now), '今日 12:04 に申し込み');
  assert.equal(rules.requestedText('2026-10-30T02:48:00Z', now), '10/30 11:48 に申し込み');
  assert.equal(rules.requestedText('おかしい', now), '');
});

test('待つ画面の三つの文は、題も説明もちがい、取り消せるのは待っている人だけ', () => {
  const entries = ['pending', 'removed', 'rejected'].map((status) => rules.waitingView({ id: status, name: 'コクヨ', status }));
  assert.equal(new Set(entries.map((entry) => entry.title)).size, 3);
  assert.equal(new Set(entries.map((entry) => entry.lede)).size, 3);
  assert.deepEqual(entries.map((entry) => entry.canCancel), [true, false, false]);
  assert.equal(entries[0].note, '');
});
