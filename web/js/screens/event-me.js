// The guest page of a 会 (#/e/<code>/me; 画面イメージ 16回目の3・20回目の3・4): what the person applied to, how it stands, and the
// buttons for being late and for cancelling. This is the page the LINE buttons open, and the only one a guest may
// open besides the public page. 第2回b: it also shows how the 会 stands (開催決定・中止), the participants' list (never
// for a cancelled 会, never an age), the cancel deadline, and 「このコミュニティに参加する」 for a 会 whose people choose.
//
// The rules (which state says what) are in event-rules.js (statusView, cancelView, joinView, participantsView).

import { session } from '../session.js';
import { state } from '../state.js';
import { navigate, screen } from '../router.js';
import { $, avatar, clear, confirmAction, el, toast } from '../ui.js';
import { eventsApi } from '../events-api.js';
import { refreshEventGuest } from '../event-guest.js';
import { refreshCommunities } from '../communities.js';
import { refreshTalk } from '../talk.js';
import {
  EVENT_B_WORDS, EVENT_WORDS, afterLinkShown, calendarUrl, cancelView, errorText, eventHashFor, eventStageView, joinView, lateChoices,
  listAllowed, mapUrl, meRedirect, participantsView, personView, statusView, validEventCode, windowText,
} from '../event-rules.js';
import { canAddFriend, friendUrl } from './event-apply.js';

export function setupEventMe() {
  const body = $('eventMeBody');
  const foot = $('eventMeFoot');
  let code = '';
  let turn = 0;
  let joinedNow = '';       // 「メンバーになりました」の文：参加ボタンを押したあと、ページを開き直すまで

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
    if (!session.signedIn()) { navigate(eventHashFor(code, 'apply'), { replace: true }); return; }
    message('読み込んでいます…');
    let result;
    try {
      result = await eventsApi.get(code);
    } catch (error) {
      if (mark !== turn) return;
      if (error.status === 401) { navigate(eventHashFor(code, 'apply'), { replace: true }); return; }
      message(error.status === 404 ? EVENT_WORDS.notFound : errorText(error), 'eventMeNotFound');
      return;
    }
    if (mark !== turn) return;
    // 申し込んでいない人や主催者が開いたら、空白にせず公開ページ（主催者は主催者の画面）へ
    const elsewhere = meRedirect(result, code);
    if (elsewhere) { navigate(elsewhere, { replace: true }); return; }
    document.title = result.event.title ? `${result.event.title} | islands` : 'islands';
    // 参加者リスト：読めなくても（SQL がまだ・見られない人）、限定ページは今までどおり出す
    let people = null;
    if (listAllowed(result.event)) {
      try { people = await eventsApi.participants(code); } catch { people = null; }
      if (mark !== turn) return;
    }
    render(result, people);
  }

  function render(result, peopleData = null) {
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

    // 開催の段階（最小人数のある会だけ）
    const stage = eventStageView(event);
    if (stage && view.tone !== 'cancelled') {
      content.push(el('div', { className: `evb-stage is-${stage.tone}`, attrs: { id: 'eventMeStage' } },
        el('b', { text: stage.label }), stage.note ? el('span', { text: stage.note }) : null));
    }

    // How it stands.
    const status = el('div', { className: `ev-card ev-status is-${view.tone}`, attrs: { id: 'eventMeStatus' } });
    if (view.title && view.tone !== 'cancelled') status.append(el('div', { className: 'ev-status-title', text: (view.tone === 'ok' || view.tone === 'attended' ? '✓ ' : '') + view.title }));
    if (view.note) status.append(el('p', { className: 'ev-status-note', text: view.note }));
    if (me.late_minutes && view.canLate) {
      status.append(el('p', { className: 'ev-status-note', attrs: { id: 'eventMeLateNote' },
        text: `${me.late_minutes === 60 ? '1時間以上' : `${me.late_minutes}分くらい`}遅れることを、主催者に伝えました。` }));
    }
    if ((view.title && view.tone !== 'cancelled') || view.note) content.push(status);

    // このコミュニティに参加する（「本人に確認」の会で、受付が済んだ人）
    const join = joinView(me, event);
    if (joinedNow) {
      content.push(el('div', { className: 'ev-card evb-join is-done', attrs: { id: 'eventMeJoined' } },
        el('div', { className: 'ev-status-title', text: `✓ ${joinedNow}` }),
        el('button', { className: 'btn btn-block evb-join-btn', text: 'マップを開く', attrs: { type: 'button', id: 'eventMeJoinedMap' }, on: { click: () => navigate('#/map') } })));
    } else if (join.show) {
      const button = el('button', { className: 'btn btn-block evb-join-btn', text: 'このコミュニティに参加する', attrs: { type: 'button', id: 'eventMeJoin' } });
      button.addEventListener('click', () => joinCommunity(join, button));
      content.push(el('div', { className: 'ev-card evb-join', attrs: { id: 'eventMeJoinCard' } }, el('p', { className: 'ev-status-note', text: join.lead }), button));
    }

    // Being late: one tap on a button, no typing.
    if (view.canLate) {
      content.push(el('h2', { className: 'ev-sub', text: '遅れるときは' }),
        el('div', { className: 'ev-late', attrs: { id: 'eventMeLate' } }, ...lateChoices(me.late_minutes).map((choice) => el('button', {
          className: `ev-late-btn${choice.selected ? ' is-on' : ''}`, text: choice.label,
          attrs: { type: 'button', 'data-minutes': String(choice.minutes), 'aria-pressed': String(choice.selected) },
          on: { click: () => setLate(choice.minutes) } }))));
    }

    const listed = participantsView(peopleData, event);
    if (listed) content.push(...peopleList(listed));

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
    const cancelling = cancelView(me, event);
    if (cancelling.note) footer.push(el('p', { className: 'ev-fine ev-center', attrs: { id: 'eventMeCancelNote' }, text: cancelling.note }));
    if (cancelling.canCancel) {
      footer.push(el('button', { className: 'ev-quiet', text: 'キャンセルする', attrs: { type: 'button', id: 'eventMeCancel' }, on: { click: () => cancel(event) } }));
    }
    if (afterLinkShown(me, event)) {
      footer.unshift(el('button', { className: 'btn btn-block ev-primary', text: EVENT_B_WORDS.afterLink, attrs: { type: 'button', id: 'eventMeAfter' },
        on: { click: () => navigate(eventHashFor(code, 'after')) } }));
    }
    if (me.is_member && state.communities.length) {
      footer.push(el('button', { className: 'ev-quiet', text: 'マップを開く', attrs: { type: 'button', id: 'eventMeMap' }, on: { click: () => navigate('#/map') } }));
    }
    paint(content, footer);
  }

  /** 参加者リスト：近いかも（最大3人）→ みんな。年代は出さない。 */
  function peopleList(listed) {
    const row = (person, near) => {
      const shown = personView(person);
      return el('li', { className: `evb-person${shown.isMe ? ' is-me' : ''}`, attrs: { 'data-person': shown.id || '' } },
        avatar({ icon_id: person.icon_id, avatar_path: person.avatar_path }, 40, person.avatar_url || null),
        el('div', { className: 'evb-person-main' },
          el('div', { className: 'evb-person-name' }, el('b', { text: shown.name }),
            ...shown.badges.map((badge) => el('span', { className: `evb-badge is-${badge.key}`, text: badge.text }))),
          shown.sub ? el('div', { className: 'evb-person-sub', text: shown.sub }) : null,
          near && shown.reason ? el('div', { className: 'evb-person-reason', text: shown.reason }) : null,
          ...shown.answers.map((answer) => el('div', { className: 'evb-person-answer' },
            answer.label ? el('small', { text: answer.label }) : null, el('span', { text: answer.body })))));
    };
    const blocks = [];
    if (listed.near.length) {
      blocks.push(el('h2', { className: 'ev-sub', text: '近いかも' }),
        el('ul', { className: 'ev-card evb-people', attrs: { id: 'eventMeNear' } }, ...listed.near.map((person) => row(person, true))));
    }
    blocks.push(el('h2', { className: 'ev-sub', attrs: { id: 'eventMePeopleTitle' }, text: `参加者 ${listed.count}人` }),
      el('ul', { className: 'ev-card evb-people', attrs: { id: 'eventMePeople' } }, ...listed.rest.map((person) => row(person, false))));
    return blocks;
  }

  async function joinCommunity(join, button) {
    const yes = await confirmAction(join.confirm);
    if (!yes) return;
    button.disabled = true;
    try {
      await eventsApi.join(code);
      await refreshCommunities();
      refreshTalk().catch(() => {});
      joinedNow = join.done;
      await load({ code });
    } catch (error) {
      button.disabled = false;
      toast(errorText(error));
    }
  }

  async function setLate(minutes) {
    try {
      await eventsApi.late(code, minutes);
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
      await eventsApi.cancel(code);
      await refreshEventGuest().catch(() => {});
      await load({ code });
    } catch (error) {
      toast(errorText(error));
    }
  }

  screen('eventMe', { enter: (params) => { joinedNow = ''; return load(params); } });
}
