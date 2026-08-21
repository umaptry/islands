// かさなり — screens, canvas views, and the bottom sheet.
//
// One rule the whole file obeys: coordinates that come from the server are
// never recomputed here. The orbit view chooses a RADIUS for each person from
// their real distance and an ANGLE from their real bearing; the map view is a
// plain pan/zoom of the server's x/y. Nothing is re-projected client-side.

import { EMOJI, avatarCss, drawAvatar, paintAvatar } from './avatars.js';

const $ = (id) => document.getElementById(id);
// Must stay in sync with ISLAND_COLORS in core/config.py and the --i0..--i9
// tokens in web/style.css. Darker than a pastel set on purpose: these are drawn
// on a white page and as thin text halos, where pastels disappear.
const ISLAND_COLORS = [
  '#ff5d8f', '#b085ff', '#35c2f5', '#17c08a', '#ffb020',
  '#ff7a59', '#7b8cff', '#4cd07a', '#23c9c0', '#d07dff',
];
// Ink drawn onto the canvas. Named here so the light palette lives in one place
// instead of being sprinkled through the render functions as literals.
const INK = {
  // The map is a sea. Terrain is land, drawn green and nearly opaque so a
  // cluster of seed points reads as an island rather than as scattered dots.
  land: '#7cc47c',
  ring: 'rgba(255, 255, 255, .40)',
  faint: 'rgba(255, 255, 255, .78)',
  label: 'rgba(255, 255, 255, .92)',
  mapLabel: '#ffffff',
  halo: 'rgba(31, 44, 59, .55)',
  self: 'rgba(255, 255, 255, .75)',
  glow: 'rgba(255, 255, 255, .65)',
  link: 'rgba(255, 255, 255, .75)',
  linkFaint: 'rgba(255, 255, 255, .3)',
};
const STORAGE_KEY = 'kasanari-me';
// Safari in private mode, and any browser with site data blocked, throws from
// localStorage rather than returning null. An exception here used to escape
// join()'s try block and send someone back to the form with an error message
// AFTER their profile had already been saved on the server.
const storage = {
  read() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch {
      return null;
    }
  },
  write(value) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  clear() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing we can do, and nothing that should stop the app */
    }
  },
};
const MIN_TEXT = 30;
const WORLD = 1000;

const state = {
  me: null,
  map: null,
  // ids this person has already liked, and the senders we have already told
  // them about. `notified` is seeded from the first inbox response so opening
  // the page does not replay every like as a fresh notification.
  liked: new Set(),
  notified: new Set(),
  inboxReady: false,
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

// Buttons are the only way through the intro. The previous version was a
// scroll-snap track, which let a half-swipe settle between two slides with the
// dots showing one thing and the screen another.
(function setupIntro() {
  const track = $('slideTrack');
  const dots = [...$('dots').children];
  const nextBtn = $('nextBtn');
  const backBtn = $('backBtn');
  const total = track.children.length;
  let index = 0;

  function paint() {
    track.style.transform = `translateX(${-index * 100}%)`;
    dots.forEach((dot, i) => dot.classList.toggle('on', i === index));
    backBtn.hidden = index === 0;
    nextBtn.textContent = index === total - 1 ? 'はじめる' : '次へ';
  }

  nextBtn.addEventListener('click', () => {
    if (index < total - 1) { index += 1; paint(); } else showScreen('profile');
  });
  backBtn.addEventListener('click', () => {
    if (index > 0) { index -= 1; paint(); }
  });
  paint();
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

let joining = false;

async function join() {
  // A double tap on a phone fired this twice and put two of the same person on
  // the map, each with its own id.
  if (joining) return;
  joining = true;
  $('submitBtn').disabled = true;

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
    const saved = storage.write({
      id: result.id, edit_token: result.edit_token, icon_id: result.icon_id, name: result.name,
    });
    showReveal(result);
    if (!saved) {
      toast('この端末では次回の自動復帰ができません');
    }
  } catch (error) {
    clearInterval(ticker);
    showScreen('profile');
    $('formError').textContent = error.message;
  } finally {
    joining = false;
    $('submitBtn').disabled = false;
  }
}

// ---------------------------------------------------------------- reveal

function showReveal(result) {
  $('revealIsland').textContent = result.island ? result.island.name : '—';

  const container = $('revealNeighbors');
  container.innerHTML = '';
  if (!result.neighbors.length) {
    container.innerHTML =
      '<p class="empty-note">まだあなただけです。URLを送ると相手も地図に出ます。</p>';
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
    : '共通のことばなし';

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
  const ok = await refreshMap();
  if (!ok && !state.map) {
    // Nothing to draw and nothing cached. Say so and keep retrying rather than
    // leaving someone staring at a blank screen.
    toast('地図を読み込めませんでした。再試行しています…');
  }
  resizeCanvas();
  startLoop();
  updateIslandBadge();
  startMapPolling();
  refreshInbox();
}

/** Returns true on success. Keeps the previous map on failure. */
async function refreshMap() {
  try {
    state.map = await api('/api/map');
    return true;
  } catch {
    return false;
  }
}

// People join while others are already looking at the map. Without this the
// only way to see somebody arrive was to reload the page, which is not
// something a room full of people is going to think of doing.
const MAP_POLL_MS = 15000;
let pollTimer = 0;

function startMapPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    // A backgrounded tab should not keep polling; it wakes up on visibility.
    if (document.hidden || document.querySelector('.screen.active').id !== 'main') return;
    const before = state.map ? state.map.users.length : -1;
    const ok = await refreshMap();
    if (ok && state.map.users.length !== before) updateIslandBadge();
    // Awaited, not fired alongside: a like almost always arrives from somebody
    // who just joined, and the inbox can only name them once the map holds them.
    await refreshInbox();
  }, MAP_POLL_MS);

  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || document.querySelector('.screen.active').id !== 'main') return;
    await refreshMap();
    await refreshInbox();
  });
}

/** Who liked me, and who have I liked. Notifies about arrivals, not history. */
async function refreshInbox() {
  if (!state.me || !state.me.edit_token) return;
  let inbox;
  try {
    inbox = await api('/api/inbox', {
      method: 'POST',
      body: JSON.stringify({ id: state.me.id, edit_token: state.me.edit_token }),
    });
  } catch {
    return; // a missed poll is not worth telling anyone about
  }

  state.liked = new Set(inbox.given);
  if (state.map) state.map.like_counts = inbox.counts;

  const fresh = inbox.received.filter((entry) => !state.notified.has(entry.from_id));
  inbox.received.forEach((entry) => state.notified.add(entry.from_id));
  // The first response is history, not news: seed the seen set and say nothing.
  if (!state.inboxReady) {
    state.inboxReady = true;
    return;
  }
  const names = await Promise.all(fresh.map((entry) => senderName(entry.from_id)));
  names.forEach((who, index) => {
    setTimeout(() => toast(`${who}さんからいいねが届きました`), index * 2800);
  });
}

/** Name for an id, from the cached map if possible and the server if not.
 *
 * The map is refreshed before the inbox for exactly this reason, but a person
 * can still join and like within the same poll window, and a notification that
 * says "だれかさん" is worse than one extra request.
 */
async function senderName(id) {
  const known = (state.map ? state.map.users : []).find((user) => user.id === id);
  if (known) return known.name;
  try {
    const person = await api(`/api/user/${id}`);
    return person.name;
  } catch {
    return 'だれか';
  }
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

// relaxAngles is O(n^2 x 40). Running it inside the render loop cost roughly
// 400k iterations per frame at the 100-person cap, which drops a phone to
// single-figure fps. The layout only depends on who is on the map and how big
// the canvas is, so compute it when that changes and reuse it every frame.
let orbitCache = { key: '', placed: [], size: 0 };

function orbitLayout(others, quantiles) {
  const size = avatarSize(others.length);
  const key = `${width}x${height}|${size}|${state.me.id}|${others.map((u) => u.id).join(',')}`;
  if (orbitCache.key === key) return orbitCache;

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
  orbitCache = { key, placed, size };
  return orbitCache;
}

function renderOrbit() {
  const time = (performance.now() - state.t0) / 1000;
  const centerX = width / 2;
  const centerY = height / 2;

  if (!state.me) return;
  const quantiles = state.map.quantiles;
  const others = state.map.users.filter((user) => user.id !== state.me.id);
  const { placed, size } = orbitLayout(others, quantiles);

  // rings: these are real percentile boundaries, not decoration
  ctx.save();
  ctx.strokeStyle = INK.ring;
  ctx.setLineDash([3, 7]);
  RING_RANKS.forEach((rank, index) => {
    ctx.lineDashOffset = (index % 2 ? time * 9 : -time * 9);
    ctx.beginPath();
    ctx.arc(centerX, centerY, orbitRadius(rank, size), 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.setLineDash([]);
  ctx.restore();

  // connectors to the three closest
  const closest = [...placed].sort((a, b) => a.distance - b.distance).slice(0, 3);
  ctx.save();
  ctx.setLineDash([2, 5]);
  closest.forEach((item, index) => {
    ctx.strokeStyle = index === 0 ? INK.link : INK.linkFaint;
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
      glow: isNearest ? INK.glow : null,
    });
    ctx.fillStyle = INK.label;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(clip(item.user.name, 6), x, y + item.size / 2 + 12);
    state.hits.push({ x, y, r: item.size / 2 + 8, user: item.user, distance: item.distance });
  });

  // you, last so you sit on top
  const pulse = 1 + Math.sin(time * 1.9) * 0.045;
  ctx.save();
  ctx.strokeStyle = INK.self;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(centerX, centerY, (SELF_SIZE / 2 + 9) * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  drawAvatar(ctx, state.me.icon_id, centerX, centerY, SELF_SIZE, { glow: INK.glow });
  // Your own avatar was not a hit target, so tapping yourself - the most
  // obvious thing to try in this view - did nothing at all.
  state.hits.push({ x: centerX, y: centerY, r: SELF_SIZE / 2 + 10, user: state.me, distance: 0 });

  if (!others.length) {
    ctx.fillStyle = INK.faint;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('まだあなただけです', centerX, centerY + 96);
    ctx.fillText('URLを送ると相手も出ます', centerX, centerY + 116);
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
        // +18, not +8: each avatar carries a name label underneath it, and a
        // gap that only clears the discs leaves the names written on top of
        // each other whenever a few people land in the same distance band.
        const need = (a.size + b.size) / 2 + 18;
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
  // Bigger and nearly opaque: at 0.3 alpha on a blue sea the seed points read
  // as haze. Overlapping green discs merge into landmasses, which is the whole
  // point of drawing the corpus at all.
  const dotRadius = Math.max(3.6, 7.2 * scale);
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = INK.land;
  state.map.seed.forEach(([x, y]) => {
    const point = toScreen(x, y);
    if (point.x < -20 || point.x > width + 20 || point.y < -20 || point.y > height + 20) return;
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
    ctx.strokeStyle = INK.halo;
    ctx.fillStyle = INK.mapLabel;
    state.map.islands.forEach((island) => {
      const point = toScreen(island.cx, island.cy);
      ctx.strokeText(island.name, point.x, point.y);
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
      ctx.strokeStyle = INK.self;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, (size / 2 + 8) * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    drawAvatar(ctx, user.icon_id, point.x, point.y, size, {
      ring: islandColor(user.cluster_id),
      glow: isMe ? INK.glow : null,
    });
    if (scale > 0.32 || isMe) {
      ctx.save();
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = INK.halo;
      ctx.strokeText(clip(user.name, 6), point.x, point.y + size / 2 + 12);
      ctx.fillStyle = INK.mapLabel;
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
    // Measure movement before the view check: the orbit view does not pan, but
    // it still has to know a swipe was a swipe, or the finger lifting after a
    // drag opens whichever avatar happened to be underneath it.
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
    if (state.view !== 'map') return;

    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      zoomAt(midX, midY, (pinchStart.scale * distance) / pinchStart.distance);
      dragged = true;
    } else if (pointers.size === 1) {
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
      '<span class="sim-label">似てる度</span>';
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

  const received = likeCountFor(person.id);
  if (received) {
    const tally = document.createElement('div');
    tally.className = 'like-count';
    tally.innerHTML = `いいね <b class="num">${received}</b>`;
    body.append(tally);
  }

  const actions = document.createElement('div');
  actions.className = 'sheet-actions';
  const close = document.createElement('button');
  close.className = 'btn btn-quiet';
  close.textContent = '閉じる';
  close.addEventListener('click', closeSheet);

  if (isSelf) {
    // Your own card is read-only now: no sharing, no leaving, no liking
    // yourself. Closing is the only thing left to do.
    close.classList.add('btn-block');
    actions.append(close);
  } else {
    actions.append(close, likeButton(person));
  }
  body.append(actions);
}

function likeCountFor(id) {
  return (state.map && state.map.like_counts && state.map.like_counts[id]) || 0;
}

function likeButton(person) {
  const button = document.createElement('button');
  button.className = 'btn btn-like';
  const paint = () => {
    const liked = state.liked.has(person.id);
    button.dataset.liked = liked ? '1' : '0';
    button.textContent = liked ? 'いいね済み' : 'いいね';
    button.disabled = liked;
  };
  paint();

  button.addEventListener('click', async () => {
    if (state.liked.has(person.id) || !state.me) return;
    // Optimistic: the tap should feel done immediately, and a failure puts the
    // button back rather than leaving it lying about what happened.
    state.liked.add(person.id);
    paint();
    try {
      await api('/api/like', {
        method: 'POST',
        body: JSON.stringify({
          id: state.me.id, edit_token: state.me.edit_token, to_id: person.id,
        }),
      });
      toast(`${person.name}さんにいいねを送りました`);
      refreshMap();
    } catch (error) {
      state.liked.delete(person.id);
      paint();
      toast(error.message);
    }
  });
  return button;
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
$('sheetClose').addEventListener('click', closeSheet);

// ---------------------------------------------------------------- boot

// index.html opens on #booting rather than on the intro, so a returning
// visitor does not watch slide 1 flash past before their map loads. Whichever
// branch wins here picks the first screen the user actually sees.
(function boot() {
  const saved = storage.read();
  if (!saved || !saved.id) {
    showScreen('intro');
    return;
  }
  (async () => {
    try {
      const me = await api(`/api/user/${saved.id}`);
      state.me = { ...me, edit_token: saved.edit_token };
      await enterMain();
    } catch (error) {
      // A 404 means the row is gone (they left, or the table was cleared) and
      // starting over is right. A 503 or a dropped connection means the server
      // is briefly unhappy, and throwing away their identity over that would
      // lose them their place on the map for good.
      if (/\b404\b/.test(error.message) || /見つかりません/.test(error.message)) {
        storage.clear();
      } else {
        toast('接続できませんでした。ページを再読み込みしてください。');
      }
      showScreen('intro');
    }
  })();
})();
