// Avatars: one face on a coloured disc.
//
// Fully offline — no image requests, no external avatar service, and each
// avatar stays legible at the ~26px the map view draws it at.
//
// Faces only, and single-codepoint only. Multi-codepoint emoji (ZWJ sequences
// like 🧑‍🦰, or skin-tone modifiers) fall back to two separate glyphs on the
// fonts that lack them, which looks broken inside a circle. Every entry below
// is one codepoint that ships in Apple Color Emoji, Segoe UI Emoji and Noto
// Color Emoji, and every one is a head-on face rather than a whole body.

export const EMOJI = [
  '🐶', '🐱', '🐭', '🐹', '🐰',
  '🦊', '🐻', '🐼', '🐨', '🐯',
  '🦁', '🐮', '🐷', '🐸', '🐵',
  '🐴', '🐺', '🐗', '🦄', '🐲',
  '🐔', '🐧', '🐤', '🦉', '🦝',
  '🧑', '🧒', '🧓', '👶', '😎',
];

// Deeper than pastels: these sit behind a face on a white page, so they need
// enough weight to read as a disc rather than a smudge.
const GRADIENTS = [
  ['#fb7185', '#e11d48'], ['#a78bfa', '#7c3aed'], ['#38bdf8', '#0284c7'],
  ['#34d399', '#059669'], ['#fbbf24', '#d97706'], ['#f472b6', '#db2777'],
  ['#818cf8', '#4f46e5'], ['#4ade80', '#16a34a'], ['#fb923c', '#ea580c'],
  ['#2dd4bf', '#0d9488'],
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

  // Clip to the disc before drawing the face. Emoji glyphs carry a lot of
  // internal padding, so 0.74 of the diameter reads as a close-up rather than a
  // small badge, and the clip keeps the silhouette round on the fonts that draw
  // the glyph wider than its em box.
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.font = `${Math.round(size * 0.74)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Emoji glyphs sit slightly high in their em box on most platforms.
  ctx.fillText(emoji, 0, size * 0.03);
  ctx.restore();
}
