// ことばの地図 — screens, canvas views, and the bottom sheet.
//
// One rule the whole file obeys: coordinates that come from the server are
// never recomputed here. The orbit view chooses a RADIUS for each person from
// their real distance and an ANGLE from their real bearing; the map view is a
// plain pan/zoom of the server's x/y. Nothing is re-projected client-side.

import { EMOJI, avatarCss, drawAvatar, paintAvatar } from './avatars.js';

const $ = (id) => document.getElementById(id);
// Must stay in sync with ISLAND_COLORS in core/config.py.
const ISLAND_COLORS = [
  '#f472b6', '#a78bfa', '#38bdf8', '#34d399', '#fbbf24',
  '#fb7185', '#818cf8', '#4ade80', '#2dd4bf', '#c084fc',
];
const STORAGE_KEY = 'kotoba-map-me';
const MIN_TEXT = 30;
const WORLD = 1000;

const state = {
  me: null,
  map: null,
  view: 'orbit',
  selected: null,
  camera: { scale: 1, x: 0, y: 0 },
  hits: [],
  raf: 0,
  t0: performance.now(),
};

// ---------------------------------------------------------------- utilities

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((element) => {
    element.classList.toggle('active', element.id === id);
  });
  const active = $(id);
  active.classList.remove('fade-in');
  void active.offsetWidth;
  active.classList.add('fade-in');
}

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('on'), 2600);
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `通信に失敗しました (${response.status})`);
  return body;
}

function islandColor(clusterId) {
  return ISLAND_COLORS[clusterId % ISLAND_COLORS.length];
}

/** Fraction of seed pairs closer than `distance`. Mirrors core/similarity.py. */
function percentileRank(distance, quantiles) {
  if (!quantiles || !quantiles.length) return 0.5;
  const last = quantiles.length - 1;
  if (distance <= quantiles[0]) return 0;
  if (distance >= quantiles[last]) return 1;
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (quantiles[middle] <= distance) low = middle; else high = middle;
  }
  const span = quantiles[high] - quantiles[low] || 1;
  return (low + (distance - quantiles[low]) / span) / last;
}

function similarityPercent(distance, quantiles) {
  return Math.round(100 * (1 - percentileRank(distance, quantiles)));
}

const distanceBetween = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------- welcome

(function setupWelcome() {
  const slides = $('slides');
  const dots = [...$('dots').children];
  slides.addEventListener('scroll', () => {
    const index = Math.round(slides.scrollLeft / slides.clientWidth);
    dots.forEach((dot, i) => dot.classList.toggle('on', i === index));
  }, { passive: true });
  $('startBtn').addEventListener('click', () => showScreen('profile'));
})();

// ---------------------------------------------------------------- profile

let chosenIcon = String(Math.floor(Math.random() * EMOJI.length));

(function setupProfile() {
  const grid = $('iconGrid');
  EMOJI.forEach((emoji, index) => {
    const cell = document.createElement('button');
    cell.className = 'icon-cell';
    cell.type = 'button';
    cell.textContent = emoji;
    cell.style.background = avatarCss(String(index));
    cell.setAttribute('aria-label', `アイコン ${index + 1}`);
    cell.addEventListener('click', () => {
      chosenIcon = String(index);
      [...grid.children].forEach((child) => child.classList.remove('on'));
      cell.classList.add('on');
    });
    grid.appendChild(cell);
  });
  grid.children[Number(chosenIcon)].classList.add('on');

  const textInput = $('textInput');
  const nameInput = $('nameInput');
  const counter = $('counter');
  const counterText = $('counterText');
  const ringValue = counter.querySelector('.value');
  const CIRCUMFERENCE = 56.5;

  function refresh() {
    const length = textInput.value.trim().length;
    const ratio = Math.min(1, length / MIN_TEXT);
    ringValue.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - ratio));
    counter.classList.toggle('done', length >= MIN_TEXT);
    counterText.textContent = length >= MIN_TEXT ? `${length}字` : `あと${MIN_TEXT - length}字`;
    $('submitBtn').disabled = !(length >= MIN_TEXT && nameInput.value.trim());
  }
  textInput.addEventListener('input', refresh);
  nameInput.addEventListener('input', refresh);
  refresh();

  $('submitBtn').addEventListener('click', join);
})();

// ---------------------------------------------------------------- join

async function join() {
  const name = $('nameInput').value.trim();
  const text = $('textInput').value.trim();
  $('formError').textContent = '';
  showScreen('computing');

  const steps = [...document.querySelectorAll('.step')];
  steps.forEach((step) => step.classList.remove('on', 'done'));
  let stepIndex = 0;
  steps[0].classList.add('on');
  const ticker = setInterval(() => {
    if (stepIndex < steps.length - 1) {
      steps[stepIndex].classList.replace('on', 'done');
      steps[++stepIndex].classList.add('on');
    }
  }, 620);

  const started = performance.now();
  try {
    const result = await api('/api/join', {
      method: 'POST',
      body: JSON.stringify({ icon_id: chosenIcon, name, text }),
    });
    // Let the animation finish so the reveal never flashes past.
    const elapsed = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1900 - elapsed)));
    clearInterval(ticker);
    steps.forEach((step) => { step.classList.remove('on'); step.classList.add('done'); });

    state.me = result;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      id: result.id, edit_token: result.edit_token, icon_id: result.icon_id, name: result.name,
    }));
    showReveal(result);
  } catch (error) {
    clearInterval(ticker);
    showScreen('profile');
    $('formError').textContent = error.message;
  }
}

// ---------------------------------------------------------------- reveal

function showReveal(result) {
  $('revealIsland').innerHTML = `<span>${result.island ? result.island.name : '—'}</span> の島`;

  const container = $('revealNeighbors');
  container.innerHTML = '';
  if (!result.neighbors.length) {
    container.innerHTML =
      '<p style="text-align:center;color:var(--muted);font-size:13px">' +
      'まだあなたひとりです。<br>このURLを誰かに送ると、その人が地図に現れます。</p>';
  } else {
    container.insertAdjacentHTML('beforeend', '<div class="section-label">あなたに近い人</div>');
    result.neighbors.forEach((person, index) => {
      container.appendChild(neighborCard(person, index * 160));
    });
    if (result.farthest && result.neighbors.length >= 2) {
      container.insertAdjacentHTML('beforeend', '<div class="section-label">いちばん遠い人</div>');
      container.appendChild(neighborCard(result.farthest, 520));
    }
  }
  showScreen('reveal');
}

function neighborCard(person, delay) {
  const card = document.createElement('button');
  card.className = 'card';
  card.style.animationDelay = `${delay}ms`;
  const shared = person.shared && person.shared.length
    ? person.shared.join('・')
    : '共通の言葉はなし';

  const avatar = document.createElement('div');
  avatar.className = 'card-avatar';
  paintAvatar(avatar, person.icon_id);

  const body = document.createElement('div');
  body.className = 'card-body';
  body.innerHTML =
    `<div class="card-name"></div>` +
    `<div class="card-shared${person.shared && person.shared.length ? '' : ' none'}"></div>`;
  body.querySelector('.card-name').textContent = person.name;
  body.querySelector('.card-shared').textContent = shared;

  const score = document.createElement('div');
  score.className = 'card-sim num';
  score.innerHTML = `${person.similarity}<small>%</small>`;

  card.append(avatar, body, score);
  card.addEventListener('click', () => openSheet(person));
  return card;
}

$('toMapBtn').addEventListener('click', enterMain);

// ---------------------------------------------------------------- main view

async function enterMain() {
  showScreen('main');
  await refreshMap();
  resizeCanvas();
  startLoop();
  updateIslandBadge();
}

async function refreshMap() {
  state.map = await api('/api/map');
}

function updateIslandBadge() {
  const badge = $('islandBadge');
  if (state.view === 'map' || !state.me || !state.me.island) {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  $('islandSwatch').style.background = islandColor(state.me.cluster_id);
  $('islandText').innerHTML = `あなたは <b>${state.me.island.name}</b> の島`;
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((other) => other.classList.remove('on'));
    tab.classList.add('on');
    state.view = tab.dataset.view;
    if (state.view === 'map') fitCamera();
    updateIslandBadge();
  });
});

$('meBtn').addEventListener('click', () => {
  if (state.me) openSheet({ ...state.me, similarity: 100, shared: [], self: true });
});

// ---------------------------------------------------------------- canvas

const canvas = $('stage');
const ctx = canvas.getContext('2d');
let dpr = 1;
let width = 0;
let height = 0;

function resizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  width = canvas.clientWidth;
  height = canvas.clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (state.view === 'map') fitCamera();
}
window.addEventListener('resize', resizeCanvas);

function startLoop() {
  if (state.raf) return;
  const frame = () => {
    render();
    state.raf = requestAnimationFrame(frame);
  };
  state.raf = requestAnimationFrame(frame);
}

function render() {
  ctx.clearRect(0, 0, width, height);
  if (!state.map) return;
  state.hits = [];
  if (state.view === 'orbit') renderOrbit();
  else renderMap();
}

// ---- orbit -----------------------------------------------------------------
//
// Angle is the true bearing from you to the other person on the full map.
// Radius is their distance expressed as a percentile against the seed corpus,
// so a ring genuinely means "closer than N% of pairs" and is labelled as such.

const RING_RANKS = [0.25, 0.5, 0.75];
const SELF_SIZE = 56;

/** Avatar diameter shrinks as the map fills up, so a busy ring still reads. */
function avatarSize(count) {
  return Math.max(26, Math.min(42, 46 - count));
}

/** rank 0..1 -> pixel radius. Never inside the centre avatar. */
function orbitRadius(rank, size) {
  const inner = SELF_SIZE / 2 + size / 2 + 12;
  const outer = Math.min(width, height) / 2 - size / 2 - 20;
  return inner + Math.max(0, outer - inner) * rank;
}

function renderOrbit() {
  const time = (performance.now() - state.t0) / 1000;
  const centerX = width / 2;
  const centerY = height / 2;

  if (!state.me) return;
  const quantiles = state.map.quantiles;
  const others = state.map.users.filter((user) => user.id !== state.me.id);
  const size = avatarSize(others.length);

  // rings: these are real percentile boundaries, not decoration
  ctx.save();
  ctx.strokeStyle = '#332a3f';
  ctx.setLineDash([3, 7]);
  RING_RANKS.forEach((rank, index) => {
    ctx.lineDashOffset = (index % 2 ? time * 9 : -time * 9);
    ctx.beginPath();
    ctx.arc(centerX, centerY, orbitRadius(rank, size), 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.setLineDash([]);
  ctx.fillStyle = '#6b6377';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  RING_RANKS.forEach((rank) => {
    ctx.fillText(`近い順 ${rank * 100}%`, centerX, centerY - orbitRadius(rank, size) - 5);
  });
  ctx.restore();

  // place everyone: angle is the true bearing, radius is the true percentile
  const placed = others.map((user) => {
    const distance = distanceBetween(state.me, user);
    const rank = Math.min(1, Math.max(0, percentileRank(distance, quantiles)));
    return {
      user,
      distance,
      angle: Math.atan2(user.y - state.me.y, user.x - state.me.x),
      radius: orbitRadius(rank, size),
      size,
    };
  });
  relaxAngles(placed);

  // connectors to the three closest
  const closest = [...placed].sort((a, b) => a.distance - b.distance).slice(0, 3);
  ctx.save();
  ctx.setLineDash([2, 5]);
  closest.forEach((item, index) => {
    ctx.strokeStyle = index === 0 ? 'rgba(251,146,60,.45)' : 'rgba(155,147,166,.22)';
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(centerX + Math.cos(item.angle) * item.radius, centerY + Math.sin(item.angle) * item.radius);
    ctx.stroke();
  });
  ctx.restore();

  placed.forEach((item, index) => {
    const float = Math.sin(time * 0.85 + index * 1.7) * 2.5;
    const x = centerX + Math.cos(item.angle) * item.radius;
    const y = centerY + Math.sin(item.angle) * item.radius + float;
    const isNearest = closest[0] && closest[0].user.id === item.user.id;
    drawAvatar(ctx, item.user.icon_id, x, y, item.size, {
      ring: islandColor(item.user.cluster_id),
      glow: isNearest ? 'rgba(251,146,60,.75)' : null,
    });
    ctx.fillStyle = '#9b93a6';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(clip(item.user.name, 6), x, y + item.size / 2 + 12);
    state.hits.push({ x, y, r: item.size / 2 + 8, user: item.user, distance: item.distance });
  });

  // you, last so you sit on top
  const pulse = 1 + Math.sin(time * 1.9) * 0.045;
  ctx.save();
  ctx.strokeStyle = 'rgba(251,146,60,.3)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(centerX, centerY, (SELF_SIZE / 2 + 9) * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  drawAvatar(ctx, state.me.icon_id, centerX, centerY, SELF_SIZE, { glow: 'rgba(251,146,60,.5)' });

  if (!others.length) {
    ctx.fillStyle = '#6b6377';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('まだあなたひとりです', centerX, centerY + 96);
    ctx.fillText('URLを誰かに送ってみてください', centerX, centerY + 116);
  }
}

/** Nudge ANGLES only, so avatars stop overlapping. Radius stays exact.
 *
 * The push is measured in ARC LENGTH and converted to an angle per item, so a
 * pair sitting close to the centre gets the large angular shove it needs while
 * a pair out near the rim gets a small one. A fixed angular push (the obvious
 * version) leaves inner avatars permanently stacked.
 */
function relaxAngles(placed) {
  const TWO_PI = Math.PI * 2;
  for (let pass = 0; pass < 40; pass += 1) {
    let worst = 0;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i];
        const b = placed[j];
        const dx = Math.cos(a.angle) * a.radius - Math.cos(b.angle) * b.radius;
        const dy = Math.sin(a.angle) * a.radius - Math.sin(b.angle) * b.radius;
        const gap = Math.hypot(dx, dy);
        const need = (a.size + b.size) / 2 + 8;
        if (gap >= need) continue;

        const overlap = need - gap;
        worst = Math.max(worst, overlap);
        // Half the shortfall each, converted from arc length to radians.
        const shiftA = (overlap * 0.5) / Math.max(a.radius, 1);
        const shiftB = (overlap * 0.5) / Math.max(b.radius, 1);
        let delta = ((b.angle - a.angle) % TWO_PI + TWO_PI) % TWO_PI;
        // Push along the shorter way round, and break exact ties deterministically.
        const direction = delta === 0 ? (i % 2 ? 1 : -1) : (delta < Math.PI ? 1 : -1);
        a.angle -= shiftA * direction;
        b.angle += shiftB * direction;
      }
    }
    if (worst < 0.5) break;
  }
}

// ---- map -------------------------------------------------------------------

/** Frame the land that actually exists, not the abstract 0-1000 box.
 *
 * The isotropic scaling maps the 99th-percentile radius to the box, so the
 * corners are always empty. Fitting the seed's real bounding box fills the
 * screen with terrain instead of margin.
 */
function fitCamera() {
  if (!state.map || !state.map.seed.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  state.map.seed.forEach(([x, y]) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });

  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  // Leave room for the top bar and the island badge.
  const scale = Math.min((width * 0.94) / spanX, (height - 190) / spanY);
  state.camera = {
    scale,
    x: width / 2 - ((minX + maxX) / 2) * scale,
    y: height / 2 - ((minY + maxY) / 2) * scale,
  };
}

const toScreen = (x, y) => ({
  x: x * state.camera.scale + state.camera.x,
  y: y * state.camera.scale + state.camera.y,
});

function renderMap() {
  const time = (performance.now() - state.t0) / 1000;
  const { scale } = state.camera;

  // Terrain: the seed corpus, unnamed. It exists to show the shape of the land,
  // so it has to be visible as texture without competing with the avatars.
  ctx.save();
  const dotRadius = Math.max(1.5, 3.2 * scale);
  ctx.globalAlpha = 0.3;
  state.map.seed.forEach(([x, y, clusterId]) => {
    const point = toScreen(x, y);
    if (point.x < -20 || point.x > width + 20 || point.y < -20 || point.y > height + 20) return;
    ctx.fillStyle = islandColor(clusterId);
    ctx.beginPath();
    ctx.arc(point.x, point.y, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();

  // Island names, only when zoomed out enough for them not to collide.
  // Drawn with a halo because they sit directly on top of the terrain dots.
  if (scale < 0.55) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(13, 10, 17, .92)';
    state.map.islands.forEach((island) => {
      const point = toScreen(island.cx, island.cy);
      ctx.strokeText(island.name, point.x, point.y);
      ctx.fillStyle = islandColor(island.id);
      ctx.fillText(island.name, point.x, point.y);
    });
    ctx.restore();
  }

  const meId = state.me && state.me.id;
  state.map.users.forEach((user, index) => {
    const point = toScreen(user.x, user.y);
    if (point.x < -40 || point.x > width + 40 || point.y < -40 || point.y > height + 40) return;
    const isMe = user.id === meId;
    const size = isMe ? 40 : 30;

    if (isMe) {
      const pulse = 1 + Math.sin(time * 1.9) * 0.09;
      ctx.save();
      ctx.strokeStyle = 'rgba(251,146,60,.4)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, (size / 2 + 8) * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    drawAvatar(ctx, user.icon_id, point.x, point.y, size, {
      ring: islandColor(user.cluster_id),
      glow: isMe ? 'rgba(251,146,60,.5)' : null,
    });
    if (scale > 0.32 || isMe) {
      ctx.save();
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(13, 10, 17, .9)';
      ctx.strokeText(clip(user.name, 6), point.x, point.y + size / 2 + 12);
      ctx.fillStyle = '#cfc8d8';
      ctx.fillText(clip(user.name, 6), point.x, point.y + size / 2 + 12);
      ctx.restore();
    }
    state.hits.push({ x: point.x, y: point.y, r: size / 2 + 8, user });
  });
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

// ---- gestures --------------------------------------------------------------

(function setupGestures() {
  const pointers = new Map();
  let pinchStart = null;
  let dragged = false;

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragged = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: state.camera.scale };
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const next = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, next);
    if (state.view !== 'map') return;

    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      zoomAt(midX, midY, (pinchStart.scale * distance) / pinchStart.distance);
      dragged = true;
    } else if (pointers.size === 1) {
      const dx = next.x - previous.x;
      const dy = next.y - previous.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
      state.camera.x += dx;
      state.camera.y += dy;
    }
  });

  function release(event) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchStart = null;
  }
  canvas.addEventListener('pointerup', (event) => {
    release(event);
    if (!dragged) handleTap(event);
  });
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('wheel', (event) => {
    if (state.view !== 'map') return;
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, state.camera.scale * (event.deltaY < 0 ? 1.12 : 0.89));
  }, { passive: false });

  function zoomAt(screenX, screenY, nextScale) {
    const clamped = Math.min(4, Math.max(0.12, nextScale));
    const worldX = (screenX - state.camera.x) / state.camera.scale;
    const worldY = (screenY - state.camera.y) / state.camera.scale;
    state.camera.scale = clamped;
    state.camera.x = screenX - worldX * clamped;
    state.camera.y = screenY - worldY * clamped;
  }
})();

function handleTap(event) {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  let best = null;
  state.hits.forEach((hit) => {
    const distance = Math.hypot(hit.x - x, hit.y - y);
    if (distance <= hit.r && (!best || distance < best.distance)) {
      best = { distance, hit };
    }
  });
  if (!best) return;
  const user = best.hit.user;
  if (state.me && user.id === state.me.id) {
    openSheet({ ...state.me, similarity: 100, shared: [], self: true });
  } else {
    openSheet(user);
  }
}

// ---------------------------------------------------------------- sheet

async function openSheet(person) {
  const body = $('sheetBody');
  body.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:20px 0">読み込み中…</p>';
  $('sheet').classList.add('on');
  $('sheetBackdrop').classList.add('on');

  let detail = person;
  if (!person.self && (person.text === undefined || person.shared === undefined)) {
    try {
      const viewer = state.me ? state.me.id : '';
      detail = await api(`/api/user/${person.id}?viewer=${encodeURIComponent(viewer)}`);
    } catch (error) {
      body.innerHTML = `<p style="color:var(--bad);padding:20px 0">${error.message}</p>`;
      return;
    }
  }
  renderSheet(detail, Boolean(person.self));
}

function renderSheet(person, isSelf) {
  const body = $('sheetBody');
  body.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'sheet-head';
  const avatar = document.createElement('div');
  avatar.className = 'sheet-avatar';
  paintAvatar(avatar, person.icon_id);
  const names = document.createElement('div');
  names.innerHTML = '<div class="sheet-name"></div><div class="sheet-sub"></div>';
  names.querySelector('.sheet-name').textContent = person.name;
  names.querySelector('.sheet-sub').textContent =
    (isSelf ? 'あなた・' : '') + (person.island ? `${person.island.name} の島` : '');
  head.append(avatar, names);
  body.append(head);

  if (!isSelf && typeof person.similarity === 'number') {
    const sim = document.createElement('div');
    sim.className = 'sim';
    sim.innerHTML =
      `<span class="sim-value num">${person.similarity}%</span>` +
      `<span class="sim-label">似てる度 ・ 地図上で ${Math.round(person.distance || 0)}px 離れています</span>`;
    const bar = document.createElement('div');
    bar.className = 'sim-bar';
    bar.innerHTML = '<div class="sim-fill" style="width:0"></div>';
    body.append(sim, bar);
    requestAnimationFrame(() => {
      bar.querySelector('.sim-fill').style.width = `${person.similarity}%`;
    });
  }

  if (!isSelf) {
    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = '共有していることば';
    body.append(label);
    if (person.shared && person.shared.length) {
      const chips = document.createElement('div');
      chips.className = 'chips';
      person.shared.forEach((word) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = word;
        chips.append(chip);
      });
      body.append(chips);
    } else {
      const note = document.createElement('div');
      note.className = 'sheet-note';
      note.textContent = person.note || '共通の言葉は見つかりませんでした。';
      body.append(note);
    }
  }

  const text = document.createElement('div');
  text.className = 'sheet-text';
  text.textContent = person.text || '';
  body.append(text);

  const actions = document.createElement('div');
  actions.className = 'sheet-actions';
  if (isSelf) {
    const share = document.createElement('button');
    share.className = 'btn';
    share.style.flex = '1';
    share.textContent = 'URLをコピー';
    share.addEventListener('click', shareUrl);
    const leave = document.createElement('button');
    leave.className = 'btn btn-ghost';
    leave.textContent = '地図から消す';
    leave.addEventListener('click', leaveMap);
    actions.append(share, leave);
  } else {
    const close = document.createElement('button');
    close.className = 'btn btn-ghost btn-block';
    close.textContent = '閉じる';
    close.addEventListener('click', closeSheet);
    actions.append(close);
  }
  body.append(actions);
}

function closeSheet() {
  $('sheet').classList.remove('on');
  $('sheetBackdrop').classList.remove('on');
}
// pointerdown, not click: the tap that OPENS the sheet arms the backdrop
// mid-gesture, so the trailing click of that same tap would land on the backdrop
// and close the sheet again immediately. pointerdown already fired before the
// backdrop existed, so only a genuinely new tap closes it.
$('sheetBackdrop').addEventListener('pointerdown', closeSheet);

async function shareUrl() {
  const url = location.origin;
  try {
    if (navigator.share) await navigator.share({ title: 'ことばの地図', url });
    else { await navigator.clipboard.writeText(url); toast('URLをコピーしました'); }
  } catch { /* the user dismissed the share sheet */ }
}

async function leaveMap() {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (!saved) return;
  if (!confirm('地図から自分を消しますか？')) return;
  try {
    await api('/api/leave', {
      method: 'POST',
      body: JSON.stringify({ id: saved.id, edit_token: saved.edit_token }),
    });
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  } catch (error) {
    toast(error.message);
  }
}

// ---------------------------------------------------------------- boot

(async function boot() {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (!saved) return; // first visit: welcome screen is already showing
  try {
    const me = await api(`/api/user/${saved.id}`);
    state.me = { ...me, edit_token: saved.edit_token };
    await enterMain();
  } catch {
    // The row is gone (a rebuild, or they left). Start over.
    localStorage.removeItem(STORAGE_KEY);
  }
})();
