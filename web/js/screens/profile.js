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
