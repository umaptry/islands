// マイページ, プロフィール編集, and somebody else's profile.
//
// islands' three profile screens, with the parts that were placeholders filled
// in: the tab counts were 345 and 1 written into the source, and another
// person's page said "このユーザーのプロフィール情報はまだ登録されていません"
// because there was nowhere for it to be registered. There is an accounts table
// now, so both read real rows.

import { data, api } from '../net.js';
import { session } from '../session.js';
import { navigate, screen } from '../router.js';
import { state } from '../state.js';
import { $, avatar, clear, el, safeUrl, toast } from '../ui.js';
import { postCard } from '../components/postcard.js';
import { setupAvatarField } from './auth.js';

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
        attrs: { type: 'button' },
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
      onOpenAuthor: () => {},
      onReact: null,
      onEdit: own ? () => navigate(`#/post/${post.id}/edit`) : null,
      onDelete: own ? () => remove(post) : null,
    }));
  });
  return box;
}

async function remove(post) {
  try {
    await api.del(`/api/posts/${post.id}`);
    state.myPosts = state.myPosts.filter((entry) => entry.id !== post.id);
    toast('削除しました。');
    navigate('#/me');
    renderMe();
  } catch (error) {
    toast(error.message);
  }
}

function openOnMap(post) {
  navigate('#/map');
  setTimeout(() => {
    document.dispatchEvent(new CustomEvent('map:focus', { detail: { postId: post.id } }));
    document.dispatchEvent(new CustomEvent('map:open', { detail: { postId: post.id } }));
  }, 80);
}

// ---------------------------------------------------------------- my page

async function renderMe() {
  const body = clear($('meBody'));
  if (!state.account) {
    body.append(el('p', { className: 'empty-note', text: 'ログインしてください。' }));
    return;
  }
  body.append(header(state.account, { own: true }));

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
      toast('保存しました。');
      navigate('#/me');
    } catch (error) {
      $('editError').textContent = error.message;
    } finally {
      $('editSave').disabled = false;
    }
  });

  $('editSignOut').addEventListener('click', () => {
    session.signOut();
    state.account = null;
    state.myPosts = [];
    state.activePostId = null;
    state.reactions = new Set();
    navigate('#/auth');
  });

  screen('profileEdit', {
    enter() {
      const account = state.account || {};
      avatarField.reset(account);
      $('editName').value = account.display_name || '';
      $('editAffiliation').value = account.affiliation || '';
      $('editBio').value = account.bio || '';
      $('editLink').value = account.link_url || '';
      $('editError').textContent = '';
    },
  });
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
