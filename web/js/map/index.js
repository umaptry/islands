// The map.
//
// islands' terrain, drawn on かさなり's coordinates. Posts contribute overlapping
// cones of energy, the sum decides the ground, and the landmasses that emerge are
// named after the words of the people standing on them. People stand on it as
// teardrop pins whose colour and flame say how fired up they are (pins.js);
// lines between them are roads inside an island and planes across the water
// (lines.js).
//
// One rule the whole file obeys: coordinates that come from the server are never
// recomputed here. The map is a plain pan/zoom of the server's x/y. Nothing is
// re-projected client-side.

import { config, energyOf, interactionsOf, islandColor, radiusOf } from '../config.js';
import { matchesFilters, state, filtering } from '../state.js';
import { clip, desktopSheet, sheetOpen, toast } from '../ui.js';
import {
  INK, REDUCED_MOTION, drawBirds, drawBoats, drawFog, drawSeaMarks, drawWhales,
  hashId, makeLabelSpace,
} from './decor.js';
import { detectLandmasses, membership } from './landmass.js';
import { drawKin, drawLinks, drawPlanes, islandFinder } from './lines.js';
import { kinLines } from './kin.js';
import { preloadSprites } from './sprites.js';
import { drawPostPin, drawMiniPin, pinColor, pinGeometry, pinScale, pinTier } from './pins.js';
import { TIER_COUNT, drawLandmark, drawNightLights, drawSettlement, drawTree, setSettled } from './buildings.js';
import { buildDetail, buildTerrain, gridTerrain, toCanvas } from './terrain.js';
import { drawSurf, surfShow } from './surf.js';
import { offThread } from './offthread.js';
import { groundOf } from './coast.js';
import { isRecruiting, isUnreadRecruit } from './reads.js';
import { buzz } from '../feedback.js';
import { playSe } from '../audio.js';
import { PALETTE, PIN, SUN, TIMES, addressParam, timeOfDay } from './palette.js';

let canvas = null;
let ctx = null;
let dpr = 1;
let resizePending = false;
let width = 0;
let height = 0;
let raf = 0;
let started = 0;
let onPick = () => {};
let onStack = () => {};
let hits = [];

// Three distances, measured against the zoom that frames everything (Q57・Q59):
//
//   far   the whole map. Continents, their towns and names, a few pins each;
//         your own posts send out radar rings, and a post asking for people you
//         have not opened wears a gold star. Tapping an island or one of those
//         flies you in.
//   near  everybody's pin where they wrote, in its heat, with names where they
//         fit. Now and then a pin says the start of what it wrote.
//   deep  bigger pins, how much each was answered.
//
// Zoomed out you want to see where the activity is; zoomed in you want to see
// who. Two views of the same fact, and the switch is what keeps a busy map
// readable.
const NEAR_AT = 1.7;
const DEEP_AT = 4;
// The small print - the 「N人・話題」 line under an island's name, the names
// under other people's faces, the dotted lines - waits until about three times
// the whole-map view (where a new post lands): between the overview and there,
// the map showed so much text at once on a phone that nothing stood out.
const DETAIL_AT = 2.9;
// Zoom per pixel of wheel or trackpad-pinch movement (see the wheel handler).
const WHEEL_ZOOM = 0.00375;

function zoomLevel() {
  const fit = state.camera.fit || state.camera.scale;
  const z = state.camera.scale / fit;
  return { z, level: z >= DEEP_AT ? 'deep' : z >= NEAR_AT ? 'near' : 'far' };
}

// The canvas runs under the search bar and the bottom controls. `frame` is how
// much of it, top and bottom, they cover: the camera centres in what is left and
// no name is put where it cannot be read.
let frame = { top: 96, bottom: 120 };

function insets() {
  if (!canvas) return frame;
  const box = canvas.getBoundingClientRect();
  const rects = (selector) => [...document.querySelectorAll(selector)]
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.height > 0 && rect.width > 0);
  const top = rects('.map-top').reduce((low, rect) => Math.max(low, rect.bottom - box.top + 8), 12);
  const bottom = rects('.island-badge, .map-controls, .bottom-nav')
    .reduce((high, rect) => Math.max(high, box.bottom - rect.top + 8), 12);
  return { top: Math.min(top, height * 0.4), bottom: Math.min(bottom, height * 0.4) };
}

/** The controls floating over the map, in canvas px. Labels keep out of them
 * so a name or a speech bubble is never half under the search bar. Measured at
 * most every CHROME_MS: querying and measuring eight elements on every frame
 * was 8% of a phone's frame time while panning (2026-10-16). */
const CHROME_MS = 300;
let chromeCache = { at: -Infinity, boxes: [] };

function chromeBoxes() {
  const now = performance.now();
  if (now - chromeCache.at < CHROME_MS) return chromeCache.boxes;
  chromeCache = { at: now, boxes: measureChrome() };
  return chromeCache.boxes;
}

function measureChrome() {
  if (!canvas) return [];
  const box = canvas.getBoundingClientRect();
  return [...document.querySelectorAll('#map .search, #map .filter-button, #mapDigest, #trialBanner, #participantStop, #islandBadge, #map .map-controls, #mapStatus, #nearIslands, #miniMap, #busyToggle, #islandCard')]
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.height > 0 && rect.width > 0)
    .map((rect) => ({
      x: rect.left - box.left + rect.width / 2, y: rect.top - box.top + rect.height / 2,
      w: rect.width + 8, h: rect.height + 8,
    }));
}

export function initMap(element, { onSelect, onSelectMany }) {
  canvas = element;
  ctx = canvas.getContext('2d');
  onPick = onSelect || (() => {});
  onStack = onSelectMany || ((posts) => onPick(posts[0]));
  started = performance.now();
  preloadSprites();
  resize();
  attachGestures();
  window.addEventListener('resize', resize);
  loop();
}

export function resize() {
  if (!canvas) return;
  // Resized while another screen is up: there is nothing to measure, and the
  // map's enter() calls resize() again when it comes back.
  if (canvas.offsetParent === null) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  width = canvas.clientWidth;
  height = canvas.clientHeight;
  // A canvas that has not been laid out yet reports 0, and a camera fitted to a
  // zero-width box has a zero scale - which turns every viewport query into
  // (-Infinity, Infinity) and asks the server for the whole world. Wait for a
  // frame instead; the first paint happens one tick later either way.
  if (width === 0 || height === 0) {
    if (!resizePending) {
      resizePending = true;
      requestAnimationFrame(() => {
        resizePending = false;
        resize();
      });
    }
    return;
  }
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  frame = insets();
  if (!state.camera.fit) fitCamera();
}

// ---------------------------------------------------------------- camera

/** Frame the land that exists, not the abstract 0-1000 box.
 *
 * The isotropic scaling maps the 99th-percentile radius to the box, so the
 * corners are always empty. Fitting the seed corpus's real bounding box fills
 * the screen with sea and islands instead of margin.
 */
let fitExtent = null;

/** The world box the whole-map camera frames (also what the mini map shows). */
function fitBounds(posts, extent) {
  const valid = posts.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  return extent || (valid.length ? [
    Math.min(...valid.map((p) => p.x - radiusOf(p))), Math.min(...valid.map((p) => p.y - radiusOf(p))),
    Math.max(...valid.map((p) => p.x + radiusOf(p))), Math.max(...valid.map((p) => p.y + radiusOf(p))),
  ] : seedBounds());
}

function fitTarget(posts, extent) {
  const [minX, minY, maxX, maxY] = fitBounds(posts, extent);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  // Edge to edge across, and between the top bar and the bottom controls down:
  // on a wide screen the land fills the width instead of floating in a band.
  frame = insets();
  const usableW = Math.max(120, width - 32);
  const usableH = Math.max(120, height - frame.top - frame.bottom);
  const scale = Math.max(0.05, Math.min(1.6, usableW / spanX, usableH / spanY));
  return {
    scale,
    fit: scale,
    x: width / 2 - ((minX + maxX) / 2) * scale,
    y: frame.top + usableH / 2 - ((minY + maxY) / 2) * scale,
  };
}

export function fitCamera(posts = state.posts, extent = null) {
  if (extent) fitExtent = extent;
  state.camera = fitTarget(posts, extent);
}

/** Pull back to see the whole map, smoothly (the globe button; also what
 * 「参加者を見てみる」 does first). */
export function showAll({ then } = {}) {
  cancelAnimationFrame(tween);
  stopGlide();
  const to = fitTarget(state.posts, fitExtent);
  const from = { ...state.camera };
  const duration = REDUCED_MOTION ? 0 : 700;
  const began = performance.now();
  const step = (now) => {
    const t = duration ? Math.min(1, (now - began) / duration) : 1;
    const k = 1 - (1 - t) ** 3;
    const scale = from.scale * (to.scale / from.scale) ** k;
    // The point under the middle of the screen slides to where the fitted view
    // has it, so the ground neither lurches nor drifts on the way.
    state.camera = {
      scale,
      fit: to.fit,
      x: from.x + (to.x - from.x) * k,
      y: from.y + (to.y - from.y) * k,
    };
    if (t < 1) {
      tween = requestAnimationFrame(step);
      return;
    }
    tween = 0;
    state.camera = to;
    onViewportChange();
    if (then) then();
  };
  tween = requestAnimationFrame(step);
}

/** How far in and out a gesture may go, relative to the fitted view. */
// Three times further in since 2026-10-18 (was max(6, fit x 8)): posts placed by
// their seeds stand close, and of 496 on map v6, 227 could show a face at the
// old limit and 354 at this one. Closer than that is a stack (drawFaces).
function clampScale(value) {
  const fit = state.camera.fit || state.camera.scale;
  return Math.max(fit * 0.5, Math.min(value, Math.max(18, fit * 24)));
}

function seedBounds() {
  const world = config().world;
  const bounds = world.seed_bounds;
  if (Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite)) {
    return bounds;
  }
  return [world.min, world.min, world.max, world.max];
}

/** The water the decoration stays inside: the seed bounds, widened a little. */
let seaCache = null;
function seaBox() {
  const [minX, minY, maxX, maxY] = seedBounds();
  const key = `${minX},${minY},${maxX},${maxY}`;
  if (seaCache && seaCache.key === key) return seaCache.box;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const box = {
    x: minX - spanX * 0.075, y: minY - spanY * 0.075,
    w: spanX * 1.15, h: spanY * 1.15,
  };
  seaCache = { key, box };
  return box;
}

const toScreen = (x, y) => ({
  x: x * state.camera.scale + state.camera.x,
  y: y * state.camera.scale + state.camera.y,
});

const toWorld = (x, y) => ({
  x: (x - state.camera.x) / state.camera.scale,
  y: (y - state.camera.y) / state.camera.scale,
});

/** The world rectangle currently on screen, with a margin. */
export function viewport(margin = 120) {
  const world = config().world;
  // Clamped to the world, and never wider than it. A query for the whole plane
  // is the same answer as a query for the world box, and sending Infinity to
  // PostgREST is a 400 rather than a large result.
  const span = (world.max - world.min) * 2;
  const clamp = (value, fallback) =>
    (Number.isFinite(value) ? Math.max(world.min - span, Math.min(world.max + span, value))
      : fallback);
  const topLeft = toWorld(-margin, -margin);
  const bottomRight = toWorld(width + margin, height + margin);
  return {
    minX: clamp(topLeft.x, world.min - span),
    minY: clamp(topLeft.y, world.min - span),
    maxX: clamp(bottomRight.x, world.max + span),
    maxY: clamp(bottomRight.y, world.max + span),
  };
}

/** Ease the camera onto a post without changing the zoom. */
export function focusOn(post, { lift = 0.34 } = {}) {
  if (!post) return;
  const { scale } = state.camera;
  const targetX = width / 2 - post.x * scale;
  const targetY = height * lift - post.y * scale;
  if (REDUCED_MOTION) {
    state.camera.x = targetX;
    state.camera.y = targetY;
    return;
  }
  const ease = 0.17;
  const step = () => {
    state.camera.x += (targetX - state.camera.x) * ease;
    state.camera.y += (targetY - state.camera.y) * ease;
    if (Math.abs(targetX - state.camera.x) < 0.5 && Math.abs(targetY - state.camera.y) < 0.5) {
      state.camera.x = targetX;
      state.camera.y = targetY;
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

let tween = 0;

/** Fly the camera to a world point at a new zoom (Q57: tap, and it comes closer).
 *
 * The zoom changes geometrically and the point slides linearly to its spot, so
 * the ground neither lurches nor drifts sideways on the way. Any touch stops it
 * where it is. Reduced motion jumps straight there.
 */
export function zoomTo(worldX, worldY, targetScale, { lift = 0.5, x = null, y = null, then } = {}) {
  cancelAnimationFrame(tween);
  frame = insets();
  const from = { ...state.camera };
  const to = clampScale(targetScale);
  const anchorX = x ?? width / 2;
  // `y`, in canvas px, puts the point exactly there instead of `lift` of the
  // way down the free frame.
  const anchorY = y ?? frame.top + Math.max(120, height - frame.top - frame.bottom) * lift;
  const start = toWorld(anchorX, anchorY);
  const duration = REDUCED_MOTION ? 0 : 480;
  const began = performance.now();
  const step = (now) => {
    const t = duration ? Math.min(1, (now - began) / duration) : 1;
    const k = 1 - (1 - t) ** 3;
    const scale = from.scale * (to / from.scale) ** k;
    const wx = start.x + (worldX - start.x) * k;
    const wy = start.y + (worldY - start.y) * k;
    state.camera.scale = scale;
    state.camera.x = anchorX - wx * scale;
    state.camera.y = anchorY - wy * scale;
    if (t < 1) {
      tween = requestAnimationFrame(step);
      return;
    }
    tween = 0;
    onViewportChange();
    if (then) then();
  };
  tween = requestAnimationFrame(step);
}

/** Open an island up: frame its posts at the near distance. */
/** Open an island up: the whole island - its land, which reaches a post's
 * radius beyond the post - fills the screen between the controls, at whatever
 * zoom that takes (2026-10-20, the user: the old cap of 3.6x the whole map left
 * a small island small). */
function zoomToIsland(island) {
  const members = (island.post_ids || []).map((id) => state.postsById.get(id)).filter(Boolean);
  let minX = island.cx;
  let maxX = island.cx;
  let minY = island.cy;
  let maxY = island.cy;
  members.forEach((post) => {
    // A coast reaches 0.7-1 of the radius (coast.js); the full radius keeps it in.
    const r = radiusOf(post);
    minX = Math.min(minX, post.x - r);
    maxX = Math.max(maxX, post.x + r);
    minY = Math.min(minY, post.y - r);
    maxY = Math.max(maxY, post.y + r);
  });
  const usableW = Math.max(120, width - 32);
  const usableH = Math.max(120, height - frame.top - frame.bottom - 16);
  const room = Math.min(usableW / Math.max(1, maxX - minX), usableH / Math.max(1, maxY - minY));
  zoomTo((minX + maxX) / 2, (minY + maxY) / 2, clampScale(room), { lift: 0.5 });
}

/** How close a tapped post is brought: near the largest zoom (2026-10-20, the
 * user: the old 2.5x steps left it small). A post already closer stays so. */
const POST_ZOOM = 0.85;

function postZoom() {
  return Math.max(state.camera.scale, clampScale(Infinity) * POST_ZOOM);
}

// ---------------------------------------------------------------- answers

// A ring that spreads from where something just happened (item 20): a post
// landing, an island opening, a reaction, a new line to somebody. It is drawn
// in world units so it stays on its spot while the camera moves.
const RIPPLE_MS = { big: 1400, small: 760 };

export function ripple(x, y, { big = false, color = MINE } = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  // While a new post is being introduced the big ring waits for the face to
  // land: the screen that posted asks for it at once.
  if (big && reveal) {
    reveal.ripple = { x, y, color };
    return;
  }
  const now = performance.now();
  state.ripples = state.ripples.filter((ring) => now - ring.at < RIPPLE_MS[ring.big ? 'big' : 'small']);
  state.ripples.push({ x, y, at: now, big, color });
}

// The island just opened keeps its name lit for a moment, so the eye knows
// which of the names on screen it was.
let emphasis = { id: null, until: 0 };

function islandKey(island) {
  return island.island_id || island.label;
}

// A screen that wants to show its own card for a tapped island registers here;
// with no handler the map flies in as before.
let islandTapHandler = null;
export function onIslandTap(handler) { islandTapHandler = typeof handler === 'function' ? handler : null; }

/** Fly in to an island by its key (the card's enter button). */
export function enterIsland(key) {
  const island = state.islands.find((entry) => islandKey(entry) === key);
  if (island) openIsland(island);
}

function openIsland(island) {
  emphasis = { id: islandKey(island), until: performance.now() + 1800 };
  ripple(island.cx, island.cy, { color: islandColor(island.cluster_id) });
  buzz('island');
  zoomToIsland(island);
}

// ---------------------------------------------------------------- gestures

// A flick keeps the map moving and slows it down; letting go past the edge of
// the world pulls it back. Both stop the moment a finger lands again.
let glide = 0;
const FRICTION = 0.0045;   // per ms: how quickly a flick runs out
const MIN_FLICK = 0.25;    // px per ms below which letting go just stops

/** How far the camera is outside the world, in screen px, per axis. */
function overshoot() {
  const [minX, minY, maxX, maxY] = seedBounds();
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  // The middle of the screen may wander a fifth of the world past its edge.
  const centre = toWorld(width / 2, frame.top + (height - frame.top - frame.bottom) / 2);
  const outX = centre.x < minX - spanX * 0.2 ? centre.x - (minX - spanX * 0.2)
    : centre.x > maxX + spanX * 0.2 ? centre.x - (maxX + spanX * 0.2) : 0;
  const outY = centre.y < minY - spanY * 0.2 ? centre.y - (minY - spanY * 0.2)
    : centre.y > maxY + spanY * 0.2 ? centre.y - (maxY + spanY * 0.2) : 0;
  return { x: outX * state.camera.scale, y: outY * state.camera.scale };
}

function stopGlide() {
  cancelAnimationFrame(glide);
  glide = 0;
}

function coast(velocity, done) {
  stopGlide();
  let vx = REDUCED_MOTION ? 0 : velocity.x;
  let vy = REDUCED_MOTION ? 0 : velocity.y;
  if (Math.hypot(vx, vy) < MIN_FLICK) { vx = 0; vy = 0; }
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(48, Math.max(0, now - last));
    last = now;
    const decay = Math.exp(-FRICTION * dt);
    state.camera.x += vx * dt;
    state.camera.y += vy * dt;
    vx *= decay;
    vy *= decay;
    // Past the edge: a spring back, and the flick loses its pull outward.
    const out = overshoot();
    const spring = REDUCED_MOTION ? 1 : Math.min(1, dt * 0.012);
    if (out.x) { state.camera.x += out.x * spring; vx *= 0.6; }
    if (out.y) { state.camera.y += out.y * spring; vy *= 0.6; }
    const moving = Math.hypot(vx, vy) > 0.02 || Math.abs(out.x) > 0.5 || Math.abs(out.y) > 0.5;
    if (moving) {
      glide = requestAnimationFrame(step);
      return;
    }
    glide = 0;
    done();
  };
  glide = requestAnimationFrame(step);
}

let onViewportChange = () => {};
export function onCameraSettled(handler) { onViewportChange = handler; }

function attachGestures() {
  const pointers = new Map();
  let pinch = null;
  let dragged = false;
  let settle = 0;
  // The last few moves, to measure the speed of a flick when the finger lifts.
  let track = [];

  const settled = () => {
    clearTimeout(settle);
    settle = setTimeout(() => onViewportChange(), 220);
  };

  canvas.addEventListener('pointerdown', (event) => {
    cancelAnimationFrame(tween);
    stopGlide();
    track = [];
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragged = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        scale: state.camera.scale,
        center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const next = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, next);

    if (pointers.size === 1) {
      const dx = next.x - previous.x;
      const dy = next.y - previous.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragged = true;
      state.camera.x += dx;
      state.camera.y += dy;
      const now = performance.now();
      track.push({ x: next.x, y: next.y, at: now });
      track = track.filter((move) => now - move.at < 100);
      settled();
      return;
    }
    if (pointers.size === 2 && pinch) {
      dragged = true;
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.distance > 0) {
        const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        zoomAround(center, pinch.scale * (distance / pinch.distance), true);
        pinch.center = center;
      }
      settled();
    }
  });

  const release = (event) => {
    const had = pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!had) return;
    if (pointers.size > 0) { track = []; return; }
    if (!dragged) { pick(event); return; }
    // Speed over the last tenth of a second; a finger that stopped before
    // lifting has no flick left in it.
    const now = performance.now();
    const first = track[0];
    const last = track[track.length - 1];
    const span = first && last ? last.at - first.at : 0;
    const still = !last || now - last.at > 60;
    const velocity = span > 0 && !still
      ? { x: (last.x - first.x) / span, y: (last.y - first.y) / span } : { x: 0, y: 0 };
    track = [];
    coast(velocity, () => onViewportChange());
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', (event) => {
    pointers.delete(event.pointerId);
    pinch = null;
    track = [];
  });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    cancelAnimationFrame(tween);
    stopGlide();
    const rect = canvas.getBoundingClientRect();
    // A trackpad pinch arrives as many small wheel steps; at the first rate
    // (0.0015) one pinch moved the map too little, so it is 2.5 times that. A
    // wheel that counts in lines (Firefox) is turned into pixels first, and one
    // event never zooms by more than about 1.6 times, so a mouse notch stays a step.
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const factor = Math.exp(Math.max(-0.5, Math.min(0.5, -delta * WHEEL_ZOOM)));
    zoomAround(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      state.camera.scale * factor,
    );
    settled();
  }, { passive: false });
}

function zoomAround(point, requested, absolute = false) {
  const rect = canvas.getBoundingClientRect();
  const cx = absolute ? point.x - rect.left : point.x;
  const cy = absolute ? point.y - rect.top : point.y;
  const old = state.camera.scale;
  const next = clampScale(requested);
  if (next === old) return;
  const localX = (cx - state.camera.x) / old;
  const localY = (cy - state.camera.y) / old;
  state.camera.scale = next;
  state.camera.x = cx - localX * next;
  state.camera.y = cy - localY * next;
}

// Tapped with no post open, the face slides to the middle of the screen, a
// quarter of the way down (25vh), clear of the half-height sheet opening under
// it. With a post already open the map stays put, so you can go from face to
// face without the ground moving each time (2026-10-16).
const TAP_SPOT = 0.25;

function tapSpot() {
  const box = canvas.getBoundingClientRect();
  let x = width / 2;
  if (desktopSheet()) {
    // A window just wide enough for the side panel has its middle under it.
    const panel = document.getElementById('sheet').getBoundingClientRect();
    x = Math.max(x, panel.right - box.left + 48);
  }
  return { x, y: window.innerHeight * TAP_SPOT - box.top };
}

function pick(event) {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  // Last drawn wins: the hit list is in paint order, so the post on top of a
  // pile is the one the finger meant.
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const hit = hits[i];
    const inside = hit.box
      ? x >= hit.box.left && x <= hit.box.right && y >= hit.box.top && y <= hit.box.bottom
      : Math.hypot(hit.x - x, hit.y - y) <= hit.r;
    if (!inside) continue;
    if (hit.islandName) {
      // The name of an island seen from near or deep: the card, never a fly-in.
      if (islandTapHandler) islandTapHandler({ key: islandKey(hit.islandName), island: hit.islandName, x, y });
    } else if (hit.island) {
      if (islandTapHandler) islandTapHandler({ key: islandKey(hit.island), island: hit.island, x, y });
      else openIsland(hit.island);
    } else if (hit.trial) {
      toast('お試しの場所です。ほかの人には見えていません');
    } else if (hit.approach) {
      // Your own post from far away: come in close first, then open it.
      const { post } = hit;
      playSe('pop');
      zoomTo(post.x, post.y, postZoom(), { ...tapSpot(), then: () => onPick(post) });
    } else if (hit.stack) {
      // Several posts on one spot at full zoom: the list of them.
      playSe('pop');
      if (!sheetOpen()) zoomTo(hit.post.x, hit.post.y, state.camera.scale, tapSpot());
      onStack(hit.stack);
    } else if (hit.dot) {
      // A dot is a face still waiting for room: come closer - its face shows
      // up on the way, or steps aside at full zoom - and open it there.
      const { post } = hit;
      playSe('pop');
      zoomTo(post.x, post.y, postZoom(), { ...tapSpot(), then: () => onPick(post) });
    } else {
      playSe('pop');
      if (!sheetOpen()) zoomTo(hit.post.x, hit.post.y, postZoom(), tapSpot());
      onPick(hit.post);
    }
    return;
  }
  onPick(null);
}

// ---------------------------------------------------------------- loop

function loop() {
  raf = requestAnimationFrame(loop);
  render();
}

export function stopMap() {
  cancelAnimationFrame(raf);
  raf = 0;
}

/** Start painting again after stopMap() (the map screen came back). Safe to
 * call when the loop is already running. */
export function startMap() {
  if (!canvas || raf) return;
  loop();
}

/** Paint exactly one frame, outside the animation loop.
 *
 * requestAnimationFrame does not run while the tab is hidden, so a headless
 * check - or a screenshot taken from a background pane - would otherwise be
 * looking at whatever was on the canvas when it was last visible. This is the
 * seam that makes "what is actually drawn" answerable at a chosen moment.
 */
export function renderOnce() {
  render();
}

function render() {
  if (!ctx || !width || !height) return;
  const time = (performance.now() - started) / 1000;
  hits = [];
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = config().energy.biome_colors.sea;
  ctx.fillRect(0, 0, width, height);
  refreshClock();
  refreshActivity();
  renderMap(time);
  notifyCamera();
}

// ---------------------------------------------------------------- time of day

// Looked up at most once a minute: the layers are a few fillRects, but a Date
// per frame is not worth it.
const CLOCK_MS = 60000;
let tod = null;
let todAt = -Infinity;
let todFor = null;

/** The address as one string, to notice an edited ?tod= or ?tier= at once
 * (comparing it is cheaper than the Date the clock would cost). */
function addressKey() {
  try {
    return typeof location !== 'undefined' ? `${location.search}${location.hash}` : '';
  } catch (error) {
    return '';
  }
}

// A ?tod= seen in the address holds until the page is loaded again: the app's
// own moves (the bottom nav, opening a post on the map) write `#/map` and drop
// a ?tod= that was added after the route, and the map went back to the clock.
let askedTod = null;

function refreshClock() {
  const now = performance.now();
  const address = addressKey();
  if (tod !== null && now - todAt < CLOCK_MS && address === todFor) return;
  todAt = now;
  todFor = address;
  let asked = null;
  try { asked = addressParam('tod'); } catch (error) { asked = null; }
  if (asked && Object.prototype.hasOwnProperty.call(TIMES, asked)) askedTod = asked;
  tod = askedTod || timeOfDay();
}

/** 'morning' | 'day' | 'evening' | 'night' - what the map is painted in now. */
export function timeOfDayNow() {
  refreshClock();
  return tod;
}

/** The time-of-day layers over the whole screen (see palette.js TIMES). */
function paintTimeOfDay() {
  const layers = TIMES[tod] || [];
  if (!layers.length) return;
  ctx.save();
  layers.forEach((layer) => {
    ctx.globalCompositeOperation = layer.blend;
    ctx.globalAlpha = layer.alpha;
    ctx.fillStyle = layer.color;
    ctx.fillRect(0, 0, width, height);
  });
  ctx.restore();
}

/** At night the dark layer took the land down with the sea, and an island's
 * shape was hard to tell from the water (review, 2026-10-18). The ground
 * texture again, screened on before the dark layer comes: the open sea in it
 * is transparent, so only the land and its shallows are lifted, and they stay
 * lighter than the water once the night is over them. */
const NIGHT_LAND = 0.42;

function liftLandAtNight(terrain, closeUp, grid, alpha) {
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  if (grid) {
    ctx.globalAlpha = NIGHT_LAND;
    const origin = toScreen(grid.minX, grid.minY);
    const { scale } = state.camera;
    ctx.drawImage(grid.canvas, origin.x, origin.y, (grid.maxX - grid.minX) * scale, (grid.maxY - grid.minY) * scale);
  }
  if (terrain) {
    paintGround(terrain, NIGHT_LAND * alpha, closeUp);
    if (closeUp) paintGround(closeUp, NIGHT_LAND);
  }
  ctx.restore();
}

/** Windows lit at night, over the dark layer: every settlement and landmark
 * that was drawn, with the seed it was drawn with. */
function paintNightLights(places, townShow, calmOf) {
  if (townShow <= 0) return;
  ctx.save();
  places.forEach((place) => {
    if (!place.town) return;
    const calm = calmOf(place.island);
    ctx.globalAlpha = place.fade * place.show;
    drawNightLights(ctx, { tier: place.tier, seed: place.seed, calm }, place.x, place.foot, place.size);
    (place.marks || []).forEach((mark) => {
      drawNightLights(ctx, { landmark: mark.name, calm }, mark.x, mark.foot, mark.size);
    });
  });
  ctx.restore();
}

/** Sunlight from the top left: a radial wash over the ground and trees, in
 * screen coordinates (it does not move with the map). */
function paintSun() {
  const cx = width * SUN.at[0];
  const cy = height * SUN.at[1];
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, SUN.reach * Math.hypot(width, height));
  gradient.addColorStop(0, SUN.color);
  gradient.addColorStop(1, `${SUN.color}00`);
  ctx.save();
  ctx.globalAlpha = SUN.alpha;
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

// ---------------------------------------------------------------- this week

// The week's activity switch: with it on, only the posts that saw something in
// the last seven days are drawn as usual; the rest step back like posts a
// filter left out.
const WEEK_MS = 7 * 24 * 3600 * 1000;
const WHOLE_MAP_Z = 1.2;   // zoomed out this far, the loaded posts are all of them
let busyOn = false;
let busyIds = new Set();
let busyIslands = new Set();   // islandKey of the islands holding one of them
let busyTotal = 0;
let busyWhole = null;   // the count last made with the whole map in view
let activitySeen = { posts: null, connections: null, islands: null, revision: -1, minute: -1 };

export function setBusyMode(on) { busyOn = Boolean(on); }
export function busyMode() { return busyOn; }
/** How many posts saw something in the last seven days. Counted over what is
 * loaded; the map holds only the posts near the screen when zoomed in, so the
 * number last made with (nearly) the whole map in view is kept and returned while
 * zoomed in, rather than a count that shrinks as you come closer. */
export function busyCount() {
  refreshActivity();
  return busyWhole === null ? busyTotal : busyWhole;
}

/** Counted again only when the posts, lines or islands changed (or a minute
 * went by), never every frame. */
function refreshActivity() {
  const minute = Math.floor(Date.now() / CLOCK_MS);
  const was = activitySeen;
  if (was.posts === state.posts && was.connections === state.connections
      && was.islands === state.islands && was.revision === state.revision
      && was.minute === minute) return;
  activitySeen = {
    posts: state.posts, connections: state.connections, islands: state.islands,
    revision: state.revision, minute,
  };
  const since = Date.now() - WEEK_MS;
  const recent = (stamp) => { const at = Date.parse(stamp); return Number.isFinite(at) && at >= since; };
  const ids = new Set();
  state.posts.forEach((post) => { if (recent(post.created_at)) ids.add(post.id); });
  (state.connections || []).forEach((row) => {
    if (!recent(row.last_at)) return;
    ids.add(row.a_post);
    ids.add(row.b_post);
  });
  busyIds = ids;
  busyTotal = [...ids].filter((id) => state.postsById.has(id)).length;
  if (zoomLevel().z <= WHOLE_MAP_Z) busyWhole = busyTotal;
  busyIslands = new Set(state.islands
    .filter((island) => (island.post_ids || []).some((id) => ids.has(id))).map(islandKey));
}

/** Whether a post is drawn faint and cannot be tapped: left out by the filter,
 * or quiet this week while the week switch is on. */
function steppedBack(post, sifting) {
  return (sifting && !matchesFilters(post)) || (busyOn && !busyIds.has(post.id));
}

/** Zoomed out: a soft warm light breathing on each island with something going on. */
function drawBusyGlow(places, motion) {
  const breath = motion === null ? 0.5 : (Math.sin(motion * 1.8) + 1) / 2;
  ctx.save();
  places.forEach((place) => {
    if (!busyIslands.has(islandKey(place.island))) return;
    const spot = toScreen(place.island.cx, place.island.cy);
    const radius = 46 + breath * 14;
    const gradient = ctx.createRadialGradient(spot.x, spot.y, 0, spot.x, spot.y, radius);
    gradient.addColorStop(0, PIN.mid);
    gradient.addColorStop(1, `${PIN.mid}00`);
    ctx.globalAlpha = 0.5 + breath * 0.25;
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(spot.x, spot.y, radius, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

// ---------------------------------------------------------------- outside views

let lastGround = null;
const cameraHandlers = [];
let cameraSeen = '';

/** Called after a frame in which the camera moved (not while it stands still). */
export function onCameraChange(handler) {
  if (typeof handler === 'function') cameraHandlers.push(handler);
}

function notifyCamera() {
  const camera = state.camera;
  const mark = `${camera.x},${camera.y},${camera.scale},${width},${height}`;
  if (mark === cameraSeen) return;
  cameraSeen = mark;
  cameraHandlers.forEach((handler) => {
    try { handler(); } catch (error) { console.error(error); }
  });
}

/** What the mini map, compass and scale bar need to know about the view. */
export function mapSnapshot() {
  const [minX, minY, maxX, maxY] = fitBounds(state.posts, fitExtent);
  const topLeft = toWorld(0, frame.top);
  const bottomRight = toWorld(width, height - frame.bottom);
  const { z, level } = zoomLevel();
  return {
    world: { minX, minY, maxX, maxY },
    view: { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y },
    scale: state.camera.scale, z, level,
    ground: lastGround,
    mine: state.myPosts.filter((post) => Number.isFinite(post.x) && Number.isFinite(post.y))
      .map((post) => ({ x: post.x, y: post.y })),
  };
}

/** Glide so that world point (x, y) is in the middle of the free part of the
 * screen, at the zoom the map has now. */
export function panTo(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  zoomTo(x, y, state.camera.scale, { lift: 0.5 });
}

// ---------------------------------------------------------------- map view

// Settlement size by growth tier (小屋 → 都市): screen px at TOWN_REF_SCALE,
// turned into a world length by worldSize() below (so a town grows and shrinks
// with the map, and TOWN_SCALE shrinks them all together).
const TIER_SIZES = [48, 56, 64, 72, 80];
// Where up to three landmarks stand around the settlement, in settlement sizes:
// behind, then front-left, then front-right.
const LANDMARK_SPOTS = [[0.2, -0.4], [-0.8, 0.14], [0.82, 0.16]];
// Landmarks are for an island that has grown: not on a hut (one person's island
// with a lighthouse beside it was clutter), from a village up.
const LANDMARK_MIN_TIER = 1;
// Towns and their landmarks are drawn only well zoomed in (1 = the whole map),
// fading in over this range, and only where they stand on the island's own
// land. Zoomed out they crowded the names and faces; and pushed aside to make
// room for the faces they used to end up in the sea (2026-10-12).
const TOWN_ZOOM = [2.3, 2.6];
// Towns and landmarks are as big as the island they stand on: their size is a
// length in the world, so they grow and shrink with the map (a pinch scales them
// with the ground). TIER_SIZES are screen px at the reference scale below - the
// phone's whole-map scale (~0.4) x TOWN_ZOOM, between the phone and a desktop -
// and are turned into world lengths once, so a phone and a desktop see the same
// town on the same island.
const TOWN_REF_SCALE = 0.55 * TOWN_ZOOM[1];
// A tenth of that (2026-10-19, the user): at the size above a town covered most
// of its island once you came close; now it is a village on the island's land.
const TOWN_SCALE = 0.1;
const worldSize = (px) => (px / TOWN_REF_SCALE) * TOWN_SCALE;
// A town shows once it is wide enough on screen to read (fading in over this
// range of px), as well as past TOWN_ZOOM. Small, because the towns are small.
const TOWN_PX = [14, 20];
const MINE = PALETTE.accent;
const LABEL_FONT = '700 13px system-ui, sans-serif';
const SMALL_FONT = '600 11px system-ui, sans-serif';

// While searching or filtering, the posts that do not match stay on the map at
// this strength and cannot be tapped. The islands - ground, towns, names - are
// drawn as they are whatever the filter.
const FILTERED_OUT = 0.15;

/** While searching or filtering, a road or flight is drawn only when the posts
 * at both ends match (not just the ones on screen: a long line with one end
 * off screen must not blink out). */
function connectionsInFilter() {
  return state.connections.filter((row) => {
    const a = state.postsById.get(row.a_post);
    const b = state.postsById.get(row.b_post);
    return a && b && matchesFilters(a) && matchesFilters(b);
  });
}

/** The dotted lines to people like you (kin.js), for this frame. While
 * searching or filtering, only those whose both ends match, like the roads. */
function kinPlan(meId, sifting) {
  if (!meId || !state.myPosts.length || !state.neighbors.size) return [];
  const linked = new Set();
  state.connections.forEach((row) => {
    if (row.a === meId) linked.add(row.b);
    else if (row.b === meId) linked.add(row.a);
  });
  const neighbors = new Map([...state.neighbors].map(([id, held]) => [id, held.rows]));
  const lines = kinLines({
    mine: state.myPosts, neighbors, islandOf: islandFinder(state.islands), linked, me: meId,
  });
  if (!sifting) return lines;
  const mineById = new Map(state.myPosts.map((post) => [post.id, post]));
  return lines.filter((line) => matchesFilters(line.row) && matchesFilters(mineById.get(line.mine)));
}

function renderMap(time) {
  // The same posts and coarse layer the ground is drawn from, so the sea's
  // moving things can keep off the land the way the routes do.
  const ground = withTrialGround(groundPosts());
  const view = {
    sea: seaBox(), toScreen, width, height, scale: state.camera.scale, maxScale: clampScale(Infinity),
    posts: ground, cells: state.saturated ? state.cells : NO_CELLS,
  };
  const { scale } = state.camera;
  const { z, level } = zoomLevel();
  const far = level === 'far';
  const meId = state.account ? state.account.id : null;
  const ceiling = frame.top + 10;
  // Seconds for things that move, or null to hold still (less motion).
  const motion = REDUCED_MOTION ? null : time;
  const stage = revealStage(performance.now());
  // Closed: the next post opened - the same one again too - hops up anew.
  if (!state.selected) opened = { id: null, at: 0 };

  // The seed corpus is NOT drawn. It used to be a field of dots, which looked
  // like a second kind of island while meaning something entirely different -
  // the shape of the reference corpus, not a person. It still frames the camera
  // and still supplies the IDF that names things.
  const sifting = filtering();
  const visible = [];
  state.posts.forEach((post) => {
    const point = toScreen(post.x, post.y);
    if (point.x < -80 || point.x > width + 80 || point.y < -80 || point.y > height + 80) return;
    visible.push({
      post, point, mine: Boolean(meId) && post.author_id === meId,
      out: steppedBack(post, sifting),
    });
  });

  // Water first: its marks, whales and boats sit under the land.
  drawSeaMarks(ctx, view, time);
  drawWhales(ctx, view, time);
  drawBoats(ctx, view, time);

  // The ground. Built from every post the client holds, not just the ones on
  // screen, so panning does not make a coastline appear out of nothing.
  const grid = gridTerrain(state.terrainGrid);
  // While the camera moves, the ground stays at the zoom it was built for and is
  // only stretched: a pinch crossed a texture step every ~19% and rebuilt the
  // whole map mid-gesture (0.2-0.4 s stalls; about a second on a phone).
  const now = performance.now();
  const mark = `${state.camera.x.toFixed(1)},${state.camera.y.toFixed(1)},${state.camera.scale.toFixed(5)}`;
  if (mark !== cameraMark) {
    cameraMark = mark;
    cameraStill = now;
  }
  if (now - cameraStill >= GROUND_SETTLE_MS || groundScale === null) groundScale = scale;
  // Same idea for buildings: stretched small pictures while moving, real-size ones once still.
  setSettled(now - cameraStill >= GROUND_SETTLE_MS);
  const buildGround = (list, revision = null) => buildTerrain({
    posts: list,
    cells: state.saturated ? state.cells : NO_CELLS,
    region: groundRegion(ground),
    scale: groundScale,
    revision,
    elsewhere: (job, answer) => offThread('ground', job, answer),
  });
  let terrain = null;
  let before = null;   // the ground as it was without the new post, while it rises
  if (!grid) {
    if (stage && !stage.playing) {
      // The new post is not on the map yet.
      terrain = buildGround(ground.filter((post) => post.id !== reveal.id));
      reveal.before = terrain;
    } else if (stage) {
      before = reveal.before || buildGround(ground.filter((post) => post.id !== reveal.id));
      reveal.before = before;
      terrain = buildGround(ground);
    } else {
      terrain = buildGround(ground, groundRev);
    }
  }
  if (grid) {
    lastGround = { canvas: grid.canvas, minX: grid.minX, minY: grid.minY, maxX: grid.maxX, maxY: grid.maxY };
    const origin = toScreen(grid.minX, grid.minY);
    ctx.drawImage(grid.canvas, origin.x, origin.y, (grid.maxX - grid.minX) * scale, (grid.maxY - grid.minY) * scale);
  }
  if (before) paintGround(before, 1);
  let closeUp = null;
  if (terrain) {
    lastGround = {
      canvas: terrain.canvas, minX: terrain.minX, minY: terrain.minY,
      maxX: terrain.minX + terrain.width / terrain.scale, maxY: terrain.minY + terrain.height / terrain.scale,
    };
    // Close up, a sharp texture of the area on screen goes over the whole-map one.
    closeUp = stage || grid ? null : sharpGround(terrain, ground);
    paintGround(terrain, before ? stage.land : 1, closeUp);
    if (closeUp) paintGround(closeUp, 1);
    // Incoming surf along the coasts, over the shallows and under the night layer
    // and everything that stands on the land. Only from a view about one island wide.
    if (closeUp && closeUp.surf && !stage) drawSurf(ctx, closeUp.surf, view, motion, tod === 'night' ? 0.55 : 1);
  }
  // At night the land is lifted before anything stands on it: screened on after
  // the dark layer it also washed over the buildings and trees, which then
  // looked half transparent.
  if (tod === 'night') liftLandAtNight(terrain, closeUp, grid, before ? stage.land : 1);

  // Where each island's settlement stands. Placed before the trees so the trees
  // can keep out of the way.
  const zShow = clamp01((z - TOWN_ZOOM[0]) / (TOWN_ZOOM[1] - TOWN_ZOOM[0]));
  const townShow = zShow;
  const calmOf = (island) => Boolean(island.quiet);
  const places = state.islands.map((island) => {
    const members = new Set(island.post_ids || []);
    const spot = toScreen(island.cx, island.cy);
    if (spot.x < -160 || spot.x > width + 160 || spot.y < -160 || spot.y > height + 160) return null;
    const seed = hashId(islandKey(island));
    const forced = forcedTier();
    const tier = forced !== null ? forced : Math.max(0, Math.min(TIER_COUNT - 1, Number(island.tier) || 0));
    // A quiet island keeps its buildings, a size smaller and with the colour
    // let out of them. `span` is the town's width in the world, `size` on screen.
    const span = worldSize(TIER_SIZES[tier]) * (island.quiet ? 0.85 : 1);
    const size = span * scale;
    const show = Math.min(zShow, clamp01((size - TOWN_PX[0]) / (TOWN_PX[1] - TOWN_PX[0])));
    // The town stands at one fixed world point per island; where it fits on the
    // land is decided in the world too, so it never comes and goes as you zoom.
    const grown = tier >= 1 || members.size >= 8;
    const home = show > 0 ? townHome(island, members, span, grown) : null;
    const at = home ? toScreen(home.x, home.y) : null;
    // The island the new post stands on comes up with its ground.
    const fade = stage && members.has(reveal.id) ? stage.land : 1;
    if (!at) {
      // No town: the name and the head count sit on the island's middle.
      return { island, members, tier, size, span, seed, x: spot.x, foot: spot.y + 4, fade, show: 0, town: false };
    }
    return { island, members, tier, size, span, seed, x: at.x, foot: at.y, fade, show, town: true, home };
  }).filter(Boolean);
  const towns = places.filter((place) => place.town);

  if (terrain && terrain.trees) {
    const old = before && before.trees
      ? new Set(before.trees.map((tree) => `${tree.x},${tree.y},${tree.name}`)) : null;
    if (old) {
      drawTrees(before.trees, towns, far ? [] : visible, far, 1);
      drawTrees(terrain.trees.filter((tree) => !old.has(`${tree.x},${tree.y},${tree.name}`)),
        towns, far ? [] : visible, far, stage.land);
    } else {
      drawTrees(terrain.trees, towns, far ? [] : visible, far, 1);
    }
  }

  paintSun();

  // Lines between people run over the ground and under the towns and faces;
  // the planes that fly them go over the towns.
  const lineView = {
    rows: sifting ? connectionsInFilter() : state.connections, islands: state.islands,
    // The same posts and coarse layer the ground is drawn from, so whether a route crosses
    // land does not change with the latest viewport fetch.
    posts: ground, cells: state.saturated ? state.cells : NO_CELLS, toScreen, width, height, far, level,
    landOf: (postId) => landIndex().get(postId) || null,
    span: config().world.max - config().world.min, phone: width < 700,
    // Vehicles shrink with the map: their size is by scale / maxScale.
    scale, maxScale: clampScale(Infinity),
  };
  const linePlan = drawLinks(ctx, lineView);
  // Dotted lines to people like you: yours alone, only close up (DETAIL_AT),
  // and not while the map is showing who joined a post.
  if (z >= DETAIL_AT && !participants) drawKin(ctx, lineView, kinPlan(meId, sifting));

  if (far && busyOn) drawBusyGlow(places, motion);

  // Settlements and their landmarks, back to front.
  places.sort((a, b) => a.foot - b.foot).forEach((place) => {
    const { island, size, x, foot } = place;
    if (!place.town) {
      place.marks = [];
      place.box = { left: x - 12, right: x + 12, top: foot - 12, bottom: foot };
      return;
    }
    const calm = Boolean(island.quiet);
    const marked = place.tier >= LANDMARK_MIN_TIER;
    const markSpan = Math.max(worldSize(36), place.span * 0.8);
    const markSize = markSpan * scale;
    // Landmarks stand at fixed world points round the town (townHome); a slot
    // that is not on land is never drawn, at any zoom.
    place.marks = [];
    if (marked) {
      landmarksOf(island, place).slice(0, LANDMARK_SPOTS.length).forEach((name, index) => {
        const slot = place.home.slots[index];
        if (!slot || !slot.land) return;
        const at = toScreen(slot.x, slot.y);
        place.marks.push({ name, size: markSize, x: at.x, foot: at.y });
      });
    }
    const pieces = [...place.marks, { main: true, x, foot }].sort((a, b) => a.foot - b.foot);
    const alpha = place.fade * place.show;
    pieces.forEach((piece) => {
      const box = piece.main
        ? drawSettlement(ctx, place.tier, piece.x, piece.foot, size, { alpha, calm, seed: place.seed })
        : drawLandmark(ctx, piece.name, piece.x, piece.foot, markSize, { alpha, calm });
      if (piece.main) place.box = box;
      else piece.box = box;
    });
    place.box = place.box || { left: x - size / 2, right: x + size / 2, top: foot - size, bottom: foot };
  });
  drawPlanes(ctx, lineView, linePlan, time);
  // The fog goes under the time-of-day layers so its edge takes the evening or
  // night colour with the rest of the sea.
  drawFog(ctx, view);
  paintTimeOfDay();
  if (tod === 'night') paintNightLights(places, townShow, calmOf);

  const claim = makeLabelSpace();
  chromeBoxes().forEach((box) => claim.block(box.x, box.y, box.w, box.h));
  const labels = [];
  const label = (text, x, y, font, extra = {}) => labels.push({ text, x, y, font, ...extra });
  const keepOnScreen = (x, w) => Math.max(w / 2 + 8, Math.min(width - w / 2 - 8, x));

  // Island names claim their space before anything else: they are the
  // headline. A name moves before it gives way - along its own island, never
  // off into the sea, and never up under the search bar - and the busiest
  // islands choose first. Only a name with no room anywhere near its island
  // waits until you come closer; yours and a lit one are always drawn
  // (2026-10-16: two names used to print over each other at the overview).
  const face = level === 'deep' ? PIN_DEEP : PIN_NEAR;
  const minePosts = new Set(visible.filter((entry) => entry.mine).map((entry) => entry.post.id));
  const weight = (place) => Number(place.island.people) || place.members.size;
  nameBoxes = [];
  ctx.save();
  [...places].sort((a, b) => weight(b) - weight(a)).forEach((place) => {
    const { island, box } = place;
    if (box.bottom < ceiling - 4) return;
    ctx.font = LABEL_FONT;
    const textWidth = ctx.measureText(island.label).width;
    const lit = emphasis.id === islandKey(island) && performance.now() < emphasis.until;
    const mine = [...place.members].some((id) => minePosts.has(id));
    // Zoomed in, a line of people and topics hangs under the name: the pair
    // stands clear of the town and of the faces as one block.
    const detail = z >= DETAIL_AT;
    const under = detail ? 18 : 0;
    let anchor = box.top - 10 - under;
    if (!far) {
      // Zoomed in, the name rides above the island's highest face, so it is
      // over the people it names rather than over whoever happens to be next.
      const tops = visible.filter(({ post }) => place.members.has(post.id))
        .map(({ post, point, mine: yours }) => point.y + pinTopOf(post, face, yours) - 8 - under);
      if (tops.length) anchor = Math.min(anchor, Math.min(...tops));
    }
    let x = null;
    let y = null;
    // Up and down first, then a little to either side (a third of the name).
    spots: for (const shift of [0, -0.35, 0.35]) {
      for (const offset of [0, -16, -32, 16, 32]) {
        // The controls hold their own space in `claim`, so beside them (a wide
        // screen) a name may rise to the top edge.
        const spotX = keepOnScreen(place.x + shift * textWidth, textWidth);
        const candidate = Math.max(14, anchor + offset);
        if (claim(spotX, candidate, textWidth, 15)) {
          x = spotX;
          y = candidate;
          break spots;
        }
      }
    }
    if (y === null) {
      if (!lit && !mine) return;
      x = keepOnScreen(place.x, textWidth);
      y = Math.max(ceiling, anchor);
    }
    place.labelBox = { left: x - textWidth / 2 - 4, right: x + textWidth / 2 + 4, top: y - 10, bottom: y + 10 };
    nameBoxes.push(place.labelBox);
    label(island.label, x, y, LABEL_FONT, {
      alpha: place.fade,
      ...(lit ? { lit: islandColor(island.cluster_id), width: textWidth } : {}),
    });

    if (detail) {
      // Under the name: how many people, and what else they talk about.
      // An AI- or hand-made name already says the topic: show people only.
      const named = island.name_source === 'ai' || island.name_source === 'manual';
      const topics = named ? [] : (island.topics || []).slice(0, 2);
      const line = [`${island.people || place.members.size}人`, ...topics].join('・');
      ctx.font = SMALL_FONT;
      const lineWidth = ctx.measureText(line).width;
      if (claim(x, y + 17, lineWidth, 12)) {
        label(line, keepOnScreen(x, lineWidth), y + 17, SMALL_FONT, { soft: true, alpha: place.fade });
      }
    }
  });
  ctx.restore();

  const talk = [];   // faces about to say what they wrote, painted last
  if (far) {
    if (!participants) drawCrowds(places, claim, meId, sifting);
    // Islands answer a tap by opening up; yours are on top of that.
    places.forEach((place) => {
      const { box, labelBox } = place;
      const around = labelBox ? {
        left: Math.min(box.left, labelBox.left), right: Math.max(box.right, labelBox.right),
        top: Math.min(box.top, labelBox.top), bottom: box.bottom + 20,
      } : { ...box, bottom: box.bottom + 20 };
      hits.push({ box: around, island: place.island });
    });
    drawPinsFar(visible, places, claim, meId, motion);
  } else {
    // Under the faces in the hit list, so a post on a name wins the tap.
    if (islandTapHandler) {
      places.forEach((place) => {
        if (place.labelBox) hits.push({ box: place.labelBox, islandName: place.island });
      });
    }
    drawFaces(visible, claim, level, motion, talk, stage, z >= DETAIL_AT);
    if (level === 'near') landmarkNames(places, claim, label);
    regionNames(places, claim, label);
  }

  drawBirds(ctx, view, time);
  drawChangeMarks(time);
  drawTrial(time);
  drawRipples();

  // Names last, so nothing can bury them. Positions were resolved above, before
  // anything else could take the space.
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  labels.forEach((entry) => {
    ctx.save();
    if (entry.alpha !== undefined) ctx.globalAlpha *= entry.alpha;
    if (entry.lit) litPill(entry);
    ctx.font = entry.font;
    ctx.lineWidth = entry.font === LABEL_FONT ? 4.5 : 3.5;
    ctx.strokeStyle = INK.halo;
    ctx.strokeText(entry.text, entry.x, entry.y);
    ctx.fillStyle = entry.soft ? 'rgba(255,255,255,.9)' : INK.label;
    ctx.fillText(entry.text, entry.x, entry.y);
    ctx.restore();
  });
  ctx.restore();
  drawTalk(talk);
}

/** The ground texture, at an opacity (it fades in while a new post lands).
 * `hole`: a texture drawn over this one; this one is left out under it, or its
 * coarser coastline would show round the edges of the sharp one. */
function paintGround(terrain, alpha, hole = null) {
  if (alpha <= 0) return;
  const origin = toScreen(terrain.minX, terrain.minY);
  ctx.save();
  if (hole) {
    const from = toScreen(hole.minX, hole.minY);
    const to = toScreen(hole.minX + hole.width / hole.scale, hole.minY + hole.height / hole.scale);
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.rect(from.x, from.y, to.x - from.x, to.y - from.y);
    ctx.clip('evenodd');
  }
  ctx.globalAlpha *= alpha;
  // Smoothing on: the field is a low-resolution texture and nearest-neighbour
  // upscaling turns a coastline into a staircase.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    terrain.canvas, origin.x, origin.y,
    (terrain.width / terrain.scale) * state.camera.scale,
    (terrain.height / terrain.scale) * state.camera.scale,
  );
  ctx.restore();
}

// ---------------------------------------------------------------- sharp ground

// The whole-map ground texture has at most 1400 pixels on a side, so zoomed in
// it is stretched until the coasts are staircases. Once the camera has been
// still for a moment, the area around the screen is built again at the
// screen's resolution (pixel ratio capped at 2: memory) and drawn over it. While
// the camera moves, the last sharp one is kept for as long as it is the same
// ground; outside it the coarse one shows until the next stop.
const SHARP_SETTLE_MS = 160;
const GROUND_SETTLE_MS = 160;
const NO_CELLS = [];         // one empty list, so the terrain cache can tell nothing changed
let groundScale = null;      // the zoom the whole-map ground is built for

// The ground is drawn from every post seen this session, not only the ones the
// latest viewport fetch returned. A settled pan used to swap state.posts for a
// new subset, which changed the terrain key and rebuilt the whole map (28-230 ms
// on a desktop, close to a second on a phone) and threw away the sharp close-up
// too (2026-10-16). Deleted posts are dropped (state.removed).
const seen = new Map();
let seenRevision = -1;
let groundRev = 0;
let groundList = [];

function groundPosts() {
  if (state.revision !== seenRevision) {
    seenRevision = state.revision;
    let changed = false;
    // Every fetch brings new objects for the same posts: only a move or a change
    // of energy is a new ground. Rebuilding on every poll also threw away the
    // sharp close-up each time.
    state.posts.forEach((post) => {
      const known = seen.get(post.id);
      if (known === post) return;
      if (!known || known.x !== post.x || known.y !== post.y || energyOf(known) !== energyOf(post)) changed = true;
      seen.set(post.id, post);
    });
    state.removed.forEach((id) => { if (seen.delete(id)) changed = true; });
    // A post deleted or hidden by someone else just stops coming back: anything
    // inside the area last fetched in full that is no longer in it is gone.
    const area = state.fetched;
    if (area) {
      seen.forEach((post, id) => {
        if (!state.postsById.has(id) && post.x > area.minX && post.x < area.maxX
            && post.y > area.minY && post.y < area.maxY) {
          seen.delete(id);
          changed = true;
        }
      });
    }
    if (changed) {
      groundRev += 1;
      groundList = [...seen.values()];
    }
  }
  return groundList;
}

// The tryout (Q40) is kept, so the land it would raise is drawn under it: the
// ground the sentence would make if it were a post. Never sent anywhere, and
// the list is rebuilt only when the posts or the tryout change (terrain cache key).
// Not added while the terrain grid is in use (800+ posts in view): the grid is a
// ready-made picture, so there only the pin and its sea effect show the tryout.
let trialGround = { base: null, key: '', list: [] };
const TRIAL_MOTIVATION = 50;

function withTrialGround(list) {
  const trial = state.trialPost;
  if (!trial || !Number.isFinite(trial.x) || !Number.isFinite(trial.y)) {
    // The tryout was closed: the ground goes back to what is saved.
    if (trialGround.base) {
      trialGround = { base: null, key: '', list: [] };
      groundRev += 1;
    }
    return list;
  }
  const key = `${trial.x},${trial.y},${trial.motivation ?? TRIAL_MOTIVATION}`;
  if (trialGround.base !== list || trialGround.key !== key) {
    const stand = { id: 'trial', x: trial.x, y: trial.y, motivation: trial.motivation ?? TRIAL_MOTIVATION };
    trialGround = { base: list, key, list: [...list, stand] };
    groundRev += 1;
  }
  return trialGround.list;
}

function groundRegion(list) {
  if (!list.length) return postsRegion();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  list.forEach((post) => {
    const reach = radiusOf(post);
    minX = Math.min(minX, post.x - reach);
    minY = Math.min(minY, post.y - reach);
    maxX = Math.max(maxX, post.x + reach);
    maxY = Math.max(maxY, post.y + reach);
  });
  return { minX, minY, maxX, maxY };
}
const SHARP_RATIO_CAP = 2;
const SHARP_MARGIN = 0.25;   // of the screen's size, on every side
let sharp = null;            // { ...texture, base, unit }
let sharpTimer = 0;
let cameraMark = '';
let cameraStill = 0;

/** The world rectangle on screen, widened by SHARP_MARGIN and snapped to a grid
 * of that size, so small pans do not ask for a new texture. */
function sharpWindow() {
  const a = toWorld(0, 0);
  const b = toWorld(width, height);
  const stepX = (b.x - a.x) * SHARP_MARGIN;
  const stepY = (b.y - a.y) * SHARP_MARGIN;
  return {
    minX: (Math.floor(a.x / stepX) - 1) * stepX, minY: (Math.floor(a.y / stepY) - 1) * stepY,
    maxX: (Math.ceil(b.x / stepX) + 1) * stepX, maxY: (Math.ceil(b.y / stepY) + 1) * stepY,
  };
}

function sharpGround(base, posts) {
  const need = state.camera.scale * Math.min(dpr, SHARP_RATIO_CAP);
  // The whole-map texture is sharp enough from here (the overview) - unless the
  // surf is showing, which is traced on the sharp one.
  if (need <= base.scale * 1.3 && surfShow(state.camera.scale, width, height) <= 0) {
    sharp = null;
    return null;
  }
  const now = performance.now();
  const valid = sharp && sharp.base === base;
  const a = toWorld(0, 0);
  const b = toWorld(width, height);
  const covers = valid && a.x >= sharp.minX && a.y >= sharp.minY
    && b.x <= sharp.minX + sharp.width / sharp.scale && b.y <= sharp.minY + sharp.height / sharp.scale;
  const fine = valid && sharp.unit >= need * 0.8;
  if ((!covers || !fine) && !sharpTimer && now - cameraStill >= SHARP_SETTLE_MS) {
    const scale = state.camera.scale;
    const pixelRatio = Math.min(dpr, SHARP_RATIO_CAP);
    const job = {
      posts, cells: state.saturated ? state.cells : [], region: sharpWindow(), scale, pixelRatio,
      surf: surfShow(scale, width, height) > 0,
    };
    // In the worker when there is one (offthread.js): the map keeps moving
    // while it is made. One job at a time; the answer clears sharpTimer.
    const sent = offThread('detail', job, (built, ok) => {
      sharpTimer = 0;
      if (ok) sharp = built ? { ...toCanvas(built), surf: built.coast, base, unit: scale * pixelRatio } : null;
    });
    if (sent) {
      sharpTimer = -1;
    } else {
      // Out of the frame being painted: the next frame shows it.
      sharpTimer = setTimeout(() => {
        sharpTimer = 0;
        const built = buildDetail(job);
        sharp = built ? { ...built, surf: built.coast, base, unit: scale * pixelRatio } : null;
      }, 0);
    }
  }
  // The last sharp texture keeps showing until its replacement is ready, even if
  // the ground under it was rebuilt: the coarse one flashing up in between read
  // as a blur followed by a second freeze.
  return sharp;
}

// Each island's town stands at one fixed world point, found from the island's
// own posts only, so panning, zooming and the faces on screen never move it.
// Recomputed only when the island's make-up changes.
const homeCache = new Map();

/** World point of the town's foot, and the world points of its landmark slots.
 * `span` is the town's width in the world, `grown` whether it must be built
 * somewhere. The island's middle if the town fits there, else the nearest post
 * where it fits with the most land round it. A grown island that fits nowhere
 * takes its best land point anyway; any other, with nothing that fits, gets no
 * town. Null if there is no land to stand on. Everything is in world units, so
 * the answer does not depend on the zoom. */
function townHome(island, members, span, grown) {
  const posts = [...members].map((id) => state.postsById.get(id)).filter(Boolean);
  const key = islandKey(island);
  const sig = `${island.cx},${island.cy},${posts.length},${span.toFixed(2)},${grown ? 1 : 0}`;
  const held = homeCache.get(key);
  if (held && held.sig === sig) return held.home;
  const { biome_order: order, biome_thresholds: thresholds } = config().energy;
  const sand = thresholds[order[1]];
  const land = (x, y) => {
    let sum = 0;
    posts.forEach((post) => { sum += groundOf(post, x, y); });
    return sum >= sand;
  };
  const ring = worldSize(TIER_SIZES[1]) * 0.4;
  const near = posts.slice()
    .sort((a, b) => Math.hypot(a.x - island.cx, a.y - island.cy) - Math.hypot(b.x - island.cx, b.y - island.cy))
    .slice(0, 40);
  let best = null;      // best point where the town fits
  let bestScore = -1;
  let spare = null;     // best land point at all, for a grown island
  let spareScore = -1;
  [{ x: island.cx, y: island.cy }, ...near].some((c) => {
    if (!land(c.x, c.y)) return false;
    let score = 0;
    for (let k = 0; k < 8; k += 1) {
      if (land(c.x + Math.cos(k * Math.PI / 4) * ring, c.y + Math.sin(k * Math.PI / 4) * ring)) score += 1;
    }
    if (score > spareScore) { spare = { x: c.x, y: c.y }; spareScore = score; }
    if (score > bestScore && standsOnLand(c.x, c.y, span, land, grown)) {
      best = { x: c.x, y: c.y };
      bestScore = score;
    }
    return bestScore === 8;
  });
  if (!best && grown) best = spare;
  let home = null;
  if (best) {
    // Landmarks stand round the town in town-sized steps.
    const slots = LANDMARK_SPOTS.map(([dx, dy]) => {
      const x = best.x + dx * worldSize(TIER_SIZES[2]);
      const y = best.y + dy * worldSize(TIER_SIZES[2]);
      return { x, y, land: land(x, y) };
    });
    home = { x: best.x, y: best.y, slots };
  }
  homeCache.set(key, { sig, home });
  return home;
}

/** Whether a town `span` wide with its foot at world (x, y) stands on land -
 * sand or higher: both bottom corners, the middle of its foot, both sides half
 * way up and its top (`loose`: the foot, its corners and half way up the
 * middle). `land` sums the island's own posts' cones, the way terrain.js does. */
function standsOnLand(x, y, span, land, loose = false) {
  const half = span * 0.45;
  const tall = span * 0.85;
  if (loose) return land(x, y) && land(x - half, y) && land(x + half, y) && land(x, y - tall * 0.5);
  return land(x, y) && land(x - half, y) && land(x + half, y)
    && land(x - half * 0.9, y - tall * 0.5) && land(x + half * 0.9, y - tall * 0.5)
    && land(x, y - tall);
}

// ?tier=0..4 in the address draws every island as that growth stage - the same
// kind of aid as ?tod=: the server's islands are mostly tier 0, so a grown town
// is otherwise never seen on the data at hand.
const DEMO_LANDMARKS = ['灯台', '風車', '時計塔', '図書館', '市場', '温室', '天文台', '工房'];
let forcedTierFor = null;
let forcedTierValue = null;

function forcedTier() {
  const address = addressKey();
  if (address !== forcedTierFor) {
    forcedTierFor = address;
    let raw = null;
    try { raw = addressParam('tier'); } catch (error) { raw = null; }
    const value = raw === null || raw.trim() === '' ? NaN : Number(raw);
    // Like ?tod=, a valid ?tier= holds until the page is loaded again, through
    // the app's own `#/map` that drops it.
    if (Number.isInteger(value) && value >= 0 && value < TIER_COUNT) forcedTierValue = value;
  }
  return forcedTierValue;
}

/** The landmarks to draw for an island: its own, or - under ?tier= - enough
 * made-up ones for that stage (1 for 小屋・村, 2 for 港町・町, 3 for 都市). */
function landmarksOf(island, place) {
  const own = island.landmarks || [];
  if (forcedTier() === null) return own;
  const count = place.tier <= 1 ? 1 : place.tier <= 3 ? 2 : 3;
  if (own.length >= count) return own;
  return Array.from({ length: count }, (_, i) => DEMO_LANDMARKS[(place.seed + i * 3) % DEMO_LANDMARKS.length]);
}

// Land at a world point, summed over every post whose cone can reach it: posts
// are kept in buckets as wide as the largest radius so a tree asks a handful of
// posts, not all of them.
let landIndexOf = null;

function landAtWorld(list, x, y) {
  if (!landIndexOf || landIndexOf.list !== list) {
    let cell = 1;
    list.forEach((post) => { cell = Math.max(cell, radiusOf(post)); });
    const buckets = new Map();
    list.forEach((post) => {
      const r = radiusOf(post);
      for (let gx = Math.floor((post.x - r) / cell); gx <= Math.floor((post.x + r) / cell); gx += 1) {
        for (let gy = Math.floor((post.y - r) / cell); gy <= Math.floor((post.y + r) / cell); gy += 1) {
          const key = `${gx},${gy}`;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(post);
        }
      }
    });
    landIndexOf = { list, cell, buckets };
  }
  const { cell, buckets } = landIndexOf;
  const { biome_order: order, biome_thresholds: thresholds } = config().energy;
  let sum = 0;
  (buckets.get(`${Math.floor(x / cell)},${Math.floor(y / cell)}`) || []).forEach((post) => { sum += groundOf(post, x, y); });
  return sum >= thresholds[order[1]];
}

/** Trees, bushes and rocks from the terrain's scatter, kept off the
 * settlements and out from under faces, and off the water: a crown reaching over
 * the shore stays home. Zoomed out, every other one. */
const TREE_WORLD = 1.1;   // world units per tree (k = 1)
const TREE_MIN = 3;       // px: smaller than this is not drawn
const TREE_MAX = 44;      // px: a ceiling for the largest zoom

function drawTrees(trees, places, posts, thin, alpha = 1) {
  // A tree is a length in the world, like the towns, and a tenth of what it was
  // (2026-10-19, the user): it grows with the map, and one too small to see on
  // screen is not drawn - zoomed out there are no trees.
  const base = state.camera.scale * TREE_WORLD;
  // With the coarse layer in play some land is not any post's cone: skip the check.
  const check = !state.saturated && groundList.length > 0;
  trees.forEach((tree) => {
    if (thin && tree.k < 1) return;
    const p = toScreen(tree.x, tree.y);
    if (p.x < -30 || p.x > width + 30 || p.y < -30 || p.y > height + 40) return;
    const size = Math.min(TREE_MAX, base * tree.k) * (tree.name === 'bush' || tree.name === 'rock' ? 0.7 : 1);
    if (size < TREE_MIN) return;
    const foot = p.y + size * 0.35;
    const covered = places.some((place) => Math.abs(p.x - place.x) < place.size * 1.45
      && foot > place.foot - place.size * 1.15 && foot < place.foot + place.size * 0.55);
    if (covered) return;
    if (posts.some(({ point }) => Math.abs(point.x - p.x) < 15 && Math.abs(point.y - p.y) < 18)) return;
    if (check) {
      const wet = [-0.35, 0, 0.35].some((dx) => {
        const at = toWorld(p.x + dx * size, foot);
        return !landAtWorld(groundList, at.x, at.y);
      });
      if (wet) return;
    }
    drawTree(ctx, tree.name, p.x, foot, size, { alpha, seed: Math.round(tree.x * 7 + tree.y * 13) });
  });
}

/** Who is on each island, zoomed out: a few faces and the head count. While
 * filtering, somebody none of whose posts here match steps back. */
function drawCrowds(places, claim, meId, sifting) {
  const size = 16;
  const step = 11;
  places.forEach((place) => {
    const authors = new Map();
    const matching = new Set();
    place.members.forEach((id) => {
      const post = state.postsById.get(id);
      if (!post) return;
      if (!steppedBack(post, sifting)) matching.add(post.author_id);
      if (!authors.has(post.author_id)) authors.set(post.author_id, post);
    });
    const people = [...authors.values()]
      .sort((a, b) => (b.author_id === meId) - (a.author_id === meId))
      .slice(0, 4);
    if (!people.length) return;
    ctx.save();
    ctx.font = '700 11px system-ui, sans-serif';
    const count = `${place.island.people || authors.size}人`;
    const countWidth = ctx.measureText(count).width;
    const rowWidth = (people.length - 1) * step + size + 4 + countWidth;
    const y = place.box.bottom + 11;
    const left = place.x - rowWidth / 2;
    if (!claim(place.x, y, rowWidth, size + 2)) { ctx.restore(); return; }
    people.slice().reverse().forEach((post, index) => {
      const at = left + size / 2 + (people.length - 1 - index) * step;
      ctx.save();
      if (!matching.has(post.author_id)) ctx.globalAlpha *= FILTERED_OUT;
      drawMiniPin(ctx, at, y, { heat: post.motivation, initial: initialOf(post.display_name), size, mine: post.author_id === meId });
      ctx.restore();
    });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = INK.halo;
    const textX = left + (people.length - 1) * step + size + 4;
    ctx.strokeText(count, textX, y + 0.5);
    ctx.fillStyle = INK.label;
    ctx.fillText(count, textX, y + 0.5);
    ctx.restore();
  });
}

// ---------------------------------------------------------------- who is shown

// Diameter of a pin's head (pins.js); the pin itself stands a good deal taller.
const PIN_NEAR = 22;
const PIN_DEEP = 30;
const PIN_FAR = 18;

/** The letter a pin wears: the first character of the name. */
const initialOf = (name) => Array.from(String(name || '').trim())[0] || '・';
const DIM = 0.2;

// 「参加者を見てみる」: only the post's writer and the people who joined it stay
// bright; everybody else steps back to a fifth of their strength.
let participants = null;   // { postId, ids: Set of account ids } or null

export function setParticipantView(next) {
  participants = next;
  bubbles.clear();
}

export function participantView() {
  return participants;
}

const dimmed = (post) => Boolean(participants) && !participants.ids.has(post.author_id);

// ---------------------------------------------------------------- a new post lands

// What happens when you post: the camera comes in, a fanfare sounds, the new
// ground rises out of the sea, the face drops onto it, and then its panel opens.
let reveal = null;
const LAND_DELAY = 400;     // after the camera has arrived
const LAND_MS = 1200;
const MARKER_DELAY = 1600;
const MARKER_MS = 1000;

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const easeOut = (t) => 1 - (1 - t) ** 3;
// A little past the mark and back: a soft landing.
const easeBack = (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;

/** Bring a freshly posted post onto the map with the full introduction.
 * `then` runs when the face has landed (open its panel there). */
export function playReveal(post, { then } = {}) {
  if (!post || !Number.isFinite(post.x) || !Number.isFinite(post.y)) {
    if (then) then();
    return;
  }
  const fit = state.camera.fit || state.camera.scale;
  if (REDUCED_MOTION) {
    playSe('fanfare');
    zoomTo(post.x, post.y, fit * 3, { lift: 0.4, then });
    return;
  }
  reveal = {
    id: post.id, startedAt: performance.now(), began: 0, then,
    before: null, ripple: null, fanfare: false,
  };
  zoomTo(post.x, post.y, fit * 3, {
    lift: 0.4,
    then: () => { if (reveal) reveal.began = performance.now(); },
  });
}

/** Stop an introduction that is under way without finishing it (the screen was left). */
export function abortReveal() {
  reveal = null;
}

function finishReveal() {
  const done = reveal;
  reveal = null;
  if (!done) return;
  if (done.ripple) ripple(done.ripple.x, done.ripple.y, { big: true, color: done.ripple.color });
  if (done.then) done.then();
}

/** Where the introduction is at `now`, or null when there is none. */
function revealStage(now) {
  if (!reveal) return null;
  if (!reveal.began) {
    // A touch can stop the camera on its way and the introduction would wait
    // forever; start it anyway after a while.
    if (now - reveal.startedAt > 2000) reveal.began = now;
    else return { playing: false, land: 0, marker: 0, drop: -16, scale: 0.6 };
  }
  const elapsed = now - reveal.began;
  if (!reveal.fanfare && elapsed >= LAND_DELAY) {
    reveal.fanfare = true;
    playSe('fanfare');
  }
  if (elapsed >= MARKER_DELAY + MARKER_MS) {
    finishReveal();
    return null;
  }
  const land = easeOut(clamp01((elapsed - LAND_DELAY) / LAND_MS));
  const t = clamp01((elapsed - MARKER_DELAY) / MARKER_MS);
  const marker = easeOut(t);
  return { playing: true, land, marker, drop: -16 * (1 - marker), scale: 0.6 + 0.4 * easeBack(t) };
}

// ---------------------------------------------------------------- pins

/** Rings that spread from your post and fade: "you are here". Only for a post
 * hidden under a town, where it is a dot; a pin carries its own ring. */
function radar(x, y, radius, motion) {
  ctx.save();
  const base = ctx.globalAlpha;
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = MINE;
  if (motion === null) {
    ctx.globalAlpha = base * 0.6;
    ctx.beginPath();
    ctx.arc(x, y, radius * 1.6, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    [0, 0.5].forEach((phase) => {
      const cycle = (motion * 0.5 + phase) % 1;
      ctx.globalAlpha = base * Math.max(0, 1 - cycle ** 1.5) * 0.9;
      ctx.beginPath();
      ctx.arc(x, y, radius * (1 + cycle * 2), 0, Math.PI * 2);
      ctx.stroke();
    });
  }
  ctx.restore();
}

/** Your posts, the posts asking for people, and the open post, zoomed out.
 *
 * Yours carry the "あなた" tag and a ring at their foot; a tap flies you to them.
 * Over a town a pin would hide the buildings, so there yours is a dot that
 * radiates. In 「参加者を見てみる」 only the writer and the people who joined are
 * pins; the rest are quiet dots.
 */
// When the open post was opened, on the animation clock: its pin hops up off
// the map over the first moments (pins.js liftShare). Null under less motion,
// which holds the pin lifted without the hop.
let opened = { id: null, at: 0 };

function openedFor(id, motion) {
  if (motion === null) return null;
  if (opened.id !== id) opened = { id, at: motion };
  return motion - opened.at;
}

function drawPinsFar(visible, places, claim, meId, motion) {
  const selectedId = state.selected ? state.selected.id : null;
  const night = tod === 'night';
  const onTown = (point) => places.some(({ box }) => box
    && point.x > box.left - 6 && point.x < box.right + 6 && point.y > box.top - 6 && point.y < box.bottom + 6);
  const pin = (post, point, extra = {}) => drawPostPin(ctx, point.x, point.y, {
    heat: post.motivation, initial: initialOf(post.display_name), size: PIN_FAR, night, ...extra,
  });
  const claimPin = (point, head) => claim(point.x, (point.y + head) / 2, 24, Math.abs(point.y - head) + 26);
  visible.forEach(({ post, point, mine, out }) => {
    const phase = (hashId(post.id) % 628) / 100;
    if (out) {
      // Filtered out: the same pin, faint, and nothing to tap.
      ctx.save();
      ctx.globalAlpha *= FILTERED_OUT;
      if (mine) pin(post, point, { mine: true });
      else if (isUnreadRecruit(post, meId)) pin(post, point, { recruit: true, phase });
      ctx.restore();
      return;
    }
    if (participants) {
      if (dimmed(post)) {
        ctx.save();
        ctx.globalAlpha = DIM;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = pinColor(post.motivation);
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.restore();
        return;
      }
      const shown = pin(post, point, { size: 20, mine, phase });
      claimPin(point, shown.headY);
      hits.push({ x: point.x, y: shown.headY, r: 22, post, approach: true });
      return;
    }
    if (post.id === selectedId) {
      const shown = pin(post, point, { size: 22, selected: true, mine, phase, openedFor: openedFor(post.id, motion) });
      hits.push({ x: point.x, y: shown.headY, r: 20, post });
      return;
    }
    if (mine) {
      let hitY = point.y - 12;
      if (!onTown(point)) {
        const shown = pin(post, point, { mine: true, recruitQuiet: isRecruiting(post), time: motion, phase });
        claimPin(point, shown.headY);
        hitY = shown.headY;
      } else {
        radar(point.x, point.y, 11, motion);
        ctx.save();
        ctx.beginPath();
        ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = MINE;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.restore();
        hitY = point.y;
      }
      hits.push({ x: point.x, y: hitY, r: 22, post, approach: true });
      return;
    }
    if (isUnreadRecruit(post, meId)) {
      const shown = pin(post, point, { recruit: true, time: motion, phase });
      hits.push({ x: point.x, y: shown.headY, r: 20, post, approach: true });
    }
  });
}

// ---------------------------------------------------------------- talk

// Now and then a face near you says the start of what it wrote: ten characters,
// five seconds, a few at a time.
const TALK_MS = 5000;
const TALK_FADE = 350;
const bubbles = new Map();   // post id -> when it started to speak
let nextTalk = 0;
let nameBoxes = [];   // island-name boxes of the last frame, in canvas px

function rollTalk(entries, stage) {
  const now = performance.now();
  bubbles.forEach((began, id) => { if (now - began > TALK_MS) bubbles.delete(id); });
  if (now < nextTalk) return;
  nextTalk = now + 500 + Math.random() * 900;
  // One at a time on a phone: three overlapped and could not be read.
  if (bubbles.size >= (width < 700 ? 1 : 3)) return;
  // A bubble stands about 40px above the face's heat; keep it clear of the
  // pills and controls over the map and of the island names already placed.
  const covered = [...chromeBoxes().map((b) => ({
    left: b.x - b.w / 2, right: b.x + b.w / 2, top: b.y - b.h / 2, bottom: b.y + b.h / 2,
  })), ...nameBoxes];
  // The pins that hold a place are in the way too: a bubble over a neighbour's
  // head hides it.
  const pins = entries.filter((entry) => entry.room && !entry.dim).map((entry) => ({
    entry, left: entry.point.x - entry.size * 0.5, right: entry.point.x + entry.size * 0.5,
    top: entry.point.y - entry.size * 1.6, bottom: entry.point.y,
  }));
  const clear = (self, reach) => {
    const point = self.point;
    const box = { left: point.x - 50, right: point.x + 50, top: point.y - reach - 44, bottom: point.y - reach };
    const hit = (c) => box.left < c.right && box.right > c.left && box.top < c.bottom && box.bottom > c.top;
    return !covered.some(hit) && !pins.some((c) => c.entry !== self && hit(c));
  };
  // A post that has just been written has no face on the map until it lands.
  const landing = (entry) => reveal && stage && entry.post.id === reveal.id && stage.marker < 1;
  const pool = entries.filter((entry) => entry.room && !entry.dim && !bubbles.has(entry.post.id)
    && !landing(entry)
    && String(entry.post.body || '').trim()
    && entry.point.x > 36 && entry.point.x < width - 36
    && entry.point.y > frame.top + 36 && entry.point.y < height - frame.bottom - 12
    && clear(entry, entry.size * 1.7));
  if (pool.length) bubbles.set(pool[Math.floor(Math.random() * pool.length)].post.id, now);
}

/** The first ten characters of a post, for a face to say. */
export function snippetOf(body) {
  const letters = [...String(body || '').replace(/\s+/g, ' ').trim()];
  return letters.length > 10 ? `${letters.slice(0, 10).join('')}…` : letters.join('');
}

function drawTalk(talk) {
  if (!talk.length) return;
  const now = performance.now();
  ctx.save();
  ctx.font = '500 11px system-ui, sans-serif';
  talk.forEach(({ post, x, y }) => {
    const age = now - (bubbles.get(post.id) || now);
    const alpha = REDUCED_MOTION ? 1 : Math.min(1, age / TALK_FADE, (TALK_MS - age) / TALK_FADE);
    if (alpha <= 0) return;
    const text = snippetOf(post.body);
    const w = ctx.measureText(text).width + 16;
    // Slid back inside the screen edge; the tail still points at the face.
    const bx = Math.max(w / 2 + 6, Math.min(width - w / 2 - 6, x));
    ctx.globalAlpha = alpha;
    speechBubble(x, { text, width: w, y, x: bx });
  });
  ctx.restore();
}

// ---------------------------------------------------------------- faces

/** How far above its point a pin reaches (negative px): the flame's tip, or the
 * 「あなた」 tag over yours - what an island's name has to clear. */
function pinTopOf(post, size, yours) {
  const top = pinGeometry(size, post.motivation).top;
  if (!yours) return top;
  const flame = pinTier(post.motivation) === 'flame' || pinTier(post.motivation) === 'top';
  const s = pinScale(size, post.motivation);
  return Math.min(top, -(flame ? 44 : 33) * s - (6.5 * size) / 18);
}

/** Zoomed in: faces where people wrote, wrapped in their heat, names where they
 * fit (`named`: other people's names too, close up; yours always).
 *
 * Like a street map's pins (2026-10-16): a face needs a clear patch of screen
 * (its size plus FACE_GAP), handed out in order - yours, the open one, unread
 * 「参加者募集中」, then the busiest, ties broken by the post so the choice holds
 * still while you pan. Whoever gets no patch waits as a small dot and becomes a
 * face as zooming in spreads the crowd apart; every face used to be drawn, small
 * if need be, and a busy island at near zoom was a jumble. Paint runs the other
 * way, so the first in line ends on top and the finger finds them first.
 */
const ANIMATED_FACES = 30;
const FACE_GAP = { near: 16, deep: 10 };

// At full zoom nothing more will part a crowd: some posts stand almost on one
// spot (two of v6's were 0.06 world units apart). Whoever is still waiting
// there joins the face it is under, which wears "+N" and opens the list of the
// spot's posts when tapped, as a map lists the shops in one building
// (2026-10-18; the day before they stepped aside onto rings with lines).
const STACK_AT = 0.97;             // of the largest zoom

function drawFaces(visible, claim, level, motion, talk, stage, named) {
  const deep = level === 'deep';
  const full = deep ? PIN_DEEP : PIN_NEAR;
  const night = tod === 'night';
  const meId = state.account ? state.account.id : null;
  const selectedId = state.selected ? state.selected.id : null;
  const landingId = stage ? reveal.id : null;
  const firstInLine = (entry) => {
    if (entry.mine || entry.post.id === landingId) return 0;
    if (entry.post.id === selectedId) return 1;
    if (isUnreadRecruit(entry.post, meId)) return 2;
    return 3;
  };
  const ranked = visible.map((entry) => ({
    ...entry,
    dim: entry.out || dimmed(entry.post),
    rank: firstInLine(entry),
    busy: interactionsOf(entry.post),
    tie: hashId(entry.post.id),
  })).sort((a, b) => (a.dim - b.dim) || a.rank - b.rank || b.busy - a.busy || a.tie - b.tie);
  const gap = deep ? FACE_GAP.deep : FACE_GAP.near;
  const stacking = deep && state.camera.scale >= clampScale(Infinity) * STACK_AT;
  // A pin stands about 1.4 heads tall on its point: the room it claims is that
  // column, centred half way up.
  const roomW = full + gap;
  const roomH = full * 1.4 + gap;
  const roomY = (point) => point.y - full * 0.6;

  ctx.save();
  ranked.forEach((entry) => {
    const { point, post } = entry;
    const room = claim(point.x, roomY(point), roomW, roomH) || entry.rank <= 1;
    entry.room = room;
    entry.size = full;
    entry.stack = null;
    // Other people's names only close up; yours always.
    if (!room || entry.dim || !(named || entry.mine)) return;
    ctx.font = SMALL_FONT;
    const name = clip(post.display_name, 6);
    const nameY = point.y + 11;
    if (claim(point.x, nameY, ctx.measureText(name).width, 12) || entry.mine) {
      entry.name = name;
      entry.nameY = nameY;
    }
  });
  ctx.restore();
  if (stacking) {
    // The pin each one is under; first in line first, so the list keeps order.
    const faces = ranked.filter((entry) => entry.room && !entry.dim);
    ranked.forEach((entry) => {
      if (entry.room || entry.dim) return;
      let under = null;
      // Under a pin means inside the column the pin claimed (roomW x roomH), so
      // the test is that rectangle's own shape, not a circle.
      let nearest = 1;
      faces.forEach((face) => {
        const distance = Math.hypot((face.point.x - entry.point.x) / roomW, (face.point.y - entry.point.y) / roomH);
        if (distance < nearest) {
          nearest = distance;
          under = face;
        }
      });
      if (!under) return;
      if (!under.stack) under.stack = [under.post];
      under.stack.push(entry.post);
      entry.stacked = true;
    });
  }
  rollTalk(ranked, stage);

  // Only the people nearest the middle of the screen move; the rest of a crowd
  // is held still, which is also what lets it be drawn from the cache.
  const alive = new Set(ranked
    .filter((entry) => entry.room && !entry.dim)
    .sort((x, y) => Math.hypot(x.point.x - width / 2, x.point.y - height / 2)
      - Math.hypot(y.point.x - width / 2, y.point.y - height / 2))
    .slice(0, ANIMATED_FACES)
    .map((entry) => entry.post.id));

  ranked.slice().reverse().forEach((entry) => {
    const { post, point, mine, size, name, nameY, busy, dim, out } = entry;
    if (entry.stacked) return;   // in the list of the pin it is under
    const phase = (hashId(post.id) % 628) / 100;
    const moving = motion !== null && (alive.has(post.id) || (mine && !dim));
    const own = moving ? motion : null;
    const landing = stage && post.id === reveal.id ? stage : null;
    const plain = !dim && !landing;

    if (!plain) {
      ctx.save();
      if (dim) ctx.globalAlpha = out ? FILTERED_OUT : DIM;
      if (landing) {
        ctx.globalAlpha *= landing.marker;
        ctx.translate(point.x, point.y + landing.drop);
        ctx.scale(landing.scale, landing.scale);
        ctx.translate(-point.x, -point.y);
      }
    }
    if (!entry.room) {
      // Waiting for room: a dot in its heat's colour. A tap on it comes closer
      // and opens it (pick: `dot`); it used to be no target at all.
      ctx.beginPath();
      ctx.arc(point.x, point.y, deep ? 3.5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = pinColor(post.motivation);
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      if (!plain) ctx.restore();
      if (!dim) hits.push({ x: point.x, y: point.y, r: 12, post, dot: true });
      return;
    }
    const unread = isUnreadRecruit(post, meId) && !dim;
    const shown = drawPostPin(ctx, point.x, point.y, {
      heat: post.motivation, initial: initialOf(post.display_name), size,
      time: own, phase, mine: mine && !dim, selected: post.id === selectedId,
      openedFor: post.id === selectedId ? openedFor(post.id, motion) : null,
      recruit: unread, recruitQuiet: mine && !dim && isRecruiting(post), night,
    });
    const r = shown.headR;
    const headY = shown.headY;
    if (isOpen(post)) openMark(point.x - r * 0.95, headY - r * 0.85, deep);
    // How much it has been answered: always when deep, only when busy at near.
    // A stack's "+N" takes the top right corner; the count then sits below.
    const stack = entry.stack;
    if (stack) stackChip(point.x + r * 1.05, headY - r * 0.85, stack.length - 1);
    if (busy > 0 && (deep || busy >= 5)) {
      countChip(point.x + r * 0.95, stack ? headY + r * 0.75 : headY - r * 0.85, busy);
    }

    if (name) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.font = SMALL_FONT;
      ctx.lineWidth = 3;
      ctx.strokeStyle = INK.halo;
      ctx.strokeText(name, point.x, nameY);
      ctx.fillStyle = INK.label;
      ctx.fillText(name, point.x, nameY);
      ctx.restore();
    }
    if (!plain) ctx.restore();

    if (bubbles.has(post.id) && !dim) talk.push({ post, x: point.x, y: shown.top - 16 });
    if (!dim && (!landing || landing.marker > 0.5)) {
      hits.push({ x: point.x, y: headY, r: Math.max(18, r * 1.6), post, ...(stack ? { stack } : {}) });
    }
  });
}

/** "+N" on a face with N more posts under it at full zoom. */
function stackChip(x, y, more) {
  const text = `+${more > 99 ? 99 : more}`;
  ctx.save();
  ctx.font = '700 11px system-ui, sans-serif';
  const w = Math.max(22, ctx.measureText(text).width + 12);
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - 9, w, 18, 9);
  ctx.fillStyle = '#16324f';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

function countChip(x, y, count) {
  const text = count > 99 ? '99+' : String(count);
  ctx.save();
  ctx.font = '700 9px system-ui, sans-serif';
  const w = Math.max(14, ctx.measureText(text).width + 7);
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - 7, w, 14, 7);
  ctx.fillStyle = MINE;
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = '#fffaf0';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

function speechBubble(tail, { text, width: w, y, x = tail }) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - 10, w, 20, 8);
  ctx.moveTo(tail - 4, y + 10);
  ctx.lineTo(tail, y + 15);
  ctx.lineTo(tail + 4, y + 10);
  // No outline (2026-10-13); a soft shadow keeps it off pale sand.
  ctx.shadowColor = 'rgba(40, 30, 20, 0.22)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = '#fffaf0';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.font = '500 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#3b2a1f';
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

/** Landmark names under their buildings, at the middle distance only: further
 * out they would crowd the island names, further in the posts need the room. */
function landmarkNames(places, claim, label) {
  ctx.save();
  ctx.font = '600 10px system-ui, sans-serif';
  places.forEach((place) => {
    (place.marks || []).forEach((mark) => {
      if (!mark.box) return;
      const y = mark.box.bottom + 7;
      if (claim(mark.x, y, ctx.measureText(mark.name).width, 12)) {
        label(mark.name, mark.x, y, '600 10px system-ui, sans-serif', { soft: true });
      }
    });
  });
  ctx.restore();
}

/** 地方 inside a large island, where there is room for them. */
function regionNames(places, claim, label) {
  const font = '600 11px system-ui, sans-serif';
  ctx.save();
  ctx.font = font;
  places.forEach((place) => {
    (place.island.regions || []).forEach((region) => {
      const spot = toScreen(region.cx, region.cy);
      if (spot.x < 0 || spot.x > width || spot.y < frame.top || spot.y > height - frame.bottom) return;
      const y = spot.y + 26;
      if (claim(spot.x, y, ctx.measureText(region.label).width, 13)) {
        label(region.label, spot.x, y, font, { soft: true });
      }
    });
  });
  ctx.restore();
}

/** Whether the writer said "talk to me" on this post (Q45). */
function isOpen(post) {
  const tag = config().open_tag;
  return Boolean(tag) && Array.isArray(post.tags) && post.tags.includes(tag);
}

const OPEN_GREEN = '#2f9e5b';

/** A small green speech bubble on the face: "you may talk to me". */
function openMark(x, y, deep) {
  const r = deep ? 8 : 6.5;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.moveTo(x - r * 0.55, y + r * 0.6);
  ctx.lineTo(x - r * 0.9, y + r * 1.25);
  ctx.lineTo(x + r * 0.05, y + r * 0.85);
  ctx.fillStyle = OPEN_GREEN;
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = '#fffaf0';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  for (const dx of [-0.42, 0, 0.42]) {
    ctx.beginPath();
    ctx.arc(x + dx * r, y, r * 0.15, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Behind an island name that was just tapped: a white pill in its colour. */
function litPill(entry) {
  const w = entry.width + 18;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(entry.x - w / 2, entry.y - 12, w, 24, 12);
  ctx.fillStyle = 'rgba(255,250,240,.94)';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = entry.lit;
  ctx.stroke();
  ctx.restore();
}

/** The tryout (Q40): where the example sentence would stand, seen by you only. */
function drawTrial(time) {
  const trial = state.trialPost;
  if (!trial) return;
  const point = toScreen(trial.x, trial.y);
  if (point.x < -60 || point.y < -60 || point.x > width + 60 || point.y > height + 60) return;
  const breathe = REDUCED_MOTION ? 0.5 : (Math.sin(time * 2.4) + 1) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(point.x, point.y, 14 + breathe * 4, 6 + breathe * 2, 0, 0, Math.PI * 2);
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = MINE;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.75;
  drawPostPin(ctx, point.x, point.y, {
    heat: trial.motivation, initial: initialOf(trial.display_name || (state.account && state.account.display_name)),
    size: 26, mine: true, tag: false, night: tod === 'night',
  });
  ctx.globalAlpha = 1;
  ctx.font = '700 11px system-ui, sans-serif';
  const text = 'お試し';
  const w = ctx.measureText(text).width + 14;
  const y = point.y + 20;
  ctx.beginPath();
  ctx.roundRect(point.x - w / 2, y - 9, w, 18, 9);
  ctx.fillStyle = MINE;
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, point.x, y + 0.5);
  // The tryout island is not in state.islands, so its name is not drawn with
  // the others; where no saved island of that name is on the map, put it here.
  const name = trial.island && trial.island.label;
  if (name && !(state.islands || []).some((island) => island.label === name)) {
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.fillStyle = INK.label;
    ctx.strokeText(name, point.x, point.y - 44);
    ctx.fillText(name, point.x, point.y - 44);
  }
  ctx.restore();
  hits.push({ x: point.x, y: point.y - 18, r: 26, trial: true });
}

/** Rings spreading from where something just happened. With less motion, a
 * single still ring that fades instead. */
function drawRipples() {
  if (!state.ripples.length) return;
  const now = performance.now();
  state.ripples = state.ripples.filter((ring) => now - ring.at < RIPPLE_MS[ring.big ? 'big' : 'small']);
  ctx.save();
  state.ripples.forEach((ring) => {
    const point = toScreen(ring.x, ring.y);
    const life = (now - ring.at) / RIPPLE_MS[ring.big ? 'big' : 'small'];
    const reach = ring.big ? 70 : 34;
    const count = ring.big && !REDUCED_MOTION ? 3 : 1;
    for (let i = 0; i < count; i += 1) {
      const t = REDUCED_MOTION ? 0.45 : life - i * 0.18;
      if (t <= 0 || t >= 1) continue;
      const eased = 1 - (1 - t) * (1 - t);
      ctx.beginPath();
      ctx.arc(point.x, point.y, 10 + eased * reach, 0, Math.PI * 2);
      ctx.globalAlpha = REDUCED_MOTION ? (1 - life) * 0.8 : (1 - t) * 0.85;
      ctx.lineWidth = ring.big ? 3 : 2.2;
      ctx.strokeStyle = ring.color;
      ctx.stroke();
    }
  });
  ctx.restore();
}

/** Where something changed while you were away (段4): a ring that breathes
 * until you look at it from the list. */
function drawChangeMarks(time) {
  const marks = state.changeMarks || [];
  if (!marks.length) return;
  const breathe = REDUCED_MOTION ? 0 : (Math.sin(time * 2) + 1) / 2;
  ctx.save();
  marks.forEach((mark) => {
    const point = toScreen(mark.x, mark.y);
    if (point.x < -40 || point.y < -40 || point.x > width + 40 || point.y > height + 40) return;
    const radius = 20 + breathe * 6;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = MINE;
    ctx.globalAlpha = 0.65 + (1 - breathe) * 0.35;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  });
  ctx.restore();
}

/** The world box the terrain has to cover: every post the client holds. */
function postsRegion() {
  if (!state.posts.length) {
    const [minX, minY, maxX, maxY] = seedBounds();
    return { minX, minY, maxX, maxY };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  state.posts.forEach((post) => {
    const reach = radiusOf(post);
    minX = Math.min(minX, post.x - reach);
    minY = Math.min(minY, post.y - reach);
    maxX = Math.max(maxX, post.x + reach);
    maxY = Math.max(maxY, post.y + reach);
  });
  return { minX, minY, maxX, maxY };
}

/** Which landmass a post is standing on, computed over what is in view. */
export function landmassOf(postId) {
  const masses = detectLandmasses(state.posts);
  return membership(masses).get(postId) || null;
}

// Per frame the lines only ask which land a post is on, so the answer is kept
// until the posts in view are replaced (an energy change in place can leave it
// a little stale, which at worst picks a boat for a walker).
let landCache = { posts: null, index: new Map() };
function landIndex() {
  if (landCache.posts !== state.posts) {
    landCache = { posts: state.posts, index: membership(detectLandmasses(state.posts)) };
  }
  return landCache.index;
}
