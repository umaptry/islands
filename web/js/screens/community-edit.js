// The community edit screen (#/community/:id), for an admin of that community: its name (and a form
// to change it) and the invite links (make one, copy it, see the ones that still work, stop one).
// The invite links used to live on マイページ; they are here now, behaving exactly as they did.
//
// Reached from the community sheet on the map (「編集」 beside a community I administer). Anybody else
// who opens the address is told it is for admins; the database refuses them in any case.

import { data } from '../net.js';
import { navigate, screen } from '../router.js';
import { notify, state } from '../state.js';
import { $, clear, confirmAction, el, toast } from '../ui.js';
import { communitiesActive, refreshCommunities } from '../communities.js';
import {
  COMMUNITY_NAME_MAX, DEFAULT_EXPIRY, EXPIRY_CHOICES, QR_NOTE, activeInvites, checkCommunityName,
  communityRefusal, createInviteBody, inviteRowText, inviteUrlFor, postsOfCommunity, readRenamed,
  withRenamed,
} from '../community-rules.js';

// ---------------------------------------------------------------- invite links (moved from マイページ)

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

/** 管理者だけ: 招待リンクを作る, 有効な招待の一覧, 止める. */
function invitePanel(entry) {
  let choice = DEFAULT_EXPIRY;
  let open = false;
  const panel = el('div', { className: 'invite-panel' });
  const form = el('div', { className: 'invite-form' });
  form.hidden = true;
  const list = el('div', { className: 'invite-list', attrs: { 'aria-live': 'polite' } });
  const opener = el('button', {
    className: 'btn btn-small invite-open', attrs: { type: 'button', 'aria-expanded': 'false' },
    text: '招待リンクを作る',
    on: { click: () => {
      open = !open;
      form.hidden = !open;
      opener.setAttribute('aria-expanded', String(open));
      // My posts may not be loaded yet (they come with the map); read them when the form opens.
      if (open) loadMine();
    } },
  });

  // ---- how long it works
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

  // ---- with a post of mine to open
  const withPost = el('input', { className: 'invite-with-post', type: 'checkbox' });
  const pick = el('select', { className: 'invite-post-select input', attrs: { 'aria-label': '一緒に開く投稿' } });
  pick.hidden = true;
  withPost.addEventListener('change', () => { pick.hidden = !withPost.checked; });
  const fillMine = (rows) => {
    const mine = postsOfCommunity(rows, entry.id).sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
    const kept = pick.value;
    clear(pick).append(...mine.map((post) => el('option', { text: clipBody(post.body), attrs: { value: post.id } })));
    if (kept && mine.some((post) => post.id === kept)) pick.value = kept;
    withPost.disabled = !mine.length;
    if (!mine.length) { withPost.checked = false; pick.hidden = true; }
  };
  fillMine(state.myPosts);
  async function loadMine() {
    try {
      const rows = await data.postsByAuthor(state.account.id);
      state.myPosts = rows;
      fillMine(rows);
    } catch { /* keep what is there */ }
  }

  // ---- the made link
  const result = el('div', { className: 'invite-result' });
  result.hidden = true;
  const error = el('div', { className: 'error', attrs: { role: 'alert' } });

  const make = el('button', {
    className: 'btn btn-block invite-make', attrs: { type: 'button' }, text: 'リンクを作る',
    on: { click: async () => {
      make.disabled = true;
      error.textContent = '';
      try {
        const made = await data.createInvite(createInviteBody(entry.id, choice));
        const url = inviteUrlFor(window.location.origin, made.code, withPost.checked ? pick.value : null);
        showResult(url, made.expires_at);
        loadList();
      } catch (failure) {
        error.textContent = failure.message;
      } finally {
        make.disabled = false;
      }
    } },
  });

  function showResult(url, expiresAt) {
    clear(result);
    const field = el('input', { className: 'input invite-url', type: 'text', attrs: { readonly: '', 'aria-label': '招待リンク' } });
    field.value = url;
    result.append(
      el('div', { className: 'invite-result-row' }, field, el('button', {
        className: 'btn btn-small invite-copy', attrs: { type: 'button' }, text: 'コピー',
        on: { click: async () => toast(await copyText(url, field) ? 'コピーしました' : '長押しでコピーしてください') },
      })),
      el('p', { className: 'invite-note', text: `${inviteRowText({ expires_at: expiresAt, uses: 0 }).expiry}。${QR_NOTE}` }),
    );
    result.hidden = false;
  }

  form.append(
    el('div', { className: 'invite-label', text: 'いつまで使えますか' }), chips, note,
    el('label', { className: 'invite-check' }, withPost, el('span', { text: '会の投稿も一緒に開くリンクにする' })),
    pick, make, error, result);

  // ---- the ones that still work
  async function loadList() {
    let rows;
    try {
      rows = activeInvites(await data.listInvites(entry.id));
    } catch (failure) {
      clear(list).append(el('p', { className: 'invite-note', text: failure.message || '招待の一覧を読み込めませんでした。' }));
      return;
    }
    clear(list);
    list.append(el('div', { className: 'invite-label', text: `有効な招待（${rows.length}）` }));
    if (!rows.length) {
      list.append(el('p', { className: 'invite-note', text: '今、使える招待リンクはありません。' }));
      return;
    }
    rows.forEach((row) => {
      const text = inviteRowText(row);
      list.append(el('div', { className: 'invite-row', attrs: { 'data-invite-id': row.id } },
        el('div', { className: 'invite-row-body' },
          el('div', { className: 'invite-row-expiry', text: text.expiry }),
          el('div', { className: 'invite-row-uses', text: text.uses })),
        el('button', {
          className: 'btn btn-small btn-quiet invite-row-copy', attrs: { type: 'button' }, text: 'コピー',
          on: { click: async () => toast(await copyText(inviteUrlFor(window.location.origin, row.code)) ? 'コピーしました' : 'コピーできませんでした') },
        }),
        el('button', {
          className: 'btn btn-small btn-quiet invite-revoke', attrs: { type: 'button' }, text: '止める',
          on: { click: async () => {
            if (!await confirmAction({ title: 'この招待リンクを止めますか？', body: 'このリンクからは、もう参加できなくなります。', confirmLabel: '止める', danger: true })) return;
            try {
              await data.revokeInvite(row.id);
              toast('止めました');
            } catch (failure) {
              toast(failure.message);
            }
            loadList();
          } },
        })));
    });
  }
  loadList();

  panel.append(opener, form, list);
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
      el('div', { className: 'section-label', text: '招待リンク' }),
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
