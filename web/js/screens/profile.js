// マイページ, プロフィール編集, and somebody else's profile.
//
// islands' three profile screens, with the parts that were placeholders filled
// in: the tab counts were 345 and 1 written into the source, and another
// person's page said "このユーザーのプロフィール情報はまだ登録されていません"
// because there was nowhere for it to be registered. There is an accounts table
// now, so both read real rows.

import { data, api } from '../net.js';
import { session } from '../session.js';
import { activeScreen, navigate, screen } from '../router.js';
import { state, removePost } from '../state.js';
import { $, avatar, clear, el, safeUrl, toast, confirmAction } from '../ui.js';
import { react, openOnMap as openMapPost, refreshMyViews } from './map.js';
import { postCard } from '../components/postcard.js';
import { openReactors } from '../components/reactors.js';
import { icon } from '../icons.js';
import { markGuidanceReview, setupAvatarField } from './auth.js';
import { buzz, canBuzz, feedbackSettings, resumeAudio, setFeedback, sound } from '../feedback.js';
import { CATEGORIES, defaultSettings, iosOtherBrowser, mergeSettings, settingsRows } from '../notify-rules.js';
import { disablePush, enablePush, forgetDevice, pushStatus } from '../push.js';
import { loadNotifySettings, useNotifySettings } from './notifications.js';
import { refreshTalk, talkAvailable, talkOptionsForPerson } from '../talk.js';
import { talkButton } from '../components/talk-button.js';
import { chooseCurrent, communitiesActive, refreshCommunities } from '../communities.js';
import {
  DEFAULT_EXPIRY, EXPIRY_CHOICES, NOT_MEMBER_NOTE, QR_NOTE, activeInvites, createInviteBody,
  inviteRowText, inviteUrlFor, postsOfCommunity,
} from '../community-rules.js';
import { unreadDmCount } from '../notify-rules.js';

let editDraft = null;

// ---------------------------------------------------------------- shared

function header(account, { own } = {}) {
  const link = safeUrl(account.link_url);
  const photo = avatar(account, 80);
  photo.classList.add('profile-avatar');
  return el('div', { className: 'profile-head' },
    el('div', { className: 'profile-top' },
      photo,
      own
        ? el('button', {
          className: 'profile-edit-button',
          attrs: { type: 'button' },
          on: { click: () => navigate('#/me/edit') },
        }, icon('pencil', 12), el('span', { text: 'プロフィールを編集' }))
        : null,
    ),
    el('h2', { className: 'profile-name' },
      account.affiliation
        ? el('span', { className: 'profile-affiliation', text: account.affiliation })
        : null,
      el('span', { text: account.display_name || '' }),
    ),
    account.bio ? el('p', { className: 'profile-bio', text: account.bio }) : null,
    link
      ? el('a', {
        className: 'profile-link',
        attrs: { href: link, target: '_blank', rel: 'noopener noreferrer' },
      }, icon('link', 16), el('span', { text: account.link_url }))
      : null,
  );
}

function tabs(counts, onSelect) {
  const row = el('div', { className: 'profile-tabs' });
  const entries = [
    ['posts', '投稿', counts.posts],
    ['messages', 'メッセージ', counts.messages],
    ['together', 'つながり', counts.together],
  ];
  let active = 'posts';
  const paint = () => {
    clear(row);
    entries.forEach(([id, label, count]) => {
      row.append(el('button', {
        className: `profile-tab${active === id ? ' on' : ''}`,
        attrs: { type: 'button', 'aria-pressed': String(active === id) },
        on: {
          click: () => {
            active = id;
            paint();
            onSelect(id);
          },
        },
      },
        el('span', { className: 'profile-tab-count num', text: String(count) }),
        el('span', { className: 'profile-tab-label', text: label }),
      ));
    });
  };
  paint();
  return row;
}

/** The three counts islands hard-coded. Derived here from what is actually there.
 *
 * つながり is the number of people this person has a route (航路) with: since
 * 2026-10-22 a route only grows from a message, a join or a reply, so it is
 * "people they have actually talked or joined with". It comes from
 * /api/connections?person=, one row per pair.
 */
function countsFor(posts, links) {
  return {
    posts: posts.length,
    messages: posts.reduce((sum, post) => sum + (post.comment_count || 0), 0),
    together: links ? links.length : '–',
  };
}

/** The lines this person is on. A failed read is null (shown as "could not load"), not zero. */
async function linksOf(accountId) {
  try {
    const result = await api.get(`/api/connections?person=${encodeURIComponent(accountId)}`, { auth: false });
    return (result.connections || []).filter((row) => row.a === accountId || row.b === accountId);
  } catch {
    return null;
  }
}

function postList(posts, { own, onOpen }) {
  const box = el('div', { className: 'profile-posts' });
  if (!posts.length) {
    box.append(el('div', { className: 'empty-panel' },
      own
        ? [
          el('p', { text: 'まだ投稿がありません。最初のひとことを書いてみましょう。' }),
          el('div', { className: 'empty-actions' }, el('button', {
            className: 'btn btn-small', attrs: { type: 'button', id: 'meEmptyPost' },
            text: '投稿する', on: { click: () => navigate('#/post') },
          })),
        ]
        : el('p', { text: '投稿はありません' })));
    return box;
  }
  posts.forEach((post) => {
    box.append(postCard(post, {
      compact: false,
      onComments: () => onOpen(post),
      onOpenAuthor: (id) => navigate(state.account?.id === id ? '#/me' : `#/u/${id}`),
      onReact: (kind) => react(post.id, kind),
      onEdit: own ? () => navigate(`#/post/${post.id}/edit`) : null,
      onDelete: own ? () => remove(post) : null,
      onSeeReactors: own ? (kind) => openReactors({
        post, kind,
        onOpenProfile: (id) => navigate(state.account?.id === id ? '#/me' : `#/u/${id}`),
      }) : null,
    }));
  });
  return box;
}

async function remove(post) {
  if (!await confirmAction({ title: 'この投稿を削除しますか？', body: '地図からも消えます。', confirmLabel: '削除する', danger: true })) return;
  try {
    await api.del(`/api/posts/${post.id}`);
    removePost(post.id);
    toast('削除しました。');
    await navigate('#/me');
  } catch (error) {
    toast(error.message);
  }
}

function openOnMap(post) {
  return openMapPost(post.id);
}

// ---------------------------------------------------------------- communities

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

/** マイページの「コミュニティ」の欄. */
function communitySection() {
  const box = el('section', { className: 'me-communities', attrs: { id: 'meCommunities' } });
  const paint = () => {
    clear(box);
    box.append(el('div', { className: 'section-label', text: 'コミュニティ' }));
    if (!state.communities.length) {
      box.append(el('p', { className: 'me-community-empty', text: NOT_MEMBER_NOTE }));
      return;
    }
    state.communities.forEach((entry) => box.append(communityCard(entry)));
  };
  paint();
  refreshCommunities().then(() => { if (box.isConnected) paint(); });
  return box;
}

function communityCard(entry) {
  const admin = entry.role === 'admin';
  const here = entry.id === state.communityId;
  const card = el('div', { className: 'me-community', attrs: { 'data-community-id': entry.id } },
    el('div', { className: 'me-community-head' },
      el('div', { className: 'me-community-name' },
        el('span', { className: 'me-community-title', text: entry.name }),
        el('span', { className: 'me-community-role', text: admin ? '管理者' : 'メンバー' }),
        here ? el('span', { className: 'me-community-here', text: '表示中' }) : null),
      el('button', {
        className: 'btn btn-small btn-quiet me-community-open', attrs: { type: 'button' },
        text: '地図を開く',
        on: { click: () => { chooseCurrent(entry.id); navigate('#/map'); } },
      })));
  if (admin) card.append(invitePanel(entry));
  return card;
}

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

// ---------------------------------------------------------------- my page

async function renderMe() {
  const body = clear($('meBody'));
  if (!state.account) {
    body.append(el('p', { className: 'empty-note', text: 'ログインしてください。' }));
    return;
  }
  body.append(header(state.account, { own: true }));
  body.append(el('button', {
    className: 'btn-link me-howto', attrs: { type: 'button', id: 'meHowto' },
    text: 'islands の使い方を見る',
    on: { click: () => { markGuidanceReview(); navigate('#/guidance?review=1'); } },
  }));
  // The way into the DM: only where 「話してみたい」 is switched on.
  if (talkAvailable()) {
    const unread = unreadDmCount(state.notifications);
    body.append(el('button', {
      className: 'list-row me-dm', attrs: { type: 'button', id: 'meDm' },
      on: { click: () => navigate('#/dm') },
    },
      el('span', { className: 'me-dm-icon' }, icon('message', 20)),
      el('div', { className: 'list-row-body' },
        el('div', { className: 'list-row-title', text: 'DM' }),
        el('div', { className: 'list-row-sub', text: '2人だけで話せるメッセージ' })),
      unread ? el('span', { className: 'unread-badge', text: `未読 ${unread}件` }) : null,
      el('span', { className: 'stack-go', text: '›', attrs: { 'aria-hidden': 'true' } }),
    ));
  }
  // Which communities I am in, and for an admin the invite links.
  if (communitiesActive()) body.append(communitySection());
  refreshMyViews();

  let posts = state.myPosts;
  const [fetched, links] = await Promise.all([
    data.postsByAuthor(state.account.id).catch(() => null),
    linksOf(state.account.id),
  ]);
  if (fetched) {
    posts = fetched;
    state.myPosts = posts;
  }
  const counts = countsFor(posts, links);
  const panel = el('div', { className: 'profile-panel' });
  body.append(tabs(counts, (tab) => paintTab(panel, tab, posts, true, links, state.account.id)), panel);
  paintTab(panel, 'posts', posts, true, links, state.account.id);
}

function paintTab(panel, tab, posts, own, links, personId) {
  clear(panel);
  if (tab === 'posts') {
    panel.append(postList(posts, { own, onOpen: openOnMap }));
    return;
  }
  if (tab === 'messages') {
    const total = posts.reduce((sum, post) => sum + (post.comment_count || 0), 0);
    panel.append(total
      ? el('div', { className: 'profile-summary' },
        el('p', { text: `${total} 件のメッセージが届いています。` }),
        ...posts.filter((post) => post.comment_count).map((post) =>
          el('button', {
            className: 'list-row', attrs: { type: 'button' },
            on: { click: () => openOnMap(post) },
          },
            el('div', { className: 'list-row-body' },
              el('div', { className: 'list-row-title', text: post.body.slice(0, 24) }),
              el('div', { className: 'list-row-sub', text: `${post.comment_count} 件` }),
            ),
          )))
      : el('div', { className: 'empty-panel' }, el('p', { text: 'メッセージはありません' })));
    return;
  }
  panel.append(el('p', { className: 'empty-note', text: 'つながりは、メッセージや参加でやりとりした人の数です。' }));
  if (!links) {
    panel.append(el('div', { className: 'empty-panel' }, el('p', { text: 'つながりを読み込めませんでした' })));
    return;
  }
  panel.append(links.length
    ? el('div', { className: 'profile-summary' },
      el('p', { text: `${links.length} 人とつながっています。` }),
      ...links.map((row) => {
        const side = row.a === personId ? 'b' : 'a';
        const other = { id: row[side], display_name: row[`${side}_name`], icon_id: row[`${side}_icon`] };
        return el('button', {
          className: 'list-row', attrs: { type: 'button' },
          on: { click: () => navigate(state.account?.id === other.id ? '#/me' : `#/u/${other.id}`) },
        },
          avatar(other, 36),
          el('div', { className: 'list-row-body' },
            el('div', { className: 'list-row-title', text: other.display_name || '名前のない人' }),
          ),
        );
      }))
    : el('div', { className: 'empty-panel' }, el('p', { text: 'まだつながっている人はいません' })));
}

// ---------------------------------------------------------------- edit

export function setupProfileEdit() {
  const avatarField = setupAvatarField('edit');

  $('editBack').addEventListener('click', () => navigate('#/me'));

  $('editSave').addEventListener('click', async () => {
    const name = $('editName').value.trim();
    if (!name) {
      $('editError').textContent = '名前を入力してください。';
      return;
    }
    $('editSave').disabled = true;
    try {
      // Empty boxes go as null on purpose: the API reads an explicit null as
      // "clear this column". An omitted key would mean "leave it alone", and
      // that is what used to make 自己紹介 and リンク impossible to take back.
      const result = await api.put('/api/account/me', {
        display_name: name,
        affiliation: $('editAffiliation').value.trim() || null,
        bio: $('editBio').value.trim() || null,
        link_url: $('editLink').value.trim() || null,
        ...(await avatarField.commit()),
      });
      state.account = result.account;
      editDraft = null;
      toast('保存しました。');
      navigate('#/me');
    } catch (error) {
      $('editError').textContent = error.message;
    } finally {
      $('editSave').disabled = false;
    }
  });

  // Sound and buzz (item 21): they change the moment they are switched, with
  // a sample of what was just turned on, so nobody has to save to find out.
  $('setSound').addEventListener('change', (event) => {
    setFeedback({ sound: event.target.checked });
    // Wait for the audio to wake up, or the sample is dropped silently.
    if (event.target.checked) resumeAudio().then(() => sound('notify'));
  });
  $('setVibrate').addEventListener('change', (event) => {
    setFeedback({ vibrate: event.target.checked });
    if (event.target.checked) buzz('tap');
  });
  $('setReduceMotion').addEventListener('change', (event) => {
    setFeedback({ reduceMotion: event.target.checked });
  });

  setupNotifyFields();

  $('editSignOut').addEventListener('click', async () => {
    // While still signed in: the next person on this device must not get
    // this one's notifications.
    $('editSignOut').disabled = true;
    await forgetDevice();
    $('editSignOut').disabled = false;
    session.signOut();
    state.account = null;
    state.myViews = {};
    state.trialPost = null;
    state.myPosts = [];
    state.neighbors = new Map();
    state.activePostId = null;
    state.quietPost = undefined;
    window.dispatchEvent(new Event('islands:signout'));
    state.reactions = new Set();
    navigate('#/auth');
  });

  screen('profileEdit', {
    leave() {
      flushNotifySettings();
      editDraft = {
        name: $('editName').value,
        affiliation: $('editAffiliation').value,
        bio: $('editBio').value,
        link: $('editLink').value,
      };
    },
    enter(params, query) {
      const account = state.account || {};
      avatarField.reset(account);
      enterNotifyFields({ scroll: Boolean(query && query.has('notify')) });
      if (editDraft) {
        $('editName').value = editDraft.name;
        $('editAffiliation').value = editDraft.affiliation;
        $('editBio').value = editDraft.bio;
        $('editLink').value = editDraft.link;
      } else {
        $('editName').value = account.display_name || '';
        $('editAffiliation').value = account.affiliation || '';
        $('editBio').value = account.bio || '';
        $('editLink').value = account.link_url || '';
      }
      $('editEmail').value = session.email() || '';
      // Signed in with LINE, which hands over no email unless asked: say how instead of a blank.
      const via = { google: 'Google', 'custom:line': 'LINE' }[session.provider()];
      $('editEmail').placeholder = via ? `${via} でログインしています` : '';
      $('editError').textContent = '';
      const settings = feedbackSettings();
      $('setSound').checked = settings.sound;
      $('setVibrate').checked = settings.vibrate && canBuzz;
      $('setVibrate').disabled = !canBuzz;
      $('setVibrateNote').textContent = canBuzz
        ? '押したときなどに短く震えます'
        : 'この端末のブラウザは振動に対応していません（iPhone など）';
      $('setReduceMotion').checked = settings.reduceMotion;
    },
  });
}

// ---------------------------------------------------------------- notifications (段6)
//
// Two separate things. Whether THIS device is told anything (a browser
// subscription, so it lives here and is answered by push.js), and which kinds
// are worth telling about at all (one row per kind on the server, shared by
// every device the person uses). Switches save the moment they move, like the
// sound settings above.

const SAVE_WAIT_MS = 400;

const DEVICE_TEXT = {
  on: 'この端末に届きます',
  off: 'この端末には届きません',
  blocked: 'この端末では通知が止められています',
  'ios-install': 'iPhone・iPad は、ホーム画面に追加すると届きます',
  'ios-old': 'iOS 16.4 以降で届きます',
  unsupported: 'このブラウザは端末への通知に対応していません',
};

const DEVICE_NOTE = {
  blocked: 'ブラウザのサイトの設定（iPhone は 設定 → 通知 → islands）で通知を許可すると、受け取れます。',
  'ios-old': '設定 → 一般 → ソフトウェアアップデート から更新できます。アプリの中の通知には届きます。',
  unsupported: 'アプリの中の通知（ベル）には届きます。',
};

let deviceStatus = null;
let saveTimer = 0;
let edits = 0;             // switch moves so far; a reply to an older save is ignored

function paintDevice(status) {
  deviceStatus = status;
  const button = $('notifyDeviceButton');
  $('notifyDeviceText').textContent = DEVICE_TEXT[status] || DEVICE_TEXT.unsupported;
  button.hidden = status !== 'on' && status !== 'off';
  button.textContent = status === 'on' ? 'やめる' : '受け取る';
  button.classList.toggle('btn-quiet', status === 'on');
  let note = DEVICE_NOTE[status] || '';
  if (status === 'ios-install' && iosOtherBrowser(navigator.userAgent)) {
    note = 'このブラウザからは追加できないことがあります。Safari で開いてから追加してください。';
  }
  $('notifyDeviceNote').textContent = note;
  $('notifyDeviceNote').hidden = !note;
  $('iosSteps').hidden = status !== 'ios-install';
  $('iosStepsNote').hidden = status !== 'ios-install';
}

function kindSwitches() {
  return [...$('notifyKinds').querySelectorAll('input.switch')];
}

function paintKinds(settings) {
  kindSwitches().forEach((input) => {
    input.checked = Boolean(settings[input.dataset.category]?.[input.dataset.channel]);
  });
}

async function saveKinds() {
  saveTimer = 0;
  const asked = edits;
  try {
    const result = await api.put('/api/notification-settings', { settings: settingsRows(state.notifySettings) });
    if (asked === edits) useNotifySettings(result.settings, result.quiet_post);
  } catch {
    if (asked !== edits) return;
    toast('通知の設定を保存できませんでした。もう一度お試しください。');
    paintKinds(await loadNotifySettings({ force: true }));
  }
}

function kindChanged() {
  const settings = mergeSettings(state.notifySettings);
  kindSwitches().forEach((input) => {
    settings[input.dataset.category][input.dataset.channel] = input.checked;
  });
  edits += 1;
  // The badge and band follow at once; the server a moment later, in one go.
  useNotifySettings(settings, state.quietPost);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveKinds, SAVE_WAIT_MS);
}

function flushNotifySettings() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveKinds();
}

function setupNotifyFields() {
  const kinds = clear($('notifyKinds'));
  kinds.append(el('div', { className: 'notify-head', attrs: { 'aria-hidden': 'true' } },
    el('span'), el('span', { text: '端末' }), el('span', { text: 'アプリ内' })));
  CATEGORIES.forEach(({ id, title, note }) => {
    const toggle = (channel, label) => el('input', {
      className: 'switch',
      type: 'checkbox',
      attrs: { 'data-category': id, 'data-channel': channel, 'aria-label': `${title}：${label}` },
      on: { change: kindChanged },
    });
    kinds.append(el('div', { className: 'notify-row' },
      el('span', { className: 'switch-text' },
        el('span', { className: 'switch-title', text: title }),
        el('span', { className: 'switch-note', text: note })),
      toggle('push', '端末に届ける'),
      toggle('in_app', 'アプリ内で知らせる')));
  });

  $('notifyDeviceButton').addEventListener('click', async () => {
    const button = $('notifyDeviceButton');
    button.disabled = true;
    try {
      // enablePush asks for permission before anything else is awaited: an
      // iPhone only shows the question in direct answer to this tap.
      const next = deviceStatus === 'on' ? await disablePush() : await enablePush();
      paintDevice(next);
      if (next === 'on') {
        toast('この端末に通知が届くようになりました。');
        resumeAudio().then(() => sound('notify'));
      }
    } catch {
      toast('この端末を登録できませんでした。もう一度お試しください。');
      paintDevice(await pushStatus());
    } finally {
      button.disabled = false;
    }
  });

  // Back from the browser's or the phone's settings: the answer may have changed.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && activeScreen() === 'profileEdit') pushStatus().then(paintDevice);
  });
}

function enterNotifyFields({ scroll }) {
  paintKinds(state.notifySettings || defaultSettings());
  loadNotifySettings().then((settings) => {
    if (!saveTimer) paintKinds(settings);
  });
  if (deviceStatus) paintDevice(deviceStatus);
  pushStatus().then(paintDevice);
  if (scroll) requestAnimationFrame(() => $('notifySettings').scrollIntoView({ block: 'start' }));
}

// ---------------------------------------------------------------- other people

async function renderUser(accountId) {
  const body = clear($('userBody'));
  body.append(el('p', { className: 'sheet-loading', text: '読み込み中…' }));

  let account = null;
  let posts = [];
  let links = null;
  try {
    [account, posts, links] = await Promise.all([
      data.getAccount(accountId),
      data.postsByAuthor(accountId),
      linksOf(accountId),
    ]);
  } catch (error) {
    clear(body).append(el('p', { className: 'sheet-error', text: error.message }));
    return;
  }
  if (!account) {
    clear(body).append(el('p', { className: 'empty-note', text: '見つかりませんでした。' }));
    return;
  }

  clear(body).append(header(account, { own: false }));
  // The same button as under a post card; it stays hidden (null state) for yourself,
  // signed out, the feature off, or somebody you share no 会 with.
  const talk = talkOptionsForPerson(accountId, account.display_name);
  if (talk) {
    body.append(el('div', { className: 'profile-talk' }, talkButton(talk)));
    refreshTalk({ maxAge: 20000 });
  }
  const counts = countsFor(posts, links);
  const panel = el('div', { className: 'profile-panel' });
  body.append(tabs(counts, (tab) => paintTab(panel, tab, posts, false, links, accountId)), panel);
  paintTab(panel, 'posts', posts, false, links, accountId);
}

// ---------------------------------------------------------------- wiring

export function setupProfile() {
  screen('me', { enter: renderMe });
  setupProfileEdit();
  $('userBack').addEventListener('click', () => history.back());
  screen('user', { enter: (params) => renderUser(params.id) });
}

export { renderMe };
