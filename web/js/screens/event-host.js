// 会の主催者メニューと名簿（#/e/:code/host、2026-11-01 第2回a。画像 5 の C・D）。
//
//   上      会の内容・状態の札（募集中／開催決定／中止）・申し込みのリンク・当日の受付 QR（作った直後は「申し込みページができました」）
//   中      内容を変える（日時・場所・名前・開催の条件）／会を中止する（確かめてから）／地図の投稿を開く
//   下      名簿：数の帯・受付待ち（受付する・却下）・1人ずつ（名前・会社・きっかけ・入り方・状態）・「•••」→ 受付する・お断りする
// 主催者はその会を投稿した人。名簿はコミュニティの管理者も見られる（お断りは主催者だけ）。
// 判断は event-host-rules.js、サーバーの道は events-api.js。

import { eventsApi } from '../events-api.js';
import {
  GO_WORDS, JOIN_CHOICES, applyLink, cancelEventConfirm, cancelNote, checkinLink, checkinToast, countsView, declineConfirm,
  decideRange, formatWhen, goalLocked, goState, quotaText, rejectConfirm, rosterSections, rowActions, rowTags, statusChip,
  toLocalInput, validateEventEdit,
} from '../event-host-rules.js';
import { qrSvg } from '../qr.js';
import { navigate, screen } from '../router.js';
import { removePost, state } from '../state.js';
import { $, chooseAction, clear, confirmAction, el, toast } from '../ui.js';
import { forgetEvent } from '../components/event-card.js';
import { config } from '../config.js';
import { rememberHostReturn } from '../event-rules.js';
import { browserStorage } from '../talk.js';
import { mapLinkFor } from '../return-post.js';

let request = 0;
let view = null;            // GET /api/events/{code}
let roster = null;          // GET /api/events/{code}/roster（見られないときは null）
let mode = 'main';          // main ／ edit
let fresh = false;          // 会を作った直後
let openMenu = null;        // 「•••」を開いている人の account_id
let editJoin = null;        // 内容を変える画面で選んでいる、会のあとの入り方

async function copyText(text, field = null) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* 昔のやり方 */ }
  try {
    if (field) { field.focus(); field.select(); return document.execCommand('copy'); }
  } catch { /* あきらめる */ }
  return false;
}

const card = (...children) => el('section', { className: 'ev-card' }, ...children);
const label = (text) => el('div', { className: 'ev-label', text });

// ---------------------------------------------------------------- 会の内容・リンク

/** 最小人数がある会：状態の札と、人数・判定日の一行ずつ。 */
function goBlock(state) {
  if (!state) return null;
  return el('div', { className: `ev-go ${state.phase}`, attrs: { id: 'eventHostGo', 'data-phase': state.phase } },
    el('span', { className: `ev-go-badge ${state.tone}`, text: state.label }),
    el('div', { className: 'ev-go-lines' },
      el('b', { text: state.countText }),
      el('span', { text: state.conditionText })));
}

function summaryCard() {
  const event = view.event;
  const capacity = event.capacity ? `先着 ${event.capacity}人` : '先着なし';
  const range = event.visibility === 'public' ? '公開（リンクを知っている人は誰でも申し込める）' : 'コミュニティの中だけ';
  const state = goState(event, roster && roster.counts);
  const cancel = cancelNote(event);
  const join = JOIN_CHOICES.find((item) => item.value === event.join_policy);
  return card(
    el('h3', { className: 'ev-title', attrs: { id: 'eventHostTitle' }, text: event.title }),
    state && state.band && !event.cancelled ? el('p', { className: 'ev-flag', attrs: { id: 'eventHostNotHeld' }, text: state.band }) : null,
    goBlock(state),
    el('p', { className: 'ev-line', text: formatWhen(event.starts_at, event.ends_at) }),
    event.place ? el('p', { className: 'ev-line', text: `場所：${event.place}` }) : null,
    el('p', { className: 'ev-line ev-quiet', text: `${capacity}　現在 ${event.applied_count}人が申し込み中` }),
    el('p', { className: 'ev-line ev-quiet', text: range }),
    cancel ? el('p', { className: 'ev-line ev-quiet', text: cancel }) : null,
    join ? el('p', { className: 'ev-line ev-quiet', text: `会のあと：${join.label}` }) : null,
    event.cancelled ? el('p', { className: 'ev-flag', text: 'この会は中止になりました' }) : null);
}

function linkCard() {
  const event = view.event;
  const url = applyLink(location.origin, event.code);
  const input = el('input', {
    className: 'ev-link', type: 'text', readOnly: true, attrs: { id: 'eventHostLink', 'aria-label': '申し込みのリンク' },
  });
  input.value = url;
  const copy = el('button', {
    className: 'btn btn-block ev-copy-btn', attrs: { type: 'button' }, text: 'リンクをコピー',
    on: {
      click: async () => {
        const ok = await copyText(url, input);
        toast(ok ? 'コピーしました。' : 'コピーできませんでした。上のリンクを長押ししてコピーしてください。');
      },
    },
  });
  const note = event.visibility === 'public'
    ? 'Instagram のプロフィールや投稿に載せてください。'
    : 'コミュニティのメンバーだけが申し込めます。';
  const nodes = [
    label(`申し込みのリンク（${event.visibility === 'public' ? '公開' : 'コミュニティの中だけ'}）`),
    input, copy, el('p', { className: 'ev-note', text: note }),
  ];
  return card(...nodes);
}

function checkinCard() {
  if (!view.checkin_code) return null;
  const url = checkinLink(location.origin, view.checkin_code);
  const qr = el('div', { className: 'ev-qr', attrs: { id: 'eventHostQr' } });
  try {
    qr.append(qrSvg(url, '当日の受付 QR コード'));
  } catch {
    qr.append(el('p', { className: 'ev-note', text: 'QR を作れませんでした。' }));
  }
  return card(
    label('当日の受付'), qr,
    el('p', { className: 'ev-note', text: 'この QR は、会の当日だけ使えます。' }));
}

// ---------------------------------------------------------------- 内容を変える

function editForm() {
  const event = view.event;
  const max = config().limits || {};
  const title = el('input', { className: 'ev-input', type: 'text', attrs: { id: 'eventEditTitle', maxlength: max.event_title_max || 40 } });
  const place = el('input', { className: 'ev-input', type: 'text', attrs: { id: 'eventEditPlace', maxlength: max.event_place_max || 60 } });
  const start = el('input', { className: 'ev-input', type: 'datetime-local', attrs: { id: 'eventEditStart' } });
  const end = el('input', { className: 'ev-input', type: 'datetime-local', attrs: { id: 'eventEditEnd' } });
  title.value = event.title || '';
  place.value = event.place || '';
  start.value = toLocalInput(event.starts_at);
  end.value = toLocalInput(event.ends_at);
  // 開催の条件：古いサーバー（キーが無い）では出さない。判定のあとは最小人数と判定日を灰色にして変えられない。
  const known = 'join_policy' in event || 'min_participants' in event;
  const locked = goalLocked(event);
  const min = el('input', {
    className: 'ev-input', type: 'number', inputMode: 'numeric', attrs: { id: 'eventEditMin', min: '2', step: '1', placeholder: '例：5' },
  });
  const decide = el('input', { className: 'ev-input', type: 'date', attrs: { id: 'eventEditDecide' } });
  const cancel = el('input', { className: 'ev-input', type: 'datetime-local', attrs: { id: 'eventEditDeadline' } });
  min.value = event.min_participants ?? '';
  decide.value = event.decide_on || '';
  cancel.value = toLocalInput(event.cancel_deadline);
  min.disabled = locked;
  decide.disabled = locked;
  editJoin = event.join_policy || 'auto';
  const decideField = el('label', { className: 'ev-field' }, el('span', { className: 'ev-label', text: GO_WORDS.decideLabel }), decide);
  const joinList = el('div', { className: 'ev-choices', attrs: { id: 'eventEditJoin', role: 'radiogroup', 'aria-label': GO_WORDS.joinLabel } });
  const paintJoin = () => {
    joinList.replaceChildren(...JOIN_CHOICES.map((item) => el('button', {
      className: `ev-choice${editJoin === item.value ? ' on' : ''}`,
      attrs: { type: 'button', role: 'radio', 'aria-checked': String(editJoin === item.value), 'data-join': item.value },
      on: { click: () => { editJoin = item.value; paintJoin(); } },
    }, el('b', { text: item.label }), el('span', { text: item.note }))));
  };
  paintJoin();
  const paintGoal = () => {
    decideField.hidden = !locked && min.value.trim() === '';
    if (locked) return;
    const range = decideRange(start.value);
    decide.min = range.min;
    if (range.max) decide.max = range.max; else decide.removeAttribute('max');
  };
  min.addEventListener('input', paintGoal);
  start.addEventListener('change', paintGoal);
  paintGoal();
  const error = el('div', { className: 'error ev-error', attrs: { role: 'alert', id: 'eventEditError' } });
  const save = el('button', { className: 'btn btn-block', attrs: { type: 'button', id: 'eventEditSave' }, text: '変更を保存' });
  const field = (text, input) => el('label', { className: 'ev-field' }, el('span', { className: 'ev-label', text }), input);
  save.addEventListener('click', async () => {
    error.textContent = '';
    const raw = { title: title.value, place: place.value, start: start.value, end: end.value };
    if (known) Object.assign(raw, { min: min.value, decide: decide.value, cancel: cancel.value, join: editJoin });
    const check = validateEventEdit(raw, event, { cfg: config() });
    if (!check.ok) { error.textContent = check.message; return; }
    const fields = check.fields;
    if (!Object.keys(fields).length) { toast('変えた所がありません。'); return; }
    save.disabled = true;
    try {
      const result = await eventsApi.update(event.code, fields);
      forgetEvent(event.post_id);
      toast(result.notified
        ? `変更しました。申し込んでいる${result.notified}人にお知らせします。`
        : '変更しました。');
      mode = 'main';
      await load(event.code);
    } catch (failure) {
      error.textContent = failure.message;
      save.disabled = false;
    }
  });
  return card(
    el('h3', { className: 'ev-title', text: '会の内容を変える' }),
    field('会の名前', title), field('開始', start), field('終了', end), field('場所', place),
    el('p', { className: 'ev-note', text: '日時や場所を変えると、申し込んでいる人にお知らせします。' }),
    known ? goalFields({ min, decideField, cancel, joinList, locked }) : null,
    error, save,
    el('button', {
      className: 'btn btn-block btn-quiet', attrs: { type: 'button', id: 'eventEditCancel' }, text: 'やめる',
      on: { click: () => { mode = 'main'; paint(); } },
    }));
}

/** 内容を変える画面の、開催の条件の4項目。判定のあとは最小人数と判定日が灰色（変えられない）。 */
function goalFields({ min, decideField, cancel, joinList, locked }) {
  const hint = (text) => el('span', { className: `ev-hint${locked ? ' locked' : ''}`, text });
  decideField.append(hint(locked ? GO_WORDS.locked : GO_WORDS.decideNote));
  return el('div', { className: 'ev-goal-edit', attrs: { id: 'eventEditGoal' } },
    el('h4', { className: 'ev-sub', text: '開催の条件' }),
    el('label', { className: 'ev-field' }, el('span', { className: 'ev-label', text: GO_WORDS.minLabel }), min,
      hint(locked ? GO_WORDS.locked : GO_WORDS.minNote)),
    decideField,
    el('label', { className: 'ev-field' }, el('span', { className: 'ev-label', text: GO_WORDS.cancelLabel }), cancel,
      el('span', { className: 'ev-hint', text: GO_WORDS.cancelNote })),
    el('span', { className: 'ev-label', text: GO_WORDS.joinLabel }), joinList);
}

// ---------------------------------------------------------------- 中止

async function cancelEvent() {
  const event = view.event;
  const text = cancelEventConfirm(event.title, event.applied_count);
  if (!await confirmAction({ title: text.title, body: text.body, confirmLabel: text.confirmLabel, danger: true })) return;
  try {
    await eventsApi.cancelEvent(event.post_id);
    removePost(event.post_id);
    forgetEvent(event.post_id);
    toast('会を中止しました。');
    await navigate('#/map');
  } catch (failure) {
    toast(failure.message);
  }
}

function actionsCard() {
  const event = view.event;
  if (event.cancelled) return null;
  return card(
    label('主催者メニュー'),
    el('div', { className: 'ev-actions' },
      el('button', {
        className: 'btn btn-block btn-quiet ev-edit', attrs: { type: 'button', id: 'eventHostEdit' }, text: '会の内容を変える',
        on: { click: () => { mode = 'edit'; paint(); $('eventHostBody').scrollTop = 0; } },
      }),
      el('button', {
        className: 'btn btn-block btn-quiet ev-see-post', attrs: { type: 'button', id: 'eventHostPost' }, text: '地図で投稿を見る',
        on: { click: () => navigate(mapLinkFor(event.post_id)) },
      }),
      el('button', {
        className: 'btn btn-block ev-cancel-event', attrs: { type: 'button', id: 'eventHostCancel' }, text: '会を中止する',
        on: { click: cancelEvent },
      })));
}

// ---------------------------------------------------------------- 名簿とお断り

async function checkin(row) {
  try {
    const result = await eventsApi.hostCheckin(view.event.code, row.account_id);
    toast(checkinToast(row, result));
    openMenu = null;
    forgetEvent(view.event.post_id);
    await load(view.event.code);
  } catch (failure) {
    toast(failure.message);
  }
}

async function reject(row) {
  const text = rejectConfirm(row);
  if (!await confirmAction({ title: text.title, body: text.body, confirmLabel: text.confirmLabel, danger: true })) return;
  try {
    await eventsApi.rejectWalkin(view.event.code, row.account_id);
    toast(`${row.display_name || 'その人'}さんを却下しました。`);
    await load(view.event.code);
  } catch (failure) {
    toast(failure.message);
  }
}

async function decide(row) {
  const text = declineConfirm(row);
  if (!await confirmAction({ title: text.title, body: text.body, confirmLabel: text.confirmLabel, danger: true })) return;
  try {
    await eventsApi.decline(view.event.code, row.account_id);
    toast(`${row.display_name || 'その人'}さんをお断りしました。`);
    openMenu = null;
    forgetEvent(view.event.post_id);
    await load(view.event.code);
  } catch (failure) {
    toast(failure.message);
  }
}

function personRow(row) {
  const chip = statusChip(row);
  const tags = rowTags(row);
  const waiting = row.status === 'waiting';
  const actions = view.is_host ? rowActions(row) : [];
  const isOpen = openMenu === row.account_id;
  const sub = [row.affiliation, row.job_title].filter(Boolean).join('・');
  const node = el('li', { className: 'ev-person', attrs: { 'data-account': row.account_id, 'data-status': row.status } },
    el('div', { className: 'ev-person-main' },
      el('span', { className: 'ev-initial', attrs: { 'aria-hidden': 'true' }, text: Array.from(row.display_name || '？')[0] }),
      el('div', { className: 'ev-person-text' },
        el('b', { className: 'ev-person-name', text: row.display_name || '（名前なし）' }),
        sub ? el('span', { className: 'ev-person-sub', text: sub }) : null,
        el('div', { className: 'ev-chips' }, tags.map((tag) => el('span', { className: `ev-chip ${tag.tone}`, text: tag.text })))),
      el('span', { className: `ev-status ${chip.tone}`, text: chip.text }),
      actions.length && !waiting ? el('button', {
        className: 'icon-button ev-more', attrs: { type: 'button', 'aria-label': `${row.display_name || 'この人'}の操作`, 'aria-expanded': String(isOpen) },
        text: '•••',
        on: { click: () => { openMenu = isOpen ? null : row.account_id; paint(); } },
      }) : null));
  if (waiting && actions.length) {
    // 受付待ち（飛び入り）は、メニューを開かずにそのまま押せる
    node.append(el('div', { className: 'ev-person-buttons' },
      el('button', { className: 'btn ev-checkin', attrs: { type: 'button' }, text: '受付する', on: { click: () => checkin(row) } }),
      el('button', { className: 'btn btn-quiet ev-reject', attrs: { type: 'button' }, text: '却下', on: { click: () => reject(row) } })));
  }
  if (isOpen) {
    node.append(el('div', { className: 'ev-person-menu' },
      actions.includes('checkin')
        ? el('button', { className: 'ev-checkin-menu', attrs: { type: 'button' }, text: '受付する', on: { click: () => checkin(row) } }) : null,
      actions.includes('decline')
        ? el('button', { className: 'ev-decline', attrs: { type: 'button' }, text: 'お断りする', on: { click: () => decide(row) } }) : null,
      el('button', { className: 'ev-menu-close', attrs: { type: 'button' }, text: 'やめる', on: { click: () => { openMenu = null; paint(); } } })));
  }
  return node;
}

function rosterCard() {
  if (!roster) return null;
  const counts = countsView(roster);
  const sections = rosterSections(roster);
  const quota = quotaText(roster.line_quota);
  return card(
    el('h3', { className: 'ev-title', text: '出欠つき名簿' }),
    el('div', { className: 'ev-counts', attrs: { id: 'eventRosterCounts' } },
      counts.map((item) => el('div', { className: `ev-count ${item.key}`, attrs: { 'data-count': item.key } },
        el('b', { className: 'num', text: item.n }), el('span', { text: item.label })))),
    quota ? el('p', { className: 'ev-note', text: quota }) : null,
    el('p', { className: 'ev-lock', text: '🔒 きっかけは主催者と管理者だけに見えます' }),
    sections.length
      ? sections.map((group) => el('div', { className: 'ev-group', attrs: { 'data-group': group.key } },
        el('div', { className: 'ev-group-title', text: group.label }),
        el('ul', { className: 'ev-people' }, group.rows.map(personRow))))
      : el('p', { className: 'empty-note ev-empty', text: 'まだ申し込みはありません。' }));
}

// ---------------------------------------------------------------- 画面

function paint() {
  const body = clear($('eventHostBody'));
  if (!view) return;
  if (mode === 'edit') {
    body.append(editForm());
    return;
  }
  const event = view.event;
  // append(null) は「null」という文字になるので、無いものは外してから並べる
  body.append(...[
    fresh ? el('div', { className: 'ev-fresh', attrs: { id: 'eventHostFresh' } },
      el('h2', { className: 'screen-title', text: '申し込みページができました' }),
      el('p', { className: 'lede', text: `${event.title}・${formatWhen(event.starts_at, event.ends_at)}` })) : null,
    event.cancelled ? null : linkCard(),
    event.cancelled ? null : checkinCard(),
    summaryCard(),
    view.is_host ? actionsCard() : null,
    rosterCard()].filter(Boolean));
}

async function load(code) {
  const mine = ++request;
  let next;
  try {
    next = await eventsApi.get(code);
  } catch (failure) {
    if (mine === request) {
      toast(failure.status === 404 ? 'この会は見つかりませんでした。' : failure.message);
      navigate('#/map', { replace: true });
    }
    return;
  }
  if (mine !== request) return;
  let list = null;
  try {
    list = await eventsApi.roster(code);
  } catch {
    list = null;
  }
  if (mine !== request) return;
  if (!next.is_host && !list) {
    toast('この会の名簿は、主催者だけが見られます。');
    navigate('#/map', { replace: true });
    return;
  }
  view = next;
  roster = list;
  paint();
}

export function setupEventHost() {
  $('eventHostBack').addEventListener('click', () => {
    if (mode === 'edit') { mode = 'main'; paint(); return; }
    navigate('#/map');
  });
  screen('eventHost', {
    async enter(params, query) {
      if (!state.account) {
        rememberHostReturn(browserStorage(), params.code);
        navigate('#/auth', { replace: true });
        return;
      }
      fresh = Boolean(query && query.get('new') === '1');
      mode = 'main';
      openMenu = null;
      view = null;
      roster = null;
      clear($('eventHostBody'));
      await load(params.code);
    },
    leave() { request += 1; },
  });
}
