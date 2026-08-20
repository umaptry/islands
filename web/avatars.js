// Avatars: one emoji on a pastel gradient disc.
// Fully offline — no image requests, no external avatar service, and each
// avatar stays legible at the ~18px the map view draws it at.

export const EMOJI = [
  '🐱', '🐶', '🦊', '🐻', '🐼', '🐨',
  '🦁', '🐯', '🐸', '🐧', '🦉', '🦖',
  '🐙', '🦀', '🐝', '🦋', '🌵', '🍄',
  '🌻', '🍊', '🍜', '☕', '🎧', '🎸',
  '📷', '🚲', '⚽', '🎲', '🔭', '🧵',
];

const GRADIENTS = [
  ['#fda4af', '#fb7185'], ['#c4b5fd', '#a78bfa'], ['#7dd3fc', '#38bdf8'],
  ['#6ee7b7', '#34d399'], ['#fcd34d', '#fbbf24'], ['#f9a8d4', '#f472b6'],
  ['#a5b4fc', '#818cf8'], ['#86efac', '#4ade80'], ['#fdba74', '#fb923c'],
  ['#67e8f9', '#22d3ee'],
];

/** Stable id -> {emoji, from, to}. Ids look like "12" (index into EMOJI). */
export function avatarFor(iconId) {
  const index = Math.abs(parseInt(iconId, 10) || 0) % EMOJI.length;
  const gradient = GRADIENTS[index % GRADIENTS.length];
  return { emoji: EMOJI[index], from: gradient[0], to: gradient[1] };
}

export function avatarCss(iconId) {
  const { from, to } = avatarFor(iconId);
  return `linear-gradient(135deg, ${from}, ${to})`;
}

/** Fill a DOM element with the avatar look. */
export function paintAvatar(element, iconId) {
  const { emoji } = avatarFor(iconId);
  element.style.background = avatarCss(iconId);
  element.textContent = emoji;
}

const gradientCache = new Map();

/** Draw the avatar onto a canvas at (x, y) with the given diameter. */
export function drawAvatar(ctx, iconId, x, y, size, options = {}) {
  const { emoji, from, to } = avatarFor(iconId);
  const radius = size / 2;

  const key = `${iconId}:${Math.round(size)}`;
  let gradient = gradientCache.get(key);
  if (!gradient) {
    gradient = ctx.createLinearGradient(-radius, -radius, radius, radius);
    gradient.addColorStop(0, from);
    gradient.addColorStop(1, to);
    gradientCache.set(key, gradient);
  }

  ctx.save();
  ctx.translate(x, y);

  if (options.glow) {
    ctx.shadowColor = options.glow;
    ctx.shadowBlur = size * 0.55;
  }
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  if (options.ring) {
    ctx.strokeStyle = options.ring;
    ctx.lineWidth = Math.max(1.5, size * 0.07);
    ctx.stroke();
  }

  ctx.font = `${Math.round(size * 0.56)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Emoji glyphs sit slightly high in their em box on most platforms.
  ctx.fillText(emoji, 0, size * 0.04);
  ctx.restore();
}
