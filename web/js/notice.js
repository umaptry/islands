// The notice band at the top of the everyday screens (規約・ポリシー改定のお知らせ).
// What to show is decided in notice-rules.js; this only paints it.

import { config } from './config.js';
import { session } from './session.js';
import { $ } from './ui.js';
import { readDismissed, readNotice, shouldShowNotice, writeDismissed } from './notice-rules.js';

let chromeNow = false;
let closedNow = '';
let measured = 0;

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function currentNotice() {
  try {
    return config().notice || null;
  } catch {
    return null;   // the config has not loaded yet
  }
}

/** Show or hide the band. Call it when the screen, the sign-in or the config changes. */
export function updateNotice(chrome = chromeNow) {
  chromeNow = chrome;
  const band = $('noticeBand');
  if (!band) return;
  const notice = currentNotice();
  const show = shouldShowNotice({
    notice, signedIn: session.signedIn(), chrome,
    dismissedId: readDismissed(storage()), closedNow,
  });
  if (show) {
    const found = readNotice(notice);
    $('noticeText').textContent = found.text;
    const more = $('noticeMore');
    more.hidden = !found.url;
    if (found.url) more.setAttribute('href', found.url);
  }
  band.hidden = !show;
  const changed = document.body.classList.contains('has-notice') !== show;
  document.body.classList.toggle('has-notice', show);
  const height = show ? band.offsetHeight : 0;
  const moved = measured !== height;
  measured = height;
  if (show) document.documentElement.style.setProperty('--notice-h', `${height}px`);
  // The map sizes its canvas to the window: tell it the screen moved down.
  if (changed || moved) window.dispatchEvent(new Event('resize'));
}

export function setupNotice() {
  // A turned phone wraps the text differently: follow the band's height.
  window.addEventListener('resize', () => {
    const band = $('noticeBand');
    if (band && !band.hidden && band.offsetHeight !== measured) updateNotice();
  });
  $('noticeClose')?.addEventListener('click', () => {
    const notice = readNotice(currentNotice());
    if (notice) {
      closedNow = notice.id;
      writeDismissed(storage(), notice.id);
    }
    updateNotice();
  });
}
