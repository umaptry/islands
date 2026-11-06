// Boot.
//
// index.html opens on #booting rather than on the welcome page, so a returning
// visitor does not watch it flash past before their session is restored. Whichever
// branch wins here picks the first screen anybody actually sees.

import { loadConfig, checkMapVersion } from './config.js';
import { api } from './net.js';
import { session } from './session.js';
import { state } from './state.js';
import { onboardingStep } from './onboarding.js';
import { setupKeyboardGuard } from './keyboard.js';
import { setupZoomGuard } from './zoom-guard.js';
import { navigate, refreshNav, route, screen, setChromeListener, setGuard, setNavVisible, show, startRouter } from './router.js';
import { live as realtimeLive, setupRealtime, sync as syncRealtime } from './realtime.js';
import { setupPush, syncPush } from './push.js';
import { setupPushAsk } from './push-ask.js';
import { $, toast } from './ui.js';
import { setupIcons } from './icons.js';
import { watchScreenTone } from './screen-tone.js';
import { setupNotice, updateNotice } from './notice.js';
import { setupFeedback } from './feedback.js';
import { setupAudio } from './audio.js';
import { rememberAffiliationReturn, setupAffiliation, setupAuth, setupGuidance, setupProfileSetup, setupWelcome } from './screens/auth.js';
import { setupCompose, setupReveal } from './screens/compose.js';
import { setupMapScreen, refreshMyPosts, forgetMapData } from './screens/map.js';
import { refreshNotifications, setupNotifications, paintBadge } from './screens/notifications.js';
import { setupProfile } from './screens/profile.js';
import { setupDm } from './screens/dm.js';
import { setupCommunityEdit } from './screens/community-edit.js';
import { fullnameHeld, markFullnameDue, rememberFullnameReturn, setupFullname } from './screens/fullname.js';
import { setupWaiting } from './screens/waiting.js';
import { browserStorage, clearDm, clearTalk, dmTabVisible, refreshDmRooms, refreshTalk, talkAvailable } from './talk.js';
import { WAITING_HOLD_MS, mapLinkFor, postIdFromHash, savePendingPost, takePendingPost } from './return-post.js';
import { setupInvite, settleSession } from './screens/invite.js';
import { communitiesActive, dropCommunities, refreshCommunities, refreshJoinStatus } from './communities.js';
import { mustWait, parseInviteHash } from './community-rules.js';
// ---- 会：公開側（第2回a） ----
import { setupEventApply } from './screens/event-apply.js';
import { setupEventMe } from './screens/event-me.js';
import { setupEventCheckin } from './screens/event-checkin.js';
import { setupEventAfter } from './screens/event-after.js';
import { forgetEventGuest, guestHome, refreshEventGuest } from './event-guest.js';
import {
  eventHashFor, isEventPattern, parseEventPath, peekApplyReturn, peekCheckinReturn, rememberApplyReturn, rememberCheckinReturn,
  rememberHostReturn, takeHostReturn,
} from './event-rules.js';
// ---- 会：主催者とメンバー（第2回a） ----
import { setupEventHost } from './screens/event-host.js';
import { setupEventCompose } from './screens/event-compose.js';

// Where every hash lands. The order matters only in that the first match wins.
route('#/welcome', 'welcome');
route('#/auth', 'auth');
route('#/setup', 'setup');
route('#/guidance', 'guidance');
route('#/affiliation', 'affiliation');
route('#/waiting', 'waiting');
route('#/fullname', 'fullname');
route('#/invite/:code', 'invite');
route('#/map', 'map');
route('#/post', 'compose');
route('#/post/:id/edit', 'compose');
route('#/notifications', 'notifications');
route('#/me', 'me');
route('#/me/edit', 'profileEdit');
route('#/u/:id', 'user');
route('#/dm', 'dmList');
route('#/dm/:id', 'dmRoom');
route('#/community/:id', 'communityEdit');
// ---- 会：公開側（第2回a） ----
route('#/e/:code', 'eventApply');
route('#/e/:code/me', 'eventMe');
route('#/e/:code/after', 'eventAfter');
route('#/c/:code', 'eventCheckin');
// ---- 会：主催者とメンバー（第2回a） ----
route('#/e/:code/host', 'eventHost');

// Signed out, you can look at the map and read a post; you cannot write, react
// or have an inbox. Sending somebody to the sign-in screen is a redirect and
// not an error page, so the address they typed is the one they come back to.
const NEEDS_ACCOUNT = new Set([
  '#/post', '#/post/:id/edit', '#/notifications', '#/me', '#/me/edit', '#/dm', '#/dm/:id', '#/community/:id',
  '#/e/:code/host',   // 会：主催者とメンバー（第2回a）
]);

// The bottom bar is マップ／DM／通知／マイページ. The DM tab exists only when signed in and 「話してみたい」 is on.
setNavVisible((target) => (target === '#/dm' ? dmTabVisible() : true));
setChromeListener((chrome) => updateNotice(chrome));

// 2026-10-29: 所属組織 is required. A named account with none, outside the sign-up
// steps, is held on #/affiliation until it has one. These screens are left alone:
// the sign-up steps themselves, and an invite link (which asks first).
const AFFILIATION_EXEMPT = new Set(['#/welcome', '#/auth', '#/setup', '#/guidance', '#/invite/:code', '#/affiliation', '#/waiting', '#/fullname']);
// 2026-11-01: somebody who applied to a community that needs approval (and is in none) is held on #/waiting,
// ahead of the onboarding. These screens are let through: the sign-up steps, the invite page, and the
// full-name page.
const WAIT_EXEMPT = new Set(['#/welcome', '#/auth', '#/setup', '#/affiliation', '#/invite/:code', '#/fullname', '#/waiting']);
const mustWaitNow = () => mustWait({ communities: state.communities, joinStatus: state.joinStatus });
// The full name page is for somebody who already has a name and 所属 (the 所属 request comes first).
const FULLNAME_EXEMPT = new Set(['#/welcome', '#/auth', '#/setup', '#/guidance', '#/invite/:code', '#/affiliation', '#/waiting', '#/fullname']);
const needsAffiliation = () => Boolean(state.account && state.account.display_name)
  && !String(state.account.affiliation || '').trim() && !onboardingStep();

setGuard((pattern) => {
  const signedIn = Boolean(state.account && state.account.display_name);
  const onboarding = onboardingStep();
  // ---- 会：公開側（第2回a） ---- the pages of a 会 are open to anybody (the page itself asks for a sign-in where it needs one)
  // (the host menu is not one of them: it needs an account, NEEDS_ACCOUNT below)
  if (isEventPattern(pattern) && pattern !== '#/e/:code/host') return null;
  // 2026-11-01: somebody who applied and closed the page before giving a name has no name to show the admin and no
  // way to give one on the waiting screen: they finish the name first (#/setup), and the save carries on to #/waiting.
  const unnamedAndWaiting = session.signedIn() && !signedIn && mustWaitNow();
  if (pattern === '#/waiting') {
    // Open for anybody the status list says something about (a person in another community opens it from the switcher).
    if (!session.signedIn()) return '#/welcome';
    if (unnamedAndWaiting) return '#/setup';
    return Array.isArray(state.joinStatus) && state.joinStatus.length ? null : '#/map';
  }
  if (unnamedAndWaiting && !WAIT_EXEMPT.has(pattern)) return '#/setup';
  if (session.signedIn() && mustWaitNow() && !WAIT_EXEMPT.has(pattern)) return '#/waiting';
  // ---- 会：公開側（第2回a） ---- a guest (applied to a 会, in no community) may open only the pages of that 会
  const guestAt = guestHome();
  if (guestAt && !['#/welcome', '#/auth', '#/invite/:code', '#/waiting'].includes(pattern)) return guestAt;
  if (pattern === '#/fullname') return fullnameHeld() ? null : '#/map';
  if (pattern === '#/affiliation') return needsAffiliation() ? null : '#/map';
  if (needsAffiliation() && !AFFILIATION_EXEMPT.has(pattern)) {
    // Remember where they were going, so saving can take them there.
    rememberAffiliationReturn(window.location.hash || '#/map');
    return '#/affiliation';
  }
  if (signedIn && !needsAffiliation() && !FULLNAME_EXEMPT.has(pattern) && fullnameHeld()) {
    rememberFullnameReturn(window.location.hash || '#/map');
    return '#/fullname';
  }
  if (signedIn && pattern === '#/map' && onboarding) {
    if (onboarding === 'photo') return '#/setup';
    return onboarding === 'post' ? '#/post?first=1' : '#/guidance';
  }
  if (NEEDS_ACCOUNT.has(pattern) && !signedIn) {
    // 主催者の画面を開こうとしたなら、ログインのあとにその会へ戻す
    if (pattern === '#/e/:code/host') {
      const found = /^#\/e\/([^/?#]+)\/host/.exec(window.location.hash || '');
      if (found) rememberHostReturn(browserStorage(), decodeURIComponent(found[1]));
    }
    return session.signedIn() ? '#/setup' : '#/auth';
  }
  // The DM does not exist while features.talk is off (the code can ship first).
  if (pattern.startsWith('#/dm') && !talkAvailable()) return '#/map';
  // A finished account has no business back on the sign-in or setup screens.
  if (signedIn && pattern === '#/auth') return '#/map';
  // The icon-photo step comes after the name is saved, so a named account is
  // still allowed on it until that step is done.
  if (signedIn && pattern === '#/setup') return onboarding === 'photo' ? null : '#/map';
  return null;
});

const NOTIFY_MS = 30000;

async function boot() {
  try {
    await loadConfig();
  } catch {
    show('booting');
    $('booting').textContent = 'サーバーに接続できませんでした。ページを再読み込みしてください。';
    return;
  }

  setupFeedback();
  setupAudio();
  setupWelcome();
  setupIcons();
  watchScreenTone();
  setupKeyboardGuard();
  setupZoomGuard();
  document.addEventListener('map:version-changed', () => {
    const node = document.getElementById('mapVersionNotice');
    if (node) node.hidden = false;
  });
  document.getElementById('mapVersionReload').addEventListener('click', () => location.reload());
  document.addEventListener('route:error', () => toast('読み込めませんでした。もう一度お試しください。'));
  setupAuth();
  setupInvite();
  setupProfileSetup();
  setupAffiliation();
  setupGuidance();
  setupCompose();
  setupReveal();
  setupMapScreen();
  setupNotifications();
  setupProfile();
  setupDm();
  setupCommunityEdit();
  setupWaiting();
  setupFullname();
  setupEventApply();   // ---- 会：公開側（第2回a） ----
  setupEventMe();
  setupEventCheckin();
  setupEventAfter();
  // ---- 会：主催者とメンバー（第2回a） ----
  setupEventHost();
  setupEventCompose();
  setupRealtime({ onArrive: refreshNotifications });
  setupPush({ onRefresh: refreshNotifications, onOpen: (hash) => navigate(hash) });
  setupPushAsk();
  screen('booting', {});

  // A link to one post (#/map?post=<id>) is read first of all: the OAuth return
  // below wipes the address, and an unfinished sign-up is sent elsewhere by the
  // guard. Kept in storage, it is opened when the person is ready (see below).
  const linkedPost = postIdFromHash(window.location.hash);

  // An OAuth round trip comes back with the token in the fragment, which is
  // also where the router looks. Consume it before the router runs, or the
  // hash it left behind is read as a route.
  const redirect = session.adoptRedirect();
  if (redirect !== 'adopted') session.restore();
  if (redirect === 'failed') toast('ログインできませんでした。もう一度お試しください。');

  // ---- 会：公開側（第2回a） ---- /e/<code> is the page of a 会: the router reads the hash, so the path becomes #/e/<code>.
  // (After the sign-in has been taken from the address, which a LINE sign-in leaves on this very path.) A sign-in that came
  // back to the front page while somebody was applying goes back to that 会.
  const eventPath = parseEventPath(window.location.pathname);
  if (eventPath) {
    // A sign-in that came back to the page of the 会 itself carries on into the steps however long it took: the mark set
    // on leaving lasts 30 minutes, and a phone that stalled on the way back was reloaded after 36 (2026-11-05).
    if (redirect === 'adopted' && eventPath.kind === 'apply') rememberApplyReturn(browserStorage(), eventPath.code);
    if (redirect === 'adopted' && eventPath.kind === 'checkin') rememberCheckinReturn(browserStorage(), eventPath.code);
    // /e/<code> is the public page, /c/<code> the check-in page (第2回b)
    history.replaceState(null, '', `/${eventHashFor(eventPath.code, eventPath.kind)}`);
  } else if (redirect === 'adopted' && peekApplyReturn(browserStorage())) {
    history.replaceState(null, '', `/${eventHashFor(peekApplyReturn(browserStorage()), 'apply')}`);
  } else if (redirect === 'adopted' && peekCheckinReturn(browserStorage())) {
    history.replaceState(null, '', `/${eventHashFor(peekCheckinReturn(browserStorage()), 'checkin')}`);
  }
  const onEventPage = /^#\/[ec]\//.test(window.location.hash);

  let invalidatedSession = false;
  let accountRead = false;
  if (session.signedIn()) {
    try {
      const result = await api.get('/api/account/me');
      accountRead = true;
      state.account = result.account;
      // A deleted user can still have an unexpired JWT in this browser.
      if (!state.account) {
        await session.validateUser();
        invalidatedSession = !session.signedIn();
      }
    } catch (error) {
      // A 401 means the token is no longer good; anything else means the server
      // is briefly unhappy, and throwing somebody out over that would cost them
      // their place for no reason.
      if (error.status === 401) { session.signOut(); invalidatedSession = true; }
      else toast('接続できませんでした。あとでもう一度お試しください。');
    }
  }

  // Communities. A waiting invite (kept across a Google sign-in, which wipes the
  // address) is used now, before anything else decides where this person goes. On
  // an invite link itself the page asks first, so it is not used behind their back.
  // Only when the account was actually read: a server hiccup must not look like
  // "a new person without an invite" and sign somebody out.
  if (session.signedIn() && !invalidatedSession && accountRead && communitiesActive()) {
    if (parseInviteHash(window.location.hash)) {
      await refreshCommunities();
    } else if (onEventPage) {
      // ---- 会：公開側（第2回a） ---- applying to a 会 makes the account: not signed out for having none yet
      await refreshCommunities();
    } else {
      const settledInvite = await settleSession(state.account);
      if (settledInvite.blocked) {
        toast(settledInvite.message);
        invalidatedSession = true;
      }
    }
  }

  // Where each community stands for me (waiting / turned away / removed): read before the router moves, so
  // somebody who is waiting is sent to #/waiting at once. Then: is the full name still to be asked this time?
  if (session.signedIn() && !invalidatedSession && accountRead && communitiesActive()) await refreshJoinStatus();
  if (state.account) markFullnameDue();
  // ---- 会：公開側（第2回a） ---- a guest is held on the page of their 会: which 会 is read before the router moves
  if (session.signedIn() && !invalidatedSession && accountRead && state.account && state.communities.length === 0) await refreshEventGuest();

  // Not signed in, or signed in but not yet through the first-post steps: the
  // link waits. (A finished account is simply taken to it by the router.)
  const settled = Boolean(state.account && state.account.display_name) && !onboardingStep()
    && Boolean(String(state.account.affiliation || '').trim());
  if (linkedPost && (invalidatedSession || !settled || mustWaitNow())) savePendingPost(browserStorage(), linkedPost, Date.now(), WAITING_HOLD_MS);

  // The first route is decided BEFORE the router starts, not after. Starting
  // the router and then navigating raced: the router's own apply() was still
  // awaiting the map's first fetch, so the second navigate found it busy and
  // did nothing but change the address bar - leaving the hash saying #/welcome
  // over a map screen.
  if (!window.location.hash || invalidatedSession) {
    let first = '#/welcome';
    if (state.account && state.account.display_name) {
      first = '#/map';
      // Came back from Google (or any fresh load) with a post waiting for them.
      const waiting = onboardingStep() ? null : takePendingPost(browserStorage());
      if (waiting) first = mapLinkFor(waiting);
      else first = takeHostReturn(browserStorage()) || first;
    } else if (session.signedIn()) first = '#/setup';
    history.replaceState(null, '', first);
  }

  startRouter();

  // The timer is unconditional: refreshNotifications() returns immediately when
  // nobody is signed in, and starting it only for a session that already
  // existed meant somebody who signed in on this page load never got a badge
  // until they reloaded. With the Realtime channel joined it rests: new rows
  // arrive by themselves (段6).
  setInterval(() => {
    if (!document.hidden && state.account && !realtimeLive()) refreshNotifications();
    if (!document.hidden) checkMapVersion().catch(() => {});
  }, NOTIFY_MS);
  if (state.account) {
    refreshMyPosts();
    refreshNotifications();
    refreshTalk();
    refreshDmRooms();
  }
  paintBadge();
  refreshNav();
  setupNotice();
  updateNotice();
  syncRealtime();
  syncPush();

  // Back from another app or tab: catch up now, and find out whether a phone
  // froze the socket while it was away.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (state.account) refreshNotifications();
    syncRealtime({ probe: true });
  });

  session.onChange(() => {
    if (!session.signedIn()) {
      state.account = null;
      state.unread = 0;
      state.notifications = [];
      state.notifySettings = null;
      paintBadge();
      clearTalk();
      clearDm();
      refreshNav();
      dropCommunities();
      forgetMapData();
      forgetEventGuest();   // ---- 会：公開側（第2回a） ----
    }
    updateNotice();
    // Also rings on every token refresh; both only act when the person changed.
    syncRealtime();
    syncPush();
  });
}
boot();
