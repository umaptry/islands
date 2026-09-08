// Boot.
//
// index.html opens on #booting rather than on the intro, so a returning visitor
// does not watch slide 1 flash past before their session is restored. Whichever
// branch wins here picks the first screen anybody actually sees.

import { loadConfig, checkMapVersion } from './config.js';
import { api } from './net.js';
import { session } from './session.js';
import { state } from './state.js';
import { route, screen, setGuard, show, startRouter } from './router.js';
import { $, toast } from './ui.js';
import { setupIcons } from './icons.js';
import { setupAuth, setupGuidance, setupIntro, setupProfileSetup } from './screens/auth.js';
import { setupCompose, setupReveal } from './screens/compose.js';
import { setupMapScreen, refreshMyPosts } from './screens/map.js';
import { refreshNotifications, setupNotifications, paintBadge } from './screens/notifications.js';
import { setupProfile } from './screens/profile.js';

// Where every hash lands. The order matters only in that the first match wins.
route('#/intro', 'intro');
route('#/welcome', 'welcome');
route('#/auth', 'auth');
route('#/setup', 'setup');
route('#/guidance', 'guidance');
route('#/map', 'map');
route('#/post', 'compose');
route('#/post/:id/edit', 'compose');
route('#/notifications', 'notifications');
route('#/me', 'me');
route('#/me/edit', 'profileEdit');
route('#/u/:id', 'user');

// Signed out, you can look at the map and read a post; you cannot write, react
// or have an inbox. Sending somebody to the sign-in screen is a redirect and
// not an error page, so the address they typed is the one they come back to.
const NEEDS_ACCOUNT = new Set(['#/post', '#/post/:id/edit', '#/notifications', '#/me', '#/me/edit']);

setGuard((pattern) => {
  const signedIn = Boolean(state.account && state.account.display_name);
  if (NEEDS_ACCOUNT.has(pattern) && !signedIn) {
    return session.signedIn() ? '#/setup' : '#/auth';
  }
  // A finished account has no business back on the sign-in or setup screens.
  if (signedIn && (pattern === '#/auth' || pattern === '#/intro')) return '#/map';
  if (signedIn && pattern === '#/setup') return '#/map';
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

  setupIntro();
  setupIcons();
  document.addEventListener('map:version-changed', () => {
    const node = document.getElementById('mapVersionNotice');
    if (node) node.hidden = false;
  });
  document.getElementById('mapVersionReload').addEventListener('click', () => location.reload());
  document.addEventListener('route:error', () => toast('読み込めませんでした。もう一度お試しください。'));
  setupAuth();
  setupProfileSetup();
  setupGuidance();
  setupCompose();
  setupReveal();
  setupMapScreen();
  setupNotifications();
  setupProfile();
  screen('booting', {});

  // An OAuth round trip comes back with the token in the fragment, which is
  // also where the router looks. Consume it before the router runs, or the
  // hash it left behind is read as a route.
  const adopted = session.adoptRedirect();
  if (!adopted) session.restore();

  let invalidatedSession = false;
  if (session.signedIn()) {
    try {
      const result = await api.get('/api/account/me');
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

  // The first route is decided BEFORE the router starts, not after. Starting
  // the router and then navigating raced: the router's own apply() was still
  // awaiting the map's first fetch, so the second navigate found it busy and
  // did nothing but change the address bar - leaving the hash saying #/intro
  // over a map screen.
  if (!window.location.hash || invalidatedSession) {
    let first = '#/intro';
    if (state.account && state.account.display_name) first = '#/map';
    else if (session.signedIn()) first = '#/setup';
    history.replaceState(null, '', first);
  }

  startRouter();

  // The timer is unconditional: refreshNotifications() returns immediately when
  // nobody is signed in, and starting it only for a session that already
  // existed meant somebody who signed in on this page load never got a badge
  // until they reloaded.
  setInterval(() => {
    if (!document.hidden && state.account) refreshNotifications();
    if (!document.hidden) checkMapVersion().catch(() => {});
  }, NOTIFY_MS);
  if (state.account) {
    refreshMyPosts();
    refreshNotifications();
  }
  paintBadge();

  session.onChange(() => {
    if (!session.signedIn()) {
      state.account = null;
      state.unread = 0;
      paintBadge();
    }
  });
}
boot();
