// Full-screen image viewer for a post's picture, in the manner of X: the image
// on a dark ground, a close button at the top and, at the foot, the post's
// messages / いいね / 手伝えるかも with the same counts and "on" state as the card.
//
// "Back" closes it: opening pushes one history entry (state only, the hash is
// untouched, so the hash router never sees it) and popstate closes it.

import { hasReacted, state, subscribe } from '../state.js';
import { el, toast } from '../ui.js';
import { icon } from '../icons.js';
import { dragBackdrop, shouldDismissSwipe, viewerActions } from '../image-viewer-rules.js';
import { showHelp } from '../recruit-rules.js';

const HISTORY_KEY = 'islandsImageViewer';
let active = null;

const reducedMotion = () => document.documentElement.classList.contains('reduce-motion')
  || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * @param url      the image
 * @param post     the post row (for counts and reactions)
 * @param options  the card's options: onReact(kind), onComments(post)
 * @param opener   the element to give focus back to
 * @returns a promise that settles once the viewer is closed
 */
export function openImageViewer({ url, post, options = {}, opener = null }) {
  if (active) return active.close();

  const root = el('div', { className: 'image-viewer', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '画像' } });
  const stage = el('div', { className: 'image-viewer-stage' });
  const img = el('img', { className: 'image-viewer-img', attrs: { src: url, alt: '添付画像', draggable: 'false' } });
  const failed = el('p', { className: 'image-viewer-error', text: '画像を読み込めませんでした', attrs: { hidden: true } });
  img.addEventListener('error', () => { img.hidden = true; failed.hidden = false; });
  stage.append(img, failed);

  const closeButton = el('button', {
    className: 'image-viewer-close', attrs: { type: 'button', 'aria-label': '閉じる' },
    on: { click: () => close() },
  }, icon('close', 24));

  // --- reaction bar -----------------------------------------------------
  const buttons = new Map();
  const bar = el('div', { className: 'image-viewer-bar' });
  viewerActions({
    hasComments: Boolean(options.onComments),
    showHelp: showHelp(post, state.account?.id, { reacted: hasReacted(post.id, 'help') }),
  }).forEach((action) => {
    const body = [
      el('span', { className: 'post-action-icon' }, icon(action.icon, action.kind === 'help' ? 18 : 20)),
      action.kind === 'help' ? el('span', { className: 'post-action-label', text: action.label }) : null,
      el('span', { className: 'post-action-count num', attrs: { 'data-count': action.countKey } }),
    ];
    const node = action.pressable
      ? el('button', { className: `image-viewer-action ${action.kind}`, attrs: { type: 'button', 'aria-label': action.label } }, body)
      : el('span', { className: `image-viewer-action ${action.kind}`, attrs: { role: 'img' } }, body);
    if (action.pressable) node.addEventListener('click', () => press(action.kind, node));
    buttons.set(action.kind, node);
    bar.append(node);
  });

  root.append(stage, closeButton, bar);

  // The card paints the same numbers from the same state; so does this.
  const lookup = () => state.postsById.get(post.id) || state.myPosts.find((p) => p.id === post.id);
  const knownAtOpen = Boolean(lookup());
  const labels = { comments: 'メッセージ', like: 'いいね', help: '手伝えるかも' };
  const paint = () => {
    const found = lookup();
    // The post was removed while the viewer was open: its card and options are stale.
    if (knownAtOpen && !found) { close(); return; }
    const current = found || post;
    buttons.forEach((node, kind) => {
      const count = String(current[`${kind === 'comments' ? 'comment' : kind}_count`] || 0);
      node.querySelector('[data-count]').textContent = count;
      node.setAttribute('aria-label', `${labels[kind] || kind} ${count}件`);
      if (kind === 'comments') return;
      const on = hasReacted(post.id, kind);
      node.classList.toggle('on', on);
      node.setAttribute('aria-pressed', String(on));
    });
  };
  paint();
  const unsubscribe = subscribe(paint);

  async function press(kind, node) {
    if (kind === 'comments') {
      await close();
      options.onComments?.(post);
      return;
    }
    if (!options.onReact) return;
    // Signed out, the card's handler says so and moves to the sign-in screen;
    // leave the viewer first so that move does not race the history step back.
    if (!state.account) {
      await close();
      options.onReact(kind);
      return;
    }
    if (node.dataset.busy) return;
    node.dataset.busy = '1';
    if (!hasReacted(post.id, kind)) {
      node.classList.remove('pop');
      void node.offsetWidth;
      node.classList.add('pop');
    }
    try {
      await options.onReact(kind);
    } catch {
      toast('うまくいきませんでした。もう一度お試しください。');
    } finally {
      delete node.dataset.busy;
      paint();
    }
  }

  // --- closing ----------------------------------------------------------
  let closed = false;
  let pushed = false;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });

  function teardown() {
    if (closed) return;
    closed = true;
    unsubscribe();
    window.removeEventListener('popstate', onPop);
    window.removeEventListener('hashchange', onHash);
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    document.body.classList.remove('image-viewer-open');
    active = null;
    hidden.forEach(({ node, inert, ariaHidden }) => {
      node.inert = inert;
      if (ariaHidden === null) node.removeAttribute('aria-hidden');
      else node.setAttribute('aria-hidden', ariaHidden);
    });
    // The card may have been redrawn while open; find its new image link.
    const target = opener?.isConnected
      ? opener
      : document.querySelector(`.post-card[data-post-id="${post.id}"] .post-image a`);
    target?.focus({ preventScroll: true });
  }

  /** Close from a button, key, backdrop or swipe; steps back the history entry we added. */
  function close() {
    if (closed) return closedPromise;
    const hadEntry = pushed;
    pushed = false;
    teardown();
    if (hadEntry) {
      const finish = () => {
        window.removeEventListener('popstate', finish);
        clearTimeout(timer);
        resolveClosed();
      };
      const timer = setTimeout(finish, 400);
      window.addEventListener('popstate', finish);
      history.back();
    } else {
      resolveClosed();
    }
    return closedPromise;
  }
  // The browser's back button: the entry is already gone.
  function onPop() { pushed = false; teardown(); resolveClosed(); }
  // Navigating elsewhere takes the viewer with it.
  function onHash() { pushed = false; teardown(); resolveClosed(); }
  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll('button:not([disabled])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!root.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  // --- pulling the image down to close ----------------------------------
  let drag = null;
  let justDragged = false;
  // A second finger (pinch) is not a swipe: ignore until all fingers are up.
  const touches = new Set();
  const cancelDrag = () => {
    if (!drag) return;
    drag = null;
    root.classList.remove('dragging');
    img.style.transform = '';
    root.style.removeProperty('--viewer-dim');
  };
  stage.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    touches.add(event.pointerId);
    if (touches.size > 1) { cancelDrag(); return; }
    if (event.target !== img && event.target !== stage) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), dx: 0, dy: 0, moving: false };
  });
  stage.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag.dx = event.clientX - drag.x;
    drag.dy = event.clientY - drag.y;
    if (!drag.moving) {
      if (Math.hypot(drag.dx, drag.dy) < 8) return;
      if (drag.dy <= 0 || Math.abs(drag.dy) <= Math.abs(drag.dx)) { drag = null; return; }
      drag.moving = true;
      stage.setPointerCapture?.(event.pointerId);
      root.classList.add('dragging');
    }
    img.style.transform = `translate(${drag.dx * 0.4}px, ${drag.dy}px)`;
    root.style.setProperty('--viewer-dim', String(dragBackdrop(drag.dy, window.innerHeight)));
  });
  const endDrag = (event) => {
    touches.delete(event.pointerId);
    if (!drag || event.pointerId !== drag.id) return;
    const done = drag;
    drag = null;
    root.classList.remove('dragging');
    if (!done.moving) return;
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);
    const leave = event.type === 'pointerup'
      && shouldDismissSwipe({ dx: done.dx, dy: done.dy, elapsedMs: performance.now() - done.at });
    if (leave) { close(); return; }
    img.style.transform = '';
    root.style.removeProperty('--viewer-dim');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  // Tapping the dark ground (not the picture) closes it.
  stage.addEventListener('click', (event) => {
    if (justDragged || event.target === img) return;
    close();
  });
  // Nothing behind the viewer may scroll or zoom from here.
  root.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });
  root.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });

  // --- open -------------------------------------------------------------
  active = { close };
  if (reducedMotion()) root.classList.add('no-motion');
  // Hide what is behind from assistive technology (the toast stays readable).
  const hidden = [...document.body.children]
    .filter((node) => node.id !== 'toast' && !['SCRIPT', 'STYLE', 'LINK'].includes(node.tagName))
    .map((node) => ({ node, inert: node.inert, ariaHidden: node.getAttribute('aria-hidden') }));
  hidden.forEach(({ node }) => { node.inert = true; node.setAttribute('aria-hidden', 'true'); });
  document.body.append(root);
  document.body.classList.add('image-viewer-open');
  try {
    history.pushState({ [HISTORY_KEY]: true }, '');
    pushed = true;
  } catch { /* the viewer still works; back then leaves the screen instead */ }
  window.addEventListener('popstate', onPop);
  window.addEventListener('hashchange', onHash);
  document.addEventListener('keydown', onKey, true);
  // Force a layout so the fade starts from opacity 0 without waiting for a frame
  // (a stalled requestAnimationFrame would leave an invisible full-screen cover).
  void root.offsetWidth;
  root.classList.add('on');
  closeButton.focus({ preventScroll: true });
  return closedPromise;
}
