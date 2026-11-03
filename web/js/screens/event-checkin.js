// 受付（#/c/<checkin_code>; /c/<code> is turned into this hash at start-up). 画面イメージ 16回目の4・20回目の2。
//
// A person reads the QR at the 会 and lands here. Signed out: sign in first (LINE, e-mail small; the way back is remembered).
// Then GET /api/checkin/<code> says where they stand, and checkinView (event-rules.js) decides what to show: not yet / over /
// 「受付する」 (applied, or a member) / the two boxes of a walk-in (full name, company) / waiting for the host (read again every
// few seconds) / turned away / done. Done: 「受付しました」, or 「『<コミュニティ名>』のメンバーになりました」 where the
// 会 makes people members at the door; then on to the guest page.

import { config } from '../config.js';
import { session } from '../session.js';
import { state } from '../state.js';
import { navigate, screen } from '../router.js';
import { $, clear, el } from '../ui.js';
import { browserStorage } from '../talk.js';
import { eventsApi } from '../events-api.js';
import { refreshEventGuest } from '../event-guest.js';
import {
  CHECKIN_POLL_MS, EVENT_WORDS, checkinDoneView, checkinView, cleanWalkin, errorText, eventHashFor, rememberCheckinReturn,
  takeCheckinReturn, validEventCode, windowText,
} from '../event-rules.js';
import { PRIVACY_PATH, TERMS_PATH } from '../event-apply-rules.js';
import { loadAfterSignIn } from './event-apply.js';

const link = (text, href) => el('a', { text, attrs: { href, target: '_blank', rel: 'noopener' } });

export function setupEventCheckin() {
  const body = $('eventCheckinBody');
  const foot = $('eventCheckinFoot');
  let code = '';
  let turn = 0;
  let timer = 0;
  let info = null;
  let pendingEmail = '';
  let again = false;        // 「名前を入れ直す」を押した：却下のあとも入力を出す

  const stop = () => { clearTimeout(timer); timer = 0; };

  const paint = (content, footer = []) => {
    clear(body).append(...content.filter(Boolean));
    clear(foot).append(...footer.filter(Boolean));
    foot.hidden = footer.filter(Boolean).length === 0;
    body.scrollTop = 0;
  };
  const brand = () => el('div', { className: 'ev-brand', text: 'islands' });
  const primary = (text, onClick, { id = '', disabled = false } = {}) => el('button', {
    className: 'btn btn-block ev-primary', text, attrs: { type: 'button', ...(id ? { id } : {}), ...(disabled ? { disabled: '' } : {}) }, on: { click: onClick },
  });
  const quiet = (text, onClick) => el('button', { className: 'ev-quiet', text, attrs: { type: 'button' }, on: { click: onClick } });
  const errorBox = () => el('div', { className: 'ev-error', attrs: { id: 'eventCheckinError', role: 'alert' } });
  const setError = (text) => { const node = $('eventCheckinError'); if (node) node.textContent = text || ''; };
  const message = (text, id = 'eventCheckinMessage') => paint([brand(), el('h1', { className: 'ev-title', attrs: { id }, text })]);

  async function load(params) {
    stop();
    const mark = ++turn;
    code = params.code;
    again = false;
    if (!validEventCode(code)) { message('この受付は見つかりません。', 'eventCheckinNotFound'); return; }
    if (!session.signedIn()) { showMethod(); return; }
    message('読み込んでいます…');
    await read(mark);
  }

  /** Read where this person stands and show it. Used again and again while waiting. */
  async function read(mark, { fromWaiting = false } = {}) {
    let next;
    try {
      next = await eventsApi.checkinInfo(code);
    } catch (error) {
      if (mark !== turn) return;
      if (error.status === 401) { session.signOut(); showMethod(); return; }
      if (fromWaiting) { schedule(mark); return; }      // a dropped connection while waiting: try again
      message(error.status === 404 ? 'この受付は見つかりません。' : errorText(error), 'eventCheckinNotFound');
      return;
    }
    if (mark !== turn) return;
    const wasWaiting = Boolean(info) && info.me === 'waiting';
    info = next;
    if (info.event && info.event.title) document.title = `${info.event.title} | islands`;
    show({ joinedByHost: wasWaiting && Boolean(info.is_member) });
  }

  function schedule(mark) {
    stop();
    timer = setTimeout(() => { if (mark === turn) read(mark, { fromWaiting: true }); }, CHECKIN_POLL_MS);
  }

  const heading = () => {
    const event = (info && info.event) || {};
    return [brand(), el('h1', { className: 'ev-title is-mid', attrs: { id: 'eventCheckinTitle' }, text: event.title || '受付' }),
      event.starts_at ? el('div', { className: 'ev-lines' }, el('div', { className: 'ev-line', text: windowText(event) }),
        event.place ? el('div', { className: 'ev-line', text: `場所：${event.place}` }) : null) : null];
  };

  function show({ joinedByHost = false } = {}) {
    const mark = turn;
    const view = checkinView(info);
    const event = (info && info.event) || {};
    stop();
    if (view.kind === 'attended') { done(null, joinedByHost); return; }
    if (view.kind === 'early' || view.kind === 'closed' || view.kind === 'cancelled') {
      paint([...heading(), el('p', { className: 'ev-lede', attrs: { id: 'eventCheckinNote' }, text: view.text })]);
      return;
    }
    if (view.kind === 'waiting') {
      paint([brand(), el('div', { className: 'evb-spinner', attrs: { 'aria-hidden': 'true' } }),
        el('h1', { className: 'ev-title is-mid is-center', attrs: { id: 'eventCheckinWaiting' }, text: EVENT_WORDS.waiting }),
        el('p', { className: 'ev-lede is-center', text: view.text })]);
      schedule(mark);
      return;
    }
    if (view.kind === 'rejected' && !again) {
      paint([brand(), el('div', { className: 'evb-mark is-bad', text: '!' }),
        el('h1', { className: 'ev-title is-mid is-center', attrs: { id: 'eventCheckinRejected' }, text: '受付できませんでした' }),
        el('p', { className: 'ev-lede is-center', text: '主催者に声をかけてください。' }),
        el('p', { className: 'ev-fine ev-center', text: '名前や会社に間違いがあったときは、入れ直せます（3回まで）。' })],
      [primary('名前を入れ直す', () => { again = true; show(); }, { id: 'eventCheckinAgain' })]);
      return;
    }
    if (view.kind === 'blocked') {
      paint([brand(), el('div', { className: 'evb-mark is-bad', text: '!' }),
        el('h1', { className: 'ev-title is-mid is-center', attrs: { id: 'eventCheckinBlocked' }, text: '受付できませんでした' }),
        el('p', { className: 'ev-lede is-center', text: '主催者に声をかけてください。' })]);
      return;
    }
    if (view.kind === 'ready') {
      const button = primary('受付する', () => checkIn(button), { id: 'eventCheckinGo' });
      paint([...heading(), errorBox()], [button]);
      return;
    }
    showWalkin();
  }

  // ---------------------------------------------------------------- 受付する

  async function checkIn(button) {
    const mark = turn;
    button.disabled = true;
    setError('');
    let result;
    try {
      result = await eventsApi.checkin(code);
    } catch (error) {
      if (mark !== turn) return;
      setError(errorText(error));
      button.disabled = false;
      return;
    }
    if (mark !== turn) return;
    if (result && result.result === 'need_walkin') { info = { ...info, me: 'none', is_member: false }; showWalkin(); return; }
    done(result, false);
  }

  /** 受付できた：コミュニティが変わったかもしれないので読み直してから、見出しを出す。 */
  async function done(result, joinedByHost) {
    const mark = turn;
    const event = (info && info.event) || {};
    try { await loadAfterSignIn(); } catch { /* the page does not need it */ }
    await refreshEventGuest().catch(() => {});
    if (mark !== turn) return;
    const shown = checkinDoneView({ joined: Boolean(result && result.joined) || joinedByHost }, event,
      (state.account && state.account.display_name) || '');
    paint([brand(), el('div', { className: 'ev-check', text: '✓' }),
      el('h1', { className: 'ev-title is-mid is-center', attrs: { id: 'eventCheckinDone' }, text: shown.title }),
      shown.note ? el('p', { className: 'ev-lede is-center', attrs: { id: 'eventCheckinDoneNote' }, text: shown.note }) : null],
    event.code ? [primary('参加者を全員見る', () => navigate(eventHashFor(event.code, 'me')), { id: 'eventCheckinToMe' })] : []);
  }

  // ---------------------------------------------------------------- 飛び入り

  function showWalkin() {
    const mark = turn;
    const name = el('input', { className: 'input input-line', attrs: { id: 'eventCheckinName', autocomplete: 'name', maxlength: '32', placeholder: '山田 花子' } });
    const affiliation = el('input', { className: 'input input-line', attrs: { id: 'eventCheckinAffiliation', autocomplete: 'organization', maxlength: '32', placeholder: '株式会社○○' } });
    name.value = (state.account && state.account.display_name) || '';
    affiliation.value = (state.account && state.account.affiliation) || '';
    const send = primary('受付をお願いする', async () => {
      const cleaned = cleanWalkin(name.value, affiliation.value);
      if (!cleaned.ok) { setError(cleaned.message); return; }
      send.disabled = true;
      setError('');
      try {
        await eventsApi.walkin(code, cleaned.body);
      } catch (error) {
        if (mark !== turn) return;
        setError(errorText(error));
        send.disabled = false;
        return;
      }
      if (mark !== turn) return;
      again = false;
      await refreshEventGuest().catch(() => {});
      await read(mark);
    }, { id: 'eventCheckinSend' });
    paint([...heading(),
      el('p', { className: 'ev-lede', text: 'この会の申し込みが見つかりません。\n名前と会社を入れると、主催者が受付します。' }),
      el('label', { className: 'field field-line' }, el('span', { className: 'label-text', text: 'フルネーム' }), name),
      el('label', { className: 'field field-line' }, el('span', { className: 'label-text', text: '会社・所属' }), affiliation),
      el('p', { className: 'ev-fine', text: '質問はありません。この名前は、受付したあとメンバーに見えます。' }),
      errorBox()],
    [el('p', { className: 'ev-consent' }, EVENT_WORDS.consentLead.replace('申し込む', '受付をお願いする'), link('新しい利用規約', TERMS_PATH), 'と',
      link('プライバシーポリシー', PRIVACY_PATH), EVENT_WORDS.consentTail), send]);
  }

  // ---------------------------------------------------------------- ログイン（受付を読むには要る）

  function showMethod() {
    const lineOn = (config().oauth || []).includes('line');
    const footer = [];
    if (lineOn) {
      footer.push(el('button', {
        className: 'btn btn-block ev-line-btn', text: 'LINE で受付する', attrs: { type: 'button', id: 'eventCheckinLine' },
        on: { click: () => { rememberCheckinReturn(browserStorage(), code); session.startOAuth('line', `/c/${code}`); } } }));
    }
    footer.push(el('button', {
      className: lineOn ? 'btn btn-block ev-mail-btn' : 'btn btn-block ev-primary', text: 'メールで受付する',
      attrs: { type: 'button', id: 'eventCheckinMail' }, on: { click: () => showEmail() } }));
    footer.push(el('p', { className: 'ev-fine ev-center' }, link('運営者と個人情報の扱いについて', PRIVACY_PATH)));
    paint([brand(), el('h1', { className: 'ev-title is-mid', text: '受付のために\nログインしてください' }),
      el('p', { className: 'ev-lede', text: '申し込んだときと同じ方法でログインすると、すぐに受付できます。' })], footer);
  }

  function showEmail() {
    const email = el('input', { className: 'input input-line', attrs: { id: 'eventCheckinEmail', type: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'you@example.com' } });
    const next = primary('次へ', async () => {
      next.disabled = true;
      setError('');
      try {
        rememberCheckinReturn(browserStorage(), code);   // 届いたメールのリンクは「/」に戻るので、先に覚える
        const result = await session.requestCode(email.value);
        pendingEmail = result.email;
        showCode(result.devCode);
      } catch (error) {
        setError(error.message);
        next.disabled = !email.value.includes('@');
      }
    }, { disabled: true, id: 'eventCheckinEmailNext' });
    email.addEventListener('input', () => { next.disabled = !email.value.includes('@'); setError(''); });
    email.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !next.disabled) next.click(); });
    paint([brand(), el('h1', { className: 'ev-title is-mid', text: 'メールアドレスを\n入力してください' }),
      el('label', { className: 'field field-line' }, el('span', { className: 'label-text', text: 'メールアドレス' }), email), errorBox()],
    [next, quiet('もどる', () => showMethod())]);
    email.focus();
  }

  function showCode(devCode) {
    const input = el('input', { className: 'input input-line', attrs: { id: 'eventCheckinCode', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: 'コード' } });
    const verify = primary('次へ', async () => {
      verify.disabled = true;
      setError('');
      try {
        await session.verifyCode(pendingEmail, input.value);
        takeCheckinReturn(browserStorage());   // この画面のまま続けるので、覚えておいた戻り先はもう要らない
        await loadAfterSignIn();
        await load({ code });
      } catch (error) {
        setError(error.message);
        verify.disabled = input.value.trim().length < 4;
      }
    }, { disabled: true, id: 'eventCheckinCodeNext' });
    input.addEventListener('input', () => { verify.disabled = input.value.trim().length < 4; setError(''); });
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !verify.disabled) verify.click(); });
    paint([brand(), el('h1', { className: 'ev-title is-mid', text: 'コードを\n入力してください' }),
      el('p', { className: 'ev-lede', text: `送り先：${pendingEmail}` }),
      devCode ? el('div', { className: 'dev-code ev-dev' }, el('span', { className: 'dev-code-label', text: 'ローカルモードのパスコード' }),
        el('strong', { className: 'dev-code-value num', text: devCode })) : null,
      el('label', { className: 'field field-line' }, el('span', { className: 'label-text', text: 'コード' }), input), errorBox()],
    [verify, quiet('もどる', () => showEmail())]);
    input.focus();
  }

  screen('eventCheckin', {
    enter: async (params) => {
      // LINE ログインから戻ってきた：覚えておいた戻り先は使い終わり
      if (session.signedIn() && peekedBack(params.code)) await loadAfterSignIn().catch(() => {});
      return load(params);
    },
    leave: () => { turn += 1; stop(); },
  });

  function peekedBack(checkinCode) { return takeCheckinReturn(browserStorage()) === checkinCode; }
}
