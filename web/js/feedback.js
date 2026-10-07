// Sound and buzz for the moments people act (items 20 and 21).
//
// The rules live in feedback-rules.js; this file only touches the browser.
// The tones are made on the spot with Web Audio - a few sine notes, quiet and
// short - so there are no sound files to download and nothing to cache.

import {
  SETTINGS_KEY, buzzFor, makeViewerKey, maySound, parseSettings, isViewerKey,
} from './feedback-rules.js';
import { SYSTEM_REDUCED_MOTION, setReducedMotion } from './map/decor.js';

const VIEWER_KEY = 'islands.viewer';
const VOLUME = 0.05;

// Notes per moment: [frequency in Hz, start in seconds, length in seconds].
const TONES = {
  post: [[659, 0, 0.16], [988, 0.11, 0.26]],
  connect: [[523, 0, 0.14], [659, 0.1, 0.14], [784, 0.2, 0.3]],
  notify: [[880, 0, 0.28]],
};

let settings = parseSettings(read(SETTINGS_KEY), SYSTEM_REDUCED_MOTION);
let audio = null;
let lastSound = 0;

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows can refuse; the setting still holds until a reload.
  }
}

export function feedbackSettings() {
  return { ...settings };
}

export function setFeedback(change) {
  settings = { ...settings, ...change };
  write(SETTINGS_KEY, JSON.stringify(settings));
  setReducedMotion(settings.reduceMotion);
  document.documentElement.classList.toggle('reduce-motion', settings.reduceMotion);
}

/** Whether this browser can buzz at all (iPhone Safari cannot). */
export const canBuzz = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

export function buzz(kind) {
  const pattern = buzzFor(kind, settings);
  if (!pattern || !canBuzz) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // A browser that says it can and then cannot is not worth an error.
  }
}

/** A sound for one of the three moments, if the settings and the clock allow. */
export function sound(moment) {
  const now = Date.now();
  if (document.hidden || !maySound(moment, settings, lastSound, now)) return;
  const context = audioContext();
  if (!context || context.state !== 'running') return;
  lastSound = now;
  const start = context.currentTime + 0.01;
  for (const [frequency, offset, length] of TONES[moment] || []) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    const at = start + offset;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(VOLUME, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + length + 0.02);
  }
}

/** The moment, all at once: a sound where one is allowed, and a buzz. */
export function moment(kind) {
  sound(kind);
  buzz(kind);
}

function audioContext() {
  if (audio) return audio;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return null;
  try {
    audio = new Context();
  } catch {
    audio = null;
  }
  return audio;
}

/** Browsers only let a page make sound after a tap; start listening for it. */
export function setupFeedback() {
  setReducedMotion(settings.reduceMotion);
  document.documentElement.classList.toggle('reduce-motion', settings.reduceMotion);
  const unlock = () => {
    const context = audioContext();
    if (context && context.state === 'suspended') context.resume().catch(() => {});
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}

/** Who is reading, for counting a view once (Q35). */
export function viewerKey() {
  const saved = read(VIEWER_KEY);
  if (isViewerKey(saved)) return saved;
  const key = makeViewerKey(crypto.getRandomValues(new Uint8Array(16)));
  write(VIEWER_KEY, key);
  return key;
}
