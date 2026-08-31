// Everything the server decided, fetched once before anything draws.
//
// The energy numbers in particular are NOT duplicated here. They are islands'
// constants - (30 + e * 0.45) * (2/3), the biome thresholds, the settlement
// tiers - and the server names the landmasses with them while the browser
// paints the ground with them. Two copies would agree right up until somebody
// changed one, and the symptom would be a label sitting in the sea.

let cache = null;

export async function loadConfig() {
  if (cache) return cache;
  const response = await fetch('/api/config', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('設定を読み込めませんでした');
  cache = await response.json();
  return cache;
}

/** Synchronous access after loadConfig() has resolved once. */
export function config() {
  if (!cache) throw new Error('loadConfig() before config()');
  return cache;
}

export const isLocal = () => config().mode === 'local';

// --- derived helpers, so no screen has to remember the shape of the payload --

export function energyOf(post) {
  if (post.energy !== undefined && post.energy !== null) return Number(post.energy);
  const { energy_per_interaction: per } = config().energy;
  return Number(post.motivation || 0) + interactionsOf(post) * per;
}

export function interactionsOf(post) {
  return (post.like_count || 0) + (post.help_count || 0)
    + (post.join_count || 0) + (post.comment_count || 0);
}

/** islands' influence radius, in world units. */
export function radiusOf(post) {
  const { radius_base: base, radius_scale: scale, radius_trim: trim } = config().energy;
  return (base + energyOf(post) * scale) * trim;
}

/** islands' staged settlement glyph. */
export function glyphOf(post) {
  const count = interactionsOf(post);
  for (const [threshold, glyph] of config().energy.plot_tiers) {
    if (count >= threshold) return glyph;
  }
  return '🪵';
}

export function islandColor(clusterId) {
  const colors = config().island_colors;
  return colors[Math.abs(Number(clusterId) || 0) % colors.length];
}
