// Islands are not drawn with a compass. Each post's cone of ground reaches a
// little less far in some directions than in others - a few slow waves around
// the circle, fixed by the post's id - so a lone post makes an island with bays
// and headlands instead of a perfect disc, and it is the same island every time
// (2026-10-13).
//
// The reach only ever shrinks (by COAST_DEPTH at most), never grows: which posts
// share an island is still decided by the full circles (landmass.js,
// core/energy.py), and land must not visibly join two islands the server keeps
// apart. How deep, and which waves, come from /api/config (core/energy.py, which
// draws the same shapes for the server's coarse grid); tests on both sides pin
// the hash and the sum to the same numbers.

import { config, energyOf, radiusOf } from '../config.js';

/** FNV-1a over the UTF-8 bytes: the same 32 bits as core/energy.py. */
export function hash32(text) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const shapes = new Map();

/** A post's coastline: per harmonic k, cos and sin weights (`a[k]`, `b[k]`). */
export function coastOf(post) {
  const key = String(post.id ?? `${post.x},${post.y}`);
  let shape = shapes.get(key);
  if (shape) return shape;
  const { coast_depth: depth = 0, coast_waves: waves = [] } = config().energy;
  const top = Math.max(1, ...waves.map(([k]) => k));
  const a = new Float64Array(top + 1);
  const b = new Float64Array(top + 1);
  let norm = 0;
  waves.forEach(([k, weight]) => {
    const h = hash32(`${key}:${k}`);
    const amp = weight * (0.5 + 0.5 * ((h & 0xffff) / 65536));
    const phase = ((h >>> 16) / 65536) * Math.PI * 2;
    a[k] = amp * Math.cos(phase);
    b[k] = amp * Math.sin(phase);
    norm += amp;
  });
  shape = { a, b, norm, top, depth };
  if (shapes.size > 5000) shapes.clear();
  shapes.set(key, shape);
  return shape;
}

/** How much of its full radius the cone reaches towards (dx, dy), `distance`
 * being their length: between 1 - depth and 1. The angle's multiples come from
 * the recurrence rather than from trig, since this runs per pixel. */
export function reachAt(shape, dx, dy, distance) {
  if (!(distance > 0) || !(shape.norm > 0)) return 1;
  const c = dx / distance;
  const s = dy / distance;
  let ck = c;
  let sk = s;
  let wave = shape.a[1] * ck + shape.b[1] * sk;
  for (let k = 2; k <= shape.top; k += 1) {
    const next = ck * c - sk * s;
    sk = sk * c + ck * s;
    ck = next;
    wave += shape.a[k] * ck + shape.b[k] * sk;
  }
  return 1 - shape.depth * (1 + wave / shape.norm) / 2;
}

/** One post's share of the ground at world (x, y), as terrain.js adds it up. */
export function groundOf(post, x, y) {
  const radius = radiusOf(post);
  const energy = energyOf(post);
  if (!(radius > 0) || !(energy > 0)) return 0;
  const dx = x - post.x;
  const dy = y - post.y;
  const distance = Math.hypot(dx, dy);
  if (distance >= radius) return 0;
  const reach = radius * reachAt(coastOf(post), dx, dy, distance);
  return distance < reach ? energy * (1 - distance / reach) : 0;
}
