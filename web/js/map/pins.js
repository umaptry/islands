// The post pin: a teardrop with the writer's initial, drawn on the map canvas.
// Its look follows the heat in the four steps of heat.js (see PIN in palette.js):
// still, bobbing, flames, blue flames. A recruiting pin sparkles itself.
//
// Shapes and fills (each flame frame too) are painted once into small offscreen
// canvases and stamped with drawImage; only the sway, the glows, the shine band,
// the stars and the rings are drawn per frame, and those are cheap. With
// `time` null nothing but the stamp is drawn (a still picture).
//
// Everything is in "pin units": the design was drawn with a head of radius 9 on a
// tip at (0,0), so one unit = size / 18 px (times the heat tier's scale).

import { PALETTE, PIN, mixHex, pinColor } from './palette.js';
import { getHeatTier } from '../heat.js';

export { pinColor };

const SPRITE_LIMIT = 800;
const FLAME_STEPS = 8;          // frames cached per flame cycle (smooth between the 4 key shapes)
const TAU = Math.PI * 2;

// The drop (tip at 0,0, head centre 17 up, radius 9) and the 4 key shapes of a
// flame head: [left tip x, y, centre tip x, y, right tip x, y].
const DROP = 'M0,0 C-3,-7 -9,-11 -9,-17 A9,9 0 1 1 9,-17 C9,-11 3,-7 0,0 Z';
const FLAME_FRAMES = [
  [-5.5, -29.0, 0.5, -36.0, 6.0, -30.5],
  [-6.5, -31.0, -1.0, -34.0, 5.0, -28.5],
  [-5.0, -28.0, 1.5, -37.5, 6.5, -31.5],
  [-6.0, -30.5, 0.0, -35.0, 5.5, -29.5],
];
const HEAD_Y = -17;
const HEAD_R = 9;

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

/** Where the head is, measured from the tip (0): { headY, headR, top }. `top` is
 * the highest point of the pin itself (the flame's tip if it has one), negative. */
export function pinGeometry(size, heat, selected = false) {
  const s = pinScale(size, heat, selected);
  const flame = TIERS[pinTier(heat)].flame;
  return { headY: HEAD_Y * s, headR: HEAD_R * s, top: (flame ? -38 : HEAD_Y - HEAD_R - 0.7) * s };
}

/** Which of the cached flame pictures a time falls on (0 when still / not a flame). */
export function pinFrame(heat, time, phase = 0) {
  const spec = TIERS[pinTier(heat)];
  if (!spec.flame || time == null) return 0;
  const u = (((time / spec.period + phase / TAU) % 1) + 1) % 1;
  return Math.floor(u * FLAME_STEPS) % FLAME_STEPS;
}

/** The key one sprite is cached under. Only what changes the picture is in it. */
export function pinSpriteKey({ dpr, tier, frame, size, gold, selected, initial }) {
  return `p|${dpr}|${tier}|${frame}|${size}|${gold ? 1 : 0}|${selected ? 1 : 0}|${initial}`;
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

/** The i-th (fractional) flame head: the 4 key shapes blended round a loop. */
function flameParams(frame) {
  const pos = (frame / FLAME_STEPS) * FLAME_FRAMES.length;
  const i = Math.floor(pos) % FLAME_FRAMES.length;
  const j = (i + 1) % FLAME_FRAMES.length;
  const f = pos - Math.floor(pos);
  return FLAME_FRAMES[i].map((v, k) => v + (FLAME_FRAMES[j][k] - v) * f);
}

/** Trace the drop, or the drop with a flame head, into ctx's current path. */
function tracePin(c, frame) {
  c.beginPath();
  if (frame == null) {
    c.moveTo(0, 0);
    c.bezierCurveTo(-3, -7, -9, -11, -9, -17);
    c.arc(0, -17, 9, Math.PI, 0, false);
    c.bezierCurveTo(9, -11, 3, -7, 0, 0);
    c.closePath();
    return;
  }
  const [lx, ly, cx, cy, rx, ry] = flameParams(frame);
  c.moveTo(0, 0);
  c.bezierCurveTo(-3, -7, -9, -11, -9, -17);
  c.bezierCurveTo(-9, -22, lx - 2, ly + 5, lx, ly);
  c.bezierCurveTo(lx + 1.5, ly + 3, -2.5, -25, -1.5, -26);
  c.bezierCurveTo(-1.5, -29, cx - 1.5, cy + 3, cx, cy);
  c.bezierCurveTo(cx + 1.5, cy + 4, 3, -28, 2.8, -25.5);
  c.bezierCurveTo(3.8, -26.5, rx - 1, ry + 2, rx, ry);
  c.bezierCurveTo(rx + 2.5, ry + 5, 9, -21, 9, -17);
  c.bezierCurveTo(9, -11, 3, -7, 0, 0);
  c.closePath();
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

/** The still picture of a pin (shadow, body, rim, letter) at scale s. The
 * open pin's picture has no shadow: it is lifted off the ground, and its
 * shadow is drawn where the ground is (drawPostPin). */
function paintPin(c, tier, frame, s, { gold, selected, initial }) {
  c.save();
  c.scale(s, s);
  if (!selected) {
    c.fillStyle = 'rgba(11,26,34,0.28)';
    c.beginPath();
    c.ellipse(1.2, 0.6, 4.2, 1.7, 0, 0, TAU);
    c.fill();
  }

  const flame = TIERS[tier].flame;
  const shapeFrame = flame ? frame : null;
  const top = flame ? Math.min(...flameParams(frame).filter((_, k) => k % 2 === 1)) : -26;
  const { stops, edge } = fillOf(tier);
  const body = c.createLinearGradient(0, top, 0, 0);
  for (const [at, color] of stops) body.addColorStop(at, color);
  tracePin(c, shapeFrame);
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
    const rim = c.createLinearGradient(0, top, 0, 0);
    rim.addColorStop(0, PIN.gold.light);
    rim.addColorStop(0.45, PIN.gold.main);
    rim.addColorStop(1, PIN.gold.dark);
    c.strokeStyle = rim;
    c.lineWidth = 1.9;
    c.stroke();
  }

  paintLetter(c, initial, edge);
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
  c.strokeText(initial, 0, -13.6);
  c.fillStyle = '#FFFFFF';
  c.fillText(initial, 0, -13.6);
}

function firstChar(initial) {
  const chars = Array.from(String(initial == null ? '' : initial).trim());
  return chars.length ? chars[0] : '?';
}

// ---------------------------------------------------------------- drawing

const fract = (v) => ((v % 1) + 1) % 1;
const wave = (t) => 0.5 - 0.5 * Math.cos(TAU * t);   // 0 -> 1 -> 0 over t = 0..1

/** Draw a post's pin with its tip at (x, y). Returns { top, headY, headR }:
 * `top` is the pin's highest y (the flame tip or the "あなた" tag included), and
 * the head circle is for hit tests and chips. See the file header for opts. */
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

export function drawPostPin(ctx, x, y, opts = {}) {
  const {
    heat = 0, size = 22, time = null, phase = 0, recruit = false, recruitQuiet = false,
    mine = false, selected = false, night = false, alpha = 1, tag = true, openedFor = null,
  } = opts;
  // A bad size would throw in arc() or poison the hit test with NaN.
  if (!(size > 0)) return { top: y, headY: y, headR: 0 };
  const initial = firstChar(opts.initial);
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

  // Motion: a mid pin bobs up and down, a flame pin sways about its tip.
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
    paintGlow(ctx, '#0B1A22', x + 1.4 * s, y + 0.8 * s, (4.6 + 2.6 * share) * s, (1.9 + 0.9 * share) * s, 0.55 - 0.15 * share);
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
    ctx.ellipse(x, y, (4 + 8 * k) * s, (1.6 + 3.2 * k) * s, 0, 0, TAU);
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
    paintGlow(ctx, '#FFD75E', x, y + bob + HEAD_Y * s, 18 * s, 19 * s, a * 1.4);
  }
  if (spec.flame) {
    const a = live ? 0.25 + 0.3 * wave(time / spec.period + phase / TAU) : 0.4;
    paintGlow(ctx, inner, x, y + bob - 22 * s, (spec.sway < 1.5 ? 17 : 15) * s, (spec.sway < 1.5 ? 24 : 21) * s, a * 1.4);
  }

  // Sparks rising off a flame.
  if (live && spec.flame) {
    const d = spec.sway < 1.5 ? 1.2 : 1.5;
    const spots = [[-3, -30], [3, -31], [0, -33]];
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

  // The pin itself, swaying about its tip.
  const key = pinSpriteKey({ dpr, tier, frame: fr, size: s, gold, selected, initial });
  const padX = 16 * s;
  const padUp = 42 * s;
  const entry = sprite(key, padX * 2, padUp + 5 * s, padX, padUp, dpr,
    (c) => paintPin(c, tier, fr, s, { gold, selected, initial }));
  ctx.save();
  ctx.translate(x, y + bob);
  if (angle) ctx.rotate(angle);
  if (entry) stamp(ctx, entry, 0, 0);
  else {
    paintPin(ctx, tier, fr, s, { gold, selected, initial });
  }

  if (sparkle) paintSparkle(ctx, tier, fr, s, time, initial);
  ctx.restore();

  let top = y + geo.top + bob;
  if (showTag) {
    ctx.save();
    const ts = size / 18;
    const ty = y + bob - (spec.flame ? 44 : 33) * s;
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

/** The shine band and the stars on a recruiting pin. ctx is already at the tip,
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
    ctx.moveTo(-3 + dx, -38);
    ctx.lineTo(2 + dx, -38);
    ctx.lineTo(-2 + dx, 2);
    ctx.lineTo(-7 + dx, 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // The letter was in the cached picture, under the band: put it back on top.
    paintLetter(ctx, initial, fillOf(tier).edge);
  }
  // Stars: two over the head, one on the rim, taking turns.
  const stars = [[-4.5, -21.5, 1.0, '#FFFFFF'], [7.5, -25, 1.5, '#FFF3B0'], [4.5, -11.5, 0.8, '#FFFFFF']];
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
