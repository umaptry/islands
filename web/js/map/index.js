// The map.
//
// Two views on one canvas:
//
//   map    islands' terrain, drawn on かさなり's coordinates. Posts contribute
//          overlapping cones of energy, the sum decides the ground, and the
//          landmasses that emerge are named after the words of the people
//          standing on them.
//   orbit  you in the middle, everybody else at a radius set by 似てる度 and a
//          bearing taken from their real position on the map. Distance here is
//          the 448-dim cosine, measured before the projection - which is the
//          only thing that is actually true about who is near you.
//
// One rule the whole file obeys: coordinates that come from the server are never
// recomputed here. The map view is a plain pan/zoom of the server's x/y and the
// orbit view re-places people by a number the server measured. Nothing is
// re-projected client-side.

import { config, interactionsOf, islandColor, radiusOf } from '../config.js';
import { drawFace } from '../avatars.js';
import { matchesFilters, state, filtering } from '../state.js';
import { clip, toast } from '../ui.js';
import {
  INK, REDUCED_MOTION, drawBirds, drawBoats, drawSeaMarks, hashId, islandPath, makeLabelSpace,
} from './decor.js';
import { detectLandmasses, membership } from './landmass.js';
import { orbitTag } from '../meet-text.js';
import { drawGuide, drawHints, drawLines, drawVehicles, homeOf } from './lines.js';
import { TIER_SPRITES, drawSprite, landmarkSprite, preloadSprites } from './sprites.js';
import { buildTerrain, gridTerrain } from './terrain.js';

let canvas = null;
let ctx = null;
let dpr = 1;
let width = 0;
let height = 0;
let raf = 0;
let started = 0;
let onPick = () => {};
let hits = [];

// Three distances, measured against the zoom that frames everything (Q57・Q59):
//
//   far   the whole map. Continents, their towns and names, a few faces each;
//         your own posts glow. Tapping an island or your post flies you in.
//   near  everybody's face where they wrote, with names where they fit.
//   deep  bigger faces, the start of what they said, how much it was answered.
//
// Zoomed out you want to see where the activity is; zoomed in you want to see
// who. Two views of the same fact, and the switch is what keeps a busy map
// readable.
const NEAR_AT = 1.7;
const DEEP_AT = 4;

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
  const bottom = rects('.island-badge, .map-controls, .map-people, .bottom-nav')
    .reduce((high, rect) => Math.max(high, box.bottom - rect.top + 8), 12);
  return { top: Math.min(top, height * 0.4), bottom: Math.min(bottom, height * 0.4) };
}

/** The controls floating over the map, in canvas px. Labels keep out of them
 * so a name or a speech bubble is never half under the search bar. */
function chromeBoxes() {
  if (!canvas) return [];
  const box = canvas.getBoundingClientRect();
  return [...document.querySelectorAll('#map .search, #map .filter-button, #map .tabs, #mapDigest, #islandBadge, #map .map-controls, #mapPeople')]
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.height > 0 && rect.width > 0)
    .map((rect) => ({
      x: rect.left - box.left + rect.width / 2, y: rect.top - box.top + rect.height / 2,
      w: rect.width + 8, h: rect.height + 8,
    }));
}

export function initMap(element, { onSelect }) {
  canvas = element;
  ctx = canvas.getContext('2d');
  onPick = onSelect || (() => {});
  started = performance.now();
  preloadSprites();
  resize();
  attachGestures();
  window.addEventListener('resize', resize);
  loop();
}

export function resize() {
  if (!canvas) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  width = canvas.clientWidth;
  height = canvas.clientHeight;
  // A canvas that has not been laid out yet reports 0, and a camera fitted to a
  // zero-width box has a zero scale - which turns every viewport query into
  // (-Infinity, Infinity) and asks the server for the whole world. Wait for a
  // frame instead; the first paint happens one tick later either way.
  if (width === 0 || height === 0) {
    requestAnimationFrame(resize);
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
export function fitCamera(posts = state.posts, extent = null) {
  const valid = posts.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const bounds = extent || (valid.length ? [
    Math.min(...valid.map((p) => p.x - radiusOf(p))), Math.min(...valid.map((p) => p.y - radiusOf(p))),
    Math.max(...valid.map((p) => p.x + radiusOf(p))), Math.max(...valid.map((p) => p.y + radiusOf(p))),
  ] : seedBounds());
  const [minX, minY, maxX, maxY] = bounds;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  // Edge to edge across, and between the top bar and the bottom controls down:
  // on a wide screen the land fills the width instead of floating in a band.
  frame = insets();
  const usableW = Math.max(120, width - 32);
  const usableH = Math.max(120, height - frame.top - frame.bottom);
  const scale = Math.max(0.05, Math.min(1.6, usableW / spanX, usableH / spanY));
  state.camera = {
    scale,
    fit: scale,
    x: width / 2 - ((minX + maxX) / 2) * scale,
    y: frame.top + usableH / 2 - ((minY + maxY) / 2) * scale,
  };
}

/** How far in and out a gesture may go, relative to the fitted view. */
function clampScale(value) {
  const fit = state.camera.fit || state.camera.scale;
  return Math.max(Math.min(0.12, fit * 0.5), Math.min(value, Math.max(6, fit * 8)));
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
export function zoomTo(worldX, worldY, targetScale, { lift = 0.5, then } = {}) {
  cancelAnimationFrame(tween);
  frame = insets();
  const from = { ...state.camera };
  const to = clampScale(targetScale);
  const anchorX = width / 2;
  const anchorY = frame.top + Math.max(120, height - frame.top - frame.bottom) * lift;
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
function zoomToIsland(island) {
  const members = (island.post_ids || []).map((id) => state.postsById.get(id)).filter(Boolean);
  const xs = members.length ? members.map((post) => post.x) : [island.cx];
  const ys = members.length ? members.map((post) => post.y) : [island.cy];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const fit = state.camera.fit || state.camera.scale;
  const usableH = Math.max(120, height - frame.top - frame.bottom);
  const room = Math.min((width - 64) / (maxX - minX + 40), (usableH - 90) / (maxY - minY + 40));
  const target = Math.max(fit * 2.2, Math.min(fit * 3.6, room));
  zoomTo((minX + maxX) / 2, (minY + maxY) / 2, target, { lift: 0.55 });
}

// ---------------------------------------------------------------- gestures

let onViewportChange = () => {};
export function onCameraSettled(handler) { onViewportChange = handler; }

function attachGestures() {
  const pointers = new Map();
  let pinch = null;
  let dragged = false;
  let settle = 0;

  const settled = () => {
    clearTimeout(settle);
    settle = setTimeout(() => onViewportChange(), 220);
  };

  canvas.addEventListener('pointerdown', (event) => {
    cancelAnimationFrame(tween);
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
    if (pointers.size === 0 && !dragged) pick(event);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', (event) => {
    pointers.delete(event.pointerId);
    pinch = null;
  });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    cancelAnimationFrame(tween);
    const rect = canvas.getBoundingClientRect();
    const factor = Math.exp(-event.deltaY * 0.0015);
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
    if (hit.island) {
      zoomToIsland(hit.island);
    } else if (hit.vehicle) {
      // Who the boat is carrying between, and how often lately.
      const row = hit.vehicle;
      const often = row.week > 0 ? `この1週間で${row.week}回` : `これまでに${row.count}回`;
      toast(`${clip(row.a_name, 10)}さん と ${clip(row.b_name, 10)}さん　${often}`);
    } else if (hit.guide) {
      // Q53: follow the gull to whoever it was flying to.
      const fit = state.camera.fit || state.camera.scale;
      zoomTo(hit.guide.x, hit.guide.y, Math.max(state.camera.scale, fit * 2.6), { lift: 0.5 });
    } else if (hit.approach) {
      // Your own post from far away: come in close first, then open it.
      const fit = state.camera.fit || state.camera.scale;
      const { post } = hit;
      zoomTo(post.x, post.y, fit * 2.6, { lift: 0.4, then: () => onPick(post) });
    } else {
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
  if (state.view === 'orbit') renderOrbit(time);
  else renderMap(time);
}

// ---------------------------------------------------------------- map view

// Settlement sprite size by growth tier (小屋 → 都市), far view, CSS px.
const TIER_SIZES = [28, 32, 36, 42, 48];
// Where up to three landmarks stand around the settlement, in settlement sizes:
// behind, then front-left, then front-right.
const LANDMARK_SPOTS = [[0.2, -0.4], [-0.8, 0.14], [0.82, 0.16]];
const OUTLINE = '#4a3426';
const MINE = '#ff8a1f';
const LABEL_FONT = '700 13px system-ui, sans-serif';
const SMALL_FONT = '600 11px system-ui, sans-serif';

function renderMap(time) {
  const view = { sea: seaBox(), toScreen, width, height };
  const { scale } = state.camera;
  const { z, level } = zoomLevel();
  const far = level === 'far';
  const meId = state.account ? state.account.id : null;
  const ceiling = frame.top + 10;

  // The seed corpus is NOT drawn. It used to be a field of dots, which looked
  // like a second kind of island while meaning something entirely different -
  // the shape of the reference corpus, not a person. It still frames the camera
  // and still supplies the IDF that names things.
  const visible = [];
  state.posts.forEach((post) => {
    if (!matchesFilters(post)) return;
    const point = toScreen(post.x, post.y);
    if (point.x < -80 || point.x > width + 80 || point.y < -80 || point.y > height + 80) return;
    visible.push({ post, point, mine: Boolean(meId) && post.author_id === meId });
  });
  const visibleIds = new Set(visible.map(({ post }) => post.id));

  // Water first: its marks and boats sit under the land.
  drawSeaMarks(ctx, view, time);
  drawBoats(ctx, view, time);

  // The ground. Built from every post the client holds, not just the ones on
  // screen, so panning does not make a coastline appear out of nothing.
  const grid = gridTerrain(state.terrainGrid);
  const terrain = grid ? null : buildTerrain({
    posts: state.posts.filter((post) => !filtering() || matchesFilters(post)),
    cells: state.saturated ? state.cells : [],
    region: postsRegion(),
    scale,
  });
  if (grid) {
    const origin = toScreen(grid.minX, grid.minY);
    ctx.drawImage(grid.canvas, origin.x, origin.y, (grid.maxX - grid.minX) * scale, (grid.maxY - grid.minY) * scale);
  }
  if (terrain) {
    const origin = toScreen(terrain.minX, terrain.minY);
    ctx.save();
    // Smoothing on: the field is a low-resolution texture and nearest-neighbour
    // upscaling turns a coastline into a staircase.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      terrain.canvas, origin.x, origin.y,
      (terrain.width / terrain.scale) * scale,
      (terrain.height / terrain.scale) * scale,
    );
    ctx.restore();
  }

  // Where each island's settlement stands. Placed before the trees so the trees
  // can keep out of the way.
  const grow = far ? 1 : Math.min(1.5, Math.sqrt(z / NEAR_AT) * 1.2);
  const places = state.islands.map((island) => {
    const members = new Set(island.post_ids || []);
    if (filtering() && ![...members].some((id) => visibleIds.has(id))) return null;
    const spot = toScreen(island.cx, island.cy);
    if (spot.x < -160 || spot.x > width + 160 || spot.y < -160 || spot.y > height + 160) return null;
    const tier = Math.max(0, Math.min(TIER_SPRITES.length - 1, Number(island.tier) || 0));
    // A quiet island keeps its buildings, a size smaller and with the colour
    // let out of them.
    const size = Math.min(72, TIER_SIZES[tier] * grow * (island.quiet ? 0.85 : 1));
    const at = far ? { x: spot.x, y: spot.y } : besideFaces(spot, size, members, visible);
    return { island, members, tier, size, x: at.x, foot: at.y + size * 0.3 };
  }).filter(Boolean);

  if (terrain && terrain.trees) drawTrees(terrain.trees, places, far ? [] : visible, far);

  // Lines between people run over the ground and under the towns and faces;
  // what travels on them goes over the towns (段3).
  const lineView = {
    rows: state.connections, islands: state.islands, toScreen, width, height, far, level, meId,
    landOf: (postId) => landIndex().get(postId) || null,
    span: config().world.max - config().world.min, phone: width < 700,
    home: meId ? homeOf(state.myPosts) : null, similar: meId ? state.similar : [],
    selected: state.selected, selectedSimilar: state.selectedSimilar, focus: state.focusPerson,
  };
  const linePlan = drawLines(ctx, lineView);
  drawHints(ctx, lineView);
  // Your posts glow from under the buildings, so the town stays readable.
  if (far) glowMine(visible, time);

  // Settlements and their landmarks, back to front.
  places.sort((a, b) => a.foot - b.foot).forEach((place) => {
    const { island, size, x, foot } = place;
    const calm = Boolean(island.quiet);
    place.marks = (island.landmarks || []).slice(0, LANDMARK_SPOTS.length).map((name, index) => ({
      name,
      sprite: landmarkSprite(name),
      x: x + LANDMARK_SPOTS[index][0] * size,
      foot: foot + LANDMARK_SPOTS[index][1] * size,
    })).filter((mark) => mark.sprite);
    const pieces = [...place.marks, { main: true, x, foot }].sort((a, b) => a.foot - b.foot);
    pieces.forEach((piece) => {
      const box = piece.main
        ? drawSprite(ctx, TIER_SPRITES[place.tier], piece.x, piece.foot, size, { calm })
        : drawSprite(ctx, piece.sprite, piece.x, piece.foot, size * 0.72, { calm });
      if (piece.main) place.box = box;
      else piece.box = box;
    });
    place.box = place.box || { left: x - size / 2, right: x + size / 2, top: foot - size, bottom: foot };
  });
  hits.push(...drawVehicles(ctx, lineView, linePlan, time));

  const claim = makeLabelSpace();
  chromeBoxes().forEach((box) => claim.block(box.x, box.y, box.w, box.h));
  const labels = [];
  const label = (text, x, y, font, extra = {}) => labels.push({ text, x, y, font, ...extra });
  const keepOnScreen = (x, w) => Math.max(w / 2 + 8, Math.min(width - w / 2 - 8, x));

  // Island names claim their space before anything else: they are the
  // headline. A name never disappears, but it moves - and it moves along its
  // own island, never off into the sea, and never up under the search bar.
  const face = level === 'deep' ? 30 : 20;
  ctx.save();
  places.forEach((place) => {
    const { island, box } = place;
    if (box.bottom < ceiling - 4) return;
    ctx.font = LABEL_FONT;
    const textWidth = ctx.measureText(island.label).width;
    const x = keepOnScreen(place.x, textWidth);
    // Zoomed in, a line of people and topics hangs under the name: the pair
    // stands clear of the town and of the faces as one block.
    const under = far ? 0 : 18;
    let anchor = box.top - 10 - under;
    if (!far) {
      // Zoomed in, the name rides above the island's highest face, so it is
      // over the people it names rather than over whoever happens to be next.
      const tops = visible.filter(({ post }) => place.members.has(post.id))
        .map(({ point }) => point.y - face / 2 - (level === 'deep' ? 26 : 0) - 12 - under);
      if (tops.length) anchor = Math.min(anchor, Math.min(...tops));
    }
    let y = Math.max(ceiling, anchor);
    for (const offset of [0, -16, -32, 16, 32]) {
      // The controls hold their own space in `claim`, so beside them (a wide
      // screen) a name may rise to the top edge.
      const candidate = Math.max(14, anchor + offset);
      if (claim(x, candidate, textWidth, 15)) { y = candidate; break; }
    }
    place.labelBox = { left: x - textWidth / 2 - 4, right: x + textWidth / 2 + 4, top: y - 10, bottom: y + 10 };
    label(island.label, x, y, LABEL_FONT);

    if (!far) {
      // Under the name: how many people, and what else they talk about.
      const topics = (island.topics || []).slice(0, 2);
      const line = [`${island.people || place.members.size}人`, ...topics].join('・');
      ctx.font = SMALL_FONT;
      const lineWidth = ctx.measureText(line).width;
      if (claim(x, y + 17, lineWidth, 12)) label(line, keepOnScreen(x, lineWidth), y + 17, SMALL_FONT, { soft: true });
    }
  });
  ctx.restore();

  if (far) {
    drawCrowds(places, claim, meId);
    // Islands answer a tap by opening up; yours are on top of that.
    places.forEach((place) => {
      const { box, labelBox } = place;
      const around = labelBox ? {
        left: Math.min(box.left, labelBox.left), right: Math.max(box.right, labelBox.right),
        top: Math.min(box.top, labelBox.top), bottom: box.bottom + 20,
      } : { ...box, bottom: box.bottom + 20 };
      hits.push({ box: around, island: place.island });
    });
    drawMineFar(visible, places, claim);
  } else {
    drawFaces(visible, claim, level, time);
    if (level === 'near') landmarkNames(places, claim, label);
    regionNames(places, claim, label);
  }

  drawBirds(ctx, view, time);
  const guide = drawGuide(ctx, lineView, time, (iconId, x, y, size) => faceBadge(iconId, x, y, size, { ring: MINE }));
  if (guide) hits.push(guide);
  drawChangeMarks(time);

  // Names last, so nothing can bury them. Positions were resolved above, before
  // anything else could take the space.
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  labels.forEach((entry) => {
    ctx.font = entry.font;
    ctx.lineWidth = entry.font === LABEL_FONT ? 4.5 : 3.5;
    ctx.strokeStyle = INK.halo;
    ctx.strokeText(entry.text, entry.x, entry.y);
    ctx.fillStyle = entry.soft ? 'rgba(255,255,255,.9)' : INK.label;
    ctx.fillText(entry.text, entry.x, entry.y);
  });
  ctx.restore();
}

/** Zoomed in, the town steps aside for the people.
 *
 * An island with one post has its centre on that post, so the town and the
 * face would stack. Try the centre, then either side, then above and below,
 * and take the first spot that leaves every face of the island clear - or, if
 * none does, the one that leaves the most room.
 */
function besideFaces(spot, size, members, visible) {
  const faces = visible.filter(({ post }) => members.has(post.id)).map(({ point }) => point);
  if (!faces.length) return spot;
  const tries = [[0, 0], [-1, 0.1], [1, 0.1], [0, -0.9], [0, 0.85], [-1.1, -0.6], [1.1, -0.6]];
  const want = size * 0.55 + 16;
  let best = spot;
  let bestRoom = -1;
  for (const [dx, dy] of tries) {
    const x = spot.x + dx * size;
    const y = spot.y + dy * size;
    const room = Math.min(...faces.map((point) => Math.hypot(point.x - x, point.y - (y - size * 0.2))));
    if (room >= want) return { x, y };
    if (room > bestRoom) { best = { x, y }; bestRoom = room; }
  }
  return best;
}

/** Trees, bushes and rocks from the terrain's scatter, kept off the
 * settlements and out from under faces. Zoomed out, every other one. */
function drawTrees(trees, places, posts, thin) {
  const base = Math.max(9, Math.min(24, state.camera.scale * 11));
  trees.forEach((tree) => {
    if (thin && tree.k < 1) return;
    const p = toScreen(tree.x, tree.y);
    if (p.x < -30 || p.x > width + 30 || p.y < -30 || p.y > height + 40) return;
    const size = base * tree.k * (tree.name === 'bush' || tree.name === 'rock' ? 0.7 : 1);
    const foot = p.y + size * 0.35;
    const covered = places.some((place) => Math.abs(p.x - place.x) < place.size * 1.45
      && foot > place.foot - place.size * 1.15 && foot < place.foot + place.size * 0.55);
    if (covered) return;
    if (posts.some(({ point }) => Math.abs(point.x - p.x) < 15 && Math.abs(point.y - p.y) < 18)) return;
    drawSprite(ctx, tree.name, p.x, foot, size);
  });
}

/** A white disc with the person's face, outlined like the buildings. */
function faceBadge(iconId, x, y, size, { ring = OUTLINE, glow = 0 } = {}) {
  ctx.save();
  if (glow > 0) {
    ctx.shadowColor = 'rgba(255, 138, 31, .9)';
    ctx.shadowBlur = glow;
  }
  ctx.beginPath();
  ctx.arc(x, y, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = '#fffaf0';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = ring === OUTLINE ? Math.max(1.4, size * 0.07) : Math.max(2.2, size * 0.12);
  ctx.strokeStyle = ring;
  ctx.stroke();
  ctx.restore();
  drawFace(ctx, iconId, x, y, size * 0.74, ring);
}

/** Who is on each island, zoomed out: a few faces and the head count. */
function drawCrowds(places, claim, meId) {
  const size = 16;
  const step = 11;
  places.forEach((place) => {
    const authors = new Map();
    place.members.forEach((id) => {
      const post = state.postsById.get(id);
      if (!post || authors.has(post.author_id)) return;
      authors.set(post.author_id, post);
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
      faceBadge(post.icon_id, at, y, size, { ring: post.author_id === meId ? MINE : OUTLINE });
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

/** A warm glow on the ground under each of your posts (Q57). */
function glowMine(visible, time) {
  const pulse = REDUCED_MOTION ? 1 : 1 + Math.sin(time * 2.2) * 0.18;
  visible.forEach(({ point, mine }) => {
    if (!mine) return;
    ctx.save();
    const glow = ctx.createRadialGradient(point.x, point.y, 4, point.x, point.y, 28 * pulse);
    glow.addColorStop(0, 'rgba(255, 170, 60, .85)');
    glow.addColorStop(1, 'rgba(255, 170, 60, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 28 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

/** Your posts, zoomed out: a tap flies you to them. Your face goes on the post
 * only where it would not sit on a town - over a town, the orange face in the
 * crowd row already says you are there. */
function drawMineFar(visible, places, claim) {
  const selectedId = state.selected ? state.selected.id : null;
  const onTown = (point) => places.some(({ box }) => box
    && point.x > box.left - 6 && point.x < box.right + 6 && point.y > box.top - 6 && point.y < box.bottom + 6);
  visible.forEach(({ post, point, mine }) => {
    if (post.id === selectedId) {
      drawPin(ctx, point.x, point.y, 22);
      hits.push({ x: point.x, y: point.y, r: 20, post });
      return;
    }
    if (!mine) return;
    if (!onTown(point)) {
      faceBadge(post.icon_id, point.x, point.y, 22, { ring: MINE, glow: 8 });
      claim(point.x, point.y, 24, 24);
    }
    hits.push({ x: point.x, y: point.y, r: 22, post, approach: true });
  });
}

/** Zoomed in: everybody's face where they wrote, names where they fit.
 *
 * Room is handed out in order - you, then the people closest to you, then the
 * busiest - and whoever does not get room is drawn smaller and unnamed rather
 * than not at all. Paint runs the other way, so the first in line ends on top
 * and the finger finds them first.
 */
function drawFaces(visible, claim, level, time) {
  const deep = level === 'deep';
  const full = deep ? 30 : 20;
  const close = new Set(state.neighbors.map((person) => person.id));
  const selectedId = state.selected ? state.selected.id : null;
  const ranked = visible.map((entry) => ({
    ...entry,
    rank: entry.mine ? 0 : close.has(entry.post.id) ? 1 : 2,
    busy: interactionsOf(entry.post),
  })).sort((a, b) => a.rank - b.rank || b.busy - a.busy);

  ctx.save();
  ranked.forEach((entry) => {
    const { point, post } = entry;
    const room = claim(point.x, point.y, full + 2, full + 2) || entry.mine;
    entry.size = room ? full : Math.round(full * 0.65);
    if (!room) return;
    ctx.font = SMALL_FONT;
    const name = clip(post.display_name, 6);
    const nameY = point.y + full / 2 + 10;
    if (claim(point.x, nameY, ctx.measureText(name).width, 12) || entry.mine) {
      entry.name = name;
      entry.nameY = nameY;
    }
    if (deep) {
      ctx.font = '500 11px system-ui, sans-serif';
      const text = clip(post.body, 14);
      const bubbleWidth = ctx.measureText(text).width + 14;
      const bubbleY = point.y - full / 2 - 15;
      // Slid back inside the screen edge; the tail still points at the face.
      const bubbleX = Math.max(bubbleWidth / 2 + 6, Math.min(width - bubbleWidth / 2 - 6, point.x));
      if (Math.abs(bubbleX - point.x) < bubbleWidth / 2 - 8 && claim(bubbleX, bubbleY, bubbleWidth, 20)) {
        entry.bubble = { text, width: bubbleWidth, y: bubbleY, x: bubbleX };
      }
    }
  });
  ctx.restore();

  ranked.slice().reverse().forEach(({ post, point, mine, size, name, nameY, bubble, busy }) => {
    if (mine) {
      const pulse = REDUCED_MOTION ? 1 : 1 + Math.sin(time * 2.2) * 0.12;
      ctx.save();
      const glow = ctx.createRadialGradient(point.x, point.y, size * 0.3, point.x, point.y, size * pulse);
      glow.addColorStop(0, 'rgba(255, 170, 60, .7)');
      glow.addColorStop(1, 'rgba(255, 170, 60, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(point.x, point.y, size * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    faceBadge(post.icon_id, point.x, point.y, size, { ring: mine ? MINE : OUTLINE });
    if (post.id === selectedId) selectionRing(ctx, point.x, point.y, size / 2 + 4, islandColor(post.cluster_id));

    // How much it has been answered: always when deep, only when busy at near.
    if (busy > 0 && (level === 'deep' || busy >= 5)) countChip(point.x + size * 0.42, point.y - size * 0.42, busy);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    if (name) {
      ctx.font = SMALL_FONT;
      ctx.lineWidth = 3;
      ctx.strokeStyle = INK.halo;
      ctx.strokeText(name, point.x, nameY);
      ctx.fillStyle = INK.label;
      ctx.fillText(name, point.x, nameY);
    }
    if (bubble) speechBubble(point.x, bubble);
    ctx.restore();

    hits.push({ x: point.x, y: point.y, r: Math.max(18, size * 0.7), post });
  });
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
  ctx.fillStyle = '#fffaf0';
  ctx.fill();
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
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

const EMOJI_STACK =
  'system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

/** islands' marker for the post that is open. Bigger than the glyph it hides,
 * because the point of it is to be findable from across the screen. */
function drawPin(ctx, x, y, size) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.max(15, Math.round(size * 1.05))}px ${EMOJI_STACK}`;
  ctx.fillText('📍', x, y);
  ctx.restore();
}

/** A ring in the landmass colour, on a white backing so it reads over water. */
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

function selectionRing(ctx, x, y, radius, accent) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = 4.5;
  ctx.stroke();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2.5;
  ctx.stroke();
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

// ---------------------------------------------------------------- orbit view

const RING_RANKS = [0.25, 0.5, 0.75];
const SELF_SIZE = 56;
// Where beside a face a common-point label may sit, best first.
const ORBIT_LABEL_SPOTS = ['out', 'in', 'above'];

let orbitCache = { key: '', placed: [], size: 0 };

function orbitLayout(neighbors) {
  const key = `${width}x${height}:${neighbors.map((n) => `${n.id}:${n.similarity}`).join(',')}`;
  if (orbitCache.key === key) return orbitCache;

  const count = neighbors.length;
  const size = count > 22 ? 30 : count > 12 ? 36 : count > 6 ? 42 : 48;
  const centreX = width / 2;
  const centreY = height / 2 - 24;
  const maxRadius = Math.min(width, height) * 0.42;
  // A tall phone has room above and below: stretch the rings into ovals so the
  // people spread out instead of piling up across the narrow width.
  const stretch = Math.max(1, Math.min(1.5, (height * 0.34) / maxRadius));

  const placed = neighbors.map((person) => {
    // Radius from 似てる度, angle from the real bearing on the map. The ring is
    // the honest measure; the angle keeps a familiar arrangement so somebody who
    // has looked at the map recognises where their neighbours are.
    const similarity = Math.max(0, Math.min(100, Number(person.similarity) || 0));
    const near = 1 - similarity / 100;
    const radius = SELF_SIZE * 0.9 + near * (maxRadius - SELF_SIZE * 0.9);
    const me = state.postsById.get(state.activePostId) || { x: person.x, y: person.y };
    let angle = Math.atan2(person.y - me.y, person.x - me.x);
    if (!Number.isFinite(angle)) angle = 0;
    return { person, radius, angle, size };
  });

  relaxAngles(placed, stretch);
  orbitCache = { key, placed, size, centreX, centreY, stretch };
  return orbitCache;
}

/** Push apart anybody whose face, name and 似てる度 would overlap, keeping
 * their radii.
 *
 * The radius is the measurement and must not move. The angle is a convenience,
 * so it is the angle that gives. Each person is a box taller than it is wide,
 * because the name and the percentage sit under the face.
 */
function relaxAngles(placed, stretch = 1) {
  for (let pass = 0; pass < 120; pass += 1) {
    let moved = false;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i];
        const b = placed[j];
        const ax = Math.cos(a.angle) * a.radius;
        const ay = Math.sin(a.angle) * a.radius * stretch;
        const bx = Math.cos(b.angle) * b.radius;
        const by = Math.sin(b.angle) * b.radius * stretch;
        const wantX = (a.size + b.size) * 0.66;
        const wantY = (a.size + b.size) * 0.86;
        const dx = Math.abs(ax - bx);
        const dy = Math.abs(ay - by);
        if (dx >= wantX || dy >= wantY || (dx === 0 && dy === 0)) continue;
        const push = 0.05 * Math.min(1 - dx / wantX, 1 - dy / wantY) + 0.004;
        const direction = Math.sign(
          ((a.angle - b.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI,
        ) || 1;
        a.angle += push * direction;
        b.angle -= push * direction;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function renderOrbit(time) {
  const view = { sea: seaBox(), toScreen, width, height };
  drawSeaMarks(ctx, view, time);

  const neighbors = state.neighbors.filter((person) => {
    const post = state.postsById.get(person.id) || person;
    return matchesFilters({ ...post, body: person.body, tags: person.tags });
  });
  const layout = orbitLayout(neighbors);
  const { stretch } = layout;
  const centreX = width / 2;
  const centreY = height / 2 - 24;

  // Rings at fixed 似てる度 marks, so the distances are readable as a scale
  // rather than as decoration.
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.28)';
  ctx.setLineDash([3, 6]);
  ctx.lineWidth = 1;
  const maxRadius = Math.min(width, height) * 0.42;
  RING_RANKS.forEach((rank) => {
    const radius = SELF_SIZE * 0.9 + rank * (maxRadius - SELF_SIZE * 0.9);
    ctx.beginPath();
    ctx.ellipse(centreX, centreY, radius, radius * stretch, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round((1 - rank) * 100)}%`, centreX, centreY - radius * stretch - 4);
    ctx.setLineDash([3, 6]);
  });
  ctx.restore();

  const me = state.postsById.get(state.activePostId);
  // The people the AI thinks are most like you get the map's orange dotted
  // line and, halfway along it, what you have in common (段4).
  const alike = new Map((state.similar || []).map((person) => [person.id, person]));
  const commons = [];
  const taken = []; // faces and names, so the common points never cover them

  layout.placed.forEach(({ person, radius, angle, size }) => {
    const x = centreX + Math.cos(angle) * radius;
    const y = centreY + Math.sin(angle) * radius * stretch;
    const accent = islandColor(person.cluster_id);
    const known = person.author_id ? alike.get(person.author_id) : null;

    ctx.save();
    if (known) {
      ctx.strokeStyle = MINE;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.setLineDash([1, 6]);
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,.30)';
      ctx.lineWidth = 1;
    }
    ctx.beginPath();
    ctx.moveTo(centreX, centreY);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();
    // Every face of a person is a candidate place for their one label.
    const common = known ? orbitTag(known.reasons) : '';
    if (common) commons.push({ author: person.author_id, text: common, x, y, size });
    taken.push({ left: x - size * 0.5, right: x + size * 0.5, top: y - size * 0.5, bottom: y + size * 0.72 + 16 });

    const post = state.postsById.get(person.id) || person;
    ctx.save();
    islandPath(ctx, x, y, size * 0.62, hashId(person.id));
    ctx.fillStyle = 'rgba(255,255,255,.16)';
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();

    drawFace(ctx, person.icon_id, x, y, size * 0.72, accent);
    if (state.selected && state.selected.id === person.id) {
      selectionRing(ctx, x, y, size * 0.46, accent);
    }

    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK.halo;
    const label = clip(person.display_name, 6);
    ctx.strokeText(label, x, y + size * 0.72);
    ctx.fillStyle = INK.label;
    ctx.fillText(label, x, y + size * 0.72);

    if (typeof person.similarity === 'number') {
      ctx.font = '700 10px system-ui, sans-serif';
      ctx.strokeStyle = INK.halo;
      ctx.strokeText(`${person.similarity}%`, x, y + size * 0.72 + 12);
      ctx.fillStyle = 'rgba(255,255,255,.86)';
      ctx.fillText(`${person.similarity}%`, x, y + size * 0.72 + 12);
    }
    ctx.restore();

    hits.push({ x, y, r: size * 0.8, post: { ...post, ...person } });
  });

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 10.5px system-ui, sans-serif';
  // You in the middle, too, and then each label that still has room.
  taken.push({ left: centreX - SELF_SIZE * 0.6, right: centreX + SELF_SIZE * 0.6,
    top: centreY - SELF_SIZE * 0.6, bottom: centreY + SELF_SIZE * 0.6 });
  const labelled = new Set();
  const clashes = (box) => taken.some((other) => box.left < other.right && box.right > other.left
    && box.top < other.bottom && box.bottom > other.top);
  // One label per person, beside one of their faces: the outer side first,
  // then the inner side, then above. A spot that would cover anybody's face
  // or name is skipped, and a person with no free spot goes without.
  ORBIT_LABEL_SPOTS.forEach((spot) => commons.forEach((common) => {
    if (labelled.has(common.author)) return;
    const w = ctx.measureText(common.text).width + 12;
    const outward = common.x >= centreX ? 1 : -1;
    const side = common.size * 0.5 + 2 + w / 2;
    const x = spot === 'above' ? common.x : common.x + (spot === 'out' ? outward : -outward) * side;
    const y = spot === 'above' ? common.y - common.size * 0.5 - 11 : common.y;
    const box = { left: x - w / 2, right: x + w / 2, top: y - 9, bottom: y + 9 };
    if (box.left < 4 || box.right > width - 4 || clashes(box)) return;
    labelled.add(common.author);
    taken.push(box);
    ctx.fillStyle = 'rgba(255,255,255,.94)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 9, w, 18, 9);
    ctx.fill();
    ctx.fillStyle = '#9a4a00';
    ctx.fillText(common.text, x, y + 0.5);
  }));
  ctx.restore();

  // You, in the middle.
  ctx.save();
  const pulse = 1 + Math.sin(time * 1.7) * 0.05;
  ctx.strokeStyle = 'rgba(255,255,255,.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(centreX, centreY, SELF_SIZE * 0.55 * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  if (me) {
    drawFace(ctx, me.icon_id, centreX, centreY, SELF_SIZE * 0.8, islandColor(me.cluster_id));
    hits.push({ x: centreX, y: centreY, r: SELF_SIZE * 0.6, post: me });
  }

  if (!neighbors.length) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText(
      me ? 'まだあなただけです。URLを送ると相手も地図に出ます。' : '投稿すると、近い人が出てきます。',
      centreX, centreY + Math.min(width, height) * 0.42 + 30,
    );
    ctx.restore();
  }
}

export function invalidateOrbit() {
  orbitCache = { key: '', placed: [], size: 0 };
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
