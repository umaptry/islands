// 通知を受け取ってもらう案内 (2026-10-29).
//
// 「受け取る」 was only inside プロフィール編集, and on 10/29 not one device was subscribed: nobody heard about a
// reaction, a message or 「もっと話してみたい」 unless they had the app open. Two places ask now:
//   ① a card of its own over the map, once the 「あなたの近くの投稿」 card after the first post is closed (and,
//      on a device whose app was opened from the Home Screen, the first time the map is up - that is right
//      after signing in there, which an iPhone needs before it can be asked at all). 「あとで」 ends it for good.
//   ③ the top of the 通知 screen, until notifications come to this device (notifications.js).
// Nobody is asked whose device already receives them, whose phone refuses them, who pressed やめる, or whose
// browser cannot take them at all.

import { config } from './config.js';
import { resumeAudio, sound } from './feedback.js';
import { icon } from './icons.js';
import { revealing } from './map/index.js';
import { iosOtherBrowser } from './notify-rules.js';
import { onboardingStep } from './onboarding.js';
import { enablePush, pushDeclined, pushStatus } from './push.js';
import { activeScreen } from './router.js';
import { state } from './state.js';
import { talkLabelOf } from './talk-rules.js';
import { $, clear, closeSheet, el, openSheet, sheetOpen, toast } from './ui.js';

const LATER_KEY = 'islands.push.later';
const IDLE_WAIT_MS = 700;       // the sheet that just closed (or the map that just came up) settles first
const RETRY_MS = 1500;          // something else is over the map (the catch-up): look again
const RETRIES = 40;

// The first post: 'landing' while it flies onto the map (the 「近くの投稿」 card is still to come - nothing
// else may take its place), 'nearby' once that card is up (ask when it, and whatever it opened, has closed).
let firstPost = null;
let askedThisPage = false;
let waiting = 0;

function readLater() {
  try { return localStorage.getItem(LATER_KEY) === '1'; } catch { return false; }
}
function writeLater() {
  try { localStorage.setItem(LATER_KEY, '1'); } catch { /* private mode: it lasts as long as the page */ }
}

const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/** 'ask' (one tap does it here), 'ios' (Safari: the Home Screen first), or null (nothing to ask). */
export async function pushAskKind() {
  if (pushDeclined()) return null;
  const status = await pushStatus();
  if (status === 'off') return 'ask';
  if (status === 'ios-install') return 'ios';
  return null;
}

function lede() {
  let talk = '';
  try { talk = talkLabelOf(config()); } catch { /* before the config: no talk */ }
  return talk
    ? `いいね・メッセージ・「${talk}」が届いたとき、アプリを閉じていてもスマホに通知します。`
    : 'いいねやメッセージが届いたとき、アプリを閉じていてもスマホに通知します。';
}

/** The three steps of プロフィール編集, ending in a sign-in: the Home Screen app does not share Safari's. */
function iosSteps() {
  const steps = $('iosSteps').cloneNode(true);
  steps.removeAttribute('id');
  steps.hidden = false;
  const last = steps.querySelectorAll('.ios-step-text')[2];
  if (last) {
    last.replaceChildren(
      el('span', { className: 'phrase', text: 'ホーム画面から' }),
      el('span', { className: 'phrase' }, '開いて', el('b', { text: 'ログイン' })),
    );
  }
  return steps;
}

/**
 * The card. `from` is 'map' (①: 「あとで」 means never again on this device) or 'list' (③'s やり方を見る:
 * it only closes). Resolves when it is on screen.
 */
export function openPushCard(kind, { from = 'map', onChange = null } = {}) {
  const body = openSheet({ fit: true });
  clear($('sheetFoot'));
  const later = el('button', {
    className: 'btn btn-quiet btn-block push-later', attrs: { type: 'button', id: 'pushLater' },
    text: from === 'map' ? 'あとで' : '閉じる',
    on: { click: () => { if (from === 'map') writeLater(); closeSheet(); } },
  });
  const parts = [
    el('div', { className: 'push-ask-icon', attrs: { 'aria-hidden': 'true' } }, icon('bell', 28)),
    el('h3', { className: 'stack-title', text: '反応が来たら、お知らせします' }),
  ];
  if (kind === 'ios') {
    parts.push(
      el('p', { className: 'nearby-lede', text: 'iPhone は、ホーム画面に追加すると通知が届きます。' }),
      iosSteps(),
      el('p', { className: 'push-ask-note', text: 'ホーム画面から開いてログインすると、「通知を受け取る」が出ます。共有は画面の下か上、または「…」の中にあります。' }),
    );
    if (iosOtherBrowser(navigator.userAgent)) {
      parts.push(el('p', { className: 'push-ask-note push-ask-warn', text: 'このブラウザからは追加できないことがあります。Safari で開いてから追加してください。' }));
    }
  } else {
    const accept = el('button', {
      className: 'btn btn-block nearby-close', attrs: { type: 'button', id: 'pushAccept' }, text: '通知を受け取る',
    });
    accept.addEventListener('click', async () => {
      accept.disabled = true;
      // enablePush asks for permission before anything else is awaited: an iPhone only shows the question
      // in direct answer to this tap.
      const next = await turnOn();
      if (next === 'on' || next === 'blocked') closeSheet();
      else accept.disabled = false;
      if (onChange) onChange(next);
    });
    parts.push(el('p', { className: 'nearby-lede', text: lede() }), accept);
  }
  parts.push(later);
  clear(body).append(el('div', { className: 'push-ask', attrs: { id: 'pushAsk' } }, parts));
}

/** 「通知を受け取る」 wherever it is. Says how it went; returns on | off | blocked | error. */
export async function turnOn() {
  let next;
  try {
    next = await enablePush();
  } catch {
    toast('この端末を登録できませんでした。もう一度お試しください。');
    return 'error';
  }
  if (next === 'on') {
    toast('この端末に通知が届くようになりました。');
    resumeAudio().then(() => sound('notify'));
  } else if (next === 'blocked') {
    toast('スマホの設定で通知が止められています。設定で islands の通知を許可すると届きます。');
  }
  document.dispatchEvent(new CustomEvent('push:changed'));
  return next;
}

/** The map is quiet: nothing over it, no post landing, nobody half way through signing up. */
function quiet() {
  return activeScreen() === 'map' && !sheetOpen() && !document.hidden && !revealing()
    && !document.body.classList.contains('catchup-open') && !document.body.classList.contains('island-card-open')
    && Boolean(state.account && state.account.display_name) && !onboardingStep();
}

async function tryAsk(tries = 0) {
  waiting = 0;
  if (askedThisPage || readLater() || firstPost === 'landing') return;
  const afterFirstPost = firstPost === 'nearby';
  if (!afterFirstPost && !standalone()) return;
  if (!quiet()) {
    // Something is over the map: a sheet says so when it closes; anything else is looked at again.
    if (!sheetOpen() && activeScreen() === 'map' && tries < RETRIES) {
      waiting = setTimeout(() => tryAsk(tries + 1), RETRY_MS);
    }
    return;
  }
  const kind = await pushAskKind();
  // The Home Screen app asks only with a button that works; Safari's steps belong after the first post.
  if (!kind || (!afterFirstPost && kind !== 'ask')) return;
  if (askedThisPage || !quiet()) return;
  askedThisPage = true;
  firstPost = null;
  openPushCard(kind);
}

function soon() {
  clearTimeout(waiting);
  waiting = setTimeout(() => tryAsk(), IDLE_WAIT_MS);
}

/** ①, compose.js: a first post is on its way to the map. */
export function firstPostLanding() {
  firstPost = 'landing';
}

/** ①, map.js: the 「あなたの近くの投稿」 card is up; the ask follows once the map is clear again. */
export function askAfterFirstPost() {
  firstPost = 'nearby';
}

export function setupPushAsk() {
  document.addEventListener('sheet:state', () => {
    if (!sheetOpen() && (firstPost === 'nearby' || standalone())) soon();
  });
  document.addEventListener('map:ready', () => { if (standalone()) soon(); });
}
