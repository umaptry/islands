// The guest page of a 会 (#/e/<code>/me; 画面イメージ 16回目の3・20回目の3・4): what the person applied to, how it stands, and the
// buttons for being late and for cancelling. This is the page the LINE buttons open, and the only one a guest may
// open besides the public page. It shows no other person: the near people are a later part (the participants'
// list of the 会), and a cancelled 会 never shows them (D 8章).
//
// The rules (which state says what) are in event-rules.js statusView.

import { session } from '../session.js';
import { state } from '../state.js';
import { navigate, screen } from '../router.js';
import { $, clear, confirmAction, el, toast } from '../ui.js';
import { publicApi } from '../event-public-api.js';
import { forgetEventGuest, refreshEventGuest } from '../event-guest.js';
import {
  EVENT_WORDS, calendarUrl, errorText, eventHashFor, lateChoices, mapUrl, statusView, validEventCode, windowText,
} from '../event-rules.js';
import { canAddFriend, friendUrl } from './event-apply.js';

export function setupEventMe() {
  const body = $('eventMeBody');
  const foot = $('eventMeFoot');
  let code = '';
  let turn = 0;

  const paint = (content, footer = []) => {
    clear(body).append(...content.filter(Boolean));
    clear(foot).append(...footer.filter(Boolean));
    foot.hidden = footer.filter(Boolean).length === 0;
    body.scrollTop = 0;
  };

  const message = (text, id = 'eventMeMessage') => paint([el('div', { className: 'ev-brand', text: 'islands' }),
    el('h1', { className: 'ev-title', attrs: { id }, text })]);

  async function load(params) {
    const mark = ++turn;
    code = params.code;
    if (!validEventCode(code)) { message(EVENT_WORDS.notFound, 'eventMeNotFound'); return; }
    if (!session.signedIn()) { await navigate(eventHashFor(code, 'apply'), { replace: true }); return; }
    message('読み込んでいます…');
    let result;
    try {
      result = await publicApi.get(code);
    } catch (error) {
      if (mark !== turn) return;
      if (error.status === 401) { await navigate(eventHashFor(code, 'apply'), { replace: true }); return; }
      message(error.status === 404 ? EVENT_WORDS.notFound : errorText(error), 'eventMeNotFound');
      return;
    }
    if (mark !== turn) return;
    document.title = result.event.title ? `${result.event.title} | islands` : 'islands';
    render(result);
  }

  function render(result) {
    const { event, me } = result;
    const view = statusView(me, event);
    const content = [];

    if (view.tone === 'cancelled') {
      content.push(el('div', { className: 'ev-band is-red', attrs: { id: 'eventMeBand' }, text: EVENT_WORDS.cancelledBand }));
    } else if (view.showFriend && canAddFriend()) {
      content.push(el('div', { className: 'ev-band is-amber is-row', attrs: { id: 'eventMeFriendBand' } },
        el('div', {}, el('b', { text: EVENT_WORDS.friendBand }), el('span', { text: EVENT_WORDS.friendNote })),
        el('a', { className: 'ev-band-btn', text: 'LINE で\n友だち追加', attrs: { href: friendUrl(), target: '_blank', rel: 'noopener', id: 'eventMeFriend' } })));
    }

    content.push(el('div', { className: 'ev-brand', text: 'islands' }),
      el('h1', { className: 'ev-title', attrs: { id: 'eventMeTitle' }, text: `${event.title} にようこそ` }),
      el('div', { className: 'ev-lines' },
        el('div', { className: 'ev-line', text: windowText(event) }),
        event.place ? el('div', { className: 'ev-line', text: `場所：${event.place}` }) : null));

    // How it stands.
    const status = el('div', { className: `ev-card ev-status is-${view.tone}`, attrs: { id: 'eventMeStatus' } });
    if (view.title) status.append(el('div', { className: 'ev-status-title', text: (view.tone === 'ok' || view.tone === 'attended' ? '✓ ' : '') + view.title }));
    if (view.note) status.append(el('p', { className: 'ev-status-note', text: view.note }));
    if (me.late_minutes && view.canLate) {
      status.append(el('p', { className: 'ev-status-note', attrs: { id: 'eventMeLateNote' },
        text: `${me.late_minutes === 60 ? '1時間以上' : `${me.late_minutes}分くらい`}遅れることを、主催者に伝えました。` }));
    }
    if (view.title || view.note) content.push(status);

    // Being late: one tap on a button, no typing.
    if (view.canLate) {
      content.push(el('h2', { className: 'ev-sub', text: '遅れるときは' }),
        el('div', { className: 'ev-late', attrs: { id: 'eventMeLate' } }, ...lateChoices(me.late_minutes).map((choice) => el('button', {
          className: `ev-late-btn${choice.selected ? ' is-on' : ''}`, text: choice.label,
          attrs: { type: 'button', 'data-minutes': String(choice.minutes), 'aria-pressed': String(choice.selected) },
          on: { click: () => setLate(choice.minutes) } }))));
    }

    const footer = [];
    const place = mapUrl(event.place);
    if (view.tone === 'ok' || view.tone === 'attended') {
      if (place) footer.push(el('a', { className: 'btn btn-block ev-primary', text: '会場への行き方', attrs: { href: place, target: '_blank', rel: 'noopener', id: 'eventMePlace' } }));
      if (view.tone === 'ok') footer.push(el('p', { className: 'ev-fine ev-center', text: '受付は会場の QR で' }));
      const calendar = calendarUrl(event, window.location.origin);
      if (calendar) footer.push(el('p', { className: 'ev-center' }, el('a', { className: 'ev-link', text: 'カレンダーに追加', attrs: { href: calendar, target: '_blank', rel: 'noopener' } })));
    }
    if (view.canReapply) {
      footer.push(el('button', { className: 'btn btn-block ev-primary', text: 'もう一度申し込む', attrs: { type: 'button', id: 'eventMeReapply' },
        on: { click: () => navigate(eventHashFor(code, 'apply')) } }));
    }
    if (view.canCancel) {
      footer.push(el('button', { className: 'ev-quiet', text: '申し込みを取り消す', attrs: { type: 'button', id: 'eventMeCancel' }, on: { click: () => cancel(event) } }));
    }
    if (me.is_member && state.communities.length) {
      footer.push(el('button', { className: 'ev-quiet', text: 'マップを開く', attrs: { type: 'button', id: 'eventMeMap' }, on: { click: () => navigate('#/map') } }));
    }
    paint(content, footer);
  }

  async function setLate(minutes) {
    try {
      await publicApi.late(code, minutes);
      toast('主催者に伝えました');
      await load({ code });
    } catch (error) {
      toast(errorText(error));
    }
  }

  async function cancel(event) {
    const yes = await confirmAction({
      title: '申し込みを取り消しますか？', body: `${event.title} への申し込みを取り消します。`, confirmLabel: '取り消す', danger: true,
    });
    if (!yes) return;
    try {
      await publicApi.cancel(code);
      forgetEventGuest();
      refreshEventGuest().catch(() => {});
      await load({ code });
    } catch (error) {
      toast(errorText(error));
    }
  }

  screen('eventMe', { enter: (params) => load(params) });
}
