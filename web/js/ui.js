// Small shared pieces: DOM helpers, the toast, the bottom sheet, formatting.

import { avatarCss, avatarFor } from './avatars.js';
import { data } from './net.js';

export const $ = (id) => document.getElementById(id);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Build an element. Text is set with textContent, never innerHTML.
 *
 * Everything on this map is written by a stranger, and the one rule that keeps
 * that safe is that no user text is ever parsed as markup. There is no path
 * through this module that concatenates a name or a post body into HTML.
 */
export function el(tag, options = {}, ...children) {
  const node = document.createElement(tag);
  const { className, text, html, attrs, on, style, ...rest } = options;
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (html !== undefined) node.innerHTML = html;   // only ever called with literals
  if (attrs) Object.entries(attrs).forEach(([key, value]) => {
    if (value === false || value === null || value === undefined) return;
    node.setAttribute(key, value === true ? '' : String(value));
  });
  if (style) Object.assign(node.style, style);
  if (on) Object.entries(on).forEach(([event, handler]) => node.addEventListener(event, handler));
  Object.assign(node, rest);
  children.flat().forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  });
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ---------------------------------------------------------------- avatars

/** A round avatar: the uploaded image if there is one, the emoji disc if not.
 *
 * `overrideUrl` is for the profile screens, which have to show a photo that has
 * been chosen but not yet uploaded - at that point there is no avatar_path to
 * resolve, only an object URL for the blob in hand.
 */
export function avatar(person, size = 40, overrideUrl = null) {
  const node = el('span', {
    className: 'avatar',
    style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.56)}px` },
  });
  const url = overrideUrl
    || (person && person.avatar_path ? data.imageUrl(person.avatar_path) : null);
  if (url) {
    node.classList.add('has-image');
    node.append(el('img', { attrs: { src: url, alt: '', loading: 'lazy' } }));
  } else {
    node.style.background = avatarCss(person ? person.icon_id : '0');
    node.textContent = avatarFor(person ? person.icon_id : '0').emoji;
  }
  return node;
}

// ---------------------------------------------------------------- toast

let toastTimer = 0;

export function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('on'), 3200);
}

// ---------------------------------------------------------------- sheet
//
// islands' post panel: half height, swipe up for full height, with the message
// list appearing only once it is expanded. Ported behaviour and all - the half
// state is what lets you read a card without losing sight of the map.

const sheetState = { open: false, expanded: false, onClose: null };

export function openSheet({ expanded = false, onClose = null } = {}) {
  const sheet = $('sheet');
  sheetState.open = true;
  sheetState.expanded = expanded;
  sheetState.onClose = onClose;
  sheet.classList.add('on');
  sheet.classList.toggle('full', expanded);
  $('sheetBackdrop').classList.add('on');
  document.body.classList.add('sheet-open');
  return $('sheetBody');
}

export function expandSheet(expanded) {
  if (!sheetState.open || sheetState.expanded === expanded) return;
  sheetState.expanded = expanded;
  $('sheet').classList.toggle('full', expanded);
  document.dispatchEvent(new CustomEvent('sheet:expand', { detail: { expanded } }));
}

export const sheetExpanded = () => sheetState.expanded;
export const sheetOpen = () => sheetState.open;

export function closeSheet() {
  if (!sheetState.open) return;
  sheetState.open = false;
  sheetState.expanded = false;
  $('sheet').classList.remove('on', 'full');
  $('sheetBackdrop').classList.remove('on');
  document.body.classList.remove('sheet-open');
  const done = sheetState.onClose;
  sheetState.onClose = null;
  if (done) done();
}

// ---------------------------------------------------------------- formatting

export function timeAgo(stamp) {
  const then = new Date(stamp).getTime();
  if (!Number.isFinite(then)) return '';
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}日前`;
  return new Date(then).toLocaleDateString('ja-JP');
}

/** islands' エンジョイ→ガチ colour: white at 0, #FF7251 at 100. */
export function motivationColor(value) {
  const t = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
  return `rgb(255, ${Math.round(255 - (255 - 114) * t)}, ${Math.round(255 - (255 - 81) * t)})`;
}

export function clip(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** A link a stranger typed. Only http(s) survives; javascript: never does. */
export function safeUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- confirm

/** A yes/no the app owns, rather than window.confirm's browser chrome. */
export function confirmAction({ title, body, confirmLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const backdrop = el('div', { className: 'modal-backdrop' });
    const panel = el('div', { className: 'modal' },
      el('h3', { className: 'modal-title', text: title }),
      body ? el('p', { className: 'modal-body', text: body }) : null,
      el('div', { className: 'modal-actions' },
        el('button', {
          className: 'btn btn-quiet', text: 'やめる',
          on: { click: () => finish(false) },
        }),
        el('button', {
          className: `btn ${danger ? 'btn-danger' : ''}`, text: confirmLabel,
          on: { click: () => finish(true) },
        }),
      ),
    );
    backdrop.append(panel);
    backdrop.addEventListener('pointerdown', (event) => {
      if (event.target === backdrop) finish(false);
    });
    document.body.append(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('on'));

    function finish(answer) {
      backdrop.remove();
      resolve(answer);
    }
  });
}
