// The map screen: the canvas, the chrome over it, and the post sheet.
//
// The sheet is islands' bottom panel, behaviour included: it opens at half
// height showing the card, and swiping up (or scrolling into it) expands it to
// full height where the message thread appears with the input pinned to the
// bottom. The half state is what lets you read a card without losing the map.

import { config, islandColor } from '../config.js';
import { api, data } from '../net.js';
import { navigate, screen } from '../router.js';
import {
  hasReacted, matchesFilters, reactionKey, removePost, setPosts, state, upsertPost,
} from '../state.js';
import {
  $, $$, clear, closeSheet, confirmAction, el, expandSheet, openSheet, sheetExpanded,
  sheetOpen, toast,
} from '../ui.js';
import { postCard } from '../components/postcard.js';
import { chatInput, postChat } from '../components/chat.js';
import {
  fitCamera, focusOn, initMap, invalidateOrbit, landmassOf, onCameraSettled, resize, viewport,
} from '../map/index.js';

const POLL_MS = 15000;
let pollTimer = 0;
let booted = false;
let activeChat = null;

// ---------------------------------------------------------------- data

export async function refreshMap({ fitFirst = false } = {}) {
  if (fitFirst) fitCamera();
  const bounds = viewport();
  const limit = config().limits.map_post_limit;
  try {
    const posts = await data.mapPosts({ ...bounds, limit });
    const saturated = posts.length >= limit;
    setPosts(posts, { saturated });
    if (saturated) {
      // Only then: the coarse layer exists so distant land does not vanish when
      // the viewport holds more posts than we asked for. Fetching it always
      // would be a second query on every pan for nothing.
      try {
        state.cells = await data.mapCells(bounds);
      } catch {
        state.cells = [];
      }
    } else {
      state.cells = [];
    }
    return true;
  } catch {
    return false;
  }
}

export async function refreshIslands() {
  try {
    const result = await api.get('/api/islands', { auth: false });
    state.islands = result.islands || [];
    paintBadge();
  } catch {
    /* keep the previous names rather than blanking every label */
  }
}

export async function refreshMyReactions() {
  if (!state.account) return;
  try {
    const rows = await data.myReactions();
    state.reactions = new Set(rows.map((row) => reactionKey(row.post_id, row.kind)));
  } catch {
    /* a missed poll is not worth telling anyone about */
  }
}

export async function refreshMyPosts() {
  if (!state.account) return;
  try {
    state.myPosts = await data.postsByAuthor(state.account.id);
    if (!state.activePostId && state.myPosts.length) {
      state.activePostId = state.myPosts[0].id;
    }
    if (state.activePostId && !state.myPosts.some((p) => p.id === state.activePostId)) {
      state.activePostId = state.myPosts.length ? state.myPosts[0].id : null;
    }
  } catch {
    /* leave whatever was there */
  }
}

async function refreshNeighbors() {
  if (!state.activePostId) {
    state.neighbors = [];
    return;
  }
  try {
    const result = await api.get(
      `/api/neighbors?post=${encodeURIComponent(state.activePostId)}` +
      `&limit=${config().limits.orbit_neighbors}`,
      { auth: false },
    );
    state.neighbors = result.neighbors || [];
    invalidateOrbit();
  } catch {
    state.neighbors = [];
  }
}

// ---------------------------------------------------------------- chrome

function paintBadge() {
  const badge = $('islandBadge');
  const mine = state.activePostId ? state.postsById.get(state.activePostId) : null;
  if (state.view !== 'map' || !mine) {
    badge.hidden = true;
    return;
  }
  const named = state.islands.find((island) =>
    Math.hypot(island.cx - mine.x, island.cy - mine.y) < 260);
  const local = landmassOf(mine.id);
  if (!named && !local) {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  $('islandSwatch').style.background = islandColor(mine.cluster_id);
  clear($('islandText')).append(
    document.createTextNode('あなたは '),
    el('b', { text: named ? named.label : `${local.size}件の島` }),
    document.createTextNode(' にいます'),
  );
}

function paintFilterPanel() {
  const panel = clear($('mapFilterPanel'));
  config().tags.forEach((tag) => {
    const on = state.filters.tags.includes(tag);
    panel.append(el('button', {
      className: `filter-tag${on ? ' on' : ''}`,
      attrs: { type: 'button', 'aria-pressed': String(on) },
      text: tag,
      on: {
        click: () => {
          state.filters.tags = on
            ? state.filters.tags.filter((entry) => entry !== tag)
            : state.filters.tags.concat(tag);
          paintFilterPanel();
          paintFilterCount();
        },
      },
    }));
  });
}

function paintFilterCount() {
  const badge = $('mapFilterCount');
  const count = state.filters.tags.length;
  badge.hidden = count === 0;
  badge.textContent = String(count);
  $('mapFilterBtn').classList.toggle('on', count > 0);
}

function setupChrome() {
  const search = $('mapSearch');
  search.addEventListener('input', () => {
    state.filters.query = search.value.trim();
    $('mapSearchClear').hidden = !search.value;
  });
  $('mapSearchClear').addEventListener('click', () => {
    search.value = '';
    state.filters.query = '';
    $('mapSearchClear').hidden = true;
  });

  $('mapFilterBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    const panel = $('mapFilterPanel');
    panel.hidden = !panel.hidden;
  });
  document.addEventListener('pointerdown', (event) => {
    if (!$('mapFilter').contains(event.target)) $('mapFilterPanel').hidden = true;
  });

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((other) => other.classList.remove('on'));
      tab.classList.add('on');
      state.view = tab.dataset.view;
      if (state.view === 'map') fitCamera();
      else refreshNeighbors();
      paintBadge();
    });
  });

  $('mapRecenter').addEventListener('click', () => {
    const mine = state.activePostId ? state.postsById.get(state.activePostId) : null;
    // islands' version of this button dispatched a resize event and hoped. It
    // moves the camera now: onto your own island if you have one, and onto the
    // whole map if you do not.
    if (mine) focusOn(mine, { lift: 0.42 });
    else fitCamera();
  });

  document.addEventListener('map:open', (event) => {
    openPost(event.detail.postId);
  });
  document.addEventListener('map:focus', async (event) => {
    const post = state.postsById.get(event.detail.postId);
    if (post) focusOn(post, { lift: 0.42 });
    else {
      await refreshMap();
      const found = state.postsById.get(event.detail.postId);
      if (found) focusOn(found, { lift: 0.42 });
    }
  });
}

// ---------------------------------------------------------------- sheet

export async function openPost(postId) {
  let post = state.postsById.get(postId);
  const body = openSheet({ onClose: () => {
    if (activeChat) activeChat.destroy();
    activeChat = null;
    state.selected = null;
  } });
  clear(body).append(el('p', { className: 'sheet-loading', text: '読み込み中…' }));
  clear($('sheetFoot'));

  if (!post) {
    try {
      post = await data.getPost(postId);
    } catch (error) {
      clear(body).append(el('p', { className: 'sheet-error', text: error.message }));
      return;
    }
  }
  if (!post) {
    clear(body).append(el('p', { className: 'sheet-error', text: '見つかりませんでした。' }));
    return;
  }
  state.selected = post;
  await renderSheet(post);
}

async function renderSheet(post) {
  const body = clear($('sheetBody'));
  const mine = state.account && post.author_id === state.account.id;

  // 似てる度 against whichever of my posts the orbit is centred on. Asking the
  // server rather than measuring on the map: the map is a 2-D shadow, and this
  // number is the 448-dim cosine the ranking already uses.
  let similarity = null;
  if (!mine && state.activePostId && state.activePostId !== post.id) {
    try {
      similarity = await api.get(
        `/api/pair?a=${encodeURIComponent(state.activePostId)}&b=${encodeURIComponent(post.id)}`,
        { auth: false },
      );
    } catch {
      similarity = null;
    }
  }

  const island = state.islands.find((entry) =>
    Math.hypot(entry.cx - post.x, entry.cy - post.y) < 260);
  if (island) {
    body.append(el('div', { className: 'sheet-island' },
      el('i', { className: 'island-swatch', style: { background: islandColor(post.cluster_id) } }),
      el('span', { text: `${island.label} のあたり` }),
    ));
  }

  body.append(postCard(post, {
    similarity,
    onReact: (kind) => react(post.id, kind),
    onOpenAuthor: (authorId) => {
      closeSheet();
      navigate(mine ? '#/me' : `#/u/${authorId}`);
    },
    onComments: () => expandSheet(true),
    onEdit: () => {
      closeSheet();
      navigate(`#/post/${post.id}/edit`);
    },
    onDelete: () => removeOwnPost(post),
    onReport: mine ? null : () => report(post),
  }));

  // The thread only exists once the sheet is expanded - islands' rule, and a
  // good one: at half height the card is the thing, and a message list peeking
  // under it just makes both harder to read.
  const thread = el('div', { className: 'sheet-thread' });
  body.append(thread);
  paintThread(post, thread);
  document.addEventListener('sheet:expand', () => paintThread(post, thread));
}

function paintThread(post, container) {
  clear(container);
  clear($('sheetFoot'));
  if (activeChat) {
    activeChat.destroy();
    activeChat = null;
  }
  if (!sheetExpanded()) {
    container.append(el('button', {
      className: 'thread-open',
      attrs: { type: 'button' },
      text: post.comment_count
        ? `メッセージを見る（${post.comment_count}）`
        : 'メッセージを送る',
      on: { click: () => expandSheet(true) },
    }));
    return;
  }
  activeChat = postChat(post.id, {
    onCountChange: (count) => upsertPost({ id: post.id, comment_count: count }),
  });
  container.append(el('div', { className: 'section-label', text: 'メッセージ' }), activeChat.node);
  if (state.account) {
    $('sheetFoot').append(chatInput(post.id, { onSent: () => activeChat.refresh() }));
  } else {
    $('sheetFoot').append(el('button', {
      className: 'btn btn-block',
      text: 'ログインしてメッセージを送る',
      on: { click: () => { closeSheet(); navigate('#/auth'); } },
    }));
  }
}

async function react(postId, kind) {
  if (!state.account) {
    toast('リアクションするにはログインしてください。');
    navigate('#/auth');
    return;
  }
  const on = hasReacted(postId, kind);
  const post = state.postsById.get(postId) || state.selected;
  const column = `${kind}_count`;
  // Optimistic: the tap should feel done immediately, and a failure puts it
  // back rather than leaving the button lying about what happened.
  if (on) state.reactions.delete(reactionKey(postId, kind));
  else state.reactions.add(reactionKey(postId, kind));
  // A MINIMAL patch, not a spread of the whole row. Spreading would carry the
  // server's `energy` along with it, and upsertPost can only tell that the
  // energy is now stale by seeing that the patch moved a count without
  // supplying one. The difference is whether the island grows under your finger
  // or fifteen seconds later.
  if (post) {
    upsertPost({ id: postId, [column]: Math.max(0, (post[column] || 0) + (on ? -1 : 1)) });
  }
  try {
    if (on) await data.removeReaction(postId, kind);
    else await data.addReaction(postId, kind);
  } catch (error) {
    if (on) state.reactions.add(reactionKey(postId, kind));
    else state.reactions.delete(reactionKey(postId, kind));
    if (post) upsertPost({ id: postId, [column]: post[column] || 0 });
    toast(error.message);
  }
}

async function removeOwnPost(post) {
  const ok = await confirmAction({
    title: 'この投稿を削除しますか？',
    body: '地図からも消えます。届いたメッセージは残ります。',
    confirmLabel: '削除する',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/api/posts/${post.id}`);
    removePost(post.id);
    closeSheet();
    toast('削除しました。');
    refreshIslands();
  } catch (error) {
    toast(error.message);
  }
}

async function report(post) {
  const ok = await confirmAction({
    title: 'この投稿を報告しますか？',
    body: '内容を確認します。報告したことは相手には伝わりません。',
    confirmLabel: '報告する',
  });
  if (!ok) return;
  try {
    await data.report({ postId: post.id });
    toast('報告しました。ありがとうございます。');
  } catch (error) {
    toast(error.message);
  }
}

/** islands' swipe: half height to full and back. */
function setupSheetGesture() {
  const sheet = $('sheet');
  const scroll = $('sheetScroll');
  let startY = 0;
  let atTop = true;

  sheet.addEventListener('touchstart', (event) => {
    startY = event.touches[0].clientY;
    atTop = scroll.scrollTop <= 0;
  }, { passive: true });

  sheet.addEventListener('touchmove', (event) => {
    const delta = startY - event.touches[0].clientY;
    if (!sheetExpanded() && delta > 24) expandSheet(true);
    // Only collapse from the top of the thread. Otherwise scrolling back up
    // through a long conversation would slam the sheet shut halfway.
    else if (sheetExpanded() && delta < -24 && atTop && scroll.scrollTop <= 0) {
      expandSheet(false);
    }
  }, { passive: true });

  scroll.addEventListener('wheel', (event) => {
    if (!sheetOpen()) return;
    if (!sheetExpanded() && event.deltaY > 8) expandSheet(true);
    else if (sheetExpanded() && event.deltaY < -8 && scroll.scrollTop <= 0) expandSheet(false);
  }, { passive: true });

  $('sheetGrip').addEventListener('click', () => expandSheet(!sheetExpanded()));
  $('sheetClose').addEventListener('click', closeSheet);
  $('sheetBackdrop').addEventListener('pointerdown', closeSheet);
}

// ---------------------------------------------------------------- polling

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    // A backgrounded tab should not keep polling; it catches up on visibility.
    if (document.hidden || document.querySelector('.screen.active').id !== 'map') return;
    await refreshMap();
    await Promise.all([refreshIslands(), refreshMyReactions()]);
    if (state.view === 'orbit') await refreshNeighbors();
  }, POLL_MS);

  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || document.querySelector('.screen.active').id !== 'map') return;
    await refreshMap();
    refreshIslands();
  });
}

// ---------------------------------------------------------------- screen

export function setupMapScreen() {
  setupChrome();
  setupSheetGesture();
  paintFilterPanel();
  paintFilterCount();

  screen('map', {
    async enter() {
      if (!booted) {
        booted = true;
        initMap($('stage'), { onSelect: (post) => (post ? openPost(post.id) : closeSheet()) });
        // A pan that ends somewhere new should pull in what is there. Debounced
        // inside the map module, so a long drag is one request and not fifty.
        onCameraSettled(() => refreshMap());
        const ok = await refreshMap({ fitFirst: true });
        if (!ok) toast('地図を読み込めませんでした。再試行しています…');
        await Promise.all([refreshIslands(), refreshMyPosts(), refreshMyReactions()]);
        await refreshNeighbors();
        startPolling();
      } else {
        resize();
        await refreshMap();
        refreshIslands();
      }
      paintBadge();
    },
  });
}
