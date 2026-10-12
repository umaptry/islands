// Web Push, the browser's half (item 23).
//
// Three jobs. Keep this browser's subscription on the server for whoever is
// signed in; tell the server while the app is on screen, so it pushes nothing
// then and the band in notifications.js speaks instead; and say what this
// device needs before it can be told anything at all - on an iPhone that is
// the Home Screen and nothing else (pushSupport in notify-rules.js).
//
// The service worker (/sw.js) caches nothing; see the comment there.

import { config } from './config.js';
import { api, data } from './net.js';
import { session } from './session.js';
import { state } from './state.js';
import { keyBytes, presenceSeconds, pushSupport, sameKey, shouldSendPresence } from './notify-rules.js';

// Turned off on this device on purpose. Permission stays granted in the
// browser, so without this the next sign-in would quietly subscribe again.
const OFF_KEY = 'islands.push.off';
const LEAVE_WAIT_MS = 3000;

let registering = null;    // the service worker registration, or null without one
let subscribing = null;    // a subscribe in flight
let syncedFor = null;      // whose subscription this page already confirmed
let lastSent = null;       // presence: seconds last told to the server
let lastAt = 0;

const hasWorker = () => 'serviceWorker' in navigator;

function readOff() {
  try {
    return localStorage.getItem(OFF_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOff(off) {
  try {
    if (off) localStorage.setItem(OFF_KEY, '1');
    else localStorage.removeItem(OFF_KEY);
  } catch {
    // Private mode: the switch lasts as long as the page.
  }
}

const publicKey = () => (config().push || {}).public_key || null;

/** standalone: opened from the Home Screen (iPhone) or installed (Android, PC). */
function standalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

/** ready | blocked | ios-install | ios-old | unsupported, for this device. */
export function pushSupportHere() {
  if (!publicKey()) return 'unsupported';
  return pushSupport({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    standalone: standalone(),
    hasWorker: hasWorker(),
    hasPush: 'PushManager' in window && 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : 'default',
  });
}

async function registration() {
  if (!registering) return null;
  const registered = await registering;
  if (!registered) return null;
  // subscribe() needs an active worker, not one still installing.
  return navigator.serviceWorker.ready;
}

async function currentSubscription() {
  const registered = await registration();
  return registered ? registered.pushManager.getSubscription() : null;
}

/** on | off, or why it cannot be: blocked | ios-install | ios-old | unsupported. */
export async function pushStatus() {
  const support = pushSupportHere();
  if (support !== 'ready') return support;
  if (Notification.permission !== 'granted' || readOff()) return 'off';
  try {
    return (await currentSubscription()) ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

async function subscribe() {
  const bytes = keyBytes(publicKey());
  const registered = await registration();
  if (!registered) throw new Error('no service worker');
  let subscription = await registered.pushManager.getSubscription();
  // A subscription made with another key can never be pushed to again.
  if (subscription && !sameKey(subscription.options?.applicationServerKey, bytes)) {
    const old = subscription.endpoint;
    await subscription.unsubscribe().catch(() => {});
    api.post('/api/push/unsubscribe', { endpoint: old }).catch(() => {});
    subscription = null;
  }
  if (!subscription) {
    subscription = await registered.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
  }
  const { endpoint, keys } = subscription.toJSON();
  await api.post('/api/push/subscribe', { endpoint, keys });
  syncedFor = session.userId();
}

function subscribeOnce() {
  if (!subscribing) subscribing = subscribe().finally(() => { subscribing = null; });
  return subscribing;
}

/**
 * The 受け取る button. Asks for permission first thing: an iPhone only shows
 * the question in direct answer to a tap. Returns the status afterwards.
 */
export async function enablePush() {
  if (pushSupportHere() !== 'ready') return pushSupportHere();
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return 'blocked';
  if (permission !== 'granted') return 'off';
  writeOff(false);
  await subscribeOnce();
  return 'on';
}

/** The やめる button: this device stops, and stays stopped across sign-ins. */
export async function disablePush() {
  writeOff(true);
  await dropSubscription();
  return pushStatus();
}

async function dropSubscription() {
  syncedFor = null;
  let subscription = null;
  try {
    subscription = await currentSubscription();
  } catch {
    return;
  }
  if (!subscription) return;
  const { endpoint } = subscription;
  await subscription.unsubscribe().catch(() => {});
  if (session.signedIn()) await api.post('/api/push/unsubscribe', { endpoint }).catch(() => {});
}

/**
 * Before signing out: this device stops being told about this account, and
 * the server stops thinking it is on screen. Never holds the sign-out up for
 * long - both would run out on their own anyway.
 */
export async function forgetDevice() {
  const leaving = Promise.all([
    dropSubscription(),
    lastSent > 0 ? data.markActive(0, { keepalive: true }).catch(() => {}) : null,
  ]);
  lastSent = null;
  await Promise.race([leaving, new Promise((resolve) => { setTimeout(resolve, LEAVE_WAIT_MS); })]);
}

/** On boot and every sign-in: keep the subscription if this person already said yes. */
export function syncPush() {
  const uid = session.signedIn() ? session.userId() : null;
  if (!uid) {
    syncedFor = null;
    lastSent = null;
    return;
  }
  presence();
  if (syncedFor === uid || readOff() || pushSupportHere() !== 'ready') return;
  if (Notification.permission !== 'granted') return;
  subscribeOnce().catch(() => {
    // Tried again on the next boot or sign-in; the list still works meanwhile.
  });
}

/**
 * "On screen" for the server: said when it changes, repeated before it runs
 * out. Seen and in front only - a window behind another one is not watched,
 * and a push is the only way it would hear anything.
 */
export function presence({ leaving = false } = {}) {
  const signedIn = session.signedIn() && Boolean(state.account);
  if (!signedIn) {
    lastSent = null;
    return;
  }
  const { presence_seconds: every = 30, presence_hold: hold = 75 } = config().push || {};
  const next = presenceSeconds({
    signedIn,
    visible: !leaving && document.visibilityState === 'visible',
    focused: !leaving && document.hasFocus(),
  }, hold);
  const now = Date.now();
  if (!shouldSendPresence(next, lastSent, lastAt, now, every * 1000)) return;
  const before = lastSent;
  lastSent = next;
  lastAt = now;
  // keepalive for "gone": the page may be closing as it is said.
  data.markActive(next, { keepalive: next === 0 }).catch(() => {
    lastSent = before;
  });
}

/**
 * Register the worker and listen to it. `onRefresh` reads the list again (a
 * push arrived while open); `onOpen` goes to the hash a tapped notification
 * named.
 */
export function setupPush({ onRefresh, onOpen }) {
  if (hasWorker()) {
    registering = navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null);
    navigator.serviceWorker.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'refresh') onRefresh();
      if (message.type === 'open' && typeof message.url === 'string') {
        const { hash } = new URL(message.url, window.location.href);
        if (hash) onOpen(hash);
      }
    });
  }
  const { presence_seconds: every = 30 } = config().push || {};
  setInterval(() => presence(), every * 1000);
  window.addEventListener('focus', () => presence());
  window.addEventListener('blur', () => presence());
  document.addEventListener('visibilitychange', () => presence());
  // Signing in fills state.account a moment after the session, then moves on.
  window.addEventListener('hashchange', () => presence());
  window.addEventListener('pagehide', () => presence({ leaving: true }));
}
