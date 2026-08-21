// かさなり — screens, canvas views, and the bottom sheet.
//
// One rule the whole file obeys: coordinates that come from the server are
// never recomputed here. The orbit view chooses a RADIUS for each person from
// their 似てる度 and an ANGLE from their real bearing on the map; the map view
// is a plain pan/zoom of the server's x/y. Nothing is re-projected client-side.

import { EMOJI, avatarCss, drawFace, paintAvatar } from './avatars.js';

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
  // The map is a sea. The seed corpus is the shallows - pale, so it reads as
  // the shape of the water rather than competing with the posts. Every post is
  // drawn as its own island on top, which is the thing worth looking at.
  shallows: '#a9dcae',
  land: '#59b463',
  landRim: '#3f9a4c',
  ring: 'rgba(255, 255, 255, .40)',
  faint: 'rgba(255, 255, 255, .78)',
  label: 'rgba(255, 255, 255, .92)',
  mapLabel: '#ffffff',
  halo: 'rgba(31, 44, 59, .55)',
  self: 'rgba(255, 255, 255, .75)',
  glow: 'rgba(255, 255, 255, .65)',
  link: 'rgba(255, 255, 255, .75)',
  linkFaint: 'rgba(255, 255, 255, .3)',
  // The sea's own furniture. Faint on purpose: chart texture is something you
  // notice after the islands, never instead of them.
  seaMark: 'rgba(255, 255, 255, .17)',
  surf: 'rgba(255, 255, 255, .55)',
  bird: 'rgba(255, 255, 255, .62)',
};
const STORAGE_KEY = 'kasanari-me';
// Safari in private mode, and any browser with site data blocked, throws from
// localStorage rather than returning null. An exception here used to escape
// join()'s try block and send someone back to the form with an error message
// AFTER their profile had already been saved on the server.
//
// One person can hold several posts, so what is stored is a LIST plus which one
// is currently being looked at. The single-object shape from the first version
// is migrated on read: someone who joined this morning must not be logged out
// by an afternoon deploy.
const storage = {
  read() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch {
      return { posts: [], active: null };
    }
    if (!raw) return { posts: [], active: null };
    if (Array.isArray(raw.posts)) {
      return { posts: raw.posts.filter((post) => post && post.id), active: raw.active || null };
    }
    return raw.id ? { posts: [raw], active: raw.id } : { posts: [], active: null };
  },
  write(value) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  addPost(entry) {
    const saved = storage.read();
    const posts = saved.posts.filter((post) => post.id !== entry.id).concat(entry);
    return storage.write({ posts, active: entry.id });
  },
  setActive(id) {
    const saved = storage.read();
    storage.write({ posts: saved.posts, active: id });
  },
  removePost(id) {
    const saved = storage.read();
    const posts = saved.posts.filter((post) => post.id !== id);
    storage.write({ posts, active: posts.length ? posts[posts.length - 1].id : null });
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
  // Every post this browser owns. state.me is whichever of them is active.
  myPosts: [],
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

/** Is this id one of my own posts? Not the same question as "is it active". */
const mine = (id) => state.myPosts.some((post) => post.id === id);

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

// Assigned by setupProfile, which owns the field references. Declared here
// because the IIFE below runs during module evaluation: a `let` placed after it
// would still be in its temporal dead zone at the moment of assignment.
let resetProfileForm = () => {};

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

  // Writing a second post must start from a blank sheet, not from whatever the
  // last one said.
  resetProfileForm = () => {
    // One person, one face. The icon and the name are chosen on the first post
    // and reused after that: a second post is another thing THIS person wrote,
    // and re-picking an avatar each time would make it read as somebody else.
    const first = state.myPosts[0];
    nameInput.value = first ? (first.name || '') : '';
    textInput.value = '';
    $('formError').textContent = '';
    if (first) {
      chosenIcon = String(first.icon_id);
    } else {
      chosenIcon = String(Math.floor(Math.random() * EMOJI.length));
    }
    [...grid.children].forEach((child, index) => {
      child.classList.toggle('on', String(index) === chosenIcon);
    });
    $('iconField').hidden = Boolean(first);
    $('cancelBtn').hidden = state.myPosts.length === 0;
    refresh();
  };
})();

function openProfileForm() {
  resetProfileForm();
  showScreen('profile');
}

$('addBtn').addEventListener('click', openProfileForm);
$('cancelBtn').addEventListener('click', () => {
  if (state.me) showScreen('main'); else showScreen('intro');
});

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
    const entry = {
      id: result.id, edit_token: result.edit_token, icon_id: result.icon_id, name: result.name,
    };
    state.myPosts = state.myPosts.filter((post) => post.id !== entry.id).concat(entry);
    const saved = storage.addPost(entry);
    orbitCache = { key: '', placed: [], size: 0 };
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
    // The viewer id buys a {id: 似てる度} table computed from the 448-dim
    // vectors, so the orbit places people by the same number the sheet prints.
    const query = state.me ? `?viewer=${encodeURIComponent(state.me.id)}` : '';
    state.map = await api(`/api/map${query}`);
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
    if (ok) syncMyIsland();
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

/** Island names are rebuilt from the posts on them, so the name attached to me
 *  at join time goes stale as soon as somebody else lands in my region. */
function syncMyIsland() {
  if (!state.me || !state.map) return;
  const current = (state.map.islands || []).find((island) => island.id === state.me.cluster_id);
  if (current && (!state.me.island || state.me.island.name !== current.name)) {
    state.me.island = current;
    updateIslandBadge();
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
// Radius is 似てる度 inverted, so the innermost person is the one the profile
// sheet also calls the closest. That number comes from the 448-dim vectors on
// the server, not from the two map coordinates - the map is a 2-D shadow of
// that space and loses most of the neighbourhood structure on the way down, so
// reading closeness off it put unrelated people in the middle of this view.
// Older servers send no similarity table; then the radius falls back to the
// percentile of the map distance, which is what this view used to do.

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
  // similarity is keyed on the viewer, so a switch of identity has to bust the
  // cache even when the same people are on the map.
  const similarity = state.map.similarity || null;
  const key = `${width}x${height}|${size}|${state.me.id}|${similarity ? 'c' : 'd'}|${others.map((u) => u.id).join(',')}`;
  if (orbitCache.key === key) return orbitCache;

  const placed = others.map((user) => {
    const distance = distanceBetween(state.me, user);
    // Radius is 似てる度 inverted: the server's cosine-based number when it is
    // there, the map-distance percentile when it is not.
    const percent = similarity ? similarity[user.id] : undefined;
    const rank = typeof percent === 'number'
      ? Math.min(1, Math.max(0, 1 - percent / 100))
      : Math.min(1, Math.max(0, percentileRank(distance, quantiles)));
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
  // by radius, not by map distance, so the lines point at the three people the
  // profile sheet would also call the closest.
  const closest = [...placed].sort((a, b) => a.radius - b.radius).slice(0, 3);
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
    // Same vocabulary as the map: a post is an island with a face on it.
    drawIsland(ctx, x, y, item.size * 0.68, item.user.id, islandColor(item.user.cluster_id));
    drawFace(ctx, item.user.icon_id, x, y, item.size * 0.7,
      isNearest ? '#ffffff' : islandColor(item.user.cluster_id));
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
  drawIsland(ctx, centerX, centerY, SELF_SIZE * 0.54, state.me.id,
    islandColor(state.me.cluster_id));
  drawFace(ctx, state.me.icon_id, centerX, centerY, SELF_SIZE * 0.56, '#ffffff');
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
  if (!state.map) return;
  // seed_bounds is what the server sends now. The other two branches are there
  // so a client and a server from different deploys still frame something
  // sensible instead of leaving the map unusable.
  let bounds = state.map.seed_bounds;
  if (!bounds && Array.isArray(state.map.seed) && state.map.seed.length) {
    let lowX = Infinity, lowY = Infinity, highX = -Infinity, highY = -Infinity;
    state.map.seed.forEach(([x, y]) => {
      if (x < lowX) lowX = x;
      if (x > highX) highX = x;
      if (y < lowY) lowY = y;
      if (y > highY) highY = y;
    });
    bounds = [lowX, lowY, highX, highY];
  }
  if (!bounds || bounds.length !== 4 || bounds.some((value) => !Number.isFinite(value))) {
    bounds = [0, 0, WORLD, WORLD];
  }
  const [minX, minY, maxX, maxY] = bounds;

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

// ---- boats -----------------------------------------------------------------
//
// Traffic on the sea, and nothing more. The boats carry no data: they are not
// people, not posts, not clusters. They exist because a map of islands with
// nothing moving on it reads as a diagram rather than a place. Everything here
// is decoration - it never touches the camera, the coordinates, or state.hits,
// so no boat can move an island or swallow a tap.

const BOAT_COUNT = 6;
// Screen pixels at every zoom, like islandRadius. A boat that grew with the
// map would start competing with the islands; the point is that it stays tiny.
const BOAT_LENGTH = 7;
const REDUCED_MOTION = !!(window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/** The water the boats stay inside: the seed bounds, widened a little.
 *
 * The same bounds fitCamera frames, so the traffic is where the sea is rather
 * than wandering off into empty world space. Cached against the map payload -
 * it only changes when a new one arrives.
 */
let seaCache = null;
function seaBounds() {
  if (seaCache && seaCache.map === state.map) return seaCache.box;
  let bounds = state.map && state.map.seed_bounds;
  if (!bounds || bounds.length !== 4 || bounds.some((value) => !Number.isFinite(value))) {
    bounds = [0, 0, WORLD, WORLD];
  }
  const [minX, minY, maxX, maxY] = bounds;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const box = {
    x: minX - spanX * 0.075,
    y: minY - spanY * 0.075,
    w: spanX * 1.15,
    h: spanY * 1.15,
  };
  seaCache = { map: state.map, box };
  return box;
}

/** Every boat, positioned from the clock alone.
 *
 * Position is a pure function of `time`, not an accumulated velocity: a
 * backgrounded tab, a resize, or a dropped frame cannot drift the fleet or
 * leave it somewhere it should not be.
 *
 * Each boat works a fixed chord between two points inside the sea box and
 * eases back and forth along it. A wrap-around course would teleport a boat
 * across the screen in full view; easing means it slows, turns, and comes
 * back, which is what a small boat looks like anyway.
 */
function drawBoats(ctx, time) {
  if (REDUCED_MOTION) return;
  const sea = seaBounds();
  // World units per second, tuned so one crossing takes the better part of a
  // minute. Slow enough that the map still reads as a still map.
  const speed = Math.max(sea.w, sea.h) / 55;
  const midX = sea.x + sea.w / 2;
  const midY = sea.y + sea.h / 2;
  for (let i = 0; i < BOAT_COUNT; i += 1) {
    const seed = 7919 * (i + 1);
    // The chord is built as a pair of points either side of the middle rather
    // than as two free points: two free points can land close together, and a
    // boat on a short leg turns around every few seconds, which reads as
    // fidgeting rather than as a crossing. `reach` + `shift` stay under half
    // the box on both axes, so the whole run is inside the water.
    const angle = noise(seed, 1) * Math.PI * 2;
    const reach = 0.28 + noise(seed, 2) * 0.12;
    const shift = (noise(seed, 3) - 0.5) * 0.18;
    const armX = Math.cos(angle) * sea.w * reach;
    const armY = Math.sin(angle) * sea.h * reach;
    const offX = -Math.sin(angle) * sea.w * shift;
    const offY = Math.cos(angle) * sea.h * shift;
    const ax = midX + offX - armX;
    const ay = midY + offY - armY;
    const bx = midX + offX + armX;
    const by = midY + offY + armY;
    const span = Math.hypot(bx - ax, by - ay);
    if (span < 1) continue;
    const period = (2 * span) / speed;
    const cycle = (time / period + noise(seed, 5)) * Math.PI * 2;
    const travel = 0.5 - Math.cos(cycle) * 0.5;
    const point = toScreen(ax + (bx - ax) * travel, ay + (by - ay) * travel);
    if (point.x < -40 || point.x > width + 40 || point.y < -40 || point.y > height + 40) continue;
    // A hair of bob, well under the height of the hull. Any more and six of
    // them moving together turns into a wobble across the whole screen.
    const bob = Math.sin(time * 1.1 + noise(seed, 6) * Math.PI * 2) * 0.6;
    const outbound = Math.sin(cycle) >= 0;
    drawBoat(ctx, point.x, point.y + bob, (bx >= ax) === outbound ? 1 : -1);
  }
}

/** Chart hatching: the little wave marks a paper sea chart is covered in.
 *
 * Fixed world positions rather than a grid sized off the zoom. A grid has to
 * change spacing as you zoom or it turns to noise at the far end, and every
 * change of spacing pops. Forty-odd marks scattered once across the sea are
 * sparse when you are close and read as texture when you are far out, and they
 * never move relative to the islands - which is the whole point of a chart.
 */
const SEA_MARK_COUNT = 44;

function drawSeaMarks(ctx, time) {
  const sea = seaBounds();
  ctx.save();
  ctx.strokeStyle = INK.seaMark;
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  for (let i = 0; i < SEA_MARK_COUNT; i += 1) {
    const seed = 104729 * (i + 1);
    const spot = toScreen(sea.x + noise(seed, 1) * sea.w, sea.y + noise(seed, 2) * sea.h);
    if (spot.x < -20 || spot.x > width + 20 || spot.y < -20 || spot.y > height + 20) continue;
    const sway = REDUCED_MOTION ? 0 : Math.sin(time * 0.6 + noise(seed, 3) * Math.PI * 2) * 1.3;
    const unit = 3.2;
    ctx.beginPath();
    for (let row = 0; row < 2; row += 1) {
      const y = spot.y + row * 2.6;
      const x = spot.x + sway + row * 1.4;
      ctx.moveTo(x - unit, y);
      ctx.quadraticCurveTo(x - unit * 0.5, y - 1.5, x, y);
      ctx.quadraticCurveTo(x + unit * 0.5, y + 1.5, x + unit, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Surf around one island, breathing slowly.
 *
 * Drawn under the land fill and a shade wider, so only the outer half of the
 * stroke survives - a shoreline rather than a ring around a token. It reuses
 * islandPath with the island's own seed, so the surf follows the same wobbled
 * outline the land has and not a circle.
 *
 * This is the one moving thing on the map that belongs to a post rather than
 * to the decoration: the land somebody wrote is standing in water.
 */
function drawSurf(ctx, x, y, radius, id, time) {
  const seed = hashId(id);
  const swell = REDUCED_MOTION
    ? 1.06
    : 1.06 + Math.sin(time * 0.8 + noise(seed, 9) * Math.PI * 2) * 0.035;
  ctx.save();
  islandPath(ctx, x, y, radius * swell, seed);
  ctx.strokeStyle = INK.surf;
  ctx.lineWidth = Math.max(1.4, radius * 0.11);
  ctx.globalAlpha = 0.38;
  ctx.stroke();
  ctx.restore();
}

/** Two skeins of three birds, crossing well above the boats.
 *
 * Same eased chord the boats use, at roughly two and a half times the speed -
 * far enough apart that a bird never reads as another boat. Drawn after the
 * land and before the faces: birds pass over an island, not through a person.
 */
const BIRD_SKEINS = 2;
const BIRD_SIZE = 2.6;

function drawBirds(ctx, time) {
  if (REDUCED_MOTION) return;
  const sea = seaBounds();
  const midX = sea.x + sea.w / 2;
  const midY = sea.y + sea.h / 2;
  const speed = Math.max(sea.w, sea.h) / 22;
  ctx.save();
  ctx.strokeStyle = INK.bird;
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  for (let flight = 0; flight < BIRD_SKEINS; flight += 1) {
    const seed = 15485863 * (flight + 1);
    const angle = noise(seed, 1) * Math.PI * 2;
    const reach = 0.30 + noise(seed, 2) * 0.10;
    const shift = (noise(seed, 3) - 0.5) * 0.18;
    const armX = Math.cos(angle) * sea.w * reach;
    const armY = Math.sin(angle) * sea.h * reach;
    const offX = -Math.sin(angle) * sea.w * shift;
    const offY = Math.cos(angle) * sea.h * shift;
    const ax = midX + offX - armX;
    const ay = midY + offY - armY;
    const span = Math.hypot(armX, armY) * 2;
    if (span < 1) continue;
    const period = (2 * span) / speed;
    const cycle = (time / period + noise(seed, 5)) * Math.PI * 2;
    const travel = 0.5 - Math.cos(cycle) * 0.5;
    const lead = toScreen(ax + armX * 2 * travel, ay + armY * 2 * travel);
    if (lead.x < -60 || lead.x > width + 60 || lead.y < -60 || lead.y > height + 60) continue;
    // Heading in screen space. toScreen is a uniform scale plus a translation,
    // so the world direction and the screen direction are the same direction.
    const sign = Math.sin(cycle) >= 0 ? 1 : -1;
    const unitX = (armX * 2 * sign) / span;
    const unitY = (armY * 2 * sign) / span;
    for (let bird = 0; bird < 3; bird += 1) {
      // A loose V: one in front, two trailing off either wing.
      const back = bird * 7;
      const side = bird === 1 ? -5 : (bird === 2 ? 5 : 0);
      const flap = Math.sin(time * 5.5 + bird * 0.7 + flight) * 0.7;
      drawBird(
        ctx,
        lead.x - unitX * back - unitY * side,
        lead.y - unitY * back + unitX * side,
        flap,
      );
    }
  }
  ctx.restore();
}

function drawBird(ctx, x, y, flap) {
  const unit = BIRD_SIZE;
  // Wingtips above the body, dipping through the middle: the gull mark. Pull
  // the control points the other way and the same three points draw a dome,
  // which at this size reads as a hill rather than a bird.
  const tip = y - unit * 0.5 - flap;
  ctx.beginPath();
  ctx.moveTo(x - unit, tip);
  ctx.quadraticCurveTo(x - unit * 0.5, y + unit * 0.16, x, y);
  ctx.quadraticCurveTo(x + unit * 0.5, y + unit * 0.16, x + unit, tip);
  ctx.stroke();
}

/** One boat, in screen pixels: hull, sail, and a wake that fades out astern. */
function drawBoat(ctx, x, y, facing) {
  const unit = BOAT_LENGTH;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(facing, 1);

  const wake = ctx.createLinearGradient(-unit * 2.6, 0, -unit * 0.4, 0);
  wake.addColorStop(0, 'rgba(255, 255, 255, 0)');
  wake.addColorStop(1, INK.linkFaint);
  ctx.strokeStyle = wake;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-unit * 2.6, unit * 0.26);
  ctx.lineTo(-unit * 0.4, unit * 0.26);
  ctx.stroke();

  ctx.fillStyle = INK.label;
  ctx.beginPath();
  ctx.moveTo(-unit * 0.5, -unit * 0.1);
  ctx.lineTo(unit * 0.5, -unit * 0.1);
  ctx.lineTo(unit * 0.24, unit * 0.32);
  ctx.lineTo(-unit * 0.34, unit * 0.32);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(-unit * 0.06, -unit * 0.16);
  ctx.lineTo(-unit * 0.06, -unit * 0.95);
  ctx.lineTo(unit * 0.4, -unit * 0.16);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/** Screen-space de-clutter for map labels.
 *
 * Names used to be hidden below a zoom threshold, so zooming out dropped every
 * one of them at once - the map looked like it had lost the information. They
 * are drawn at every zoom now, and crowding is handled where crowding actually
 * happens, in screen pixels: a label is skipped only when it would land on top
 * of one already placed. Space is claimed in priority order - island names,
 * then you, then everybody else - so the headline never loses to a passer-by.
 */
function makeLabelSpace() {
  const taken = [];
  return function claim(x, y, textWidth, textHeight) {
    const left = x - textWidth / 2 - 2;
    const right = x + textWidth / 2 + 2;
    const top = y - textHeight / 2 - 1;
    const bottom = y + textHeight / 2 + 1;
    for (let i = 0; i < taken.length; i += 1) {
      const box = taken[i];
      if (left < box.right && right > box.left && top < box.bottom && bottom > box.top) {
        return false;
      }
    }
    taken.push({ left, right, top, bottom });
    return true;
  };
}

function renderMap() {
  const time = (performance.now() - state.t0) / 1000;
  const { scale } = state.camera;

  // The seed corpus is NOT drawn. It used to be a field of dots, which looked
  // like a second kind of island while meaning something entirely different -
  // the shape of the reference corpus, not a person. The names it produced are
  // still worth keeping, so the regions stay labelled and the only land on the
  // map is somebody's post. The seed coordinates still frame the camera.

  const meId = state.me && state.me.id;

  // Islands first, all of them, then the avatars. Drawing each island directly
  // before its own avatar would let a later island's fill cover an earlier
  // avatar wherever two posts land close together.
  const visible = [];
  state.map.users.forEach((user) => {
    const point = toScreen(user.x, user.y);
    if (point.x < -60 || point.x > width + 60 || point.y < -60 || point.y > height + 60) return;
    visible.push({ user, point, isMe: user.id === meId });
  });
  // The sea, then what is on it, then the land, then what flies over it. Each
  // pass is behind the next, so nothing decorative can sit on top of a person.
  drawSeaMarks(ctx, time);
  drawBoats(ctx, time);
  visible.forEach(({ user, point, isMe }) => {
    drawSurf(ctx, point.x, point.y, islandRadius(scale) * (isMe ? 1.25 : 1), user.id, time);
  });
  visible.forEach(({ user, point, isMe }) => {
    drawIsland(ctx, point.x, point.y, islandRadius(scale) * (isMe ? 1.25 : 1),
      user.id, islandColor(user.cluster_id));
  });
  drawBirds(ctx, time);

  // Island names are painted last, so nothing can bury them - but they claim
  // their space first, so nothing can crowd them out either.
  const claim = makeLabelSpace();
  const labelLift = islandRadius(scale) + 22;
  const islandLabels = [];
  ctx.save();
  ctx.font = '700 12px system-ui, sans-serif';
  (state.map.islands || []).forEach((island) => {
    const spot = toScreen(island.cx, island.cy);
    const y = spot.y - labelLift;
    // The claim is a reservation, never a filter: an island name always draws.
    // Two regions can drift close enough to overlap each other, and a region
    // losing its name as posts arrive is the bug this view already had once.
    claim(spot.x, y, ctx.measureText(island.name).width, 14);
    islandLabels.push({ name: island.name, x: spot.x, y });
  });
  ctx.restore();

  // You come next: your own name is never the one that gives way.
  const mine = visible.find((entry) => entry.isMe);
  if (mine) {
    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    const below = mine.point.y + islandRadius(scale) * 1.25 + 11;
    claim(mine.point.x, below - 4, ctx.measureText(clip(mine.user.name, 6)).width, 12);
    ctx.restore();
  }

  visible.forEach(({ user, point, isMe }, index) => {
    const radius = islandRadius(scale) * (isMe ? 1.25 : 1);
    // A shade under the island's own radius, so the land still reads as land
    // around the face rather than being covered by it.
    const size = radius * 1.04;

    if (isMe) {
      const pulse = 1 + Math.sin(time * 1.9) * 0.09;
      ctx.save();
      ctx.strokeStyle = INK.self;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, (radius + 7) * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    drawFace(ctx, user.icon_id, point.x, point.y, size, islandColor(user.cluster_id));
    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    const label = clip(user.name, 6);
    const below = point.y + radius + 11;
    // isMe already reserved its box above, so it always draws.
    if (isMe || claim(point.x, below - 4, ctx.measureText(label).width, 12)) {
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = INK.halo;
      ctx.strokeText(label, point.x, below);
      ctx.fillStyle = INK.mapLabel;
      ctx.fillText(label, point.x, below);
    }
    ctx.restore();
    state.hits.push({ x: point.x, y: point.y, r: Math.max(18, radius + 6), user });
  });

  // Island names last, so nothing can bury them. They are the headline now -
  // each one is built from the posts underneath it - and there is one per
  // populated region rather than ten fixed ones, so they do not crowd. Lifted
  // in screen pixels, so the gap does not change with zoom. The positions were
  // resolved above, before anything else could take the space.
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 12px system-ui, sans-serif';
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK.halo;
  ctx.fillStyle = INK.mapLabel;
  islandLabels.forEach((label) => {
    ctx.strokeText(label.name, label.x, label.y);
    ctx.fillText(label.name, label.x, label.y);
  });
  ctx.restore();
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** FNV-1a over the id. Same person, same island shape, on every device. */
function hashId(id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Deterministic 0..1 from a seed and an index. */
function noise(seed, index) {
  const value = Math.sin(seed * 0.0001 + index * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/** A rounded, irregular blob: one post drawn as one island.
 *
 * Points on a wobbled ellipse, joined through their midpoints with quadratic
 * curves so the outline is smooth rather than a visible polygon. The wobble
 * comes from the id, so an island keeps its shape as the map is panned and
 * across everybody's screen - the same promise the coordinates make.
 */
function islandPath(ctx, x, y, radius, seed) {
  const COUNT = 11;
  const points = [];
  for (let i = 0; i < COUNT; i += 1) {
    const angle = (i / COUNT) * Math.PI * 2;
    const wobble = 0.74 + noise(seed, i) * 0.46;
    points.push([
      x + Math.cos(angle) * radius * wobble,
      y + Math.sin(angle) * radius * wobble * 0.8,
    ]);
  }
  ctx.beginPath();
  const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let start = midpoint(points[COUNT - 1], points[0]);
  ctx.moveTo(start[0], start[1]);
  for (let i = 0; i < COUNT; i += 1) {
    const control = points[i];
    const end = midpoint(points[i], points[(i + 1) % COUNT]);
    ctx.quadraticCurveTo(control[0], control[1], end[0], end[1]);
  }
  ctx.closePath();
}

/** Island size for the current zoom. Small: the map is an archipelago of many
 *  little places, not a handful of continents. */
function islandRadius(scale) {
  return Math.max(17, 29 * scale);
}

function drawIsland(ctx, x, y, radius, id, accent) {
  const seed = hashId(id);
  ctx.save();
  islandPath(ctx, x, y, radius, seed);
  ctx.fillStyle = INK.land;
  ctx.fill();
  // A thin rim in the island's own hue: enough to tell two neighbouring posts
  // apart without turning the archipelago into a colour chart. Keep it quiet -
  // at full strength the rim reads as a ring and the green stops reading as land.
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1, radius * 0.055);
  ctx.globalAlpha = 0.55;
  ctx.stroke();
  ctx.restore();
}

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

function isOwn(person) {
  return Boolean(person.self) || mine(person.id);
}

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
  renderSheet(detail, isOwn(person));
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
    // Otherwise a high number next to somebody drawn on the far side of the
    // map reads as a bug rather than as the two different things they are.
    const note = document.createElement('div');
    note.className = 'sim-note';
    note.textContent = '地図の位置は全体を見渡すためのもの。似てる度は潰す前の448次元で測っています。';
    body.append(sim, bar, note);
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
    // Your own card is read-only: no sharing, no leaving, no liking yourself.
    close.classList.add('btn-block');
    actions.append(close);
  } else {
    actions.append(close, likeButton(person));
  }
  body.append(actions);

  if (isSelf && state.myPosts.length > 1) body.append(postSwitcher());
}

/** The other posts this browser owns, with a tap to switch to one. */
function postSwitcher() {
  const wrap = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = 'あなたの投稿';
  wrap.append(label);

  state.myPosts.forEach((post) => {
    const row = document.createElement('button');
    row.className = 'card';
    const avatar = document.createElement('div');
    avatar.className = 'card-avatar';
    paintAvatar(avatar, post.icon_id);
    const bodyText = document.createElement('div');
    bodyText.className = 'card-body';
    bodyText.innerHTML = '<div class="card-name"></div><div class="card-shared none"></div>';
    bodyText.querySelector('.card-name').textContent = post.name;
    const active = state.me && post.id === state.me.id;
    bodyText.querySelector('.card-shared').textContent = active ? '表示中' : 'この投稿に切り替える';
    row.append(avatar, bodyText);
    if (!active) row.addEventListener('click', () => switchTo(post.id));
    wrap.append(row);
  });
  return wrap;
}

async function switchTo(id) {
  const post = state.myPosts.find((entry) => entry.id === id);
  if (!post) return;
  try {
    const profile = await api(`/api/user/${id}`);
    state.me = { ...profile, edit_token: post.edit_token };
  } catch {
    toast('切り替えられませんでした。');
    return;
  }
  storage.setActive(id);
  orbitCache = { key: '', placed: [], size: 0 };
  state.inboxReady = false;
  state.notified = new Set();
  closeSheet();
  updateIslandBadge();
  await refreshInbox();
  toast(`${post.name} の投稿に切り替えました`);
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
    button.textContent = liked ? 'いいね済' : 'いいねをおくる';
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
  state.myPosts = saved.posts;
  if (!saved.posts.length) {
    showScreen('intro');
    return;
  }

  // Try the active post, then fall back through the rest. One deleted post
  // should not strand somebody who still has others on the map.
  const order = [
    ...saved.posts.filter((post) => post.id === saved.active),
    ...saved.posts.filter((post) => post.id !== saved.active),
  ];

  (async () => {
    let networkTrouble = false;
    for (const post of order) {
      try {
        const profile = await api(`/api/user/${post.id}`);
        state.me = { ...profile, edit_token: post.edit_token };
        storage.setActive(post.id);
        await enterMain();
        return;
      } catch (error) {
        // A 404 means that row is gone (it was removed, or the table was
        // cleared). A 503 or a dropped connection means the server is briefly
        // unhappy, and discarding the identity over that would cost somebody
        // their place on the map for good.
        if (/\b404\b/.test(error.message) || /見つかりません/.test(error.message)) {
          state.myPosts = state.myPosts.filter((entry) => entry.id !== post.id);
          storage.removePost(post.id);
        } else {
          networkTrouble = true;
          break;
        }
      }
    }
    if (networkTrouble) toast('接続できませんでした。ページを再読み込みしてください。');
    showScreen('intro');
  })();
})();
