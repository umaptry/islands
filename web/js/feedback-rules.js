// The rules behind the app's small answers to a tap, kept free of the browser
// so they can be tested: which moments may make a sound, how a buzz feels for
// each, and what the settings are when nothing has been chosen yet.
//
// Item 21 (approved 10/06): sound in three moments only and quietly, buzz on,
// both can be turned off. Everything that makes a sound or a buzz also shows
// something on screen, so a phone on silent - or an iPhone, which has no buzz
// for web pages - loses nothing but the extra.

export const SETTINGS_KEY = 'islands.feedback';

/** The only moments that may make a sound. Anything else is silent. */
export const SOUND_MOMENTS = Object.freeze(['post', 'connect', 'notify']);

/** Two sounds closer than this would be noise, not an answer. */
export const SOUND_GAP_MS = 1500;

/** Short and soft. Milliseconds, as navigator.vibrate takes them. */
export const BUZZ = Object.freeze({
  tap: 8,
  react: 12,
  save: 10,
  island: 8,
  post: [14, 60, 22],
  connect: [10, 40, 10, 40, 18],
  notify: [12, 50, 12],
  error: [30, 40, 30],
});

/** What a person who has never opened the settings gets. */
export function defaultSettings(systemReduced = false) {
  return { sound: true, vibrate: true, reduceMotion: Boolean(systemReduced) };
}

/** Saved settings, trusting nothing about what was saved. */
export function parseSettings(text, systemReduced = false) {
  const settings = defaultSettings(systemReduced);
  let saved = null;
  try {
    saved = text ? JSON.parse(text) : null;
  } catch {
    saved = null;
  }
  if (!saved || typeof saved !== 'object') return settings;
  for (const key of Object.keys(settings)) {
    if (typeof saved[key] === 'boolean') settings[key] = saved[key];
  }
  return settings;
}

/** Whether `moment` may make a sound now, given when the last one played. */
export function maySound(moment, settings, lastAt, now) {
  if (!settings.sound || !SOUND_MOMENTS.includes(moment)) return false;
  return !(lastAt > 0 && now - lastAt < SOUND_GAP_MS);
}

/** The buzz for `kind`, or null for none. */
export function buzzFor(kind, settings) {
  if (!settings.vibrate) return null;
  return BUZZ[kind] ?? null;
}

/** A key a signed-out browser keeps so the same reader counts once (Q35). */
export function makeViewerKey(randomBytes) {
  const hex = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `anon:${hex}`;
}

export function isViewerKey(text) {
  return typeof text === 'string' && /^anon:[0-9a-f]{16,64}$/.test(text);
}
