// 会のあと（#/e/<code>/after）。画面イメージ 16回目の6。
//
// 受付が済んだ人の一覧。「会えてよかった」（相手には知らせない・トグル）と、2人ともメンバーのときだけ「もっと話してみたい」
// （今の話してみたいのボタンをそのまま使う）。メンバーでなくて「本人に確認」の会なら、上に参加の案内とボタン。
// The rules are in event-rules.js afterView / joinView.

import { session } from '../session.js';
import { navigate, screen } from '../router.js';
import { $, avatar, clear, confirmAction, el, toast } from '../ui.js';
import { eventsApi } from '../events-api.js';
import { talkButton } from '../components/talk-button.js';
import { refreshCommunities } from '../communities.js';
import { refreshTalk, talkOptionsForPerson } from '../talk.js';
import { EVENT_WORDS, afterView, errorText, eventHashFor, joinView, validEventCode } from '../event-rules.js';

export function setupEventAfter() {
  const body = $('eventAfterBody');
  const foot = $('eventAfterFoot');
  let code = '';
  let turn = 0;

  const paint = (content, footer = []) => {
    clear(body).append(...content.filter(Boolean));
    clear(foot).append(...footer.filter(Boolean));
    foot.hidden = footer.filter(Boolean).length === 0;
    body.scrollTop = 0;
  };
  const brand = () => el('div', { className: 'ev-brand', text: 'islands' });
  const message = (text, id = 'eventAfterMessage') => paint([brand(), el('h1', { className: 'ev-title', attrs: { id }, text })]);
  const toMe = () => navigate(eventHashFor(code, 'me'));

  async function load(params) {
    const mark = ++turn;
    code = params.code;
    if (!validEventCode(code)) { message(EVENT_WORDS.notFound, 'eventAfterNotFound'); return; }
    if (!session.signedIn()) { navigate(eventHashFor(code, 'apply'), { replace: true }); return; }
    message('読み込んでいます…');
    let result;
    let mine = null;
    try {
      [result, mine] = await Promise.all([eventsApi.after(code), eventsApi.get(code).catch(() => null), refreshTalk().catch(() => {})]);
    } catch (error) {
      if (mark !== turn) return;
      if (error.status === 401) { navigate(eventHashFor(code, 'apply'), { replace: true }); return; }
      // 受付が済んでいない人は、自分のページへ
      if (error.status === 403 || error.status === 404) { navigate(eventHashFor(code, 'me'), { replace: true }); return; }
      message(errorText(error), 'eventAfterNotFound');
      return;
    }
    if (mark !== turn) return;
    if (mine && mine.event && mine.event.title) document.title = `${mine.event.title} | islands`;
    render(result, mine && mine.event);
  }

  function render(result, event) {
    const view = afterView(result);
    const content = [brand(), el('h1', { className: 'ev-title is-mid', attrs: { id: 'eventAfterTitle' }, text: '今日の会で会った人' })];

    if (view.askJoin) {
      const join = joinView({ can_join: true }, event);
      const button = el('button', { className: 'btn btn-block evb-join-btn', text: 'このコミュニティに参加する', attrs: { type: 'button', id: 'eventAfterJoin' } });
      button.addEventListener('click', () => joinCommunity(join, button));
      content.push(el('div', { className: 'ev-card evb-join', attrs: { id: 'eventAfterJoinCard' } }, el('p', { className: 'ev-status-note', text: view.note }), button));
    }

    if (view.empty) {
      content.push(el('p', { className: 'ev-lede', attrs: { id: 'eventAfterEmpty' }, text: 'まだ受付が済んだ人がいません。' }));
    } else {
      content.push(el('ul', { className: 'ev-card evb-people', attrs: { id: 'eventAfterList' } }, ...view.people.map((person) => row(person))));
    }
    paint(content, [el('button', { className: 'btn btn-block ev-primary', text: '終わる', attrs: { type: 'button', id: 'eventAfterDone' }, on: { click: toMe } })]);
  }

  function row(person) {
    let met = person.met;
    const metButton = el('button', { className: `evb-met${met ? ' is-on' : ''}`, text: '会えてよかった', attrs: { type: 'button', 'aria-pressed': String(met), 'data-met': person.id } });
    metButton.addEventListener('click', async () => {
      metButton.disabled = true;
      try {
        const result = await eventsApi.met(code, person.id, !met);
        met = Boolean(result && result.on);
        metButton.classList.toggle('is-on', met);
        metButton.setAttribute('aria-pressed', String(met));
      } catch (error) {
        toast(errorText(error));
      } finally {
        metButton.disabled = false;
      }
    });
    const talk = person.canTalk ? talkOptionsForPerson(person.id, person.name) : null;
    return el('li', { className: 'evb-person', attrs: { 'data-person': person.id || '' } },
      avatar({ icon_id: person.raw.icon_id }, 40, person.raw.avatar_url || null),
      el('div', { className: 'evb-person-main' },
        el('div', { className: 'evb-person-name' }, el('b', { text: person.name })),
        person.sub ? el('div', { className: 'evb-person-sub', text: person.sub }) : null,
        el('div', { className: 'evb-person-actions' }, metButton, talk ? talkButton(talk) : null)));
  }

  async function joinCommunity(join, button) {
    const yes = await confirmAction(join.confirm);
    if (!yes) return;
    button.disabled = true;
    try {
      await eventsApi.join(code);
      await refreshCommunities();
      toast(join.done);
      await load({ code });
    } catch (error) {
      button.disabled = false;
      toast(errorText(error));
    }
  }

  screen('eventAfter', { enter: (params) => load(params), leave: () => { turn += 1; } });
}
