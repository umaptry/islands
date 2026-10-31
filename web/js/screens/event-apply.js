// The public page of a 会 and the steps of applying (#/e/<code>; /e/<code> is turned into this hash at start-up).
// 画面イメージ 16回目の1・2、20回目の3・4。
//
// A person who is not signed in sees the 会 and the counts (nothing else: E 8), may try 「近い人が来るか見てみる」,
// and signs in (LINE first, e-mail small). Then the steps: あなたについて (only when the name is not confirmed yet)
// -> きっかけ -> up to three questions (two answers are enough) -> done. A member of the community applies with one tap.
// The rules are in event-rules.js and event-apply-rules.js; the calls are in event-public-api.js.

import { config } from '../config.js';
import { api } from '../net.js';
import { session } from '../session.js';
import { state } from '../state.js';
import { navigate, screen } from '../router.js';
import { $, clear, el, toast } from '../ui.js';
import { browserStorage } from '../talk.js';
import { publicApi } from '../event-public-api.js';
import { noteEventGuest, refreshEventGuest } from '../event-guest.js';
import {
  EVENT_WORDS, applyView, breakdownRows, calendarUrl, cleanInterests, countView, errorText, eventHashFor, probeDraft,
  probeView, rememberApplyReturn, saveProbeDraft, takeApplyReturn, validEventCode, windowText,
} from '../event-rules.js';
import {
  APPLY_WORDS, ANSWER_MAX, PRIVACY_PATH, QUESTION_EXAMPLES, TERMS_PATH, ageChoices, answersNeeded, applyBody,
  applySteps, canSubmit, cleanAnswer, collectAnswers, stepAfter, stepBefore, validateProfile,
} from '../event-apply-rules.js';

const link = (text, href) => el('a', { text, attrs: { href, target: '_blank', rel: 'noopener' } });

/** Does this person get the LINE friend button? Not somebody who signed in with Google (their LINE is not linked). */
export function canAddFriend() {
  const url = config().line && config().line.add_friend_url;
  return Boolean(url) && session.provider() !== 'google';
}

export const friendUrl = () => (config().line && config().line.add_friend_url) || '';

/** After signing in on one of these pages: what boot() and afterSignIn() would have read. Quiet on failure. */
export async function loadAfterSignIn() {
  try {
    state.account = (await api.get('/api/account/me')).account;
  } catch (error) {
    throw error;
  }
  const tasks = [];
  try {
    const { refreshCommunities, refreshJoinStatus } = await import('../communities.js');
    tasks.push(refreshCommunities().then(() => refreshJoinStatus()));
    const map = await import('./map.js');
    const notifications = await import('./notifications.js');
    const talk = await import('../talk.js');
    if (state.account && state.account.display_name) {
      tasks.push(map.refreshMyPosts(), map.refreshMyReactions(), notifications.refreshNotifications(), talk.refreshTalk());
    }
  } catch { /* the page does not need them */ }
  await Promise.allSettled(tasks);
}

export function setupEventApply() {
  const body = $('eventApplyBody');
  const foot = $('eventApplyFoot');

  let code = '';
  let info = null;            // GET /api/public/events/<code>
  let mine = null;            // GET /api/events/<code> (signed in)
  let turn = 0;               // a late answer of an older screen is dropped
  let flow = freshFlow();
  let pendingEmail = '';

  function freshFlow() {
    return { steps: [], typed: {}, profile: { name: '', age: '', affiliation: '', job: '' }, referral: '', interests: [], isMember: false };
  }

  // ---------------------------------------------------------------- pieces

  const brand = () => el('div', { className: 'ev-brand', text: 'islands' });

  function paint(content, footer = []) {
    clear(body).append(...content.filter(Boolean));
    clear(foot).append(...footer.filter(Boolean));
    foot.hidden = footer.filter(Boolean).length === 0;
    body.scrollTop = 0;
  }

  const primary = (text, onClick, { disabled = false, id = null } = {}) => el('button', {
    className: 'btn btn-block ev-primary', text, attrs: { type: 'button', id }, disabled, on: { click: onClick },
  });
  const quiet = (text, onClick, { id = null } = {}) => el('button', { className: 'ev-quiet', text, attrs: { type: 'button', id }, on: { click: onClick } });
  const errorBox = () => el('div', { className: 'error ev-error', attrs: { role: 'alert', id: 'eventApplyError' } });
  const setError = (message) => { const box = $('eventApplyError'); if (box) box.textContent = message || ''; };

  const consentNote = () => el('p', { className: 'ev-consent', id: 'eventConsent' },
    EVENT_WORDS.consentLead, link('新しい利用規約', TERMS_PATH), 'と', link('プライバシーポリシー', PRIVACY_PATH), EVENT_WORDS.consentTail);

  function titleBlock() {
    const lines = [];
    const when = windowText(info);
    if (when) lines.push(el('div', { className: 'ev-line', text: when }));
    if (info.place) lines.push(el('div', { className: 'ev-line', text: `会場：${info.place}` }));
    if (info.host_name) lines.push(el('div', { className: 'ev-line', text: `主催：${info.host_name}` }));
    return [el('h1', { className: 'ev-title', text: info.title }), el('div', { className: 'ev-lines' }, ...lines)];
  }

  function smallTitle() {
    return el('div', { className: 'ev-small' },
      el('div', { className: 'ev-small-title', text: info.title }), el('div', { className: 'ev-small-when', text: windowText(info) }));
  }

  // ---------------------------------------------------------------- A: the 会 and who is coming

  function genreDot(label) {
    const colors = config().island_colors || [];
    if (!colors.length) return null;
    let hash = 0;
    for (const ch of Array.from(label)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return el('span', { className: 'ev-dot', style: { background: colors[hash % colors.length] } });
  }

  function peopleCard() {
    const count = countView(info);
    const rows = breakdownRows(info.breakdown);
    const card = el('div', { className: 'ev-card', id: 'eventCount' });
    card.append(el('div', { className: 'ev-count' },
      el('span', { className: 'ev-count-n num', text: String(count.count) }), el('span', { className: 'ev-count-u', text: '人' }),
      el('span', { className: 'ev-count-l', text: '参加予定' }),
      count.capacityText ? el('span', { className: 'ev-cap', text: count.capacityText }) : null));
    for (const row of rows) {
      card.append(el('div', { className: 'ev-break', attrs: { 'data-kind': row.key } },
        el('div', { className: 'ev-break-title', text: row.title }),
        el('div', { className: 'ev-break-items' }, ...row.items.map((item) => el('span', { className: 'ev-break-item' },
          row.key === 'genre' ? genreDot(item.label) : null, `${item.label} `, el('b', { className: 'num', text: String(item.count) }))))));
    }
    if (rows.length) card.append(el('p', { className: 'ev-fine', text: '2人以下の区分は「ほか」にまとめます。' }));
    return card;
  }

  function closedBand(view) {
    if (!view.band) return null;
    return el('div', { className: `ev-band ${view.state === 'cancelled' ? 'is-red' : 'is-amber'}`, id: 'eventBand', text: view.band });
  }

  function showInfo() {
    const view = applyView(info);
    const content = [closedBand(view), brand(), ...titleBlock()];
    if (view.state !== 'cancelled') {
      content.push(el('h2', { className: 'ev-sub', text: 'どんな人が来る？' }), peopleCard());
    }
    const footer = [];
    if (view.canApply) {
      const probeOn = Boolean(config().features && config().features.probe);
      if (probeOn) footer.push(primary(EVENT_WORDS.probe, () => showProbe(), { id: 'eventProbeOpen' }));
      footer.push(probeOn
        ? quiet(EVENT_WORDS.applyNow, () => proceed(), { id: 'eventApplyNow' })
        : primary(EVENT_WORDS.applyTo, () => proceed(), { id: 'eventApplyNow' }));
      footer.push(el('p', { className: 'ev-fine ev-center', text: 'このページは検索エンジンには載りません。' }));
    }
    paint(content, footer);
    const now = $('eventApplyNow');
    if (now) now.id = 'eventApplyNow';
  }

  // ---------------------------------------------------------------- B: the probe

  function showProbe(result = null, message = '') {
    flow.interests = flow.interests.length ? flow.interests : probeDraft(browserStorage(), code);
    const input = el('input', {
      className: 'input input-line ev-interest', attrs: { id: 'eventInterest', maxlength: '30', placeholder: '例：キャンプ飯', autocomplete: 'off', enterkeyhint: 'done' },
    });
    const add = () => {
      const value = input.value.replace(/\s+/g, ' ').trim();
      if (!value || flow.interests.length >= 2 || flow.interests.includes(value)) { input.value = ''; return; }
      flow.interests = [...flow.interests, value];
      input.value = '';
      run();
    };
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } });
    const chips = el('div', { className: 'ev-chips', id: 'eventInterests' }, ...flow.interests.map((item) => el('button', {
      className: 'ev-chip is-on', text: `${item} ×`, attrs: { type: 'button', 'aria-label': `${item} を外す` },
      on: { click: () => { flow.interests = flow.interests.filter((x) => x !== item); run(); } },
    })));
    const resultCard = el('div', { className: 'ev-card ev-result', id: 'eventProbeResult' });
    if (result) {
      const words = probeView(result);
      resultCard.append(el('div', { className: 'ev-result-lead', text: words.lead }),
        el('div', { className: 'ev-result-n' }, el('span', { className: 'num', text: words.number }), words.unit ? el('span', { className: 'ev-result-u', text: words.unit }) : null),
        el('div', { className: 'ev-result-lead', text: words.tail }),
        el('div', { className: 'ev-dots' }, ...(result.genres || []).map((genre) => el('span', {
          className: 'ev-dot is-big', style: { background: genre.color }, attrs: { title: genre.genre, 'aria-label': genre.genre } }))),
        el('div', { className: 'ev-fine', text: '名前や顔は出ません' }));
    } else if (message) {
      resultCard.append(el('div', { className: 'ev-result-lead', text: message }));
    } else {
      resultCard.append(el('div', { className: 'ev-result-lead', text: '興味を入れると、近そうな人の数が分かります。' }));
    }
    paint([
      brand(), el('h1', { className: 'ev-title is-mid', text: 'あなたの興味を\n1〜2個入れてみて' }),
      el('p', { className: 'ev-lede', text: '入れると、近そうな人の数が分かります。' }),
      chips,
      flow.interests.length < 2 ? el('div', { className: 'ev-add' }, input, el('button', {
        className: 'ev-chip', text: '＋ ひとつ足す', attrs: { type: 'button', id: 'eventInterestAdd' }, on: { click: add } })) : null,
      resultCard,
      el('p', { className: 'ev-fine', text: '入れた興味は、申し込むときにそのまま引き継ぎます。' }),
    ], [
      primary(EVENT_WORDS.applyTo, () => proceed(), { id: 'eventApplyNow' }),
      quiet('もどる', () => showInfo()),
    ]);
    if (flow.interests.length < 2) input.focus();

    async function run() {
      saveProbeDraft(browserStorage(), code, flow.interests);
      const mark = ++turn;
      if (!flow.interests.length) { showProbe(); return; }
      let answer = null;
      let note = '';
      try {
        answer = await publicApi.probe(code, flow.interests);
      } catch (error) {
        note = errorText(error);
      }
      if (mark !== turn) return;
      showProbe(answer, note);
    }
  }

  // ---------------------------------------------------------------- C: how to apply (signed out)

  function showMethod() {
    const providers = config().oauth || [];
    const lineOn = providers.includes('line');
    const content = [
      brand(), el('h1', { className: 'ev-title is-mid', text: '申し込みの方法を\n選んでください' }), smallTitle(),
    ];
    const footer = [];
    if (lineOn) {
      footer.push(el('div', { className: 'ev-why' },
        el('b', { text: 'LINE で申し込むと' }),
        el('ul', {}, ...['1週間前と当日にリマインドが届く', '遅刻・キャンセルはボタン1つで連絡できる', '近い人をいつでも見られる'].map((t) => el('li', { text: `✓ ${t}` })))));
      footer.push(el('div', { className: 'ev-line-wrap' },
        el('span', { className: 'ev-tag', text: 'おすすめ' }),
        el('button', {
          className: 'btn btn-block ev-line-btn', text: 'LINE で申し込む', attrs: { type: 'button', id: 'eventLine' },
          on: { click: () => { rememberApplyReturn(browserStorage(), code); session.startOAuth('line', `/e/${code}`); } } })));
      footer.push(el('button', {
        className: 'btn btn-block ev-mail-btn', text: 'メールで申し込む', attrs: { type: 'button', id: 'eventMail' }, on: { click: () => showEmail() } }));
      footer.push(el('p', { className: 'ev-fine ev-center', text: 'メールの場合、遅刻・キャンセルはメールの返信で' }));
    } else {
      footer.push(primary('メールで申し込む', () => showEmail(), { id: 'eventMail' }));
    }
    footer.push(el('p', { className: 'ev-fine ev-center' }, link('運営者と個人情報の扱いについて', PRIVACY_PATH)));
    paint(content, footer);
  }

  function showEmail(message = '') {
    const email = el('input', {
      className: 'input input-line', attrs: { id: 'eventEmail', type: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'you@example.com' },
    });
    const send = primary('次へ', async () => {
      send.disabled = true;
      setError('');
      try {
        const result = await session.requestCode(email.value);
        pendingEmail = result.email;
        showCode(result.devCode);
      } catch (error) {
        setError(error.message);
        send.disabled = !email.value.includes('@');
      }
    }, { disabled: true, id: 'eventEmailNext' });
    email.addEventListener('input', () => { send.disabled = !email.value.includes('@'); setError(''); });
    email.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !send.disabled) send.click(); });
    paint([
      brand(), el('h1', { className: 'ev-title is-mid', text: 'メールアドレスを\n入力してください' }), smallTitle(),
      el('label', { className: 'field field-line' }, el('span', { className: 'label-text', text: 'メールアドレス' }), email),
      el('p', { className: 'ev-fine', text: '届いたコードで確かめます。' }), errorBox(),
    ], [send, quiet('もどる', () => showMethod())]);
    if (message) setError(message);
    email.focus();
  }

  function showCode(devCode) {
    const input = el('input', {
      className: 'input input-line', attrs: { id: 'eventCode', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: 'コード' },
    });
    const verify = primary('次へ', async () => {
      verify.disabled = true;
      setError('');
      try {
        await session.verifyCode(pendingEmail, input.value);
        await loadAfterSignIn();
        await begin();
      } catch (error) {
        setError(error.message);
        verify.disabled = input.value.trim().length < 4;
      }
    }, { disabled: true, id: 'eventCodeNext' });
    input.addEventListener('input', () => { verify.disabled = input.value.trim().length < 4; setError(''); });
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !verify.disabled) verify.click(); });
    paint([
      brand(), el('h1', { className: 'ev-title is-mid', text: 'コードを\n入力してください' }),
      el('p', { className: 'ev-lede', text: `送り先：${pendingEmail}` }),
      devCode ? el('div', { className: 'dev-code ev-dev' }, el('span', { className: 'dev-code-label', text: 'ローカルモードのパスコード' }),
        el('strong', { className: 'dev-code-value num', text: devCode })) : null,
      el('label', { className: 'field field-line' }, el('span', { className: 'label-text', text: 'コード' }), input), errorBox(),
    ], [verify, quiet('もどる', () => showEmail())]);
    input.focus();
  }

  // ---------------------------------------------------------------- the steps

  /** The button of "申し込みに進む": signed out -> how to apply; signed in -> the steps. */
  async function proceed() {
    if (!session.signedIn()) { showMethod(); return; }
    await begin();
  }

  async function begin() {
    const mark = ++turn;
    paint([brand(), el('p', { className: 'ev-lede', text: '確認しています…' })]);
    try {
      mine = await publicApi.get(code);
    } catch (error) {
      if (mark !== turn) return;
      if (error.status === 401) { session.signOut(); showMethod(); return; }
      paint([brand(), el('p', { className: 'ev-lede', text: errorText(error) })], [quiet('もどる', () => showInfo())]);
      return;
    }
    if (mark !== turn) return;
    const me = mine.me || {};
    if (['applied', 'attended', 'waiting'].includes(me.status)) { navigate(eventHashFor(code, 'me'), { replace: true }); return; }
    if (mine.event && mine.event.cancelled) { navigate(eventHashFor(code, 'me'), { replace: true }); return; }
    if (me.status === 'declined') { navigate(eventHashFor(code, 'me'), { replace: true }); return; }
    const account = state.account || {};
    const settled = Boolean(account.display_name && account.affiliation && account.name_confirmed_at);
    flow.isMember = Boolean(me.is_member);
    const questions = (mine.event && mine.event.questions) || info.questions || [];
    flow.questions = questions;
    flow.steps = applySteps({ nameConfirmed: settled, isMember: flow.isMember, questions });
    flow.profile.name = flow.profile.name || account.display_name || '';
    flow.profile.affiliation = flow.profile.affiliation || account.affiliation || '';
    flow.profile.age = flow.profile.age || account.age_band || '';
    flow.profile.job = flow.profile.job || account.job_title || '';
    // The interests typed for the probe become the draft of 「いまやってること」.
    const drafted = flow.interests.length ? flow.interests : probeDraft(browserStorage(), code);
    if (drafted.length && !flow.typed.now && flow.steps.includes('q:now')) flow.typed.now = drafted.join('、');
    if (!flow.steps.length) { showMember(); return; }
    showStep(flow.steps[0]);
  }

  const stepNumber = (id) => flow.steps.indexOf(id);

  function progress(id) {
    if (flow.steps.length < 2) return null;
    return el('div', { className: 'ev-progress', attrs: { 'aria-hidden': 'true' } },
      ...flow.steps.map((step, index) => el('span', { className: index <= stepNumber(id) ? 'is-on' : '' })));
  }

  function goBack(id) {
    const before = stepBefore(flow.steps, id);
    if (before) showStep(before); else showInfo();
  }

  const isLast = (id) => stepAfter(flow.steps, id) === null;

  function showStep(id) {
    if (id === 'profile') showProfile();
    else if (id === 'referral') showReferral();
    else showQuestion(id.slice(2));
  }

  function advance(id) {
    const next = stepAfter(flow.steps, id);
    if (next) showStep(next); else submit();
  }

  function consentFor(id) {
    return isLast(id) ? consentNote() : null;
  }

  function showProfile() {
    const bands = ageChoices(config().age_bands);
    const needGuest = !flow.isMember;
    const name = el('input', { className: 'input input-line', attrs: { id: 'eventName', autocomplete: 'name', maxlength: String((config().limits || {}).name_max || 24) } });
    const affiliation = el('input', { className: 'input input-line', attrs: { id: 'eventAffiliation', autocomplete: 'organization', maxlength: '32', placeholder: APPLY_WORDS.affiliationPlaceholder } });
    const job = el('input', { className: 'input input-line', attrs: { id: 'eventJob', maxlength: '32', placeholder: APPLY_WORDS.jobPlaceholder } });
    name.value = flow.profile.name; affiliation.value = flow.profile.affiliation; job.value = flow.profile.job;
    const chips = el('div', { className: 'ev-chips', id: 'eventAges' });
    const paintAges = () => {
      clear(chips).append(...bands.map((band) => el('button', {
        className: `ev-chip${flow.profile.age === band.key ? ' is-on' : ''}`, text: band.label,
        attrs: { type: 'button', 'aria-pressed': String(flow.profile.age === band.key), 'data-age': band.key },
        on: { click: () => { flow.profile.age = band.key; paintAges(); sync(); } },
      })));
    };
    const next = primary(isLast('profile') ? APPLY_WORDS.submit : APPLY_WORDS.next, () => {
      read();
      const check = validateProfile(flow.profile, { needGuest, ageKeys: bands.map((b) => b.key), nameMax: (config().limits || {}).name_max || 24 });
      if (!check.ok) { setError(check.message); return; }
      flow.cleanProfile = check.profile;
      advance('profile');
    }, { id: 'eventStepNext' });
    const read = () => { flow.profile.name = name.value; flow.profile.affiliation = affiliation.value; flow.profile.job = job.value; };
    const sync = () => { read(); next.disabled = !name.value.trim() || !affiliation.value.trim() || (needGuest && !flow.profile.age); setError(''); };
    [name, affiliation, job].forEach((input) => input.addEventListener('input', sync));
    paintAges();
    paint([
      progress('profile'), el('h1', { className: 'ev-title is-mid', text: APPLY_WORDS.aboutTitle }),
      !needGuest ? el('p', { className: 'ev-lede', text: APPLY_WORDS.fullnameLead }) : null,
      el('label', { className: 'field field-line' }, el('span', { className: 'label-text', text: APPLY_WORDS.nameLabel }), name,
        el('span', { className: 'ev-hint', text: APPLY_WORDS.nameNote })),
      needGuest ? el('div', { className: 'field field-line' }, el('span', { className: 'label-text', text: APPLY_WORDS.ageLabel }), chips) : null,
      el('label', { className: 'field field-line' }, el('span', { className: 'label-text', text: APPLY_WORDS.affiliationLabel }), affiliation,
        el('span', { className: 'ev-hint', text: APPLY_WORDS.affiliationNote })),
      needGuest ? el('label', { className: 'field field-line' }, el('span', { className: 'label-text', text: APPLY_WORDS.jobLabel }), job) : null,
      errorBox(),
    ], [next, consentFor('profile'), quiet('もどる', () => goBack('profile'))]);
    sync();
    setError('');
  }

  function showReferral() {
    const choices = config().referral_choices || [];
    const next = primary(isLast('referral') ? APPLY_WORDS.submit : APPLY_WORDS.next, () => advance('referral'), { disabled: !flow.referral, id: 'eventStepNext' });
    const list = el('div', { className: 'ev-choices', id: 'eventReferral' });
    const paintList = () => {
      clear(list).append(...choices.map((choice) => el('button', {
        className: `ev-choice${flow.referral === choice ? ' is-on' : ''}`, text: choice,
        attrs: { type: 'button', 'aria-pressed': String(flow.referral === choice) },
        on: { click: () => { flow.referral = choice; next.disabled = false; paintList(); } },
      })));
    };
    paintList();
    paint([
      progress('referral'), el('h1', { className: 'ev-title is-mid', text: APPLY_WORDS.referralTitle }),
      el('p', { className: 'ev-lock', text: `🔒 ${APPLY_WORDS.referralNote}` }), list, errorBox(),
    ], [next, consentFor('referral'), quiet('もどる', () => goBack('referral'))]);
  }

  function showQuestion(prompt) {
    const question = (flow.questions || []).find((item) => item.prompt === prompt) || { label: '', hint: '' };
    const id = `q:${prompt}`;
    const index = flow.steps.filter((step) => step.startsWith('q:')).indexOf(id);
    const total = flow.steps.filter((step) => step.startsWith('q:')).length;
    const need = answersNeeded((flow.questions || []).length);
    const area = el('textarea', {
      className: 'ev-answer', attrs: { id: 'eventAnswer', rows: '4', maxlength: String(ANSWER_MAX), placeholder: 'ここに書く', autocomplete: 'off' },
    });
    area.value = flow.typed[prompt] || '';
    const count = el('div', { className: 'ev-count-chars num' });
    const answered = () => collectAnswers(flow.questions, { ...flow.typed, [prompt]: area.value }).length;
    const last = isLast(id);
    const next = primary(last ? APPLY_WORDS.submit : APPLY_WORDS.next, () => {
      const check = cleanAnswer(area.value);
      if (!check.ok) { setError(check.message); return; }
      flow.typed[prompt] = check.body;
      advance(id);
    }, { id: 'eventStepNext' });
    const early = quiet(APPLY_WORDS.applyHere, () => {
      const check = cleanAnswer(area.value);
      if (!check.ok) { setError(check.message); return; }
      flow.typed[prompt] = check.body;
      submit();
    });
    early.id = 'eventApplyEarly';
    const sync = () => {
      const have = answered();
      count.textContent = `${Array.from(area.value).length}/${ANSWER_MAX}`;
      // Enough answered: a blank question may be passed; not enough: this one has to be written.
      next.disabled = last ? have < need : (have < need && !area.value.trim());
      early.hidden = last || have < need;
      note.hidden = have < need;
      setError('');
    };
    const note = el('div', { className: 'ev-early', text: APPLY_WORDS.early, hidden: true });
    area.addEventListener('input', sync);
    paint([
      progress(id), el('div', { className: 'ev-qno num', text: `${index + 1} / ${total}` }), note,
      el('h1', { className: 'ev-title is-mid', text: question.label || '' }),
      el('p', { className: 'ev-lede', text: question.hint ? `${APPLY_WORDS.questionLead}、${APPLY_WORDS.questionOne}（${question.hint}）` : `${APPLY_WORDS.questionLead}\n${APPLY_WORDS.questionOne}` }),
      area, count, el('p', { className: 'ev-hint', text: QUESTION_EXAMPLES[prompt] || '' }), errorBox(),
    ], [next, early, consentFor(id), quiet('もどる', () => goBack(id))]);
    sync();
    area.focus();
  }

  // The one tap of a member: no questions.
  function showMember() {
    const go = primary(APPLY_WORDS.submit, () => submit(), { id: 'eventMemberApply' });
    paint([
      brand(), el('h1', { className: 'ev-title is-mid', text: APPLY_WORDS.memberTitle }),
      el('div', { className: 'ev-card ev-plain' }, el('div', { className: 'ev-small-title', text: info.title }),
        el('div', { className: 'ev-small-when', text: windowText(info) }),
        info.place ? el('div', { className: 'ev-small-when', text: `場所：${info.place}` }) : null),
      el('p', { className: 'ev-fine', text: APPLY_WORDS.memberNote }), errorBox(),
    ], [go, consentNote(), quiet('やめる', () => showInfo())]);
  }

  async function submit() {
    const buttons = [...foot.querySelectorAll('button')];
    buttons.forEach((button) => { button.disabled = true; });
    setError('');
    const answers = flow.isMember ? [] : collectAnswers(flow.questions, flow.typed);
    const payload = applyBody({
      profile: flow.steps.includes('profile') ? flow.cleanProfile : null,
      referral: flow.isMember ? '' : flow.referral,
      answers,
    });
    try {
      const result = await publicApi.apply(code, payload);
      state.account = (await api.get('/api/account/me')).account || state.account;
      noteEventGuest({ code, title: info.title, starts_at: info.starts_at, status: result.status || 'applied' });
      refreshEventGuest().catch(() => {});
      showDone();
    } catch (error) {
      setError(errorText(error));
      buttons.forEach((button) => { button.disabled = false; });
      // Back-end refusals that cannot be mended by typing again: say it and offer the way out.
      if (error.status === 403 || error.status === 409) {
        const final = $('eventApplyError');
        if (final) final.dataset.final = 'true';
      }
    }
  }

  // ---------------------------------------------------------------- done

  function showDone() {
    const friend = canAddFriend();
    const calendar = calendarUrl({ ...info, code }, window.location.origin);
    paint([
      el('div', { className: 'ev-check', attrs: { 'aria-hidden': 'true' } }, '✓'),
      el('h1', { className: 'ev-title is-center', id: 'eventDoneTitle', text: '申し込みました' }),
      el('p', { className: 'ev-lede is-center', text: windowText(info) }),
      el('p', { className: 'ev-lede is-center', text: info.title }),
      calendar ? el('p', { className: 'ev-center' }, link('カレンダーに追加', calendar)) : null,
    ], [
      friend ? el('a', { className: 'btn btn-block ev-line-btn', text: 'LINE で islands を友だち追加', attrs: { href: friendUrl(), target: '_blank', rel: 'noopener', id: 'eventFriend' } }) : null,
      friend ? el('p', { className: 'ev-fine ev-center', text: '1週間前と当日に、LINE でお知らせが届きます' }) : null,
      primary('会のページを見る', () => navigate(eventHashFor(code, 'me'), { replace: true }), { id: 'eventToMe' }),
    ]);
  }

  // ---------------------------------------------------------------- the screen

  async function load(params) {
    const mark = ++turn;
    code = params.code;
    flow = freshFlow();
    info = null;
    mine = null;
    if (!validEventCode(code)) { paint([brand(), el('h1', { className: 'ev-title', text: EVENT_WORDS.notFound })]); return; }
    paint([brand(), el('p', { className: 'ev-lede', text: '読み込んでいます…' })]);
    try {
      info = await publicApi.info(code);
    } catch (error) {
      if (mark !== turn) return;
      paint([brand(), el('h1', { className: 'ev-title', id: 'eventNotFound', text: error.status === 404 ? EVENT_WORDS.notFound : errorText(error) })]);
      return;
    }
    if (mark !== turn) return;
    document.title = info.title ? `${info.title} | islands` : 'islands';
    // Back from a sign-in that left the page (LINE): carry on where the person was.
    const resumed = takeApplyReturn(browserStorage()) === code && session.signedIn();
    if (resumed) {
      try { await loadAfterSignIn(); } catch { /* the steps ask again */ }
      if (mark !== turn) return;
    }
    if (applyView(info).state === 'cancelled') { showInfo(); return; }
    if (session.signedIn() && state.account && state.account.display_name) {
      // Somebody who has applied already has no business on this page: their own page is the guest page.
      try {
        mine = await publicApi.get(code);
        if (mark !== turn) return;
        if (mine.me && ['applied', 'attended', 'waiting', 'declined'].includes(mine.me.status)) {
          navigate(eventHashFor(code, 'me'), { replace: true });
          return;
        }
      } catch { /* shown as the public page */ }
    }
    if (resumed) { await begin(); return; }
    showInfo();
  }

  screen('eventApply', { enter: (params) => load(params) });
}
