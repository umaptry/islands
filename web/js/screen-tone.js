// The background of the page-like screens (compose, DM, 通知, マイページ, profile, community
// edit ...) follows the map's time of day: the sea colour is run through the SAME layers the
// map paints over itself (palette.js TIMES), so the two never disagree.
//
// seaFor() is pure (tests run it); applyScreenTone() writes the result to --page-sea.

import { PAGE_SEA, TIMES, addressParam, timeOfDay } from './map/palette.js';

const rgb = (hex) => [16, 8, 0].map((shift) => (parseInt(hex.slice(1), 16) >> shift) & 255);
const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

// Canvas globalCompositeOperation maths for the three blends TIMES uses (channels 0-255).
const BLENDS = {
  multiply: (b, s) => (b * s) / 255,
  screen: (b, s) => b + s - (b * s) / 255,
  overlay: (b, s) => (b <= 127.5 ? (2 * b * s) / 255 : 255 - (2 * (255 - b) * (255 - s)) / 255),
};

/** The sea colour of a time of day ('morning' | 'day' | 'evening' | 'night') as #RRGGBB. */
export function seaFor(tod, base = PAGE_SEA) {
  let c = rgb(base);
  (TIMES[tod] || []).forEach((layer) => {
    const mix = BLENDS[layer.blend] || ((_, s) => s);
    const s = rgb(layer.color);
    c = c.map((b, i) => b + (mix(b, s[i]) - b) * layer.alpha);
  });
  return hex(c);
}

const luminance = (color) => {
  const [r, g, b] = rgb(color).map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Contrast ratio of white text on `color` (1 - 21). */
export function whiteContrast(color) {
  return 1.05 / (luminance(color) + 0.05);
}

/**
 * The page background for a time of day. White text sits on it, so a sea that the
 * time of day makes too light is deepened until the text reads (the day sea
 * #1D88C7, the map's own sea, is kept as it is).
 */
export function pageSeaFor(tod) {
  const sea = seaFor(tod);
  if (tod === 'day') return sea;
  const floor = whiteContrast(PAGE_SEA);
  let c = rgb(sea);
  let guard = 0;
  while (whiteContrast(hex(c)) < floor && guard++ < 40) c = c.map((v) => v * 0.97);
  return hex(c);
}

// A ?tod= in the address holds until the page is loaded again (like the map).
let asked = null;

export function currentTone() {
  try {
    const want = addressParam('tod');
    if (want && Object.prototype.hasOwnProperty.call(TIMES, want)) asked = want;
  } catch (error) { /* no address: use the clock */ }
  return asked || timeOfDay();
}

/** Paint the screens' background for now; returns the time of day used. */
export function applyScreenTone() {
  const tod = currentTone();
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--page-sea', pageSeaFor(tod));
    document.documentElement.dataset.tod = tod;
  }
  return tod;
}

/** Keep it in step with the clock and with the address. */
export function watchScreenTone() {
  applyScreenTone();
  window.addEventListener('hashchange', applyScreenTone);
  setInterval(applyScreenTone, 60000);
}
