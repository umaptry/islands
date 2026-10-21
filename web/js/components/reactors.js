// 「いいねした人」 / 「手伝えるかもと言った人」: the people behind one reaction on
// your own post. Opened by holding the button (see longpress.js).
//
// Built like confirmAction's dialog in ui.js - the same backdrop and panel - and
// shown over whatever is open, so a post sheet on the map stays where it is.

import { data } from '../net.js';
import { avatar, el } from '../ui.js';

const TITLES = { like: 'いいねした人', help: '手伝えるかもと言った人', join: '参加した人' };
const EMPTY = { like: 'まだ誰もいいねしていません', help: 'まだ誰も手伝えるかもと言っていません', join: 'まだ誰も参加していません' };

/**
 * @param post          the post whose reactions are listed
 * @param kind          'like' | 'help' | 'join'
 * @param onOpenProfile (accountId) => void, called after the list has closed
 */
export function openReactors({ post, kind, onOpenProfile }) {
  const previousFocus = document.activeElement;
  const events = new AbortController();
  const background = [...document.body.children].map((node) => [node, node.inert]);
  const title = TITLES[kind] || 'リアクションした人';
  const list = el('div', { className: 'reactors-list' },
    el('p', { className: 'reactors-note', text: '読み込み中…' }));
  const heading = el('h3', { className: 'modal-title', text: title });
  const closeButton = el('button', {
    className: 'btn btn-quiet', text: '閉じる', attrs: { type: 'button' },
    on: { click: () => finish() },
  });
  const panel = el('div', {
    className: 'modal reactors-modal',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
  }, heading, list, el('div', { className: 'modal-actions' }, closeButton));
  const backdrop = el('div', { className: 'modal-backdrop' }, panel);
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) finish();
  });
  document.body.append(backdrop);
  background.forEach(([node]) => { node.inert = true; });
  closeButton.focus();
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); finish(); }
    if (event.key === 'Tab') {
      const stops = [...panel.querySelectorAll('button')];
      const first = stops[0];
      const last = stops.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }, { signal: events.signal });
  requestAnimationFrame(() => backdrop.classList.add('on'));

  data.reactorsOf(post.id, kind).then((people) => {
    if (!backdrop.isConnected) return;
    heading.textContent = `${title}（${people.length}人）`;
    list.replaceChildren(...(people.length
      ? people.map((person) => el('button', {
        className: 'reactor-row', attrs: { type: 'button' },
        on: { click: () => finish(person.id) },
      }, avatar(person, 36), el('span', { className: 'reactor-name', text: person.display_name || '名前なし' })))
      : [el('p', { className: 'reactors-note', text: EMPTY[kind] || 'まだ誰もいません' })]));
  }).catch(() => {
    if (!backdrop.isConnected) return;
    list.replaceChildren(el('p', { className: 'reactors-note', text: '読み込めませんでした。少し待ってからもう一度お試しください。' }));
  });

  function finish(accountId = null) {
    events.abort();
    backdrop.remove();
    background.forEach(([node, inert]) => { if (node.isConnected) node.inert = inert; });
    if (previousFocus && previousFocus.isConnected) previousFocus.focus?.();
    if (accountId && onOpenProfile) onOpenProfile(accountId);
  }
}
