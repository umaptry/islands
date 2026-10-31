// The map's colours: design 05 リアル・レリーフ in palette 03 クリア・スカイ
// (chosen 2026-10-18). One place for every module that paints the map - the
// ground's own bands still come from the server (core/config.py BIOME_COLORS,
// the same values), the rest is here.
//
// This file is pure (no DOM, no imports), so the tests and the workers can use it.

// 2026-10-31: the ground in the colours of prototype C (see core/config.py).
export const PALETTE = {
  sea: '#1D88C7',
  shallow: '#3EA7D0',
  sand: '#E3C98B',
  grass: '#74AD4E',
  forest: '#5C9F48',
  peak: '#4D8A40',
  halo: '#1D5F90',      // the dark rim round white island names
  wall: '#FFFFFF',      // buildings
  roof: '#EE6B5A',
  ui: '#1B8ED5',        // controls: the selected chip, the bottom nav, links
  accent: '#FF5A5F',    // yours: your post's ring, the "あなた" tag
};

// The post pin: a teardrop with the writer's initial. Its look follows the
// heat (motivation 0-100) in the four steps of heat.js:
//   0-30 low    still            31-65 mid   bobbing gently
//   66-90 flame head of flames   91-100 top  blue flames, faster
export const PIN = {
  low: '#3F9C8E',
  mid: '#F09534',
  flame: { outer: '#EE4B2B', inner: '#FF8A3D', core: '#FFD866' },
  top: { outer: '#2F63F0', inner: '#4FB8FF', core: '#E4F8FF' },
  gold: { light: '#FFF4C2', main: '#F5C440', dark: '#D9962A' },   // 参加者募集中
  rim: '#FFFFFF',
};

/** The colour a pin of this heat is at a glance (a dot, a mini pin). */
export function pinColor(value) {
  const v = Number(value) || 0;
  if (v >= 91) return PIN.top.outer;
  if (v >= 66) return PIN.flame.outer;
  if (v >= 31) return PIN.mid;
  return PIN.low;
}

// The time of day the map is painted in. Layers go over the ground and the
// buildings and under the pins and names, each { color, blend, alpha }, with
// `blend` a canvas globalCompositeOperation.
// The page-like screens (compose, DM, マイページ ...) are painted in the map's own
// sea (screen-tone.js), at the user's request on 2026-10-31: "make the other pages
// match the map". It used to be the lighter #46AEE6 they had before the map's sea deepened.
export const PAGE_SEA = PALETTE.sea;

export const TIMES = {
  morning: [
    { color: '#FFD9B8', blend: 'multiply', alpha: 0.26 },
    { color: '#FFF4E0', blend: 'screen', alpha: 0.06 },
  ],
  day: [],
  // Golden hour: an overlay of amber warms the sand and the green while the sea
  // stays a bright blue. A multiply of orange or rose greyed the sea or turned
  // the whole map lavender (compared side by side, 2026-10-18).
  evening: [
    { color: '#FFA65C', blend: 'overlay', alpha: 0.36 },
    { color: '#FFDCC0', blend: 'multiply', alpha: 0.14 },
  ],
  night: [
    { color: '#2A3C78', blend: 'multiply', alpha: 0.62 },
  ],
};

export const TIME_NAMES = { morning: '朝', day: '昼', evening: '夕方', night: '夜' };

/** A setting from the page's address: `?name=` before the `#`, or after the
 * route (`#/map?name=`) - where it lands when it is added to the end of the
 * address, and where it was first ignored (2026-10-19). */
export function addressParam(name, place = (typeof location !== 'undefined' ? location : null)) {
  if (!place) return null;
  const before = new URLSearchParams(place.search || '').get(name);
  if (before !== null) return before;
  const hash = String(place.hash || '');
  const at = hash.indexOf('?');
  return at < 0 ? null : new URLSearchParams(hash.slice(at + 1)).get(name);
}

/** Which time of day it is on this device: 5-9 morning, 10-15 day, 16-18
 * evening, 19-4 night. `?tod=night` (morning/day/evening/night) in the page's
 * address overrides it, for checking how each looks. `place` is anything with
 * `search` and `hash`, like `location`. */
export function timeOfDay(date = new Date(), place = (typeof location !== 'undefined' ? location : null)) {
  const forced = addressParam('tod', place);
  if (forced && Object.prototype.hasOwnProperty.call(TIMES, forced)) return forced;
  const hour = date.getHours();
  if (hour >= 5 && hour < 10) return 'morning';
  if (hour >= 10 && hour < 16) return 'day';
  if (hour >= 16 && hour < 19) return 'evening';
  return 'night';
}

// Sunlight over the whole map, from the top-left: a radial wash of white.
export const SUN = { color: '#FFFFFF', alpha: 0.08, at: [0.16, 0.06], reach: 1.05 };

/** Mix two #RRGGBB colours, t = 0 (a) .. 1 (b). */
export function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const channel = (shift) => {
    const x = (pa >> shift) & 255;
    const y = (pb >> shift) & 255;
    return Math.round(x + (y - x) * t);
  };
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}
