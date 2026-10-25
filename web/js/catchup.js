// 「新しい住人」のキャッチアップ: when the map shows (the page opened, the app came back to the front, a push led
// here), the unread "somebody moved onto your island" notifications are shown one card at a time over the map -
// swipe (left or up) or 次へ to go on, × to stop. The rules (which rows, the order, the count, the swipe) are in
// catchup-rules.js; this file draws it.
//
// It does not import the notification or map screens (they import the map's tree): setupCatchup() is handed what
// it needs, and the map announces itself with a 'map:ready' event.

import { communitiesActive } from './communities.js';
import { data } from './net.js';
import { onboardingStep } from './onboarding.js';
import { activeScreen } from './router.js';
import { state } from './state.js';
import { avatar, clear, el, sheetOpen } from './ui.js';
import { icon } from './icons.js';
import { postCard } from './components/postcard.js';
import * as mapApi from './map/index.js';
import {
  canOpenCatchup, keyAction, pickCatchup, rowIdsOf, slideTitle, stepText, stepTo, swipeAction,
} from './catchup-rules.js';

const SLIDE_MS = 220;
const FOCUS_LIFT = 0.28;   // the post sits in the upper part of the map, above the card

let deps = null;           // { refresh, markRead, openPost }
let shown = new Set();     // row ids shown (or closed) in this page: never twice
let shownFor = null;       // whose ids they are
let trying = false;
let session = null;        // { items, index, busy } while open

const reducedMotion = () => document.documentElement.classList.contains('reduce-motion')
  || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

const root = () => document.getElementById('catchup');

function context() {
  return {
    signedIn: Boolean(state.account && state.account.display_name), screen: activeScreen(), sheetOpen: sheetOpen(),
    cardOpen: document.body.classList.contains('island-card-open'), onboarding: onboardingStep(),
    active: Boolean(session) || trying, visible: !document.hidden,
  };
}

/** A post from the screen, else asked for; null when it cannot be read (deleted, or not mine to see). */
async function postOf(id) {
  const known = state.postsById.get(id) || state.myPosts.find((post) => post.id === id);
  if (known) return known;
  try {
    return await data.getPost(id);
  } catch {
    return null;
  }
}

/** Try to open the catch-up. Safe to call as often as you like: every refusal is quiet. */
export async function startCatchup() {
  if (!deps || !canOpenCatchup(context())) return;
  const accountId = state.account.id;
  if (shownFor !== accountId) { shown = new Set(); shownFor = accountId; }
  trying = true;
  try {
    await deps.refresh();
    if (state.account?.id !== accountId || !canOpenCatchup({ ...context(), active: false })) return;
    const rows = pickCatchup(state.notifications, {
      communitiesOn: communitiesActive(), communityId: state.viewCommunity?.id || state.communityId || null, shown,
    });
    if (!rows.length) return;
    const found = await Promise.all(rows.map(async (row) => ({ row, post: await postOf(row.post_id) })));
    // A post that is gone is skipped, and its row is read so it does not come back.
    const gone = found.filter((item) => !item.post || item.post.deleted_at).map((item) => item.row);
    if (gone.length) leave(gone);
    const items = found.filter((item) => item.post && !item.post.deleted_at);
    if (!items.length) return;
    if (state.account?.id !== accountId || !canOpenCatchup({ ...context(), active: false })) return;
    open(items);
  } finally {
    trying = false;
  }
}

/** These rows will not be shown again in this page, and are read. */
function leave(rows) {
  const fresh = rows.filter((row) => rowIdsOf([row]).some((id) => !shown.has(id)));
  rowIdsOf(rows).forEach((id) => shown.add(id));
  if (fresh.length) deps.markRead(fresh);
}

// ---------------------------------------------------------------- the cards

function slideFor({ row, post }) {
  const actor = (row.actors && row.actors[0]) || post;
  const name = (row.actors && row.actors[0] && row.actors[0].display_name) || post.display_name;
  const slide = el('div', { className: 'catchup-slide' },
    el('div', { className: 'catchup-title' },
      avatar(actor, 36),
      el('p', { text: slideTitle(name, row.payload && row.payload.name) })),
    postCard(post, { compact: true }));
  const url = post.image_path ? data.imageUrl(post.image_path) : null;
  if (url) slide.append(el('img', { className: 'catchup-image', attrs: { src: url, alt: '添付画像', loading: 'lazy' } }));
  return slide;
}

function paintStep() {
  const { items, index } = session;
  root().querySelector('.catchup-step').textContent = stepText(index, items.length);
  root().querySelectorAll('.catchup-dots i').forEach((dot, at) => dot.classList.toggle('on', at === index));
  root().querySelector('.catchup-next').textContent = index + 1 >= items.length ? '地図にもどる' : '次へ';
  root().querySelector('.catchup-prev').hidden = index === 0;
}

/** Put card `index` on the screen: the card slides in from the right, the map turns to its post. */
function showCard(index, { first = false } = {}) {
  const { items } = session;
  const item = items[index];
  const view = root().querySelector('.catchup-view');
  const old = view.querySelector('.catchup-slide');
  const slide = slideFor(item);
  session.index = index;
  leave([item.row]);
  paintStep();
  if (typeof mapApi.focusOn === 'function') mapApi.focusOn(item.post, { lift: FOCUS_LIFT });
  if (first || reducedMotion() || !old) {
    clear(view).append(slide);
    return;
  }
  session.busy = true;
  old.classList.add('leaving');
  slide.classList.add('entering');
  view.append(slide);
  requestAnimationFrame(() => requestAnimationFrame(() => slide.classList.remove('entering')));
  setTimeout(() => { old.remove(); if (session) session.busy = false; }, SLIDE_MS);
}

function go(action) {
  if (!session || session.busy) return;
  const target = stepTo(session.index, session.items.length, action);
  if (target === 'done') close();
  else if (target !== session.index) showCard(target);
}

/** Stop (the last card, ×, Escape, a post opened, another screen): the cards not seen yet are read too. */
function close() {
  if (!session) return;
  const rest = session.items.slice(session.index + 1).map((item) => item.row);
  session = null;
  if (rest.length) leave(rest);
  const box = root();
  box.hidden = true;
  clear(box);
  document.body.classList.remove('catchup-open');
}

function open(items) {
  const box = clear(root());
  session = { items, index: 0, busy: false };
  box.append(
    el('div', { className: 'catchup-head' },
      el('span', { className: 'catchup-step' }),
      el('span', { className: 'catchup-dots', attrs: { 'aria-hidden': 'true' } }, items.map(() => el('i'))),
      el('button', {
        className: 'catchup-close', attrs: { type: 'button', 'aria-label': '閉じる' }, on: { click: close },
      }, icon('close', 18))),
    el('div', { className: 'catchup-view' }),
    el('div', { className: 'catchup-foot' },
      el('button', { className: 'btn catchup-open-post', attrs: { type: 'button' }, text: '投稿を開く', on: { click: openCurrent } }),
      el('button', { className: 'btn catchup-prev', attrs: { type: 'button' }, text: '前へ', on: { click: () => go('prev') } }),
      el('button', { className: 'btn catchup-next', attrs: { type: 'button' }, on: { click: () => go('next') } })));
  swipeOn(box.querySelector('.catchup-view'));
  box.hidden = false;
  document.body.classList.add('catchup-open');
  showCard(0, { first: true });
  box.querySelector('.catchup-next').focus({ preventScroll: true });
}

function openCurrent() {
  if (!session) return;
  const id = session.items[session.index].post.id;
  close();
  deps.openPost(id);
}

function swipeOn(view) {
  let down = null;
  view.addEventListener('pointerdown', (event) => { down = { x: event.clientX, y: event.clientY }; });
  view.addEventListener('pointerup', (event) => {
    if (!down) return;
    const action = swipeAction(event.clientX - down.x, event.clientY - down.y);
    down = null;
    if (action) go(action);
  });
  view.addEventListener('pointercancel', () => { down = null; });
}

// ---------------------------------------------------------------- when

export function setupCatchup(handlers) {
  deps = handlers;
  // The map is up (the page opened, a sign-in, coming back from another screen).
  document.addEventListener('map:ready', () => startCatchup());
  // The app came back to the front.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) startCatchup(); });
  // A tapped push opens the map (sw.js posts {type: 'open', url}); the map may already be on screen.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type !== 'open' || typeof message.url !== 'string') return;
      if (new URL(message.url, window.location.href).hash.startsWith('#/map')) setTimeout(startCatchup, 700);
    });
  }
  // Anything else coming up (a post sheet) or leaving the map puts it away.
  document.addEventListener('sheet:state', () => { if (session && sheetOpen()) close(); });
  window.addEventListener('hashchange', () => { if (session) close(); });
  document.addEventListener('keydown', (event) => {
    if (!session) return;
    const action = keyAction(event.key);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === 'close') close();
    else go(action);
  }, true);
}
