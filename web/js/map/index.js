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

import { config, glyphOf, interactionsOf, islandColor, radiusOf } from '../config.js';
import { drawFace } from '../avatars.js';
import { matchesFilters, state, filtering } from '../state.js';
import { clip } from '../ui.js';
import {
  INK, drawBirds, drawBoats, drawSeaMarks, drawSurf, hashId, islandPath, makeLabelSpace,
} from './decor.js';
import { detectLandmasses, membership } from './landmass.js';
import { buildTerrain } from './terrain.js';

let canvas = null;
let ctx = null;
let dpr = 1;
let width = 0;
let height = 0;
let raf = 0;
let started = 0;
let onPick = () => {};
let hits = [];

// Below this zoom a post is drawn as islands' settlement glyph, above it as the
// person's face. Zoomed out you want to see where the activity is; zoomed in you
// want to see who. Two views of the same fact, and the switch is the thing that
// lets a busy map stay readable.
const FACE_ZOOM = 0.55;

export function initMap(element, { onSelect }) {
  canvas = element;
  ctx = canvas.getContext('2d');
  onPick = onSelect || (() => {});
  started = performance.now();
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
  if (!state.camera.scale || state.camera.scale === 1) fitCamera();
}

// ---------------------------------------------------------------- camera

/** Frame the land that exists, not the abstract 0-1000 box.
 *
 * The isotropic scaling maps the 99th-percentile radius to the box, so the
 * corners are always empty. Fitting the seed corpus's real bounding box fills
 * the screen with sea and islands instead of margin.
 */
export function fitCamera() {
  const bounds = seedBounds();
  const [minX, minY, maxX, maxY] = bounds;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  // Room for the top bar, the island badge and the bottom nav.
  const scale = Math.max(
    0.05,
    Math.min((width * 0.94) / spanX, Math.max(120, height - 210) / spanY),
  );
  state.camera = {
    scale,
    x: width / 2 - ((minX + maxX) / 2) * scale,
    y: (height - 60) / 2 - ((minY + maxY) / 2) * scale,
  };
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
  const next = Math.max(0.12, Math.min(requested, 6));
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
    if (Math.hypot(hit.x - x, hit.y - y) <= hit.r) {
      onPick(hit.post);
      return;
    }
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

function renderMap(time) {
  const view = { sea: seaBox(), toScreen, width, height };
  const { scale } = state.camera;
  const meId = state.account ? state.account.id : null;

  // The seed corpus is NOT drawn. It used to be a field of dots, which looked
  // like a second kind of island while meaning something entirely different -
  // the shape of the reference corpus, not a person. It still frames the camera
  // and still supplies the IDF that names things.
  const visible = [];
  state.posts.forEach((post) => {
    const point = toScreen(post.x, post.y);
    if (point.x < -80 || point.x > width + 80 || point.y < -80 || point.y > height + 80) return;
    visible.push({ post, point, mine: post.author_id === meId, dim: !matchesFilters(post) });
  });

  drawSeaMarks(ctx, view, time);

  // The ground. Built from every post the client holds, not just the ones on
  // screen, so panning does not make a coastline appear out of nothing.
  const terrain = buildTerrain({
    posts: state.posts.filter((post) => !filtering() || matchesFilters(post)),
    cells: state.saturated ? state.cells : [],
    region: postsRegion(),
    scale,
  });
  if (terrain) {
    const origin = toScreen(terrain.minX, terrain.minY);
    ctx.save();
    // Smoothing on: the field is a low-resolution texture and nearest-neighbour
    // upscaling turns a coastline into a staircase.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 0.96;
    ctx.drawImage(
      terrain.canvas, origin.x, origin.y,
      (terrain.width / terrain.scale) * scale,
      (terrain.height / terrain.scale) * scale,
    );
    ctx.restore();
  }

  drawBoats(ctx, view, time);

  const showFaces = scale >= FACE_ZOOM;
  const markerSize = Math.max(15, Math.min(30, 22 * Math.max(scale, 0.6)));

  // Surf first for every post, then the markers: drawing each ring immediately
  // before its own marker would let a later ring cover an earlier face wherever
  // two posts land close together.
  visible.forEach(({ post, point, mine, dim }) => {
    if (dim) return;
    const radius = Math.max(10, radiusOf(post) * scale * 0.5);
    drawSurf(ctx, point.x, point.y, radius * (mine ? 1.2 : 1), post.id, time);
  });

  drawBirds(ctx, view, time);

  const claim = makeLabelSpace();
  const labels = [];

  // Landmass names claim their space before anything else. They are the
  // headline: each one is built from the posts underneath it.
  //
  // A name never disappears - a region losing its label as the map fills up is
  // a bug this view has had before. But it does MOVE. Sitting the label a fixed
  // distance above the centre put it inside its own island once that island got
  // big, and two neighbouring names drew straight through each other. So the
  // preferred spot is clear of the island's own coastline, and a name that
  // cannot have it steps further out until it finds room.
  ctx.save();
  ctx.font = '700 13px system-ui, sans-serif';
  state.islands.forEach((island) => {
    const spot = toScreen(island.cx, island.cy);
    if (spot.x < -120 || spot.x > width + 120) return;
    if (spot.y < -80 || spot.y > height + 80) return;

    const textWidth = ctx.measureText(island.label).width;
    // Keep the whole name on screen: an edge label clipped in half is worse
    // than one nudged inwards.
    const half = textWidth / 2;
    const x = Math.max(half + 8, Math.min(width - half - 8, spot.x));
    const lift = islandLift(island) + 16;

    let y = spot.y - lift;
    // Above first, then below, then progressively further out on both sides.
    const tries = [0, lift * 2, -18, lift * 2 + 18, -36, lift * 2 + 36, -54];
    for (const offset of tries) {
      y = spot.y - lift + offset;
      if (claim(x, y, textWidth, 15)) break;
    }
    labels.push({ text: island.label, x, y, color: islandColor(island.cluster_id) });
  });
  ctx.restore();

  // You come next: your own name is never the one that gives way.
  const mine = visible.find((entry) => entry.mine && !entry.dim);
  if (mine) {
    ctx.save();
    ctx.font = '600 11px system-ui, sans-serif';
    const below = mine.point.y + markerSize * 0.7 + 12;
    claim(mine.point.x, below - 4, ctx.measureText(clip(mine.post.display_name, 6)).width, 13);
    ctx.restore();
  }

  // The post whose sheet is open. islands swapped its glyph for 📍 so you could
  // see, without closing the panel, which speck on the map you were reading.
  const selectedId = state.selected ? state.selected.id : null;

  visible.forEach(({ post, point, mine: isMe, dim }) => {
    ctx.save();
    if (dim) ctx.globalAlpha = 0.22;
    const accent = islandColor(post.cluster_id);
    const isSelected = post.id === selectedId;

    if (isMe && !dim) {
      const pulse = 1 + Math.sin(time * 1.9) * 0.09;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, (markerSize * 0.62 + 7) * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (showFaces) {
      drawFace(ctx, post.icon_id, point.x, point.y, markerSize, accent);
      // Zoomed in the face is the marker, so 📍 would cover the thing you came
      // to look at. A ring in the landmass colour says the same thing over it.
      if (isSelected) selectionRing(ctx, point.x, point.y, markerSize * 0.62 + 4, accent);
    } else if (isSelected) {
      drawPin(ctx, point.x, point.y, markerSize);
    } else {
      drawGlyph(ctx, post, point.x, point.y, markerSize);
    }

    // Reaction tally next to a busy post, so "this is where things are
    // happening" survives being zoomed out past the faces.
    const busy = interactionsOf(post);
    if (busy >= 5 && !dim) {
      ctx.font = '600 9px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = INK.halo;
      ctx.fillStyle = INK.label;
      const text = String(busy);
      const at = point.x + markerSize * 0.42;
      ctx.strokeText(text, at, point.y - markerSize * 0.3);
      ctx.fillText(text, at, point.y - markerSize * 0.3);
    }

    if (showFaces && !dim) {
      ctx.font = '600 11px system-ui, sans-serif';
      const label = clip(post.display_name, 6);
      const below = point.y + markerSize * 0.7 + 12;
      if (isMe || claim(point.x, below - 4, ctx.measureText(label).width, 13)) {
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = INK.halo;
        ctx.strokeText(label, point.x, below);
        ctx.fillStyle = INK.label;
        ctx.fillText(label, point.x, below);
      }
    }
    ctx.restore();

    if (!dim) {
      hits.push({ x: point.x, y: point.y, r: Math.max(20, markerSize * 0.7), post });
    }
  });

  // Names last, so nothing can bury them. Positions were resolved above, before
  // anything else could take the space.
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 13px system-ui, sans-serif';
  ctx.lineWidth = 4.5;
  ctx.lineJoin = 'round';
  labels.forEach((label) => {
    ctx.strokeStyle = INK.halo;
    ctx.strokeText(label.text, label.x, label.y);
    ctx.fillStyle = INK.label;
    ctx.fillText(label.text, label.x, label.y);
  });
  ctx.restore();
}

/** How far this landmass's ground reaches from its centre, in screen pixels.
 *
 * The label has to clear the island's own coastline, and a big island's
 * coastline is a long way out: the busiest post here reaches 74 world units,
 * which at a typical zoom is most of a phone's width. A fixed offset put the
 * name inside the land it was naming.
 *
 * Measured from the posts near the centre rather than from a stored radius,
 * because a landmass is a union of overlapping cones and no single number
 * describes it. Cheap: a handful of islands against one viewport of posts.
 */
function islandLift(island) {
  let reach = 0;
  state.posts.forEach((post) => {
    const radius = radiusOf(post);
    const distance = Math.hypot(post.x - island.cx, post.y - island.cy);
    // Only posts whose own ground touches the centre belong to this landmass
    // for the purpose of measuring it.
    if (distance <= radius * 1.35) reach = Math.max(reach, distance + radius);
  });
  return Math.max(24, reach * state.camera.scale);
}

const EMOJI_STACK =
  'system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

/** islands' staged settlement icon, drawn as the marker when zoomed out. */
function drawGlyph(ctx, post, x, y, size) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.max(11, Math.round(size * 0.8))}px ${EMOJI_STACK}`;
  ctx.fillText(glyphOf(post), x, y);
  ctx.restore();
}

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

let orbitCache = { key: '', placed: [], size: 0 };

function orbitLayout(neighbors) {
  const key = `${width}x${height}:${neighbors.map((n) => `${n.id}:${n.similarity}`).join(',')}`;
  if (orbitCache.key === key) return orbitCache;

  const count = neighbors.length;
  const size = count > 22 ? 30 : count > 12 ? 36 : count > 6 ? 42 : 48;
  const centreX = width / 2;
  const centreY = height / 2 - 24;
  const maxRadius = Math.min(width, height) * 0.42;

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

  relaxAngles(placed);
  orbitCache = { key, placed, size, centreX, centreY };
  return orbitCache;
}

/** Push apart anybody whose discs would overlap, keeping their radii.
 *
 * The radius is the measurement and must not move. The angle is a convenience,
 * so it is the angle that gives.
 */
function relaxAngles(placed) {
  for (let pass = 0; pass < 60; pass += 1) {
    let moved = false;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i];
        const b = placed[j];
        const ax = Math.cos(a.angle) * a.radius;
        const ay = Math.sin(a.angle) * a.radius;
        const bx = Math.cos(b.angle) * b.radius;
        const by = Math.sin(b.angle) * b.radius;
        const gap = Math.hypot(ax - bx, ay - by);
        const want = (a.size + b.size) * 0.62;
        if (gap >= want || gap === 0) continue;
        const push = 0.06 * (1 - gap / want);
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
    ctx.arc(centreX, centreY, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round((1 - rank) * 100)}%`, centreX, centreY - radius - 4);
    ctx.setLineDash([3, 6]);
  });
  ctx.restore();

  const me = state.postsById.get(state.activePostId);

  layout.placed.forEach(({ person, radius, angle, size }) => {
    const x = centreX + Math.cos(angle) * radius;
    const y = centreY + Math.sin(angle) * radius;
    const accent = islandColor(person.cluster_id);

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.30)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centreX, centreY);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();

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
