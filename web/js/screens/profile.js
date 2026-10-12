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
import { setupAvatarField } from './auth.js';
import { buzz, canBuzz, feedbackSettings, setFeedback, sound } from '../feedback.js';
import { CATEGORIES, defaultSettings, iosOtherBrowser, mergeSettings, settingsRows } from '../notify-rules.js';
import { disablePush, enablePush, forgetDevice, pushStatus } from '../push.js';
import { loadNotifySettings, useNotifySettings } from './notifications.js';

let editDraft = null;

// ---------------------------------------------------------------- shared

function header(account, { own } = {}) {
  const link = safeUrl(account.link_url);
  return el('div', { className: 'profile-head' },
    el('div', { className: 'profile-top' },
      avatar(account, 78),
      own
        ? el('button', {
          className: 'btn btn-small btn-outline',
          text: 'プロフィールを編集',
          on: { click: () => navigate('#/me/edit') },
        })
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
        text: account.link_url,
        attrs: { href: link, target: '_blank', rel: 'noopener noreferrer' },
      })
      : null,
  );
}

function tabs(counts, onSelect) {
  const row = el('div', { className: 'profile-tabs' });
  const entries = [
    ['posts', '投稿', counts.posts],
    ['messages', 'メッセージ', counts.messages],
    ['together', '協働', counts.together],
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
 * 協働 is "people who have reacted with 手伝えるかも or 参加したい to something
 * you wrote" - the two reactions that mean somebody offered to do a thing with
 * you, which is the only sense in which islands' "協働" tab ever meant anything.
 */
function countsFor(posts) {
  return {
    posts: posts.length,
    messages: posts.reduce((sum, post) => sum + (post.comment_count || 0), 0),
    together: posts.reduce((sum, post) =>
      sum + (post.help_count || 0) + (post.join_count || 0), 0),
  };
}

function postList(posts, { own, onOpen }) {
  const box = el('div', { className: 'profile-posts' });
  if (!posts.length) {
    box.append(el('div', { className: 'empty-panel' },
      el('p', { text: '投稿はありません' })));
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
  refreshMyViews();

  let posts = state.myPosts;
  try {
    posts = await data.postsByAuthor(state.account.id);
    state.myPosts = posts;
  } catch {
    /* fall back to whatever the map already loaded */
  }

  const counts = countsFor(posts);
  const panel = el('div', { className: 'profile-panel' });
  body.append(tabs(counts, (tab) => paintTab(panel, tab, posts, true)), panel);
  paintTab(panel, 'posts', posts, true);
}

function paintTab(panel, tab, posts, own) {
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
  const total = posts.reduce((sum, post) =>
    sum + (post.help_count || 0) + (post.join_count || 0), 0);
  panel.append(el('p', { className: 'empty-note', text: '協働は「手伝えるかも」「参加したい」の反応を集計しています。' }));
  panel.append(total
    ? el('div', { className: 'profile-summary' },
      el('p', { text: `${total} 件の「手伝えるかも」「参加したい」が届いています。` }),
      ...posts.filter((post) => (post.help_count || 0) + (post.join_count || 0)).map((post) =>
        el('button', {
          className: 'list-row', attrs: { type: 'button' },
          on: { click: () => openOnMap(post) },
        },
          el('div', { className: 'list-row-body' },
            el('div', { className: 'list-row-title', text: post.body.slice(0, 24) }),
            el('div', {
              className: 'list-row-sub',
              text: `手伝えるかも ${post.help_count || 0}・参加したい ${post.join_count || 0}`,
            }),
          ),
        )))
    : el('div', { className: 'empty-panel' }, el('p', { text: '協働の記録はありません' })));
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
    if (event.target.checked) sound('notify');
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
    state.activePostId = null;
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
    if (asked === edits) useNotifySettings(result.settings);
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
  useNotifySettings(settings);
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
        sound('notify');
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
  try {
    [account, posts] = await Promise.all([
      data.getAccount(accountId),
      data.postsByAuthor(accountId),
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
  const counts = countsFor(posts);
  const panel = el('div', { className: 'profile-panel' });
  body.append(tabs(counts, (tab) => paintTab(panel, tab, posts, false)), panel);
  paintTab(panel, 'posts', posts, false);
}

// ---------------------------------------------------------------- wiring

export function setupProfile() {
  screen('me', { enter: renderMe });
  setupProfileEdit();
  $('userBack').addEventListener('click', () => history.back());
  screen('user', { enter: (params) => renderUser(params.id) });
}

export { renderMe };
