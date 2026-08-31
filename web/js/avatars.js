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

const EMOJI_FONT =
  '"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", ' +
  '"Twemoji Mozilla", "EmojiOne Color", "Android Emoji", sans-serif';

/** Can this device actually paint an emoji onto a canvas?
 *
 * Some mobile browsers - and any device without a colour emoji font - paint
 * nothing at all, which leaves the map looking empty rather than looking wrong.
 * Probed once, lazily, because the answer cannot change within a session, and
 * used to pick a fallback that always draws something.
 */
let emojiSupported = null;

function canDrawEmoji() {
  if (emojiSupported !== null) return emojiSupported;
  try {
    const probe = document.createElement('canvas');
    probe.width = 32;
    probe.height = 32;
    const context = probe.getContext('2d');
    context.font = `20px ${EMOJI_FONT}`;
    context.textBaseline = 'middle';
    context.fillText(EMOJI[0], 4, 16);
    // A glyph that rendered leaves non-transparent pixels. measureText alone is
    // not enough: a missing-glyph box still reports a width.
    const pixels = context.getImageData(0, 0, 32, 32).data;
    let painted = false;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] !== 0) { painted = true; break; }
    }
    emojiSupported = painted;
  } catch {
    // A blocked getImageData must not be read as "this device is broken".
    emojiSupported = true;
  }
  return emojiSupported;
}

/** The face on its own: no disc, no ring, no shadow.
 *
 * Every post on the map is an island with a face standing on it, so a coloured
 * disc behind the face only competed with the land. Keeping this path free of
 * clip(), gradients and shadows also removes every canvas feature that a phone
 * browser might quietly decline to render.
 */
export function drawFace(ctx, iconId, x, y, size, fallbackColor) {
  const { emoji, to } = avatarFor(iconId);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (canDrawEmoji()) {
    // Never let rounding produce a 0px font, which draws nothing at all.
    ctx.font = `${Math.max(9, Math.round(size))}px ${EMOJI_FONT}`;
    ctx.fillText(emoji, x, y + size * 0.04);
  } else {
    ctx.fillStyle = fallbackColor || to;
    ctx.beginPath();
    ctx.arc(x, y, size * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, .9)';
    ctx.lineWidth = Math.max(1, size * 0.07);
    ctx.stroke();
  }
  ctx.restore();
}
