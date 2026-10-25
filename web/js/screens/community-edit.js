// The community edit screen (#/community/:id), for an admin of that community: its name (and a form
// to change it) and 「メンバーを招待する」: one link per community, shown as a QR code (LINE-style).
//
// Reached from the community sheet on the map (「編集」 beside a community I administer). Anybody else
// who opens the address is told it is for admins; the database refuses them in any case.

import { data } from '../net.js';
import { navigate, screen } from '../router.js';
import { notify, state } from '../state.js';
import { $, clear, confirmAction, el, toast } from '../ui.js';
import { communitiesActive, refreshCommunities } from '../communities.js';
import { icon } from '../icons.js';
import { qrPng, qrSvg } from '../qr.js';
import {
  COMMUNITY_NAME_MAX, DEFAULT_EXPIRY, EXPIRY_CHOICES, activeInvites, checkCommunityName,
  communityRefusal, createInviteBody, inviteImageLines, inviteImageName, inviteLineText, invitePostFor, inviteRowText,
  inviteShareData, inviteUrlFor, postsOfCommunity, readRenamed,
  withRenamed,
} from '../community-rules.js';

// ---------------------------------------------------------------- inviting members

/** Copy a sentence to the clipboard; the fallback is the old select-and-copy. */
async function copyText(text, field = null) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* try the old way */ }
  try {
    if (field) { field.focus(); field.select(); return document.execCommand('copy'); }
  } catch { /* nothing more to try */ }
  return false;
}

const clipBody = (text, max = 22) => {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
};

/**
 * 管理者だけ: メンバーを招待する. One link per community (the newest one that still works), shown as
 * a QR code with コピー / シェア / 保存. 更新 makes a new link and stops the old ones; 止める stops them all.
 */
function invitePanel(entry) {
  let choice = DEFAULT_EXPIRY;
  let rows = [];            // the invites that still work, newest first
  let loaded = false;
  let step = 'idle';        // idle | choose (the first link) | renew (pick the time again)
  let postOn = false;       // the switch 「会の投稿も一緒に開く」
  let postId = '';
  let busy = false;
  const panel = el('div', { className: 'invite-panel' });
  const error = el('div', { className: 'error', attrs: { role: 'alert' } });

  // ---- my posts of this community (they may not be loaded yet: they come with the map)
  const mineOf = (list) => postsOfCommunity(list, entry.id)
    .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
  let mine = mineOf(state.myPosts);
  if (mine.length) postId = mine[0].id;
  async function loadMine() {
    try {
      const list = await data.postsByAuthor(state.account.id);
      state.myPosts = list;
      mine = mineOf(list);
      if (!mine.some((post) => post.id === postId)) postId = mine[0]?.id || '';
      if (!mine.length) postOn = false;
      if (rows.length || step !== 'idle') paint();
    } catch { /* keep what is there */ }
  }

  // keepError: after a failed action the message stays on screen while the list is read again.
  async function refresh(keepError = false) {
    try {
      rows = activeInvites(await data.listInvites(entry.id));
      if (!keepError) error.textContent = '';
    } catch (failure) {
      error.textContent = failure.message || '招待の情報を読み込めませんでした。';
    }
    loaded = true;
    if (rows.length && step === 'choose') step = 'idle';
    paint();
  }

  // ---- how long it works (the first link, and 更新)
  function expiryPicker() {
    const chips = el('div', { className: 'invite-chips', attrs: { role: 'radiogroup', 'aria-label': 'いつまで使えますか' } });
    const note = el('p', { className: 'invite-note' });
    const paintChips = () => {
      clear(chips);
      EXPIRY_CHOICES.forEach((item) => chips.append(el('button', {
        className: `invite-chip${item.key === choice ? ' on' : ''}`,
        attrs: { type: 'button', role: 'radio', 'aria-checked': String(item.key === choice), 'data-key': item.key },
        text: item.label,
        on: { click: () => { choice = item.key; paintChips(); } },
      })));
      note.textContent = EXPIRY_CHOICES.find((item) => item.key === choice)?.note || '';
      note.hidden = !note.textContent;
    };
    paintChips();
    return [el('div', { className: 'invite-label', text: 'いつまで使えますか' }), chips, note];
  }

  const linkOf = (row) => inviteUrlFor(window.location.origin, row.code, invitePostFor(postOn, postId));

  // ---- 「会の投稿も一緒に開く」: the switch and the post picker. Shown with the expiry chips (before the link
  // is made) and above the QR (after); `onChange` is what the caller does when either changes.
  function postSwitch(onChange) {
    const picker = el('select', { className: 'invite-post-select input', attrs: { 'aria-label': '一緒に開く投稿' } },
      ...mine.map((post) => el('option', { text: clipBody(post.body), attrs: { value: post.id } })));
    picker.value = postId;
    picker.hidden = !postOn;
    const toggle = el('input', { className: 'invite-with-post', type: 'checkbox', attrs: { role: 'switch' } });
    toggle.checked = postOn;
    toggle.disabled = !mine.length;
    toggle.addEventListener('change', () => { postOn = toggle.checked; picker.hidden = !postOn; onChange(); });
    picker.addEventListener('change', () => { postId = picker.value; onChange(); });
    return [
      el('label', { className: 'invite-switch' },
        el('span', { className: 'invite-switch-text', text: '会の投稿も一緒に開く' }),
        toggle,
        el('span', { className: 'invite-switch-track', attrs: { 'aria-hidden': 'true' } })),
      mine.length ? null : el('p', { className: 'invite-note', text: 'この会に投稿すると、その投稿も一緒に開けるようになります。' }),
      picker,
    ];
  }

  // ---- the actions
  // Stops every given invite, carrying on past one that fails; returns how many could not be stopped.
  async function revokeAll(list) {
    let failed = 0;
    for (const row of list) {
      try { await data.revokeInvite(row.id); } catch { failed += 1; }
    }
    return failed;
  }

  // The links to stop are read again right now, so one an admin made a moment ago is stopped too.
  async function currentRows(except = '') {
    const fresh = activeInvites(await data.listInvites(entry.id));
    return fresh.filter((row) => row.id !== except);
  }

  async function makeLink(replacing) {
    if (busy) return;
    busy = true;
    error.textContent = '';
    let message = '';
    paint();
    try {
      const made = await data.createInvite(createInviteBody(entry.id, choice));
      step = 'idle';           // the new link exists: a second press must not make a third
      choice = DEFAULT_EXPIRY;
      if (replacing) {
        // The new link exists first; only then are the others stopped, so there is never a moment without one.
        const failed = await revokeAll(await currentRows(made.id));
        if (failed) message = '新しいリンクは作りましたが、古いリンクを止められませんでした。「更新」か「止める」をもう一度押してください。';
      }
      toast(replacing ? '作り直しました' : 'リンクを作りました');
    } catch (failure) {
      message = failure.message || 'リンクを作れませんでした。';
    } finally {
      busy = false;
    }
    await refresh(Boolean(message));
    if (message) error.textContent = message;
  }

  async function renew() {
    if (!await confirmAction({
      title: 'いまのリンクと QR は使えなくなります。作り直しますか？', confirmLabel: '作り直す', danger: true,
    })) return;
    await makeLink(true);
  }

  async function stopAll() {
    if (!await confirmAction({
      title: 'この招待リンクを止めますか？', body: 'このリンクと QR からは、もう参加できなくなります。', confirmLabel: '止める', danger: true,
    })) return;
    busy = true;
    error.textContent = '';
    paint();
    let message = '';
    try {
      const failed = await revokeAll(await currentRows());
      step = 'idle';
      postOn = false;
      if (failed) message = '止められないリンクがありました。もう一度「止める」を押してください。';
      else toast('止めました');
    } catch (failure) {
      message = failure.message || '止められませんでした。';
    } finally {
      busy = false;
    }
    await refresh(Boolean(message));
    if (message) error.textContent = message;
  }

  async function shareLink(row) {
    try {
      await navigator.share(inviteShareData(entry.name, linkOf(row)));
    } catch { /* closed without sharing */ }
  }

  // The picture is made ahead of time, so 保存 can open the share sheet right at the tap (Safari insists).
  let pngFor = '';
  let pngReady = null;
  function prepareImage(row) {
    const url = linkOf(row);
    const key = `${row.id}|${url}`;
    if (pngFor !== key) {
      pngFor = key;
      pngReady = qrPng(url, inviteImageLines(entry.name, row.expires_at)).catch(() => null);
    }
    return pngReady;
  }

  async function saveImage(row) {
    const name = inviteImageName(entry.name);
    const blob = await prepareImage(row);
    if (!blob) { toast('画像を作れませんでした'); return; }
    // On a phone the share sheet offers 「画像を保存」; elsewhere the file is simply downloaded.
    try {
      const file = new File([blob], name, { type: 'image/png' });
      if (navigator.maxTouchPoints > 0 && typeof navigator.share === 'function'
        && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `${entry.name} への招待` });
        return;
      }
    } catch (failure) {
      if (failure && failure.name === 'AbortError') return;   // the person closed the sheet
    }
    try {
      const url = URL.createObjectURL(blob);
      const link = el('a', { attrs: { href: url, download: name } });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('保存しました');
    } catch {
      toast('保存できませんでした');
    }
  }

  // ---- the views
  const opener = () => el('button', {
    className: 'btn btn-block invite-open', attrs: { type: 'button' }, text: 'メンバーを招待する',
    on: { click: () => { step = 'choose'; loadMine(); paint(); } },
  });

  function chooseView(renewing) {
    return el('div', { className: 'invite-form' },
      ...expiryPicker(),
      ...postSwitch(() => {}),   // the choice is kept in postOn / postId; the link made next carries it
      el('button', {
        className: 'btn btn-block invite-make', attrs: { type: 'button' }, disabled: busy,
        text: renewing ? '作り直す' : 'リンクを作る',
        on: { click: () => (renewing ? renew() : makeLink(false)) },
      }),
      renewing ? el('button', {
        className: 'btn btn-block btn-quiet invite-cancel', attrs: { type: 'button' }, text: 'やめる',
        on: { click: () => { step = 'idle'; paint(); } },
      }) : null);
  }

  const actionButton = (name, label, cls, onClick) =>
    el('button', { className: `invite-act ${cls}`, attrs: { type: 'button' }, on: { click: onClick } },
      el('span', { className: 'invite-act-icon' }, icon(name, 22)),
      el('span', { className: 'invite-act-label', text: label }));

  function linkView(row) {
    const url = linkOf(row);
    // Not shown: 「リンクをコピー」 is how a person gets the link. The field only holds the text
    // for the copy (and its select-and-copy fallback), so it is kept out of sight.
    const field = el('input', { className: 'invite-url', type: 'text', attrs: { readonly: '', tabindex: '-1', 'aria-hidden': 'true' } });
    field.value = url;
    const qrBox = el('div', { className: 'invite-qr' });
    const paintQr = (text) => {
      clear(qrBox);
      try {
        qrBox.append(qrSvg(text));
      } catch {
        qrBox.append(el('p', { className: 'invite-note', text: 'QR コードを作れませんでした。リンクをお使いください。' }));
      }
    };
    paintQr(url);
    prepareImage(row);
    // The switch and the picked post only change the link text and the QR; the invite itself stays.
    const swap = () => {
      field.value = linkOf(row);
      paintQr(field.value);
      prepareImage(row);
    };

    // The switch comes first: it changes the link and the QR below it.
    return el('div', { className: 'invite-live' },
      ...postSwitch(swap),
      qrBox,
      el('p', { className: 'invite-line', attrs: { 'aria-label': inviteLineText(row) } },
        el('span', { className: 'invite-line-expiry', text: inviteRowText(row).expiry.replace(/ /g, ' ') }),
        el('span', { className: 'invite-line-dot', text: '・', attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'invite-line-uses', text: inviteRowText(row).uses })),
      field,
      el('div', { className: 'invite-acts' },
        actionButton('link', 'リンクをコピー', 'invite-copy', async () => {
          toast(await copyText(field.value, field) ? 'コピーしました' : '長押しでコピーしてください');
        }),
        typeof navigator.share === 'function'
          ? actionButton('share', 'シェア', 'invite-share', () => shareLink(row)) : null,
        actionButton('download', '保存', 'invite-save', () => saveImage(row))),
      el('div', { className: 'invite-manage' },
        el('button', {
          className: 'btn btn-small btn-quiet invite-renew', attrs: { type: 'button' }, text: '更新', disabled: busy,
          on: { click: () => { step = 'renew'; paint(); } },
        }),
        el('button', {
          className: 'btn btn-small btn-quiet invite-revoke', attrs: { type: 'button' }, text: '止める', disabled: busy,
          on: { click: stopAll },
        })));
  }

  function paint() {
    clear(panel);
    if (!loaded) return;
    const row = rows[0] || null;
    if (!row) panel.append(step === 'choose' ? chooseView(false) : opener());
    else panel.append(step === 'renew' ? chooseView(true) : linkView(row));
    panel.append(error);
  }

  // Opened straight by URL, my posts are not loaded yet: read them now so 「会の投稿も一緒に開く」 can be switched on.
  if (!mine.length && state.account) loadMine();
  refresh();
  return panel;
}

// ---------------------------------------------------------------- the name

/** The name and the form that changes it. */
function renameSection(entry, onRenamed) {
  const input = el('input', {
    className: 'input', type: 'text',
    attrs: { id: 'communityName', 'aria-label': 'コミュニティの名前', autocomplete: 'off' },
  });
  input.value = entry.name;
  const error = el('div', { className: 'error', attrs: { role: 'alert', id: 'communityNameError' } });
  const save = el('button', {
    className: 'btn btn-block', attrs: { type: 'button', id: 'communityRename' }, text: '名前を保存',
  });
  const submit = async () => {
    error.textContent = '';
    const check = checkCommunityName(input.value);
    if (!check.ok) {
      error.textContent = check.message;
      return;
    }
    save.disabled = true;
    try {
      const name = readRenamed(await data.renameCommunity(entry.id, check.name)) || check.name;
      // The header, the sheet and this screen all read state.communities.
      state.communities = withRenamed(state.communities, entry.id, name);
      input.value = name;
      notify('community');
      onRenamed(name);
      toast('名前を変えました');
    } catch (failure) {
      error.textContent = communityRefusal(failure.message);
    } finally {
      save.disabled = false;
    }
  };
  save.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  return el('section', { className: 'community-card community-rename' },
    el('label', { className: 'field' },
      el('span', { className: 'label-text' }, 'コミュニティの名前',
        el('span', { className: 'hint-text', text: `${COMMUNITY_NAME_MAX}文字まで` })),
      input),
    error, save);
}

// ---------------------------------------------------------------- the screen

let request = 0;

async function render(id) {
  const mine = ++request;
  const body = clear($('communityEditBody'));
  if (!state.account || !communitiesActive()) {
    navigate('#/map', { replace: true });
    return;
  }
  if (!state.communitiesLoaded) await refreshCommunities();
  if (mine !== request) return;
  const entry = state.communities.find((item) => item.id === id);
  if (!entry || entry.role !== 'admin') {
    clear(body).append(
      el('p', {
        className: 'empty-note', attrs: { id: 'communityEditNote' },
        text: entry ? 'このコミュニティを編集できるのは、管理者だけです。' : 'このコミュニティは見つかりませんでした。',
      }),
      el('button', {
        className: 'btn btn-small btn-quiet community-edit-home', attrs: { type: 'button' },
        text: '地図へ戻る', on: { click: () => navigate('#/map') },
      }));
    return;
  }
  const title = el('h3', { className: 'community-edit-name', attrs: { id: 'communityEditName' }, text: entry.name });
  clear(body).append(
    title,
    renameSection(entry, (name) => { title.textContent = name; }),
    el('section', { className: 'community-card community-invites', attrs: { 'data-community-id': entry.id } },
      el('div', { className: 'section-label', text: 'メンバーを招待する' }),
      invitePanel(entry)),
  );
}

export function setupCommunityEdit() {
  $('communityEditBack').addEventListener('click', () => navigate('#/map'));
  screen('communityEdit', {
    enter: (params) => render(params.id),
    leave: () => { request += 1; },
  });
}
