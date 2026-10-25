// The post pin: a round badge with the writer's face (photo, emoji or silhouette;
// the initial while a photo is still loading), drawn on the map canvas.
// Its look follows the heat in the four steps of heat.js (see PIN in palette.js):
// still, bobbing, soft round flames, blue flames. A recruiting pin sparkles itself.
//
// Shapes and fills (each flame frame too) are painted once into small offscreen
// canvases and stamped with drawImage; only the sway, the glows, the shine band,
// the stars and the rings are drawn per frame, and those are cheap. With
// `time` null nothing but the stamp is drawn (a still picture).
//
// Everything is in "pin units": the badge has radius 9 and its centre is the
// post's place (0,0), so one unit = size / 18 px (times the heat tier's scale).

import { PALETTE, PIN, mixHex, pinColor } from './palette.js';
import { getHeatTier } from '../heat.js';
import { drawFace, faceKey } from '../avatars.js';

export { pinColor };

const SPRITE_LIMIT = 800;
const FLAME_STEPS = 8;          // frames cached per flame cycle (smooth between the 4 key shapes)
const TAU = Math.PI * 2;

// A flame is three soft, round-ended lobes behind the top of the badge:
// [x, top y, half width] for the left, middle and right lobe. The 4 key shapes
// are blended round a loop. Every lobe is an upright ellipse, so nothing is sharp.
const FLAME_FRAMES = [
  [[-5.6, -16.5, 3.6], [0.4, -23.0, 4.4], [5.8, -17.5, 3.6]],
  [[-6.2, -18.0, 3.8], [-0.8, -21.5, 4.2], [5.2, -15.5, 3.4]],
  [[-5.2, -15.5, 3.4], [1.2, -24.0, 4.6], [6.4, -18.5, 3.8]],
  [[-5.9, -17.5, 3.7], [0.0, -22.0, 4.3], [5.5, -16.5, 3.5]],
];
const HEAD_Y = 0;
const HEAD_R = 9;
const FLAME_TOP = -24.5;   // above the badge's centre, in pin units
const LOBE_BOTTOM = -3;    // where a lobe starts, inside the badge
const GROUND = 10;         // how far below the centre the pin's shadow lies
const TAG_RISE = 14.5;     // from the pin's top to the top of the あなた tag, in size / 18 px

// Per tier: size scale, flame cycle (s), sway cycle (s) and angle (deg), sparks.
const TIERS = {
  low: { scale: 0.95, flame: false },
  mid: { scale: 1.0, flame: false },
  flame: { scale: 1.08, flame: true, period: 0.9, sway: 1.8, deg: 2, sparks: 2, colors: PIN.flame },
  top: { scale: 1.16, flame: true, period: 0.6, sway: 1.0, deg: 3, sparks: 3, colors: PIN.top },
};
const SELECTED_SCALE = 1.15;

const lighten = (hex, t) => mixHex(hex, '#FFFFFF', t);
const darken = (hex, t) => mixHex(hex, '#000000', t);

/** 'low' | 'mid' | 'flame' | 'top' for a heat value (same borders as heat.js). */
export function pinTier(heat) {
  const t = getHeatTier(Number(heat) || 0);
  return t === 'blueFlame' ? 'top' : t === 'flame' ? 'flame' : t === 'orange' ? 'mid' : 'low';
}

/** How many px one pin unit is. */
export function pinScale(size, heat, selected = false) {
  return (size / 18) * TIERS[pinTier(heat)].scale * (selected ? SELECTED_SCALE : 1);
}

/** The badge, measured from the post's place (its centre, 0): { headY, headR, top }.
 * `top` is the highest point of the pin itself (the flame if it has one), negative. */
export function pinGeometry(size, heat, selected = false) {
  const s = pinScale(size, heat, selected);
  const flame = TIERS[pinTier(heat)].flame;
  return { headY: HEAD_Y * s, headR: HEAD_R * s, top: (flame ? FLAME_TOP : HEAD_Y - HEAD_R - 0.7) * s };
}

/** How far above its place a pin reaches (negative px): the flame, or the
 * 「あなた」 tag over yours. What an island's name has to clear. `selected`: the
 * open pin is bigger and hops LIFT up, so it reaches higher. */
export function pinReach(size, heat, yours = false, selected = false) {
  const geo = pinGeometry(size, heat, selected);
  const top = selected ? geo.top - LIFT * pinScale(size, heat, true) : geo.top;
  return yours ? top - TAG_RISE * (size / 18) : top;
}

/** Which of the cached flame pictures a time falls on (0 when still / not a flame). */
export function pinFrame(heat, time, phase = 0) {
  const spec = TIERS[pinTier(heat)];
  if (!spec.flame || time == null) return 0;
  const u = (((time / spec.period + phase / TAU) % 1) + 1) % 1;
  return Math.floor(u * FLAME_STEPS) % FLAME_STEPS;
}

/** The key one sprite is cached under. Only what changes the picture is in it. */
export function pinSpriteKey({ dpr, tier, frame, size, gold, selected, initial, face = null }) {
  // `face` is the avatars.js faceKey (null: show the initial); the initial only counts without one.
  const look = face ? `f:${face}` : `i:${initial}`;
  return `p|${dpr}|${tier}|${frame}|${size}|${gold ? 1 : 0}|${selected ? 1 : 0}|${look}`;
}

// ---------------------------------------------------------------- the sprite cache

const sprites = new Map();
const glows = new Map();

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

/** The canvas scale in 0.25 steps (as buildings.js does), so a pin that is
 * scaled during its landing animation does not paint a new picture every frame. */
function dprOf(ctx) {
  let a = 1;
  try { a = ctx.getTransform().a; } catch { a = 1; }
  if (!(a > 0)) a = 1;
  return Math.min(4, Math.max(0.5, Math.round(a * 4) / 4));
}

/** A cached picture: paint(c) draws with its origin at (ax, ay) in CSS px. */
function sprite(key, w, h, ax, ay, dpr, paint) {
  let entry = sprites.get(key);
  if (entry) return entry;
  try {
    const canvas = makeCanvas(Math.max(1, Math.ceil(w * dpr)), Math.max(1, Math.ceil(h * dpr)));
    const c = canvas.getContext('2d');
    if (!c) return null;
    c.setTransform(dpr, 0, 0, dpr, ax * dpr, ay * dpr);
    paint(c);
    entry = { canvas, w: canvas.width / dpr, h: canvas.height / dpr, ax, ay };
  } catch {
    return null;
  }
  if (sprites.size >= SPRITE_LIMIT) sprites.clear();
  sprites.set(key, entry);
  return entry;
}

function stamp(ctx, entry, x, y) {
  ctx.drawImage(entry.canvas, x - entry.ax, y - entry.ay, entry.w, entry.h);
}

/** A soft round glow of one colour (a radial gradient, 64px), for stretching. */
function glowOf(color) {
  let entry = glows.get(color);
  if (entry) return entry;
  const canvas = makeCanvas(64, 64);
  const c = canvas.getContext('2d');
  c.fillStyle = color;
  c.fillRect(0, 0, 64, 64);
  // Fade only the opacity, so the colour stays pure to the edge.
  const mask = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(0.35, 'rgba(0,0,0,0.75)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  c.globalCompositeOperation = 'destination-in';
  c.fillStyle = mask;
  c.fillRect(0, 0, 64, 64);
  glows.set(color, canvas);
  return canvas;
}

/** A soft blot centred at (x, y), rx/ry wide, at this opacity. */
function paintGlow(ctx, color, x, y, rx, ry, alpha) {
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * Math.min(1, alpha);
  ctx.drawImage(glowOf(color), x - rx, y - ry, rx * 2, ry * 2);
  ctx.globalAlpha = prev;
}

// ---------------------------------------------------------------- shapes

/** The i-th (fractional) flame: the 4 key shapes blended round a loop. */
function flameParams(frame) {
  const pos = (frame / FLAME_STEPS) * FLAME_FRAMES.length;
  const i = Math.floor(pos) % FLAME_FRAMES.length;
  const j = (i + 1) % FLAME_FRAMES.length;
  const f = pos - Math.floor(pos);
  return FLAME_FRAMES[i].map((lobe, k) => lobe.map((v, m) => v + (FLAME_FRAMES[j][k][m] - v) * f));
}

/** Add a flame's round lobes to the current path (after beginPath). */
function addLobes(c, frame) {
  for (const [x, top, w] of flameParams(frame)) {
    const cy = (top + LOBE_BOTTOM) / 2;
    c.moveTo(x + w, cy);
    c.ellipse(x, cy, w, (LOBE_BOTTOM - top) / 2, 0, 0, TAU);
  }
}

/** Trace the round badge, with its flame's lobes when `frame` is given. */
function tracePin(c, frame) {
  c.beginPath();
  c.moveTo(HEAD_R, 0);
  c.arc(0, 0, HEAD_R, 0, TAU);
  if (frame != null) addLobes(c, frame);
}

/** A 4-pointed star of radius 3 at the origin. */
function traceStar(c) {
  c.beginPath();
  c.moveTo(0, -3);
  c.bezierCurveTo(0.4, -0.6, 0.6, -0.4, 3, 0);
  c.bezierCurveTo(0.6, 0.4, 0.4, 0.6, 0, 3);
  c.bezierCurveTo(-0.4, 0.6, -0.6, 0.4, -3, 0);
  c.bezierCurveTo(-0.6, -0.4, -0.4, -0.6, 0, -3);
  c.closePath();
}

/** Fill colours (top to bottom stops) and the letter's outline for a tier. */
function fillOf(tier) {
  if (tier === 'low') return { stops: [[0, lighten(PIN.low, 0.28)], [1, darken(PIN.low, 0.16)]], edge: darken(PIN.low, 0.3) };
  if (tier === 'mid') return { stops: [[0, lighten(PIN.mid, 0.30)], [1, darken(PIN.mid, 0.14)]], edge: darken(PIN.mid, 0.3) };
  const { outer, inner, core } = TIERS[tier].colors;
  return {
    stops: [[0, core], [0.30, inner], [0.62, outer], [1, darken(outer, 0.25)]],
    edge: darken(outer, 0.35),
  };
}

/** The still picture of a pin (shadow, flame, badge, rim, letter) at scale s.
 * The open pin's picture has no shadow: it is lifted off the ground, and its
 * shadow is drawn where the ground is (drawPostPin). */
function paintPin(c, tier, frame, s, { gold, selected, initial, face, who }) {
  c.save();
  c.scale(s, s);
  if (!selected) {
    c.fillStyle = 'rgba(11,26,34,0.28)';
    c.beginPath();
    c.ellipse(1.2, GROUND - 0.4, 6.6, 2.2, 0, 0, TAU);
    c.fill();
  }

  const flame = TIERS[tier].flame;
  const { stops, edge } = fillOf(tier);
  // The soft flame behind the badge: round lobes, hot colour at the tips.
  if (flame) {
    const top = Math.min(...flameParams(frame).map((lobe) => lobe[1]));
    const fire = c.createLinearGradient(0, top, 0, LOBE_BOTTOM + 6);
    fire.addColorStop(0, stops[0][1]);
    fire.addColorStop(0.35, stops[1][1]);
    fire.addColorStop(1, stops[2][1]);
    c.beginPath();
    addLobes(c, frame);
    c.fillStyle = fire;
    c.fill();
  }
  const body = c.createLinearGradient(0, -HEAD_R, 0, HEAD_R);
  for (const [at, color] of stops) body.addColorStop(at, color);
  c.beginPath();
  c.arc(0, 0, HEAD_R, 0, TAU);
  c.fillStyle = body;
  c.fill();
  c.lineJoin = 'round';
  // Every pin has its white rim - without it a pin was hard to pick out on the
  // land (the user, 2026-10-19, after a day without). A recruiting pin's rim is
  // gold, part of its shine. The open one is no longer ringed in white.
  if (!gold) {
    c.strokeStyle = PIN.rim;
    c.lineWidth = selected ? 1.9 : 1.4;
    c.stroke();
  } else {
    const rim = c.createLinearGradient(0, -HEAD_R, 0, HEAD_R);
    rim.addColorStop(0, PIN.gold.light);
    rim.addColorStop(0.45, PIN.gold.main);
    rim.addColorStop(1, PIN.gold.dark);
    c.strokeStyle = rim;
    c.lineWidth = 1.9;
    c.stroke();
  }

  if (face) paintFace(c, who);
  else paintLetter(c, initial, edge);
  c.restore();
}

const FACE_SIZE = 11.2;   // drawFace size: its radius is 0.66 of it, 7.4, inside the rim

/** The writer's face inside the badge, in pin units. */
function paintFace(c, who) {
  c.save();
  // A pale disc under it, so an emoji reads on any heat colour (a photo and the silhouette cover it).
  c.fillStyle = 'rgba(255,255,255,0.88)';
  c.beginPath();
  c.arc(0, 0, FACE_SIZE * 0.66, 0, TAU);
  c.fill();
  drawFace(c, who, 0, 0, FACE_SIZE);
  c.restore();
}

/** The white initial with a dark outline, in pin units. */
function paintLetter(c, initial, edge) {
  c.font = `700 9.5px system-ui, -apple-system, "Segoe UI", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  c.lineJoin = 'round';
  c.lineWidth = 1.6;
  c.strokeStyle = edge;
  c.strokeText(initial, 0, 3.4);
  c.fillStyle = '#FFFFFF';
  c.fillText(initial, 0, 3.4);
}

function firstChar(initial) {
  const chars = Array.from(String(initial == null ? '' : initial).trim());
  return chars.length ? chars[0] : '?';
}

// ---------------------------------------------------------------- drawing

const fract = (v) => ((v % 1) + 1) % 1;
const wave = (t) => 0.5 - 0.5 * Math.cos(TAU * t);   // 0 -> 1 -> 0 over t = 0..1

/** How far the open pin stands off the ground, in pin units (x s), and how it
 * gets there: a little hop past the height and back, over LIFT_S seconds. */
const LIFT = 6;
const LIFT_S = 0.38;

/** 0 (on the ground) .. 1 (lifted), with a small overshoot on the way up.
 * `age` is seconds since the pin was opened; null holds it lifted. */
export function liftShare(age) {
  if (age == null || !(age >= 0)) return 1;
  const t = Math.min(1, age / LIFT_S);
  const k = 1.9;   // how far past the top the hop goes
  return 1 + (k + 1) * (t - 1) ** 3 + k * (t - 1) ** 2;
}

/** Draw a post's pin with its centre at (x, y). Returns { top, headY, headR }:
 * `top` is the pin's highest y (the flame or the "あなた" tag included), and
 * the badge circle (centre headY, radius headR) is for hit tests and chips. */
export function drawPostPin(ctx, x, y, opts = {}) {
  const {
    heat = 0, size = 22, time = null, phase = 0, recruit = false, recruitQuiet = false,
    mine = false, selected = false, night = false, alpha = 1, tag = true, openedFor = null,
  } = opts;
  // A bad size would throw in arc() or poison the hit test with NaN.
  if (!(size > 0)) return { top: y, headY: y, headR: 0 };
  const initial = firstChar(opts.initial);
  const who = opts.face || null;
  const face = who ? faceKey(who) : null;
  const tier = pinTier(heat);
  const spec = TIERS[tier];
  const s = pinScale(size, heat, selected);
  const geo = pinGeometry(size, heat, selected);
  const dpr = dprOf(ctx);
  const live = time != null;
  const gold = recruit || recruitQuiet;
  const sparkle = recruit && live;
  const fr = pinFrame(heat, time, phase);
  const showTag = mine && tag !== false;

  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = prevAlpha * alpha;

  // Motion: a mid pin bobs up and down, a flame pin sways about its centre.
  let bob = 0;
  let angle = 0;
  if (live) {
    if (tier === 'mid') bob = -1.8 * (size / 18) * wave(time / 2.6 + phase / TAU);
    else if (spec.flame) {
      const th = TAU * (time / spec.sway) + phase;
      angle = ((spec.deg * Math.PI) / 180) * (0.78 * Math.sin(th) + 0.22 * Math.sin(2 * th + 1.3));
    }
  }
  // The open pin hops up off the map and stays lifted; its shadow stays on the
  // ground, wider and softer the higher the pin is (2026-10-19, the user chose
  // this over a ring). The lift rides on top of the bob, so all below moves up.
  if (selected) {
    const up = liftShare(openedFor);
    const share = Math.max(0, Math.min(1.2, up));
    paintGlow(ctx, '#0B1A22', x + 1.4 * s, y + (GROUND + 0.4) * s, (7 + 3 * share) * s, (2.3 + 1.1 * share) * s, 0.55 - 0.15 * share);
    bob -= LIFT * s * up;
  }

  // Ring spreading from the foot (yours).
  if (mine) {
    const k = live ? fract(time / 1.8) : 0.35;
    ctx.save();
    ctx.globalAlpha *= 1 - k;
    ctx.strokeStyle = PALETTE.accent;
    ctx.lineWidth = 1.6 * s;
    ctx.beginPath();
    ctx.ellipse(x, y + GROUND * s, (7 + 8 * k) * s, (2.2 + 2.4 * k) * s, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // Soft light behind: night colour, the recruiting gold, the flame's own glow.
  const inner = spec.flame ? spec.colors.inner : null;
  if (night) {
    const base = tier === 'low' ? PIN.low : tier === 'mid' ? PIN.mid : inner;
    paintGlow(ctx, lighten(base, 0.2), x, y + bob + HEAD_Y * s, 22 * s, 22 * s, 0.6);
  }
  if (gold && (sparkle || !live)) {
    const a = live ? 0.2 + 0.4 * wave(time / 1.8 + phase / TAU) : 0.4;
    paintGlow(ctx, '#FFD75E', x, y + bob + HEAD_Y * s, 18 * s, 18 * s, a * 1.4);
  }
  if (spec.flame) {
    const a = live ? 0.25 + 0.3 * wave(time / spec.period + phase / TAU) : 0.4;
    paintGlow(ctx, inner, x, y + bob - 7 * s, (spec.sway < 1.5 ? 17 : 15) * s, (spec.sway < 1.5 ? 21 : 19) * s, a * 1.4);
  }

  // Round sparks floating up off a flame.
  if (live && spec.flame) {
    const d = spec.sway < 1.5 ? 1.2 : 1.5;
    const spots = [[-4, -20], [4, -21], [0, -23]];
    ctx.save();
    ctx.fillStyle = spec.colors.core;
    for (let j = 0; j < spec.sparks; j++) {
      const u = fract((time + phase) / d + j / 2.5);
      const [ex, ey] = spots[j];
      ctx.globalAlpha = prevAlpha * alpha * Math.sin(Math.PI * u);
      ctx.beginPath();
      ctx.arc(x + (ex - 2 * u + 3 * u * u) * s, y + bob + (ey - 13 * u) * s, 1.1 * s, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // The pin itself, swaying about its centre.
  const key = pinSpriteKey({ dpr, tier, frame: fr, size: s, gold, selected, initial, face });
  const padX = 16 * s;
  const padUp = 28 * s;
  const entry = sprite(key, padX * 2, padUp + 15 * s, padX, padUp, dpr,
    (c) => paintPin(c, tier, fr, s, { gold, selected, initial, face, who }));
  ctx.save();
  ctx.translate(x, y + bob);
  if (angle) ctx.rotate(angle);
  if (entry) stamp(ctx, entry, 0, 0);
  else {
    paintPin(ctx, tier, fr, s, { gold, selected, initial, face, who });
  }

  if (sparkle) paintSparkle(ctx, tier, fr, s, time, face ? null : initial);
  ctx.restore();

  let top = y + geo.top + bob;
  if (showTag) {
    ctx.save();
    const ts = size / 18;
    const ty = y + bob + geo.top - 8 * ts;
    ctx.fillStyle = PALETTE.accent;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x - 13 * ts, ty - 6.5 * ts, 26 * ts, 11 * ts, 5.5 * ts)
      : ctx.rect(x - 13 * ts, ty - 6.5 * ts, 26 * ts, 11 * ts);
    ctx.fill();
    ctx.font = `700 ${7 * ts}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('あなた', x, ty + 1.6 * ts);
    top = Math.min(top, ty - 6.5 * ts);
    ctx.restore();
  }

  ctx.globalAlpha = prevAlpha;
  return { top, headY: y + geo.headY + bob, headR: geo.headR };
}

/** The shine band and the stars on a recruiting pin. ctx is already at the badge's centre,
 * rotated, in px; this draws in pin units. */
function paintSparkle(ctx, tier, frame, s, time, initial) {
  ctx.save();
  ctx.scale(s, s);
  // Band: sweeps across in the first 40% of every 2.4s, clipped to the pin's shape.
  const u = fract(time / 2.4);
  if (u < 0.4) {
    tracePin(ctx, TIERS[tier].flame ? frame : null);
    ctx.save();
    ctx.clip();
    const dx = -12 + 32 * (u / 0.4);
    const g = ctx.createLinearGradient(-7 + dx, 0, 2 + dx, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.94)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.globalAlpha *= 0.9;
    ctx.beginPath();
    ctx.moveTo(-3 + dx, -27);
    ctx.lineTo(2 + dx, -27);
    ctx.lineTo(-2 + dx, 11);
    ctx.lineTo(-7 + dx, 11);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // The letter was in the cached picture, under the band: put it back on top
    // (a face is left under the band).
    if (initial != null) paintLetter(ctx, initial, fillOf(tier).edge);
  }
  // Stars: two over the top of the badge, one low on the rim, taking turns.
  const stars = [[-4.5, -6.5, 1.0, '#FFFFFF'], [7.2, -7.5, 1.5, '#FFF3B0'], [5.2, 6.5, 0.8, '#FFFFFF']];
  for (let j = 0; j < stars.length; j++) {
    const k = fract((time - (j * 0.7 - (j === 1 ? 0.05 : 0))) / 2.1);
    const grow = k < 0.18 ? k / 0.18 : k < 0.36 ? 1 - (k - 0.18) / 0.18 : 0;
    if (grow <= 0.01) continue;
    const [sx, sy, sc, color] = stars[j];
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(sc * grow, sc * grow);
    traceStar(ctx);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/** A small round mark for the people list of an island seen from afar:
 * (x, y) is the centre. */
export function drawMiniPin(ctx, x, y, { heat = 0, initial = '', size = 16, mine = false, alpha = 1 } = {}) {
  if (!(size > 0)) return;
  const dpr = dprOf(ctx);
  const letter = firstChar(initial);
  const color = pinColor(heat);
  const pad = 2;
  const side = size + pad * 2;
  const key = `m|${dpr}|${color}|${size}|${mine ? 1 : 0}|${letter}`;
  const entry = sprite(key, side, side, side / 2, side / 2, dpr, (c) => {
    const r = size / 2;
    const rim = Math.max(1.2, size / 10);
    c.beginPath();
    c.arc(0, 0, r - rim / 2, 0, TAU);
    c.fillStyle = color;
    c.fill();
    c.lineWidth = rim;
    c.strokeStyle = mine ? PALETTE.accent : '#FFFFFF';
    c.stroke();
    c.font = `700 ${size * 0.55}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.lineWidth = Math.max(1, size / 10);
    c.strokeStyle = darken(color, 0.3);
    c.strokeText(letter, 0, size * 0.04);
    c.fillStyle = '#FFFFFF';
    c.fillText(letter, 0, size * 0.04);
  });
  if (!entry) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  stamp(ctx, entry, x, y);
  ctx.globalAlpha = prev;
}

/** For tests: forget every cached picture. */
export function clearPinCache() {
  sprites.clear();
  glows.clear();
}
