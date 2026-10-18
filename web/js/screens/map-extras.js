// The small parts around the map: nearby islands, the island card,
// the mini map and the "this week" switch. map.js owns the screen;
// this file only draws these parts and calls the map module.
//
// The map module is imported as a namespace on purpose: a name it does not
// export yet is then `undefined` (and the part stays hidden) instead of
// stopping the whole page from loading.

import { state } from '../state.js';
import { $, clear, clip, closeSheet, el, sheetOpen } from '../ui.js';
import { icon } from '../icons.js';
import { PALETTE, TIMES } from '../map/palette.js';
import * as mapApi from '../map/index.js';
import { MINI_SHOW_ZOOM, miniToWorld, miniVisible, pickNear, recentPosts } from './map-extras-logic.js';

const NEAR_COUNT = 3;
const MINI_SIZE = 96;
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
const islandKey = (island) => island.island_id || island.label;   // the same key map/index.js uses
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
  const signature = picked.map((island) => `${islandKey(island)}:${islandName(island)}`).join('|');
  if (signature === nearSignature) return;
  nearSignature = signature;
  box.hidden = picked.length === 0;
  clear(box);
  if (!picked.length) return;
  box.append(el('span', { className: 'near-label' }, icon('pin', 14), el('span', { text: '近くの島' })));
  picked.forEach((island) => {
    box.append(el('button', {
      className: 'near-chip', attrs: { type: 'button' }, text: islandName(island),
      on: { click: () => {
        openIslandCard(island);
        if (typeof mapApi.panTo === 'function') mapApi.panTo(island.cx, island.cy);
      } },
    }));
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
  if (sheetOpen()) closeSheet();
  if (!cardIsland) cardOpener = document.activeElement;
  cardIsland = island;
  const card = clear($('islandCard'));
  // A named island (AI or hand-made name) already says what it is about, so its
  // card shows no topics; only genre-named islands list "いま話題".
  const named = island.name_source === 'ai' || island.name_source === 'manual';
  const topics = named ? [] : (island.topics || []).slice(0, 3);
  const ids = island.post_ids || [];
  const recent = recentPosts(ids, state.postsById, 2);

  card.append(
    el('button', {
      className: 'island-card-close', attrs: { type: 'button', 'aria-label': '閉じる' },
      on: { click: closeIslandCard },
    }, icon('close', 18)),
    el('h3', { className: 'island-card-name', text: islandName(island) }),
    el('p', { className: 'island-card-count', text: `${island.people ?? 0}人・投稿${ids.length}件` }),
  );
  if (topics.length) {
    card.append(el('div', { className: 'island-card-topics' },
      el('span', { className: 'island-card-label', text: 'いま話題' }),
      ...topics.map((topic) => el('span', { className: 'island-topic', text: topic }))));
  }
  if (recent.length) {
    card.append(el('div', { className: 'island-card-posts' }, ...recent.map((post) => el('button', {
      className: 'island-post', attrs: { type: 'button' },
      on: { click: () => handlers.openPost(post.id) },
    },
    el('b', { text: post.display_name || '' }),
    el('span', { text: clip(String(post.body || '').replace(/\s+/g, ' ').trim(), 40) })))));
  }
  // Far islands may not be loaded yet: say so instead of showing a thin list.
  if (recent.length < Math.min(2, ids.length)) {
    card.append(el('p', { className: 'island-card-note', text: '島に入ると、ほかの投稿も見られます。' }));
  }
  const enter = el('button', {
    className: 'btn island-card-enter', attrs: { type: 'button' }, text: '島に入る',
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

// ---------------------------------------------------------------- this week

function paintBusy() {
  const button = $('busyToggle');
  if (typeof mapApi.setBusyMode !== 'function') { button.hidden = true; return; }
  button.hidden = false;
  const on = typeof mapApi.busyMode === 'function' && mapApi.busyMode();
  button.setAttribute('aria-checked', String(on));
  button.classList.toggle('on', on);
  const count = typeof mapApi.busyCount === 'function' ? mapApi.busyCount() : null;
  $('busyText').textContent = on && finite(count) ? `今週 ${count}件` : '今週の動き';
}

// ---------------------------------------------------------------- shared

/** The mini map sits under whatever the top strip holds (search, chips, the
 * trial banner), so it is placed from the strip's real height. */
function syncTopHeight() {
  const top = document.querySelector('#map .map-top');
  if (!top) return;
  document.documentElement.style.setProperty('--map-top-h', `${Math.round(top.getBoundingClientRect().height)}px`);
}

export function refreshExtras() {
  refreshNearIslands();
  paintBusy();
  scheduleMini();
  syncTopHeight();
}

function onCamera() {
  scheduleMini();
  clearTimeout(nearTimer);
  nearTimer = setTimeout(refreshNearIslands, NEAR_SETTLE_MS);
  if (typeof mapApi.busyCount === 'function' && $('busyToggle').classList.contains('on')) paintBusy();
}

export function setupMapExtras({ openPost }) {
  handlers = { openPost };
  setupMini();

  if (typeof mapApi.onIslandTap === 'function') {
    mapApi.onIslandTap(({ key, island }) => openIslandCard(island, key));
  }
  if (typeof mapApi.onCameraChange === 'function') mapApi.onCameraChange(onCamera);

  $('busyToggle').addEventListener('click', () => {
    const on = !(typeof mapApi.busyMode === 'function' && mapApi.busyMode());
    mapApi.setBusyMode(on);
    paintBusy();
  });

  // A post sheet opening replaces the card; dragging the map puts it away.
  document.addEventListener('sheet:state', () => { if (sheetOpen() && cardIsland) closeIslandCard(); });
  const stage = $('stage');
  let down = null;
  stage.addEventListener('pointerdown', (event) => { down = { x: event.clientX, y: event.clientY }; });
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
