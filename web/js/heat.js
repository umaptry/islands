// HeatObject: the ball or flame that wraps a person's face, set by how fired up
// the post is (motivation, 0-100). Ported from the design mock's HeatObject.tsx.
//
//   0-30     lime ball, drifting slowly
//   31-65    orange ball, drifting a little quicker
//   66-90    red-orange flame, swaying; bigger the higher the number
//   91-100   blue flame, shaking hard; bigger still
//
// This file is pure (no DOM, no imports) on purpose. The tier test, the colours
// and the flame outlines are exported for anyone who draws the same object a
// different way - the compose screen draws it as SVG from these - and the canvas
// drawing for the map lives at the bottom.

export const HEAT_LIME = 'lime';
export const HEAT_ORANGE = 'orange';
export const HEAT_FLAME = 'flame';
export const HEAT_BLUE = 'blueFlame';

/** Which of the four looks a heat value gets. */
export function getHeatTier(value) {
  const v = Number(value);
  if (v >= 91) return HEAT_BLUE;
  if (v >= 66) return HEAT_FLAME;
  if (v >= 31) return HEAT_ORANGE;
  return HEAT_LIME;
}

/** How large a flame is (1.0 = the mock's reference). Balls are always 1. */
export function getFlameScale(value) {
  const v = Number(value) || 0;
  if (v >= 91) return 1.1 + ((Math.min(v, 100) - 91) / 9) * 0.2; // 1.1 - 1.3
  if (v >= 66) return 0.8 + ((v - 66) / 24) * 0.3;               // 0.8 - 1.1
  return 1;
}

export const isFlameTier = (tier) => tier === HEAT_FLAME || tier === HEAT_BLUE;

export const HEAT_COLORS = {
  lime: { light: '#D8FF8A', main: '#9BE03C', dark: '#5FA81A' },
  orange: { light: '#FFD9A0', main: '#FF9A2E', dark: '#E06A00' },
  flame: { outer: '#FF4B2B', inner: '#FF8A3D', core: '#FFE07A' },
  blueFlame: { outer: '#2F6BFF', inner: '#4FC3FF', core: '#E6FBFF' },
};

/** The colour of the heat at a glance (a dot, a ring). */
export function heatColor(value) {
  const tier = getHeatTier(value);
  return isFlameTier(tier) ? HEAT_COLORS[tier].outer : HEAT_COLORS[tier].main;
}

// Flame outlines on a 0-100 box; the base of the flame is at (50, 92).
export const FLAME_OUTER_PATH =
  'M 52 6 C 58 20, 68 28, 75 38 C 81 47, 82 54, 82 62 C 82 79, 68 92, 50 92 C 32 92, 18 79, 18 62 C 18 50, 23 39, 32 29 C 36 24, 40 26, 42 28 C 45 31, 49 18, 52 6 Z';
export const FLAME_INNER_PATH =
  'M 50 34 C 60 44, 70 52, 70 66 C 70 77, 61 86, 50 86 C 39 86, 30 77, 30 66 C 30 52, 40 44, 50 34 Z';
export const FLAME_CORE_PATH =
  'M 50 60 C 55.5 60, 60 64.5, 60 70 C 60 75.5, 55.5 80, 50 80 C 44.5 80, 40 75.5, 40 70 C 40 64.5, 44.5 60, 50 60 Z';

// The round "body" of the flame outline, which is what wraps the face.
export const FLAME_BODY = { cx: 50, cy: 62, r: 30, bottom: 92, innerBottom: 88 };

// ---------------------------------------------------------------- motion

/** How far the face and ball rise (positive = up), in units of the mock's
 * 18px face. A flame does not bob: it sways instead. */
export function heatBob(tier, time, phase = 0) {
  if (tier === HEAT_LIME) return Math.sin(time * 1.4 + phase) * 2.5;
  if (tier === HEAT_ORANGE) return Math.sin(time * 2.4 + phase) * 3;
  return 0;
}

/** The sway of a flame at `time`: skew of the outline and the squash of the
 * outline and of the core. All 0/1 when `time` is null (no motion). */
export function flameSway(tier, time, phase = 0) {
  if (time == null) return { skew: 0, sx: 1, sy: 1, innerSx: 1, innerSy: 1 };
  const t = time;
  if (tier === HEAT_FLAME) {
    const k = Math.sin(t * 3.1 + phase) * 0.02;
    return {
      skew: Math.sin(t * 2.2 + phase) * 0.05,
      sx: 1 - k, sy: 1 + k,
      innerSx: 1, innerSy: 1 + Math.sin(t * 6 + phase) * 0.07,
    };
  }
  const k = Math.sin(t * 13 + phase) * 0.04 + Math.sin(t * 21 + phase) * 0.02;
  return {
    skew: Math.sin(t * 9 + phase) * 0.1 + Math.sin(t * 15.3 + phase) * 0.05,
    sx: 1 - k, sy: 1 + k * 1.5,
    innerSx: 1 - k * 0.5, innerSy: 1 + Math.sin(t * 24 + phase) * 0.1,
  };
}

// ---------------------------------------------------------------- morph

// The compose screen does not jump between the four looks. As the slider moves
// the ball stretches into a flame, its colour runs lime → orange → red → blue,
// and it grows - every number in between has its own shape. At the middle of
// each tier it is that tier's look, so it still matches what the map stamps.
//
// The ball is drawn with the same seven curves as FLAME_OUTER_PATH, its anchors
// on a circle at the angles the flame's anchors stand at round the flame's body,
// so one outline can be blended into the other point by point.

const FLAME_POINTS = FLAME_OUTER_PATH.match(/-?\d+(\.\d+)?/g).map(Number);
const BALL = { cx: 50, cy: 56 };

const clampUnit = (t) => Math.max(0, Math.min(1, t));
const smoothBetween = (from, to, v) => {
  const t = clampUnit((v - from) / (to - from));
  return t * t * (3 - 2 * t);
};

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `a` and `b` (#rrggbb) blended, `t` of the way to `b`, as #rrggbb. */
export function mixHex(a, b, t) {
  const from = hexRgb(a);
  const to = hexRgb(b);
  const k = clampUnit(t);
  return `#${from.map((c, i) => Math.round(c + (to[i] - c) * k).toString(16).padStart(2, '0')).join('')}`;
}

/** A circle drawn with the flame outline's seven curves (44 numbers, like FLAME_POINTS). */
export function ballPoints(radius) {
  const { cx, cy } = FLAME_BODY;
  // The start point, then the end point of each of the seven curves (the last
  // is the start again): [x, y, then six numbers per curve, ending x, y].
  const anchors = [FLAME_POINTS.slice(0, 2)];
  for (let i = 2; i < FLAME_POINTS.length; i += 6) anchors.push(FLAME_POINTS.slice(i + 4, i + 6));
  const angles = anchors.map(([x, y]) => Math.atan2(y - cy, x - cx));
  // The outline runs clockwise on screen: each angle is past the one before.
  for (let i = 1; i < angles.length; i += 1) {
    while (angles[i] <= angles[i - 1]) angles[i] += Math.PI * 2;
  }
  const at = (angle) => [BALL.cx + Math.cos(angle) * radius, BALL.cy + Math.sin(angle) * radius];
  const out = [...at(angles[0])];
  for (let i = 1; i < angles.length; i += 1) {
    const a = angles[i - 1];
    const b = angles[i];
    const k = (4 / 3) * Math.tan((b - a) / 4) * radius;
    const [ax, ay] = at(a);
    const [bx, by] = at(b);
    out.push(ax - Math.sin(a) * k, ay + Math.cos(a) * k, bx + Math.sin(b) * k, by - Math.cos(b) * k, bx, by);
  }
  return out;
}

/** The flame outline grown or shrunk about its base. */
function flamePointsAt(scale) {
  const { cx, bottom } = FLAME_BODY;
  return FLAME_POINTS.map((value, i) => (i % 2 === 0
    ? cx + (value - cx) * scale
    : bottom + (value - bottom) * scale));
}

/** 44 numbers as an SVG/Path2D outline in the shape of FLAME_OUTER_PATH. */
export function outlinePath(points) {
  const n = (v) => Number(v.toFixed(2));
  let d = `M ${n(points[0])} ${n(points[1])}`;
  for (let i = 2; i < points.length; i += 6) {
    d += ` C ${n(points[i])} ${n(points[i + 1])}, ${n(points[i + 2])} ${n(points[i + 3])}, ${n(points[i + 4])} ${n(points[i + 5])}`;
  }
  return `${d} Z`;
}

/** Flame size for any number, joined up: 0.75 below 60, then as getFlameScale. */
export function morphScale(value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  if (v <= 60) return 0.75;
  if (v < 66) return 0.75 + ((v - 60) / 6) * 0.05;
  return getFlameScale(v);
}

/**
 * Everything the compose screen's object needs at one heat value, every part a
 * continuous function of it.
 *
 * flame   0 ball .. 1 flame (the outline's shape, and how much flame shows)
 * orange  0 lime .. 1 orange (the ball's colour)
 * blue    0 red .. 1 blue (the flame's colour)
 */
export function heatMorph(value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const orange = smoothBetween(22, 40, v);
  const flame = smoothBetween(48, 72, v);
  const blue = smoothBetween(89, 95, v);
  const scale = morphScale(v);
  const radius = 21 + 2 * clampUnit(v / 60);

  const ball = ['light', 'main', 'dark'].map((key) => mixHex(HEAT_COLORS.lime[key], HEAT_COLORS.orange[key], orange));
  const outer = mixHex(HEAT_COLORS.flame.outer, HEAT_COLORS.blueFlame.outer, blue);
  const [light, main, dark] = ball.map((color) => mixHex(color, outer, flame));

  const round = ballPoints(radius);
  const pointed = flamePointsAt(scale);
  const points = round.map((value, i) => value + (pointed[i] - value) * flame);

  return {
    flame, orange, blue, scale, radius,
    body: { light, main, dark },
    outer,
    inner: mixHex(HEAT_COLORS.flame.inner, HEAT_COLORS.blueFlame.inner, blue),
    core: mixHex(HEAT_COLORS.flame.core, HEAT_COLORS.blueFlame.core, blue),
    points,
    path: outlinePath(points),
  };
}

/** The bob of a ball and the sway of a flame at `time`, blended the way
 * heatMorph blends the looks. `time` null: all still. */
export function morphMotion(morph, time, phase = 0) {
  if (time == null) return { bob: 0, ...flameSway(HEAT_FLAME, null) };
  const bob = (heatBob(HEAT_LIME, time, phase) * (1 - morph.orange)
    + heatBob(HEAT_ORANGE, time, phase) * morph.orange) * (1 - morph.flame);
  const red = flameSway(HEAT_FLAME, time, phase);
  const hot = flameSway(HEAT_BLUE, time, phase);
  const blend = (key, rest) => {
    const swayed = red[key] + (hot[key] - red[key]) * morph.blue;
    return rest + (swayed - rest) * morph.flame;
  };
  return {
    bob,
    skew: blend('skew', 0),
    sx: blend('sx', 1), sy: blend('sy', 1),
    innerSx: blend('innerSx', 1), innerSy: blend('innerSy', 1),
  };
}

// ---------------------------------------------------------------- sprites

// A crowd cannot afford to draw every ball and flame stroke by stroke, so the
// map paints each look once onto a small canvas and stamps it. A flame is
// painted at a few moments of its sway and the stamp is switched with time.
export const HEAT_FRAMES = 6;
const FLAME_CYCLE = (Math.PI * 2) / 2.2;   // the slow skew term's period

/** Values that look alike share one sprite: same tier, same flame size. */
export function heatSpriteValue(value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const tier = getHeatTier(v);
  if (tier === HEAT_BLUE) return Math.min(100, 91 + Math.round((v - 91) / 3) * 3);
  if (tier === HEAT_FLAME) return Math.min(90, 66 + Math.round((v - 66) / 4) * 4);
  return tier === HEAT_ORANGE ? 48 : 15;
}

/** How many pictures a look needs: balls hold still, flames have HEAT_FRAMES. */
export function heatFrameCount(tier) {
  return isFlameTier(tier) ? HEAT_FRAMES : 1;
}

/** The `time` a given picture of a flame is painted at (null: the still one). */
export function heatFrameTime(tier, frame) {
  if (!isFlameTier(tier)) return null;
  return tier === HEAT_FLAME
    ? (frame * FLAME_CYCLE) / HEAT_FRAMES
    : 0.3 + frame * 0.137;
}

/** Which picture to show at `time` seconds (`phase` desynchronises a crowd). */
export function heatFrameAt(tier, time, phase = 0) {
  if (!isFlameTier(tier) || time == null) return 0;
  const turn = tier === HEAT_FLAME
    ? (time / FLAME_CYCLE) * HEAT_FRAMES * 1
    : time * 11;
  return ((Math.floor(turn + phase * 1.7) % HEAT_FRAMES) + HEAT_FRAMES) % HEAT_FRAMES;
}

/** Half the side of a square that holds the whole object centred on the face. */
export function heatSpriteHalf(radius, value) {
  const a = radius / 18;
  if (isFlameTier(getHeatTier(value))) {
    const s = ((23 * a) / FLAME_BODY.r) * (getFlameScale(value) / 0.8) * 0.75;
    return Math.ceil(80 * s + 8);
  }
  return Math.ceil(radius + Math.max(5, 8 * a) + 6);
}

// ---------------------------------------------------------------- canvas

let paths = null;
function flamePaths() {
  if (!paths) {
    paths = {
      outer: new Path2D(FLAME_OUTER_PATH),
      inner: new Path2D(FLAME_INNER_PATH),
      core: new Path2D(FLAME_CORE_PATH),
    };
  }
  return paths;
}

/** The lift to give the face itself so it floats with its ball. */
export function faceLift(value, radius, time, phase = 0) {
  if (time == null) return 0;
  return heatBob(getHeatTier(value), time, phase) * (radius / 18);
}

/** Draw the heat object around a face centred on (x, y) with `radius`.
 *
 * Draw the face afterwards, on top: the ball and the flame are made to be
 * wrapped around it. `time` is seconds (null: hold still, for reduced motion).
 * `phase` offsets the sway so a crowd does not move in step.
 * Returns how far the object reaches above the face's centre, for label room.
 */
export function drawHeat(ctx, x, y, radius, value, time, phase = 0) {
  const tier = getHeatTier(value);
  const a = radius / 18;
  if (isFlameTier(tier)) return drawFlame(ctx, x, y, a, tier, value, time, phase);
  return drawBall(ctx, x, y - faceLift(value, radius, time, phase), radius, a, tier);
}

function drawBall(ctx, x, y, radius, a, tier) {
  const c = HEAT_COLORS[tier];
  const pad = Math.max(3.5, 4.5 * a);
  ctx.save();
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius + Math.max(5, 8 * a), 0, Math.PI * 2);
  ctx.globalAlpha *= 0.25;
  ctx.fillStyle = c.main;
  ctx.fill();
  ctx.restore();
  // The shadow side first, then the body a touch higher: a little roundness.
  ctx.beginPath();
  ctx.arc(x, y + 1, radius + pad, 0, Math.PI * 2);
  ctx.fillStyle = c.dark;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y - 0.5, radius + pad - 0.5, 0, Math.PI * 2);
  ctx.fillStyle = c.main;
  ctx.fill();
  const hl = (radius + 2) * 0.7;
  ctx.beginPath();
  ctx.arc(x - hl, y - hl, Math.max(1.6, 2.4 * a), 0, Math.PI * 2);
  ctx.globalAlpha *= 0.8;
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
  return radius + Math.max(5, 8 * a);
}

function drawFlame(ctx, x, y, a, tier, value, time, phase) {
  const c = HEAT_COLORS[tier];
  const { inner, core, outer } = flamePaths();
  const sway = flameSway(tier, time, phase);
  const s = ((23 * a) / FLAME_BODY.r) * (getFlameScale(value) / 0.8) * 0.75;
  const { cx, cy, bottom, innerBottom } = FLAME_BODY;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.translate(-cx, -cy);

  // The outline sways about the base of the flame.
  ctx.save();
  ctx.translate(cx, bottom);
  ctx.transform(sway.sx, 0, Math.sin(sway.skew) * sway.sy, Math.cos(sway.skew) * sway.sy, 0, 0);
  ctx.translate(-cx, -bottom);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1.12, 1.12);
  ctx.translate(-cx, -cy);
  ctx.globalAlpha *= 0.3;
  ctx.fillStyle = c.outer;
  ctx.fill(outer);
  ctx.restore();

  ctx.fillStyle = c.outer;
  ctx.fill(outer);
  ctx.save();
  ctx.translate(28, 40);
  ctx.rotate((-30 * Math.PI) / 180);
  ctx.beginPath();
  ctx.ellipse(0, 0, 3, 6, 0, 0, Math.PI * 2);
  ctx.globalAlpha *= 0.5;
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
  ctx.restore();

  // The core only flickers, about its own base.
  ctx.save();
  ctx.translate(cx, innerBottom);
  ctx.scale(sway.innerSx, sway.innerSy);
  ctx.translate(-cx, -innerBottom);
  ctx.fillStyle = c.inner;
  ctx.fill(inner);
  ctx.fillStyle = c.core;
  ctx.fill(core);
  ctx.restore();

  ctx.restore();
  // From the body's middle to the tip of the flame (and its glow).
  return (FLAME_BODY.cy - 6) * s * 1.12;
}
