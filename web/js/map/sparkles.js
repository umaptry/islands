// The little glints round an island that has something new (drawn by index.js
// when zoomed out). Where they stand comes from the island's key alone, so they
// never jump between frames; only their twinkle moves.

const TAU = Math.PI * 2;

function hashOf(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 3 to 5 glints for an island: angle round its middle, `ring` (how far out, in
 * island radii, around the edge), `size` (0.7 - 1.3) and a twinkle `phase` (0 - 1). */
export function sparkleSpots(key) {
  const next = rng(hashOf(key));
  const count = 3 + Math.floor(next() * 3);
  const turn = next() * TAU;
  const spots = [];
  for (let i = 0; i < count; i++) {
    // Evenly spread round the island with some wobble, so they do not bunch up.
    const angle = turn + ((i + 0.2 + next() * 0.6) / count) * TAU;
    spots.push({ angle, ring: 0.85 + next() * 0.3, size: 0.7 + next() * 0.6, phase: next() });
  }
  return spots;
}

/** How lit a glint is (0 - 1) at a time in seconds. `time` null: a still glint. */
export function sparkleLevel(time, phase, period = 2.4) {
  if (time == null) return 0.85;
  const u = (((time / period + phase) % 1) + 1) % 1;
  // Faintly lit, with a bright swell for a third of each cycle.
  return 0.12 + 0.88 * (u < 0.35 ? Math.sin((u / 0.35) * Math.PI) : 0);
}
