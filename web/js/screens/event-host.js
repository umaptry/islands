// 会の主催者メニューと名簿（#/e/:code/host、2026-11-01 第2回a。画像 5 の C・D）。
//
//   上      会の内容・申し込みのリンク・当日の受付 QR（作った直後は「申し込みページができました」）
//   中      内容を変える（日時・場所・名前）／会を中止する（確かめてから）／地図の投稿を開く
//   下      名簿：数の帯・1人ずつ（名前・会社・きっかけ・入り方・状態）・「•••」→ お断りする（確かめてから）
// 主催者はその会を投稿した人。名簿はコミュニティの管理者も見られる（お断りは主催者だけ）。
// 判断は event-host-rules.js、サーバーの道は events-api.js。

import { eventsApi } from '../events-api.js';
import {
  applyLink, cancelEventConfirm, checkinLink, countsView, declineConfirm, formatWhen,
  quotaText, rosterSections, rowActions, rowTags, statusChip, toLocalInput, validateEventEdit,
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

function summaryCard() {
  const event = view.event;
  const capacity = event.capacity ? `先着 ${event.capacity}人` : '先着なし';
  const range = event.visibility === 'public' ? '公開（リンクを知っている人は誰でも申し込める）' : 'コミュニティの中だけ';
  return card(
    el('h3', { className: 'ev-title', attrs: { id: 'eventHostTitle' }, text: event.title }),
    el('p', { className: 'ev-line', text: formatWhen(event.starts_at, event.ends_at) }),
    event.place ? el('p', { className: 'ev-line', text: `場所：${event.place}` }) : null,
    el('p', { className: 'ev-line ev-quiet', text: `${capacity}　現在 ${event.applied_count}人が申し込み中` }),
    el('p', { className: 'ev-line ev-quiet', text: range }),
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
  const error = el('div', { className: 'error ev-error', attrs: { role: 'alert', id: 'eventEditError' } });
  const save = el('button', { className: 'btn btn-block', attrs: { type: 'button', id: 'eventEditSave' }, text: '変更を保存' });
  const field = (text, input) => el('label', { className: 'ev-field' }, el('span', { className: 'ev-label', text }), input);
  save.addEventListener('click', async () => {
    error.textContent = '';
    const check = validateEventEdit(
      { title: title.value, place: place.value, start: start.value, end: end.value }, event, { cfg: config() });
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
    error, save,
    el('button', {
      className: 'btn btn-block btn-quiet', attrs: { type: 'button', id: 'eventEditCancel' }, text: 'やめる',
      on: { click: () => { mode = 'main'; paint(); } },
    }));
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
      actions.length ? el('button', {
        className: 'icon-button ev-more', attrs: { type: 'button', 'aria-label': `${row.display_name || 'この人'}の操作`, 'aria-expanded': String(isOpen) },
        text: '•••',
        on: { click: () => { openMenu = isOpen ? null : row.account_id; paint(); } },
      }) : null));
  if (isOpen) {
    node.append(el('div', { className: 'ev-person-menu' },
      el('button', { className: 'ev-decline', attrs: { type: 'button' }, text: 'お断りする', on: { click: () => decide(row) } }),
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
        el('div', { className: 'ev-group-title', text: `${group.title}（${group.rows.length}）` }),
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
  body.append(
    fresh ? el('div', { className: 'ev-fresh', attrs: { id: 'eventHostFresh' } },
      el('h2', { className: 'screen-title', text: '申し込みページができました' }),
      el('p', { className: 'lede', text: `${event.title}・${formatWhen(event.starts_at, event.ends_at)}` })) : null,
    event.cancelled ? null : linkCard(),
    event.cancelled ? null : checkinCard(),
    summaryCard(),
    view.is_host ? actionsCard() : null,
    rosterCard());
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
