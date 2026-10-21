// The map screen: the canvas, the chrome over it, and the post sheet.
//
// The sheet is islands' bottom panel, behaviour included: it opens at half
// height showing the card, and swiping up (or scrolling into it) expands it to
// full height where the message thread appears with the input pinned to the
// bottom. The half state is what lets you read a card without losing the map.

import { config, isLocal, islandColor, setReachFactor } from '../config.js';
import { api, data } from '../net.js';
import { navigate, screen, activeScreen } from '../router.js';
import {
  hasReacted, matchesFilters, reactionKey, removePost, setPosts, state, upsertPost, notify,
} from '../state.js';
import {
  $, clear, clip, closeSheet, confirmAction, el, expandSheet, motivationColor, openSheet, sheetExpanded,
  sheetOpen, toast, desktopSheet, setupSheetAccessibility,
} from '../ui.js';
import { postCard } from '../components/postcard.js';
import { openReactors } from '../components/reactors.js';
import { chatInput, postChat } from '../components/chat.js';
import { loadDigest, paintMarks, setupMeet } from './meet.js';
import { refreshExtras, hideTrialHint, setupMapExtras, showTrialHint } from './map-extras.js';
import { trialView } from './map-extras-logic.js';
import {
  abortReveal, fitCamera, focusOn, initMap, onCameraSettled, participantView, playReveal,
  resize, ripple, setParticipantView, showAll, startMap, stopMap, viewport, zoomTo,
} from '../map/index.js';
import { noteLinks } from '../map/lines.js';
import { isRecruiting, markRead } from '../map/reads.js';
import { buzz, viewerKey } from '../feedback.js';
import { playSe, setAmbient } from '../audio.js';

const VIEWS_MS = 60000;
const viewed = new Set();   // posts already counted in this visit (Q35)
let viewsAt = 0;

const POLL_MS = 15000;
let pollTimer = 0;
let booted = false;
let activeChat = null;
let selectionGeneration = 0;
let sheetEvents = null;
let restorePost = null;
let mapRequest = 0;
let mapError = false;
let worldCount = null;   // how many posts the whole world has (null: not asked yet)
let myLinks = { owner: null, count: 0 };   // how many roads are mine, for the success sound

function paintMapStatus() {
  const status = $('mapStatus');
  const filtering = state.filters.query || state.filters.tags.length;
  const terrainNote = state.saturated && state.terrainGrid ? '・地形は表示範囲のみ' : '';
  status.hidden = !mapError && !filtering && state.posts.length > 0 && !terrainNote;
  $('mapRetry').hidden = !mapError;
  $('mapStatusText').textContent = mapError ? '地図を更新できませんでした。接続を確認してください。'
    : filtering ? `${state.posts.filter(matchesFilters).length}件が該当・検索対象は読み込み済みの範囲です${terrainNote}`
    : state.posts.length > 0 && terrainNote ? `${state.posts.length}件表示${terrainNote}`
    : worldCount === 0 && !state.myPosts.length ? 'まだ投稿がありません。最初の投稿で島をつくりましょう。'
    : 'この範囲には投稿がありません。右下の全体表示ボタンで全体を見られます';
}

// The map is redrawn every frame from state.filters: posts that do not match
// fade back, and the islands stay as they are, so there is nothing to fetch.
function filtersChanged() {
  paintMapStatus();
}

/** Q40: the tried-out sentence, standing on the map for this browser only. */
function paintTrial() {
  $('trialBanner').hidden = !state.trialPost;
  if (!state.trialPost) hideTrialHint();
}

export async function showTrial() {
  if (!await navigate('#/map')) return;
  paintTrial();
  // Stand back far enough to see the tryout and the islands around it: close in
  // on the tryout alone it was a pin in an empty sea, with nothing to do next.
  const trial = state.trialPost;
  if (trial) {
    const fit = state.camera.fit || state.camera.scale;
    const view = trialView({ trial, islands: state.islands, width: window.innerWidth, height: window.innerHeight, fit });
    zoomTo(view.x, view.y, view.scale, { lift: 0.5, then: showTrialHint });
  }
}

export async function openOnMap(postId) {
  if (!await navigate('#/map')) return;
  const fresh = justPosted(postId);
  if (fresh) {
    playNewPost(fresh);
    return;
  }
  await openPost(postId);
  if (state.selected?.id === postId) focusOn(state.selected, { lift: desktopSheet() ? 0.5 : 0.25 });
}

// A post you wrote a moment ago is introduced once, with the full show; any
// other way of reaching a post (a notification, your page) just opens it.
const introduced = new Set();
const JUST_POSTED_MS = 90000;
let landing = null;   // the post being introduced, kept on the map meanwhile

function justPosted(postId) {
  if (!state.account || introduced.has(postId)) return null;
  const post = state.myPosts.find((entry) => entry.id === postId) || state.postsById.get(postId);
  if (!post || post.author_id !== state.account.id) return null;
  const age = Date.now() - Date.parse(post.created_at);
  return Number.isFinite(age) && age > -60000 && age < JUST_POSTED_MS ? post : null;
}

function playNewPost(post) {
  introduced.add(post.id);
  if (sheetOpen()) closeSheet();
  setParticipantView(null);
  paintParticipantBar();
  landing = post;
  upsertPost(post);
  refreshIslands();
  refreshNeighbors();
  playReveal(post, {
    then: async () => {
      landing = null;
      await openPost(post.id);
      if (state.selected?.id === post.id) focusOn(state.selected, { lift: desktopSheet() ? 0.5 : 0.25 });
    },
  });
}

/** A screen that is wide and short (a phone on its side) cannot fit every
 * island name when the whole map is shown, so the first view comes in on your
 * own island - or the biggest one - instead. The globe still shows everything. */
function closeInFlat() {
  if (window.innerHeight >= 500 || window.innerWidth <= window.innerHeight) return;
  const cam = state.camera;
  if (landing || state.selected || !cam.fit || Math.abs(cam.scale - cam.fit) > 1e-6) return;
  const mine = state.myPosts.find((post) => post.id === state.activePostId) || state.myPosts[0];
  let spot = mine && Number.isFinite(mine.x) && Number.isFinite(mine.y) ? { x: mine.x, y: mine.y } : null;
  if (!spot) {
    const biggest = [...state.islands].sort((a, b) => (b.people || 0) - (a.people || 0))[0];
    if (biggest && Number.isFinite(biggest.cx) && Number.isFinite(biggest.cy)) spot = { x: biggest.cx, y: biggest.cy };
  }
  if (spot) zoomTo(spot.x, spot.y, cam.fit * 2.6, { lift: 0.5 });
}

// ---------------------------------------------------------------- data

export async function refreshMap({ fitFirst = false } = {}) {
  const generation = ++mapRequest;
  if (fitFirst) {
    try {
      const result = await api.get('/api/map/bounds', { auth: false });
      if (generation !== mapRequest) return false;
      worldCount = Number.isFinite(result.count) ? result.count : null;
      fitCamera([], result.bounds);
    } catch { fitCamera(); }
  }
  const bounds = viewport();
  const limit = config().limits.map_post_limit;
  try {
    const posts = await data.mapPosts({ ...bounds, limit });
    if (generation !== mapRequest) return false;
    mapError = false;
    const saturated = posts.length >= limit;
    setPosts(posts, { saturated, bounds });
    // A refresh that was asked for before the post existed must not take it
    // away while it is being introduced.
    if (landing && !state.postsById.has(landing.id)) upsertPost(landing);
    if (saturated) {
      // Only then: the coarse layer exists so distant land does not vanish when
      // the viewport holds more posts than we asked for. Fetching it always
      // would be a second query on every pan for nothing.
      try {
        // Never filtered: the islands are drawn as they are while searching.
        const params = new URLSearchParams({ min_x: bounds.minX, min_y: bounds.minY,
          max_x: bounds.maxX, max_y: bounds.maxY });
        const grid = await api.get(`/api/terrain?${params}`, { auth: false });
        if (generation !== mapRequest) return false;
        state.terrainGrid = grid;
      } catch {
        state.terrainGrid = null;
        mapError = true;
      }
    } else {
      state.terrainGrid = null;
    }
    state.cells = [];
    paintMapStatus();
    return true;
  } catch {
    mapError = true;
    paintMapStatus();
    return false;
  }
}

export async function refreshIslands() {
  try {
    const result = await api.get('/api/islands', { auth: false });
    state.islands = result.islands || [];
    setReachFactor(result.radius_factor);
    paintChrome();
  } catch {
    /* keep the previous names rather than blanking every label */
  }
}

// The dotted lines (map/kin.js) need, for each of my posts, the people whose
// posts are most like it. Asked again only after a while: it is a search over
// every post, and who is like you changes slowly.
const NEIGHBORS_FOR_KIN = 24;
const NEIGHBORS_STALE_MS = 5 * 60000;

export async function refreshNeighbors({ force = false } = {}) {
  if (!state.account) return;
  const owner = state.account.id;
  const now = Date.now();
  const keep = new Set(state.myPosts.map((post) => post.id));
  [...state.neighbors.keys()].forEach((id) => { if (!keep.has(id)) state.neighbors.delete(id); });
  await Promise.all(state.myPosts.map(async (post) => {
    const held = state.neighbors.get(post.id);
    if (!force && held && now - held.at < NEIGHBORS_STALE_MS) return;
    try {
      const result = await api.get(
        `/api/neighbors?post=${encodeURIComponent(post.id)}&limit=${NEIGHBORS_FOR_KIN}`, { auth: false });
      // Signed out (or somebody else signed in) while it was on its way.
      if (state.account?.id !== owner) return;
      state.neighbors.set(post.id, { at: now, rows: result.neighbors || [] });
    } catch {
      /* no dots for this post until next time */
    }
  }));
}

/** Lines between people (段3). Public, and cached by the server for a while.
 * `fresh` right after you reacted or wrote: the server recounts and nothing on
 * the way may answer from a cache, so your road appears now and not on the next
 * poll - it used to take 25-45 s, and longer in production. */
export async function refreshConnections({ fresh = false } = {}) {
  try {
    const result = await api.get(fresh ? '/api/connections?fresh=1' : '/api/connections',
      { auth: false, ...(fresh ? { cache: 'no-store' } : {}) });
    state.connections = result.connections || [];
    // A road that was not there a moment ago grows, and says so.
    // A sound only for a road that is mine; other people's roads grow silently.
    const meId = state.account ? state.account.id : null;
    // Not `fresh`: that name is the parameter above, and a const of the same
    // name in this block shadowed it, so reading it threw and no line was drawn.
    const grown = noteLinks(state.connections);
    const mineNow = meId ? state.connections.filter((row) => row.a === meId || row.b === meId).length : 0;
    if (grown > 0 && myLinks.owner === meId && mineNow > myLinks.count) playSe('success');
    myLinks = { owner: meId, count: mineNow };
  } catch {
    /* keep the lines already drawn */
  }
}

export async function refreshMyReactions() {
  if (!state.account) return;
  try {
    const rows = await data.myReactions();
    state.reactions = new Set(rows.map((row) => reactionKey(row.post_id, row.kind)));
    notify('reactions');
  } catch {
    /* a missed poll is not worth telling anyone about */
  }
}

/** How many people have seen each of my posts. Only ever my own (Q35). */
export async function refreshMyViews({ force = false } = {}) {
  if (!state.account) return;
  if (!force && Date.now() - viewsAt < VIEWS_MS) return;
  viewsAt = Date.now();
  try {
    const result = await api.get('/api/me/views');
    state.myViews = result.views || {};
    notify('views');
  } catch {
    viewsAt = 0;   // try again next time rather than waiting a minute
  }
}

/** One footprint, once per post per visit, never on my own post. */
function recordView(post) {
  if (viewed.has(post.id) || post.author_id === state.account?.id) return;
  viewed.add(post.id);
  api.post(`/api/posts/${post.id}/view`, { viewer: state.account ? null : viewerKey() })
    .catch(() => viewed.delete(post.id));
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
    // "Near me" depends on my posts, which arrive after the map first draws.
    if (booted) refreshExtras();
  } catch {
    /* leave whatever was there */
  }
}

// ---------------------------------------------------------------- chrome

function paintChrome() {
  paintMarks();
  if (booted) refreshExtras();
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
          playSe('hardClick');
          state.filters.tags = on
            ? state.filters.tags.filter((entry) => entry !== tag)
            : state.filters.tags.concat(tag);
          paintFilterPanel();
          paintFilterCount();
          filtersChanged();
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
    filtersChanged();
  });
  $('mapSearchClear').addEventListener('click', () => {
    search.value = '';
    state.filters.query = '';
    $('mapSearchClear').hidden = true;
    filtersChanged();
  });

  $('mapFilterBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    playSe('hardClick');
    const panel = $('mapFilterPanel');
    panel.hidden = !panel.hidden;
  });
  document.addEventListener('pointerdown', (event) => {
    if (!$('mapFilter').contains(event.target)) $('mapFilterPanel').hidden = true;
  });

  $('mapRetry').addEventListener('click', async () => {
    $('mapRetry').disabled = true;
    const ok = await refreshMap();
    $('mapRetry').disabled = false;
    if (ok) {
      refreshIslands();
      toast('地図を更新しました');
    } else {
      buzz('error');
      toast('まだつながりません。少し待ってからもう一度お試しください。');
    }
  });
  $('trialWrite').addEventListener('click', () => navigate('#/post'));
  $('trialClose').addEventListener('click', () => {
    state.trialPost = null;
    paintTrial();
    toast('お試しを消しました');
  });

  $('mapOverview').addEventListener('click', () => {
    playSe('click');
    showAll();
  });
  $('participantStop').addEventListener('click', stopParticipants);

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

/** Several posts on one spot at full zoom (map/index.js): a list to pick from.
 * Picking one opens it with a way back to this list. */
export function openStack(posts) {
  const body = openSheet({ onClose: () => { state.selected = null; } });
  clear($('sheetFoot'));
  clear(body).append(
    el('h3', { className: 'stack-title', text: `この場所の投稿（${posts.length}件）` }),
    el('ul', { className: 'stack-list' }, posts.map((post) => el('li', {},
      el('button', {
        className: 'stack-row',
        attrs: { type: 'button' },
        on: { click: () => openPost(post.id, { back: posts }) },
      },
      el('i', { className: 'stack-heat', style: { background: motivationColor(post.motivation) } }),
      el('span', { className: 'stack-who', text: clip(post.display_name || '', 8) }),
      el('span', { className: 'stack-text', text: post.body || '' }),
      el('span', { className: 'stack-go', text: '›', attrs: { 'aria-hidden': 'true' } }))))),
  );
}

/** Open a post's sheet. `expand` opens the sheet at full height; `back`, the
 * list of a spot's posts it was picked from (openStack). */
export async function openPost(postId, { expand = false, back = null } = {}) {
  if (sheetOpen()) closeSheet();
  const generation = ++selectionGeneration;
  let post = state.postsById.get(postId);
  const body = openSheet({ expanded: expand, onClose: () => {
    selectionGeneration += 1;
    sheetEvents?.abort();
    sheetEvents = null;
    if (activeChat) activeChat.destroy();
    activeChat = null;
    state.selected = null;
  } });
  sheetEvents = new AbortController();
  clear(body).append(el('p', { className: 'sheet-loading', text: '読み込み中…' }));
  clear($('sheetFoot'));

  if (!post) {
    try {
      post = await data.getPost(postId);
    } catch (error) {
      if (generation !== selectionGeneration) return;
      clear(body).append(el('p', { className: 'sheet-error', text: error.message }));
      return;
    }
  }
  if (generation !== selectionGeneration) return;
  if (!post) {
    clear(body).append(el('p', { className: 'sheet-error', text: '見つかりませんでした。' }));
    return;
  }
  state.selected = post;
  recordView(post);
  // Looking at a post puts its star out - except while looking at who joined,
  // when the sheet is only a way to read the writer's words.
  if (!participantView()) markRead(post.id);
  await renderSheet(post, generation, back);
}

async function renderSheet(post, generation, back = null) {
  const body = clear($('sheetBody'));
  if (back) {
    body.append(el('button', {
      className: 'sheet-back', attrs: { type: 'button' },
      text: `‹ この場所の投稿（${back.length}件）に戻る`,
      on: { click: () => openStack(back) },
    }));
  }
  const mine = state.account && post.author_id === state.account.id;

  if (generation !== selectionGeneration || !sheetOpen()) return;
  const island = state.islands.find((entry) => entry.post_ids?.includes(post.id));
  if (island) {
    body.append(el('div', { className: 'sheet-island' },
      el('i', { className: 'island-swatch', style: { background: islandColor(post.cluster_id) } }),
      el('span', { text: `${island.label} のあたり` }),
    ));
  }

  body.append(postCard(post, {
    onReact: (kind) => react(post.id, kind),
    onOpenAuthor: (authorId) => {
      restorePost = post.id;
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
    onSeeParticipants: isRecruiting(post) ? () => showParticipants(post) : null,
    onSeeReactors: mine ? (kind) => openReactors({
      post, kind,
      onOpenProfile: (id) => {
        restorePost = post.id;
        closeSheet();
        navigate(id === state.account?.id ? '#/me' : `#/u/${id}`);
      },
    }) : null,
  }));

  // The thread only exists once the sheet is expanded - islands' rule, and a
  // good one: at half height the card is the thing, and a message list peeking
  // under it just makes both harder to read.
  const thread = el('div', { className: 'sheet-thread' });
  body.append(thread);
  paintThread(post, thread);
  let layout = desktopSheet();
  document.addEventListener('sheet:expand', () => paintThread(post, thread), { signal: sheetEvents.signal });
  document.addEventListener('sheet:layout', () => {
    if (layout === desktopSheet()) return;
    layout = desktopSheet();
    paintThread(post, thread);
  }, { signal: sheetEvents.signal });
}

function paintThread(post, container) {
  clear(container);
  clear($('sheetFoot'));
  if (activeChat) {
    activeChat.destroy();
    activeChat = null;
  }
  if (!sheetExpanded() && !desktopSheet()) {
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
  let input = null;
  activeChat = postChat(post.id, {
    onCountChange: (count) => upsertPost({ id: post.id, comment_count: count }),
    onReply: (comment) => input?.replyTo(comment),
  });
  container.append(el('div', { className: 'section-label', text: 'メッセージ' }), activeChat.node);
  if (state.account) {
    const chat = activeChat;
    input = chatInput(post.id, { onSent: () => { chat.refresh(); refreshConnections({ fresh: true }); } });
    $('sheetFoot').append(input.node);
  } else {
    $('sheetFoot').append(el('button', {
      className: 'btn btn-block',
      text: 'ログインしてメッセージを送る',
      on: { click: () => { closeSheet(); navigate('#/auth'); } },
    }));
  }
}

export async function react(postId, kind) {
  if (!state.account) {
    toast('リアクションするにはログインしてください。');
    navigate('#/auth');
    return;
  }
  const on = hasReacted(postId, kind);
  const post = state.postsById.get(postId) || state.myPosts.find((p) => p.id === postId)
    || (state.selected?.id === postId ? state.selected : null) || await data.getPost(postId);
  if (!post) return;
  upsertPost(post);
  const column = `${kind}_count`;
  // Optimistic: the tap should feel done immediately, and a failure puts it
  // back rather than leaving the button lying about what happened.
  if (on) state.reactions.delete(reactionKey(postId, kind));
  else state.reactions.add(reactionKey(postId, kind));
  const celebrate = () => {
    buzz('react');
    if (Number.isFinite(Number(post.x))) ripple(Number(post.x), Number(post.y), { color: islandColor(post.cluster_id) });
  };
  // 参加 can be refused (closed / full), so it celebrates only once accepted.
  if (!on && kind !== 'join') celebrate();
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
    else {
      await data.addReaction(postId, kind);
      if (kind === 'join') celebrate();
    }
    // Only 参加 (and messages) draw a route since 2026-10-22: いいね and
    // 手伝えるかも have nothing new to fetch.
    if (kind === 'join') refreshConnections({ fresh: true });
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
  setupSheetAccessibility();
  const sheet = $('sheet');
  const scroll = $('sheetScroll');
  let startY = 0;
  let atTop = true;

  sheet.addEventListener('touchstart', (event) => {
    startY = event.touches[0].clientY;
    atTop = scroll.scrollTop <= 0;
  }, { passive: true });

  sheet.addEventListener('touchmove', (event) => {
    if (desktopSheet()) return;
    const delta = startY - event.touches[0].clientY;
    if (!sheetExpanded() && delta > 24) expandSheet(true);
    // Only collapse from the top of the thread. Otherwise scrolling back up
    // through a long conversation would slam the sheet shut halfway.
    else if (sheetExpanded() && delta < -24 && atTop && scroll.scrollTop <= 0) {
      expandSheet(false);
    }
  }, { passive: true });

  scroll.addEventListener('wheel', (event) => {
    if (desktopSheet()) return;
    if (!sheetOpen()) return;
    if (!sheetExpanded() && event.deltaY > 8) expandSheet(true);
    else if (sheetExpanded() && event.deltaY < -8 && scroll.scrollTop <= 0) expandSheet(false);
  }, { passive: true });

  $('sheetGrip').addEventListener('click', () => expandSheet(!sheetExpanded()));
  $('sheetClose').addEventListener('click', closeSheet);
}

// ---------------------------------------------------------------- participants

/** Who joined a post, as account ids.
 *
 * With a database the reactions are public, so this asks it directly. The local
 * stand-in has a route of its own that lists the people who pressed 参加.
 */
async function joinersOf(post) {
  const ids = new Set();
  if (isLocal()) {
    const result = await api.get(`/api/local/posts/${encodeURIComponent(post.id)}/joiners`, { auth: false });
    (result.joiners || []).forEach((id) => ids.add(id));
    return ids;
  }
  const { url, anon_key: key } = config().supabase;
  const query = new URLSearchParams({ select: 'actor_id', post_id: `eq.${post.id}`, kind: 'eq.join' });
  const rows = await api.get(`${url}/rest/v1/reactions?${query}`, { headers: { apikey: key } });
  rows.forEach((row) => ids.add(row.actor_id));
  return ids;
}

function paintParticipantBar() {
  $('participantStop').hidden = !participantView();
}

/** 「参加者を見てみる」: pull back, keep the writer and the people who joined
 * bright, and let everybody else fade. */
async function showParticipants(post) {
  let ids;
  try {
    ids = await joinersOf(post);
  } catch {
    toast('参加者を読み込めませんでした。少し待ってからもう一度お試しください。');
    return;
  }
  ids.delete(post.author_id);
  const count = ids.size;
  ids.add(post.author_id);
  closeSheet();
  setParticipantView({ postId: post.id, ids });
  paintParticipantBar();
  showAll();
  toast(count ? `参加した人 ${count}人を表示しています` : 'まだ参加した人はいません。投稿者だけを表示しています');
}

function stopParticipants() {
  const view = participantView();
  setParticipantView(null);
  paintParticipantBar();
  const post = view && state.postsById.get(view.postId);
  if (!post) return;
  const fit = state.camera.fit || state.camera.scale;
  zoomTo(post.x, post.y, fit * 2.6, { lift: 0.4, then: () => openPost(post.id) });
}

// ---------------------------------------------------------------- polling

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    // A backgrounded tab should not keep polling; it catches up on visibility.
    if (document.hidden || document.querySelector('.screen.active').id !== 'map') return;
    // Lines alongside the map, not after it: a slow map refresh held them up.
    await Promise.all([refreshMap(), refreshConnections()]);
    await Promise.all([refreshIslands(), refreshMyReactions()]);
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
  setupMeet();
  setupSheetGesture();
  paintFilterPanel();
  paintFilterCount();

  screen('map', {
    leave(next) {
      if (['me', 'user'].includes(next) && state.selected) restorePost = state.selected.id;
      hideTrialHint();
      setAmbient(false);
      stopMap();   // no painting while another screen is in front
      abortReveal();
      landing = null;
      if (participantView()) {
        setParticipantView(null);
        paintParticipantBar();
      }
    },
    async enter() {
      setAmbient(true);
      startMap();   // no-op the first time: initMap starts the loop itself
      if (!booted) {
        booted = true;
        initMap($('stage'), {
          onSelect: (post) => (post ? openPost(post.id) : closeSheet()),
          onSelectMany: (posts) => openStack(posts),
        });
        // A pan that ends somewhere new should pull in what is there. Debounced
        // inside the map module, so a long drag is one request and not fifty.
        onCameraSettled(() => refreshMap());
        setupMapExtras({ openPost });
        const ok = await refreshMap({ fitFirst: true });
        if (!ok) toast('地図を読み込めませんでした。再試行しています…');
        await Promise.all([
          refreshIslands(), refreshMyPosts(), refreshMyReactions(), refreshConnections(),
        ]);
        refreshNeighbors();
        startPolling();
        closeInFlat();
      } else {
        resize();
        await refreshMap();
        refreshIslands();
        refreshConnections();
        refreshNeighbors();
      }
      paintChrome();
      paintTrial();
      refreshMyViews();
      // Not awaited: the map is already up, and the pill can arrive a moment later.
      loadDigest();
      if (restorePost && activeScreen() === 'map') {
        const postId = restorePost;
        restorePost = null;
        await openPost(postId);
      }
    },
  });
}
