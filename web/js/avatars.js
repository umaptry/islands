// Avatars: a photo, or - for people who signed up before photos were the only
// choice - one emoji face on a coloured disc.
//
// New accounts pick a photo or nothing (the モック② decision). Nothing is a
// person-shaped silhouette, and is told apart from the old emoji icons by the
// icon_id: an emoji icon is a number (an index into EMOJI), anything else - the
// PHOTO_ICON marker new accounts save - is not. accounts.icon_id is free text,
// so no database change is needed, and a person who still has an emoji keeps it
// until they set a photo.
//
// No external avatar service; each avatar stays legible at the ~26px the map
// view draws it at.
//
// Faces only, and single-codepoint only. Multi-codepoint emoji (ZWJ sequences
// like 🧑‍🦰, or skin-tone modifiers) fall back to two separate glyphs on the
// fonts that lack them, which looks broken inside a circle. Every entry below
// is one codepoint that ships in Apple Color Emoji, Segoe UI Emoji and Noto
// Color Emoji, and every one is a head-on face rather than a whole body.

import { data } from './net.js';

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

/** What a new account saves as icon_id: "no emoji, the photo is the icon". */
export const PHOTO_ICON = 'photo';

/** Whether this icon_id is one of the old emoji faces ("12"), not the marker. */
export function hasEmoji(iconId) {
  return /^\d+$/.test(String(iconId ?? '').trim());
}

/** Stable id -> {emoji, from, to}. Ids look like "12" (index into EMOJI). */
export function avatarFor(iconId) {
  const index = Math.abs(parseInt(iconId, 10) || 0) % EMOJI.length;
  const gradient = GRADIENTS[index % GRADIENTS.length];
  return { emoji: EMOJI[index], from: gradient[0], to: gradient[1] };
}

/** The silhouette shown while somebody has no photo (viewBox 0 0 24 24). */
export const SILHOUETTE_BG = '#d9dde3';
export const SILHOUETTE_FG = '#9aa3ae';
export const SILHOUETTE_SVG =
  `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true" focusable="false">`
  + `<rect width="24" height="24" fill="${SILHOUETTE_BG}"/>`
  + `<circle cx="12" cy="9.2" r="4.1" fill="${SILHOUETTE_FG}"/>`
  + `<path d="M3.5 24c0-5 3.8-8.3 8.5-8.3s8.5 3.3 8.5 8.3z" fill="${SILHOUETTE_FG}"/></svg>`;

export function avatarCss(iconId) {
  const { from, to } = avatarFor(iconId);
  return `linear-gradient(135deg, ${from}, ${to})`;
}

/** Fill a DOM element with the avatar look. */
export function paintAvatar(element, iconId) {
  if (!hasEmoji(iconId)) {
    element.style.background = SILHOUETTE_BG;
    element.innerHTML = SILHOUETTE_SVG;   // a literal, never user text
    return;
  }
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

// ---------------------------------------------------------------- photos on a canvas

const photos = new Map();   // storage path -> { img, ready }

/** The loaded photo for a person, or null while it is still coming.
 *
 * The map draws every frame (or on demand), and an <img> that has not decoded
 * yet draws nothing. The first ask starts the load and a later draw finds it
 * ready; 'avatar:loaded' tells a map that only redraws on change to do so.
 */
function photoFor(path) {
  if (!path) return null;
  let entry = photos.get(path);
  if (!entry) {
    const url = data.imageUrl(path);
    if (!url) return null;
    entry = { img: new Image(), ready: false, failed: false };
    entry.img.onload = () => {
      entry.ready = true;
      document.dispatchEvent(new CustomEvent('avatar:loaded', { detail: { path } }));
    };
    entry.img.onerror = () => { entry.failed = true; };
    entry.img.src = url;
    photos.set(path, entry);
  }
  return entry.ready ? entry.img : null;
}

/** What drawFace would paint for somebody right now, as a short key, or null while
 * their photo is still coming (a caller that has a fallback shows that instead,
 * and finds the key changed once 'avatar:loaded' has fired). The key changes
 * whenever the picture does, so it can name a cached sprite. */
export function faceKey(who) {
  const person = who && typeof who === 'object' ? who : { icon_id: who };
  const path = person.avatar_path;
  if (path) {
    if (photoFor(path)) return `photo:${path}`;
    const entry = photos.get(path);
    if (!entry || !entry.failed) return null;
  }
  if (!hasEmoji(person.icon_id)) return 'silhouette';
  return `emoji:${Math.abs(parseInt(person.icon_id, 10) || 0) % EMOJI.length}`;
}

/** The person-shaped silhouette on a canvas, inside a disc of radius `r`. */
function drawSilhouette(ctx, x, y, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = SILHOUETTE_BG;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.fillStyle = SILHOUETTE_FG;
  ctx.beginPath();
  ctx.arc(x, y - r * 0.14, r * 0.34, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.92, r * 0.72, r * 0.62, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The face on its own: no disc behind it.
 *
 * `who` is a person ({icon_id, avatar_path}) or, as the map has always passed
 * it, just the icon_id. A person with a photo gets the photo, round; a person
 * with an emoji icon gets the emoji; anybody else gets the silhouette. Every
 * post on the map is an island with a face standing on it, so a coloured disc
 * behind the face only competed with the land. Keeping the emoji path free of
 * clip(), gradients and shadows also removes every canvas feature that a phone
 * browser might quietly decline to render.
 */
export function drawFace(ctx, who, x, y, size, fallbackColor) {
  const person = who && typeof who === 'object' ? who : { icon_id: who };
  const r = size * 0.66;
  const photo = photoFor(person.avatar_path);
  if (photo) {
    const side = Math.min(photo.naturalWidth, photo.naturalHeight) || 1;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(photo,
      (photo.naturalWidth - side) / 2, (photo.naturalHeight - side) / 2, side, side,
      x - r, y - r, r * 2, r * 2);
    ctx.restore();
    return;
  }
  if (!hasEmoji(person.icon_id)) {
    drawSilhouette(ctx, x, y, r);
    return;
  }
  const { emoji, to } = avatarFor(person.icon_id);
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
