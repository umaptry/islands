// The small parts around the map: nearby islands, the island card
// and the mini map. map.js owns the screen;
// this file only draws these parts and calls the map module.
//
// The map module is imported as a namespace on purpose: a name it does not
// export yet is then `undefined` (and the part stays hidden) instead of
// stopping the whole page from loading.

import { state } from '../state.js';
import { $, avatar, clear, clip, closeSheet, el, sheetOpen } from '../ui.js';
import { icon } from '../icons.js';
import { PALETTE, TIMES } from '../map/palette.js';
import * as mapApi from '../map/index.js';
import {
  MINI_SHOW_ZOOM, miniToWorld, miniVisible, myIslands, nearestIsland, pickNear, recentPosts,
} from './map-extras-logic.js';

const NEAR_COUNT = 3;
const MINI_SIZE = 96;
const RESIDENT_FACES = 5;     // faces on the island card
const NEAR_SETTLE_MS = 400;   // wait for the camera to stop before choosing "near" again

let handlers = { openPost: () => {} };
let nearSignature = '';
let cardIsland = null;
let miniGeometry = null;   // world -> mini map pixels, for drawing and for taps
let miniFrame = 0;
let nearTimer = 0;
let cardOpener = null;   // what had focus before the card opened

const snapshot = () => (typeof mapApi.mapSnapshot === 'function' ? mapApi.mapSnapshot() : null);
const finite = (value) => Number.isFinite(value);
const hasCenter = (island) => finite(island.cx) && finite(island.cy);
const islandKey = (island) => island.island_id || (island.name_pending ? `${island.label}@${island.cx},${island.cy}` : island.label);   // the same key map/index.js uses
const islandName = (island) => island.label || island.name || '名前のない島';

// ---------------------------------------------------------------- near islands

function choosePicks() {
  const snap = snapshot();
  return pickNear({
    islands: state.islands, myPostIds: state.myPosts.map((post) => post.id),
    view: snap?.view || null, zoomed: !!snap && snap.z >= MINI_SHOW_ZOOM, count: NEAR_COUNT,
  });
}

export function refreshNearIslands() {
  const box = $('nearIslands');
  const picked = choosePicks();
  // Near my own island when I have one; otherwise just the islands around.
  const mine = myIslands(state.islands.filter(hasCenter), state.myPosts.map((post) => post.id)).length > 0;
  const label = mine ? 'あなたに近い島' : 'まわりの島';
  const signature = `${label}|${picked.map((island) => `${islandKey(island)}:${islandName(island)}`).join('|')}`;
  if (signature === nearSignature) return;
  nearSignature = signature;
  box.hidden = picked.length === 0;
  clear(box);
  if (!picked.length) return;
  // A heading in small words over a row of buttons (2026-10-31, the user: the
  // heading was a blue pill beside white ones and read as one more button, and as
  // their equal rather than their title).
  const chips = el('div', { className: 'near-chips' });
  box.append(el('span', { className: 'near-label' }, icon('pin', 13), el('span', { text: label })), chips);
  picked.forEach((island) => {
    chips.append(el('button', {
      className: 'near-chip', attrs: { type: 'button' },
      on: { click: () => {
        openIslandCard(island);
        if (typeof mapApi.panTo === 'function') mapApi.panTo(island.cx, island.cy);
      } },
    }, el('span', { text: islandName(island) }), el('span', { className: 'near-chevron', text: '›', attrs: { 'aria-hidden': 'true' } })));
  });
  syncTopHeight();
}

// ---------------------------------------------------------------- island card

export function closeIslandCard() {
  const card = $('islandCard');
  const hadFocus = card.contains(document.activeElement);
  cardIsland = null;
  card.hidden = true;
  document.body.classList.remove('island-card-open');
  // Give focus back only if it was inside the card (a drag or a sheet opening
  // must not pull focus somewhere else).
  if (hadFocus && cardOpener && document.contains(cardOpener)) cardOpener.focus();
  cardOpener = null;
}

function openIslandCard(island, key = islandKey(island)) {
  if (!island) return;
  hideTrialHint();
  if (sheetOpen()) closeSheet();
  if (!cardIsland) cardOpener = document.activeElement;
  cardIsland = island;
  const card = clear($('islandCard'));
  const intro = String(island.intro || '').trim();
  const residents = (island.residents || []).slice(0, RESIDENT_FACES);
  const ids = island.post_ids || [];
  const unread = typeof mapApi.freshPostSet === 'function' ? mapApi.freshPostSet() : new Set();
  const unreadCount = ids.filter((id) => unread.has(id)).length;
  const recent = recentPosts(ids, state.postsById, 2, unread);

  card.append(
    el('button', {
      className: 'island-card-close', attrs: { type: 'button', 'aria-label': '閉じる' },
      on: { click: closeIslandCard },
    }, icon('close', 18)),
    el('h3', { className: 'island-card-name', text: islandName(island) }),
    el('p', { className: 'island-card-count', text: `${island.people ?? 0}人・投稿${ids.length}件` }),
  );
  // 2026-10-31 (the user): which of them you have not opened yet.
  if (unreadCount) {
    card.append(el('p', { className: 'island-card-unread' },
      el('i', { className: 'unread-mark', attrs: { 'aria-hidden': 'true' } }),
      el('span', { text: `まだ見ていない投稿 ${unreadCount}件` })));
  }
  // One line about the island, and a few of the people living on it.
  if (intro) card.append(el('p', { className: 'island-card-intro', text: intro }));
  if (residents.length) {
    const more = Math.max(0, (island.people ?? 0) - residents.length);
    card.append(el('div', { className: 'island-card-residents', attrs: { 'aria-label': '住人' } },
      el('span', { className: 'island-card-label', text: '住人' }),
      el('span', { className: 'face-stack' }, ...residents.map((person) => avatar(person, 30))),
      more > 0 ? el('span', { className: 'island-card-more', text: `+${more}` }) : null));
  }
  if (recent.length) {
    card.append(el('div', { className: 'island-card-posts' }, ...recent.map((post) => el('button', {
      className: 'island-post', attrs: { type: 'button' },
      on: { click: () => handlers.openPost(post.id) },
    },
    unread.has(post.id) ? el('em', { className: 'island-post-new', text: 'NEW' }) : null,
    el('b', { text: post.display_name || '' }),
    el('span', { text: clip(String(post.body || '').replace(/\s+/g, ' ').trim(), 40) })))));
  }
  // Far islands may not be loaded yet: say so instead of showing a thin list.
  if (recent.length < Math.min(2, ids.length)) {
    card.append(el('p', { className: 'island-card-note', text: '島をのぞくと、ほかの投稿も見られます。' }));
  }
  const enter = el('button', {
    className: 'btn island-card-enter', attrs: { type: 'button' }, text: '島をのぞく',
    on: { click: () => {
      if (typeof mapApi.enterIsland === 'function') mapApi.enterIsland(key);
      closeIslandCard();
    } },
  });
  card.append(enter);
  card.hidden = false;
  document.body.classList.add('island-card-open');
  enter.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- mini map

function updateMini() {
  miniFrame = 0;
  const box = $('miniMap');
  const snap = snapshot();
  if (!snap || !snap.world || !miniVisible(snap.z)) {
    box.hidden = true;
    document.body.classList.remove('mini-on');
    return;
  }
  box.hidden = false;
  document.body.classList.add('mini-on');   // the status strip makes room (style.css)
  const canvas = $('miniMapCanvas');
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== MINI_SIZE * dpr) {
    canvas.width = MINI_SIZE * dpr;
    canvas.height = MINI_SIZE * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, MINI_SIZE, MINI_SIZE);
  ctx.fillStyle = PALETTE.sea;
  ctx.fillRect(0, 0, MINI_SIZE, MINI_SIZE);

  const { world, view, ground, mine } = snap;
  const ww = world.maxX - world.minX;
  const wh = world.maxY - world.minY;
  if (!(ww > 0 && wh > 0)) return;
  const pad = 3;
  const k = (MINI_SIZE - pad * 2) / Math.max(ww, wh);
  const ox = (MINI_SIZE - ww * k) / 2 - world.minX * k;
  const oy = (MINI_SIZE - wh * k) / 2 - world.minY * k;
  miniGeometry = { k, ox, oy, world };
  const px = (x) => x * k + ox;
  const py = (y) => y * k + oy;

  if (ground?.canvas) {
    ctx.drawImage(ground.canvas, px(ground.minX), py(ground.minY),
      (ground.maxX - ground.minX) * k, (ground.maxY - ground.minY) * k);
  }
  if (view) {
    const x = px(view.minX);
    const y = py(view.minY);
    const w = (view.maxX - view.minX) * k;
    const h = (view.maxY - view.minY) * k;
    ctx.fillStyle = 'rgba(255, 255, 255, .18)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = PALETTE.ui;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
  }
  paintMiniTime();
  (mine || []).forEach((point) => {
    ctx.beginPath();
    ctx.arc(px(point.x), py(point.y), 3, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.accent;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  });
}

// The same time-of-day layers the map gets, so the small map does not stay
// daylight blue on a night map.
function paintMiniTime() {
  const ctx = $('miniMapCanvas').getContext('2d');
  const tod = typeof mapApi.timeOfDayNow === 'function' ? mapApi.timeOfDayNow() : 'day';
  const layers = TIMES[tod] || [];
  if (!layers.length) return;
  ctx.save();
  layers.forEach((layer) => {
    ctx.globalCompositeOperation = layer.blend;
    ctx.globalAlpha = layer.alpha;
    ctx.fillStyle = layer.color;
    ctx.fillRect(0, 0, MINI_SIZE, MINI_SIZE);
  });
  ctx.restore();
}

function scheduleMini() {
  if (!miniFrame) miniFrame = requestAnimationFrame(updateMini);
}

function setupMini() {
  const box = $('miniMap');
  const aim = (event) => {
    if (!miniGeometry || typeof mapApi.panTo !== 'function') return;
    // The canvas sits inside the box's 2px border, so measure the canvas.
    const rect = $('miniMapCanvas').getBoundingClientRect();
    const at = miniToWorld(event.clientX, event.clientY, rect, miniGeometry, MINI_SIZE);
    mapApi.panTo(at.x, at.y);
  };
  let dragging = false;
  box.addEventListener('pointerdown', (event) => {
    dragging = true;
    box.setPointerCapture?.(event.pointerId);
    aim(event);
  });
  box.addEventListener('pointermove', (event) => { if (dragging) aim(event); });
  const stop = () => { dragging = false; };
  box.addEventListener('pointerup', stop);
  box.addEventListener('pointercancel', stop);
}

// ---------------------------------------------------------------- first-visit hint

// 「島をタップ」: once, after the tryout, pointing at the island nearest to it.
// Seen once (or tapped past) and it does not come back. Storage may be refused
// (private windows), so every use is guarded and the hint then shows each time.
const HINT_KEY = 'islands.trialHint';
const HINT_APART_PX = 60;
let hint = { on: false, island: null };

function hintSeen() {
  try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; }
}

function markHintSeen() {
  try { localStorage.setItem(HINT_KEY, '1'); } catch { /* not kept */ }
}

export function hideTrialHint() {
  hint = { on: false, island: null };
  $('trialHint').hidden = true;
}

/** The island to point at: the nearest one that is not the tryout's own island
 * (the banner says "the islands around"). Without any other, the nearest. */
function hintIsland() {
  const trial = state.trialPost;
  const home = mapApi.screenPoint(trial.x, trial.y);
  const others = state.islands.filter((island) => {
    if (!hasCenter(island)) return false;
    const at = mapApi.screenPoint(island.cx, island.cy);
    return Math.hypot(at.x - home.x, at.y - home.y) > HINT_APART_PX;
  });
  return nearestIsland(others, trial.x, trial.y) || nearestIsland(state.islands, trial.x, trial.y);
}

function placeTrialHint() {
  const node = $('trialHint');
  if (!hint.on) return;
  if (typeof mapApi.screenPoint !== 'function') { node.hidden = true; return; }
  if (!hint.island && state.trialPost) hint.island = hintIsland();
  const island = hint.island;
  if (!island || !hasCenter(island)) { node.hidden = true; return; }
  const spot = mapApi.screenPoint(island.cx, island.cy);
  const box = $('map').getBoundingClientRect();
  const banner = $('trialBanner');
  const floor = Math.max(150, banner.hidden ? 0 : banner.getBoundingClientRect().bottom + 80);
  const inside = spot.x > 40 && spot.x < box.width - 40 && spot.y > floor && spot.y < box.height - 120;
  node.hidden = !inside;
  if (inside) {
    node.style.transform = `translate(${Math.round(spot.x - node.offsetWidth / 2)}px, ${Math.round(spot.y - node.offsetHeight - 40)}px)`;
    if (!hint.marked) { hint.marked = true; markHintSeen(); }   // only a hint that was really shown counts as seen
  }
}

export function showTrialHint() {
  if (!state.trialPost || hintSeen()) return;
  hint = { on: true, island: null };
  placeTrialHint();
}

// ---------------------------------------------------------------- shared

/** The mini map sits under whatever the top strip holds (the header, chips, the
 * trial banner), so it is placed from the strip's real height. */
function syncTopHeight() {
  const top = document.querySelector('#map .map-top');
  if (!top) return;
  document.documentElement.style.setProperty('--map-top-h', `${Math.round(top.getBoundingClientRect().height)}px`);
}

export function refreshExtras() {
  placeTrialHint();
  refreshNearIslands();
  scheduleMini();
  syncTopHeight();
}

function onCamera() {
  placeTrialHint();
  scheduleMini();
  clearTimeout(nearTimer);
  nearTimer = setTimeout(refreshNearIslands, NEAR_SETTLE_MS);
}

export function setupMapExtras({ openPost }) {
  handlers = { openPost };
  setupMini();

  if (typeof mapApi.onIslandTap === 'function') {
    mapApi.onIslandTap(({ key, island }) => openIslandCard(island, key));
  }
  if (typeof mapApi.onCameraChange === 'function') mapApi.onCameraChange(onCamera);

  // A post sheet opening replaces the card; dragging the map puts it away.
  document.addEventListener('sheet:state', () => { if (sheetOpen() && cardIsland) closeIslandCard(); });
  const stage = $('stage');
  let down = null;
  stage.addEventListener('pointerdown', (event) => {
    down = { x: event.clientX, y: event.clientY };
    hideTrialHint();
  });
  stage.addEventListener('pointermove', (event) => {
    if (down && cardIsland && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 10) closeIslandCard();
  });
  const release = () => { down = null; };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);

  // The strip grows and shrinks (trial banner, digest, stop button), so follow it.
  const top = document.querySelector('#map .map-top');
  if (top && typeof ResizeObserver === 'function') new ResizeObserver(syncTopHeight).observe(top);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && cardIsland) closeIslandCard();
  });
  window.addEventListener('resize', () => { syncTopHeight(); scheduleMini(); });
  document.addEventListener('visibilitychange', syncTopHeight);
  refreshExtras();
}
