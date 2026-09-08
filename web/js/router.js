// Which screen is showing, and the bottom nav that switches between them.
//
// Hash routing rather than the History API: the app is served from one file and
// a deep link has to survive a hard refresh without the server knowing every
// path. It also means a signed-out visitor who lands on #/me is redirected by
// the guard below rather than by a 404.

import { $, $$, closeSheet } from './ui.js';

const screens = new Map();
const routes = [];
let current = null;
let guard = () => null;

/** Register a screen. `enter` may be async; `leave` is always sync. */
export function screen(id, handlers = {}) {
  screens.set(id, handlers);
}

/**
 * @param pattern  '#/map' or '#/u/:id'
 * @param target   the screen id to show
 */
export function route(pattern, target) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((part) => {
      if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      keys.push(part.slice(1));
      return '([^/]+)';
    })
    .join('/');
  routes.push({ regex: new RegExp(`^${source}$`), keys, target, pattern });
}

/** Runs before every navigation. Return a hash to redirect, or null to allow. */
export function setGuard(handler) {
  guard = handler;
}

export function navigate(hash, { replace = false } = {}) {
  if (window.location.hash !== hash) {
    history[replace ? 'replaceState' : 'pushState'](null, '', hash);
  }
  return apply(hash);
}

export const currentRoute = () => window.location.hash || '#/map';

function match(hash) {
  // A route is the path only. `#/post?first=1` is still the compose screen, and
  // matching the whole string against the pattern quietly fell through to the
  // default route instead - which put the map on screen under a #/post address.
  const [path, query = ''] = String(hash).split('?');
  for (const entry of routes) {
    const found = entry.regex.exec(path);
    if (!found) continue;
    const params = {};
    entry.keys.forEach((key, index) => { params[key] = decodeURIComponent(found[index + 1]); });
    return {
      target: entry.target, params, pattern: entry.pattern,
      query: new URLSearchParams(query),
    };
  }
  return null;
}

let applying = false;
let pending = null;
let waiters = [];

async function apply(hash) {
  pending = hash;
  const done = new Promise((resolve) => waiters.push({ hash, resolve }));
  if (applying) return done;
  applying = true;
  try {
    while (pending !== null) {
      const requested = pending;
      pending = null;
      const found = match(requested) || match('#/map');
      if (!found) continue;
      const redirect = guard(found.pattern, found.params);
      if (redirect && redirect !== requested) {
        history.replaceState(null, '', redirect);
        pending = redirect;
        continue;
      }
      const previous = screens.get(current);
      if (previous?.leave) previous.leave(found.target);
      closeSheet();
      show(found.target);
      current = found.target;
      try {
        await screens.get(current)?.enter?.(found.params, found.query);
      } catch (error) {
        document.dispatchEvent(new CustomEvent('route:error', { detail: error }));
      }
      if (pending === null) paintNav(found.pattern);
    }
  } finally {
    applying = false;
    const completed = waiters;
    waiters = [];
    completed.forEach(({ hash: target, resolve }) => resolve(currentRoute() === target));
  }
  return done;
}

export function show(id) {
  $$('.screen').forEach((node) => node.classList.toggle('active', node.id === id));
  // The nav is hidden on the screens you have to finish before you can use the
  // app - an intro you are half way through, a sign-in, a first profile.
  const chrome = ['map', 'notifications', 'me', 'user', 'compose', 'profileEdit'].includes(id);
  $('bottomNav').hidden = !chrome;
  document.body.classList.toggle('has-nav', chrome);
}

export const activeScreen = () => current;

function paintNav(pattern) {
  $$('.nav-item').forEach((item) => {
    const target = item.dataset.route;
    const active = pattern === target || pattern.startsWith(`${target}/`);
    item.classList.toggle('on', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
}

export function startRouter() {
  window.addEventListener('hashchange', () => apply(currentRoute()));
  $$('.nav-item').forEach((item) => {
    item.addEventListener('click', () => navigate(item.dataset.route));
  });
  apply(currentRoute());
}
