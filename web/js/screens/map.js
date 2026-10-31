// The map screen: the canvas, the chrome over it, and the post sheet.
//
// The sheet is islands' bottom panel, behaviour included: it opens at half
// height showing the card, and swiping up (or scrolling into it) expands it to
// full height where the message thread appears with the input pinned to the
// bottom. The half state is what lets you read a card without losing the map.

import { config, isLocal, islandColor, membersOnly, radiusOf, setReachFactor } from '../config.js';
import { api, data } from '../net.js';
import { navigate, screen, activeScreen } from '../router.js';
import { primeKeyboard } from '../keyboard.js';
import {
  hasReacted, matchesFilters, reactionKey, setPosts, state, subscribe, upsertPost, notify,
} from '../state.js';
import {
  $, avatar, clear, clip, closeSheet, confirmAction, el, expandSheet, motivationColor, openSheet, sheetExpanded,
  sheetOpen, toast, desktopSheet, setupSheetAccessibility,
} from '../ui.js';
import { postCard } from '../components/postcard.js';
import { openReactors } from '../components/reactors.js';
import { chatInput, postChat } from '../components/chat.js';
import { clearDigest, loadDigest, paintMarks, setupMeet } from './meet.js';
import { refreshExtras, hideTrialHint, setupMapExtras, showTrialHint } from './map-extras.js';
import { searchClosesOnTouch, trialView } from './map-extras-logic.js';
import {
  abortReveal, clearMatchBeams, fitCamera, focusMatchBeam, focusOn, initMap, onCameraSettled, participantView, playMatchBeams, playReveal,
  resize, ripple, setFreshPosts, setParticipantView, showAll, startMap, stopMap, viewport, zoomTo,
} from '../map/index.js';
import { noteLinks } from '../map/lines.js';
import { isRecruiting, markRead } from '../map/reads.js';
import { buzz, feedbackSettings, viewerKey } from '../feedback.js';
import { SWITCH_FX_MS } from '../feedback-rules.js';
import { currentTone, pageSeaFor } from '../screen-tone.js';
import { playSe, setAmbient } from '../audio.js';
import { browserStorage, refreshTalk } from '../talk.js';
import { clearInviteJoin, mapLinkFor, readInviteJoin, savePendingPost, validPostId } from '../return-post.js';
import { recruitState } from '../recruit-rules.js';
import { chooseCurrent, communitiesActive, communityOfPost, currentScope, refreshCommunities } from '../communities.js';
import {
  canPostFromMap, canSwitch, headerTitle, islandsInScope, linkIsClosed, mapNotice, postsExtent,
} from '../community-rules.js';
import { freshPostIds, loadSeen, markSeen } from '../fresh-rules.js';
import { nearestPosts } from '../nearby-rules.js';
import {
  MATCH_FETCH_MS, cardPost, matchView, slideIndex, usableMatches,
} from '../match-rules.js';
import { deleteOwnPost } from '../share.js';
import { askAfterFirstPost } from '../push-ask.js';

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

// Which `#/map?post=` link this history entry has opened already, kept in the
// entry's own state: coming back to it with the back button is not a new link,
// while a navigation to it (a new entry, state null) is.
const LINK_KEY = 'islandsOpenedPost';
const linkOpened = (postId) => Boolean(history.state && history.state[LINK_KEY] === postId);
function markLinkOpened(postId) {
  try { history.replaceState({ ...(history.state || {}), [LINK_KEY]: postId }, ''); } catch { /* not allowed: the link opens again */ }
}
function forgetLinkOpened() {
  if (!history.state || !(LINK_KEY in history.state)) return;
  const { [LINK_KEY]: _gone, ...rest } = history.state;
  try { history.replaceState(Object.keys(rest).length ? rest : null, ''); } catch { /* ignore */ }
}
let mapRequest = 0;
let mapError = false;
let worldCount = null;   // how many posts the whole world has (null: not asked yet)
let myLinks = { owner: null, count: 0 };   // how many roads are mine, for the success sound

// ---------------------------------------------------------------- community scope
//
// With features.communities on, the map is one community's: the posts come from
// community_map_posts, a visitor who followed a link sees the community of that
// post, and a person who is in none sees a notice instead of a map. With it off,
// scope.mode is 'legacy' and every line below this heading does nothing.

let scope = { mode: 'legacy' };
let loadedKey = null;       // the scope the posts on screen were read for
let rawIslands = [];        // /api/islands as the server sent it, before the community filter

const scopeKey = () => (scope.mode === 'community' || scope.mode === 'viewing' ? `${scope.mode}:${scope.id}` : scope.mode);
const scoped = () => scope.mode === 'community' || scope.mode === 'viewing';

/** Decide what the map shows. `linked`: the community of the post a link opened. `closed` (members only):
 * the link led to something this person cannot read. */
function applyScope(linked = null, closed = false) {
  scope = currentScope(linked, closed);
  // A community of mine that a link led to becomes the current one.
  if (scope.mode === 'community' && scope.id !== state.communityId) chooseCurrent(scope.id);
  if (scope.mode === 'viewing') state.viewCommunity = { id: scope.id, name: scope.name };
  paintMarks();   // the away digest follows the community shown
  paintCommunity();
}

function paintCommunity() {
  // A rename (the edit screen) changes the name in my list; the scope follows it.
  if (scope.mode === 'community') {
    const mine = state.communities.find((entry) => entry.id === scope.id);
    if (mine && mine.name !== scope.name) scope = { ...scope, name: mine.name };
  }
  // The left of the header: the community button, or just 「islands」 when there is no community to open.
  const button = $('mapCommunity');
  const head = headerTitle(scope, state.communities.length);
  const caret = head.text.endsWith(' ▾');
  clear(button).append(el('span', { className: 'header-community-name', text: caret ? head.text.slice(0, -2) : head.text }));
  if (caret) button.append(el('span', { className: 'header-community-caret', text: '▾', attrs: { 'aria-hidden': 'true' } }));
  $('map').classList.toggle('no-community', scope.mode === 'none');
  button.disabled = !head.tappable;
  button.classList.toggle('is-brand', head.brand);
  button.setAttribute('aria-haspopup', head.tappable ? 'dialog' : 'false');
  button.setAttribute('aria-label', head.tappable ? `${scope.name}。コミュニティの一覧を開く` : head.text);
  // Writing: from the round button, for the community shown here (compose says 「{name} に投稿」).
  $('mapPost').hidden = !canPostFromMap({ signedIn: Boolean(state.account), scope });
  const notice = mapNotice(scope, {
    signedIn: Boolean(state.account), known: state.communitiesLoaded, inviteOnly: config().invite_only === true,
    membersOnly: membersOnly(),
  });
  $('mapNotice').hidden = !notice;
  if (notice) {
    $('mapNoticeRetry').hidden = !notice.retry;
    $('mapNoticeTitle').textContent = notice.title;
    $('mapNoticeSub').textContent = notice.sub;
    $('mapNoticeLogin').hidden = !notice.login;
    $('mapNoticeHome').hidden = !notice.home;
  }
}

/** The posts of the current map for a box of the world. */
async function readPosts(bounds, limit) {
  if (scoped()) return data.communityMapPosts(scope.id, { ...bounds, limit });
  return data.mapPosts({ ...bounds, limit });
}

/** /api/islands names islands from every community; keep the ones on this map. */
function applyIslands() {
  if (scope.mode === 'none') state.islands = [];
  else if (scoped()) state.islands = islandsInScope(rawIslands, new Set(state.posts.map((post) => post.id)), state.saturated);
  else state.islands = rawIslands;
  // The lines (map/lines.js, kin.js) decide road / sea route / arch from the islands of the whole map, not
  // the ones in view, so the same two posts are joined the same way at every zoom.
  if (scope.mode === 'none') state.worldIslands = null;
  else if (scoped() && state.worldPosts) {
    state.worldIslands = islandsInScope(rawIslands, new Set(state.worldPosts.map((post) => post.id)), state.worldSaturated);
  } else state.worldIslands = state.islands;
}

/** The sheet that lists my communities (the current one marked). An admin's row also has 「編集」, which
 * opens that community's edit screen. Opens with one community too: it shows that row and its 編集. */
function openCommunitySheet() {
  if (!canSwitch(scope, state.communities.length)) return;
  const body = openSheet({ onClose: () => { state.selected = null; } });
  clear($('sheetFoot'));
  clear(body).append(
    el('h3', { className: 'stack-title', text: 'コミュニティ' }),
    el('ul', { className: 'stack-list community-list', attrs: { id: 'communityList' } },
      state.communities.map((entry) => el('li', { className: 'community-item' },
        el('button', {
          className: `stack-row community-row${entry.id === scope.id ? ' on' : ''}`,
          attrs: { type: 'button', 'aria-current': String(entry.id === scope.id), 'data-community-id': entry.id },
          on: { click: () => switchCommunity(entry.id) },
        },
        el('span', { className: 'stack-who', text: entry.name }),
        el('span', { className: 'stack-text', text: entry.role === 'admin' ? '管理者' : '' }),
        el('span', { className: 'stack-go', text: entry.id === scope.id ? '✓' : '›', attrs: { 'aria-hidden': 'true' } })),
        entry.role === 'admin' ? el('button', {
          className: 'btn btn-small btn-quiet community-edit',
          attrs: { type: 'button', 'aria-label': `${entry.name} を編集`, 'data-community-id': entry.id },
          text: '編集',
          on: { click: () => editCommunity(entry.id) },
        }) : null))),
    el('p', { className: 'community-hint', text: '新しいコミュニティには、招待リンクを開くと入れます。' }),
  );
}

function editCommunity(id) {
  closeSheet();
  navigate(`#/community/${encodeURIComponent(id)}`);
}

/** The answer to switching community: a sound, a buzz (phones that have one), the sea washing over the
 * map, and the new name settling into the header. Reduced motion keeps only the sound and the buzz. */
function switchFeel() {
  playSe('switch');
  buzz('switch');
  if (feedbackSettings().reduceMotion) return;
  const button = $('mapCommunity');
  button.classList.add('switched');
  setTimeout(() => button.classList.remove('switched'), SWITCH_FX_MS + 100);
  const wash = el('div', { className: 'switch-wash', attrs: { 'aria-hidden': 'true' } });
  wash.style.setProperty('--wash-sea', pageSeaFor(currentTone()));
  wash.style.setProperty('--wash-ms', `${SWITCH_FX_MS}ms`);
  wash.addEventListener('animationend', () => wash.remove());
  setTimeout(() => wash.remove(), SWITCH_FX_MS + 300);   // in case the animation never runs
  $('map').append(wash);
}

async function switchCommunity(id) {
  closeSheet();
  if (id === scope.id) return;
  if (!chooseCurrent(id)) return;
  switchFeel();
  applyScope(null);
  await loadScope();
  refreshNeighbors();
  toast(`${scope.name} の地図にしました`);
}

/** Replace what is on screen with the current scope's map (a switch, a sign-in). */
async function loadScope() {
  setPosts([], { saturated: false, bounds: null });
  state.selected = null;
  rawIslands = [];
  state.islands = [];
  state.worldIslands = null;
  state.worldPosts = null;
  state.connections = [];
  state.terrainGrid = null;
  closeSheet();
  await refreshMap({ fitFirst: true });
  if (scope.mode !== 'none') await Promise.all([refreshIslands(), refreshConnections()]);
  paintChrome();
}

function paintMapStatus() {
  const status = $('mapStatus');
  const filtering = state.filters.query || state.filters.tags.length;
  const terrainNote = state.saturated && state.terrainGrid ? '・地形は表示範囲のみ' : '';
  status.hidden = scope.mode === 'none' || (!mapError && !filtering && state.posts.length > 0 && !terrainNote);
  $('mapRetry').hidden = !mapError;
  $('mapStatusText').textContent = mapError ? '地図を更新できませんでした。接続を確認してください。'
    : filtering ? `${state.posts.filter(matchesFilters).length}件が該当・検索対象は読み込み済みの範囲です${terrainNote}`
    : state.posts.length > 0 && terrainNote ? `${state.posts.length}件表示${terrainNote}`
    : worldCount === 0 && !state.myPosts.length ? (canPostFromMap({ signedIn: Boolean(state.account), scope })
      ? 'まだ投稿がありません。右下の「＋」から、最初の投稿で島をつくりましょう。'
      : 'まだ投稿がありません。')
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

/** `thenOpen`: a post to open once the landing show of a brand-new post is over
 * (a new person who came through a link: first their own island, then the 会 they
 * were invited to). */
export async function openOnMap(postId, { thenOpen = null, afterLand = null } = {}) {
  const fresh = justPosted(postId);
  // Any other post (a notification, somebody's page): go through the link, which also turns the map to the
  // post's own community and, if the viewer cannot read it, says so calmly.
  if (!fresh && communitiesActive() && validPostId(thenOpen || postId)) {
    const link = mapLinkFor(thenOpen || postId);
    // The same address again (no new history entry): asked for, so it opens again.
    if (window.location.hash === link) forgetLinkOpened();
    await navigate(link);
    return;
  }
  if (!await navigate('#/map')) return;
  if (fresh) {
    playNewPost(fresh, thenOpen, afterLand);
    return;
  }
  await openLinkedPost(thenOpen || postId);
}

// ---------------------------------------------------------------- nearby posts (after the first post)

const NEARBY_WAIT_MS = 900;   // let the new island settle before the card comes up

/** The posts of the map that is open, the whole of it (the viewport holds only the part in view). */
async function nearbyCandidates() {
  if (scope.mode === 'none') return [];
  const world = config().world;
  const span = (world.max - world.min) * 2;
  try {
    return await readPosts({ minX: world.min - span, minY: world.min - span,
      maxX: world.max + span, maxY: world.max + span }, config().limits.map_post_limit);
  } catch {
    return state.posts;   // the ones already on screen are better than none
  }
}

/** 「あなたの近くの投稿」: right after a first post, up to three people who stand nearest to it. `thenOpen`
 * (the post an invite link led to) opens once the card is closed. */
export async function showNearbyPosts(post, { thenOpen = null, pending = null } = {}) {
  const began = Date.now();
  // The cards of posts that may connect come first; when there are none (or anything goes wrong) the
  // nearby posts come as they always did.
  if (await showMatchCards(post, { thenOpen, first: true, pending })) return;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, NEARBY_WAIT_MS - (Date.now() - began))));
  const near = nearestPosts(await nearbyCandidates(), post, { meId: state.account?.id, gone: state.removed });
  if (activeScreen() !== 'map') return;
  let picked = false;
  const body = openSheet({
    fit: true,
    onClose: () => {
      state.selected = null;
      // Another card taken up in the meantime (a tap on the map) means the person has moved on.
      if (!picked && thenOpen) setTimeout(() => { if (!sheetOpen()) openLinkedPost(thenOpen); }, 0);
    },
  });
  askAfterFirstPost();
  clear($('sheetFoot'));
  const rows = near.map((entry) => el('li', {},
    el('button', {
      className: 'stack-row nearby-row', attrs: { type: 'button', 'data-post-id': entry.id, 'data-author-id': entry.author_id },
      on: { click: () => { picked = true; closeSheet(); openLinkedPost(entry.id); } },
    },
    avatar(entry, 32),
    el('span', { className: 'nearby-who', text: entry.display_name || '' }),
    el('span', { className: 'stack-text nearby-text', text: clip(entry.body, 40) }),
    el('span', { className: 'stack-go', text: '›', attrs: { 'aria-hidden': 'true' } }))));
  clear(body).append(
    el('h3', { className: 'stack-title', text: 'あなたの近くの投稿' }),
    el('p', { className: 'nearby-lede', text: '近くにいる人ほど、似た話をしています' }),
    rows.length
      ? el('ul', { className: 'stack-list nearby-list', attrs: { id: 'nearbyList' } }, rows)
      : el('p', { className: 'nearby-empty', attrs: { id: 'nearbyEmpty' }, text: 'まだ近くに投稿がありません。仲間が投稿すると、ここに並びます。' }),
    el('button', {
      className: 'btn btn-block nearby-close', attrs: { type: 'button', id: 'nearbyClose' }, text: '地図を見る',
      on: { click: () => closeSheet() },
    }),
  );
}

// ---------------------------------------------------------------- match cards (after a post)

// One switch for the whole thing: false and every post lands as it did before (the server has its own,
// ISLANDS_MATCH_CARDS).
const MATCH_CARDS_ON = true;

/** Ask the server which posts may connect to a new one. Start it the moment the post exists: it is done by
 * the time the landing show is over. Resolves to the rows; never rejects (a failure is an empty list). null
 * when the cards are off. */
export function startMatchFetch(postId) {
  if (!MATCH_CARDS_ON || !postId || !state.account) return null;
  const startedAt = Date.now();
  // null: no answer (failed, switched off, another post); [] is the server's own "nobody yet".
  const promise = api.get(`/api/matches?post=${encodeURIComponent(postId)}`)
    .then((result) => (result?.post === postId && !result.unknown ? usableMatches(result.matches) : null))
    .catch(() => null);
  promise.startedAt = startedAt;
  return promise;
}

/** The rows of a startMatchFetch, or null when they take longer than MATCH_FETCH_MS since it started. */
async function waitForMatches(pending) {
  const left = Math.max(300, MATCH_FETCH_MS - (Date.now() - (pending.startedAt || Date.now())));
  let timer = 0;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), left); });
  try {
    return await Promise.race([pending, late]);
  } finally {
    clearTimeout(timer);
  }
}

export const NO_MATCH_TEXT = 'まだ、つながりそうな投稿はありません。\n似た話が投稿されたら、通知でお知らせします';

/** The line for "nobody yet". It comes once the own post card is up (the caller opens it), and on a phone
 * just above that card rather than over its buttons; the side panel of a wide screen leaves room below. */
function noMatchNote() {
  setTimeout(() => {
    const top = sheetOpen() && !desktopSheet() ? $('sheet').getBoundingClientRect().top : 0;
    toast(NO_MATCH_TEXT, 6000, { bottom: top > 0 ? Math.round(innerHeight - top + 12) : null });
  }, 600);
}

/** 「あなたの話とつながりそうな人」: after a post, the posts that may connect to it as cards to swipe, with
 * dotted lines from the new post on the map. true when the cards came up; false (nothing changed) when there
 * is nobody, it took too long, or anything failed - the caller then does what it always did. Nobody (the
 * server's own empty answer) on a later post also says so in one line (noMatchNote).
 * `first`: the first post, which asks about notifications once the card is closed (push-ask.js).
 * `thenOpen`: a post to open once the cards are closed. `pending`: startMatchFetch's promise. */
export async function showMatchCards(post, { thenOpen = null, first = false, pending = null } = {}) {
  if (!MATCH_CARDS_ON || !pending) return false;
  let picked = false;
  try {
    const rows = await waitForMatches(pending);
    if (!rows || activeScreen() !== 'map') return false;
    // Nobody yet (the server said so): one line, so the post does not seem to have done nothing.
    // The first post shows the nearest posts instead.
    if (!rows.length) {
      if (!first) noMatchNote();
      return false;
    }
    if (!Number.isFinite(Number(post.x)) || !Number.isFinite(Number(post.y))) return false;
    const from = { x: Number(post.x), y: Number(post.y) };
    const leave = () => { picked = true; closeSheet(); };
    const track = el('div', { className: 'match-track', attrs: { id: 'matchTrack' } });
    const slides = rows.map((row, index) => {
      const shown = cardPost(row, state.postsById.get(row.id));
      const card = postCard(shown, {
        onReact: (kind) => react(row.id, kind),
        onOpenAuthor: (authorId) => {
          restorePost = row.id;
          leave();
          navigate(`#/u/${authorId}`);
        },
        onComments: () => { leave(); openLinkedPost(row.id); },
        onReport: () => report(shown),
      });
      return el('section', {
        className: 'match-slide',
        attrs: { 'data-post-id': row.id, 'aria-label': `${index + 1} / ${rows.length}` },
      }, el('p', { className: 'match-why', text: row.reason || 'この人の話と、つながりそうです' }), card);
    });
    track.append(...slides);
    const count = el('span', { className: 'match-count num', attrs: { id: 'matchCount', 'aria-live': 'polite' }, text: `1 / ${rows.length}` });
    const dots = el('div', { className: 'match-dots', attrs: { 'aria-hidden': 'true' } },
      rows.map((row, index) => el('i', { className: index ? '' : 'on' })));

    const sheet = $('sheet');
    const body = openSheet({
      fit: true,
      onClose: () => {
        sheet.classList.remove('match-mode');
        focusMatchBeam(-1);   // the lines stay, thin and pale
        state.selected = null;
        if (!picked && thenOpen) setTimeout(() => { if (!sheetOpen()) openLinkedPost(thenOpen); }, 0);
      },
    });
    sheet.classList.add('match-mode');
    if (first) askAfterFirstPost();
    clear($('sheetFoot'));
    clear(body).append(
      el('div', { className: 'match-head' }, el('h3', { className: 'stack-title', text: 'あなたの話とつながりそうな人' }), count),
      dots,
      track,
      el('button', {
        className: 'btn btn-block nearby-close', attrs: { type: 'button', id: 'matchClose' }, text: '地図を見る',
        on: { click: () => closeSheet() },
      }),
    );

    // Swiping only turns the page: the number, the dots and the bold line follow the card in view.
    let current = 0;
    let waiting = 0;
    const settle = () => {
      waiting = 0;
      const stride = slides.length > 1 ? slides[1].offsetLeft - slides[0].offsetLeft : track.clientWidth;
      const index = slideIndex(track.scrollLeft, stride, slides.length);
      if (index === current) return;
      current = index;
      count.textContent = `${index + 1} / ${slides.length}`;
      [...dots.children].forEach((dot, at) => dot.classList.toggle('on', at === index));
      focusMatchBeam(index);
    };
    track.addEventListener('scroll', () => { if (!waiting) waiting = setTimeout(settle, 100); }, { passive: true });

    // The camera takes in the new post and everyone the cards show, above the sheet; then the lines grow.
    const fit = state.camera.fit || state.camera.scale;
    const view = matchView({
      from, targets: rows.map((row) => ({ x: Number(row.x), y: Number(row.y) })),
      width: window.innerWidth, height: window.innerHeight, fit, desktop: desktopSheet(), covered: sheet.offsetHeight,
    });
    zoomTo(view.x, view.y, view.scale, { x: view.anchorX, y: view.anchorY });
    playMatchBeams(from, rows.map((row) => ({ x: Number(row.x), y: Number(row.y), key: `${post.id}|${row.id}` })),
      { delay: 450 });
    return true;
  } catch {
    clearMatchBeams();
    if ($('sheet').classList.contains('match-mode')) {
      picked = true;   // the caller shows its own card now: nothing of `thenOpen` here
      $('sheet').classList.remove('match-mode');
      closeSheet();
    }
    return false;
  }
}

/** Open a post wherever it is on the map and bring the camera to it. */
/** The 参加者募集中 post of the invite QR this person came in by: joined once the
 * account exists (2026-10-31, the user). A post that no longer recruits, is closed
 * or full, or that they are in already is let go quietly - signing up is not
 * stopped by it. A failure that may pass (the network) keeps it for next time. */
let joining = null;
export function joinFromInvite() {
  if (joining) return joining;
  joining = (async () => {
    const storage = browserStorage();
    const postId = readInviteJoin(storage);
    if (!postId || !state.account) return;
    let post = state.postsById.get(postId) || null;
    if (!post) post = await data.getPost(postId).catch(() => undefined);
    if (post === undefined) return;   // could not ask: try again later
    clearInviteJoin(storage);
    if (!post || !isRecruiting(post) || post.author_id === state.account.id) return;
    if (hasReacted(postId, 'join')) return;
    if (recruitState(post)) {
      toast(recruitState(post) === 'full' ? '会は満員のため、参加できませんでした。' : '会の受付が終わっていたため、参加できませんでした。');
      return;
    }
    await react(postId, 'join');
    if (hasReacted(postId, 'join')) toast(`「${clipText(post.body)}」に参加しました`);
  })().finally(() => { joining = null; });
  return joining;
}

const clipText = (text, max = 18) => {
  const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
};

export async function openLinkedPost(postId) {
  if (state.account) await joinFromInvite().catch(() => {});
  await openPost(postId);
  if (state.selected?.id === postId) focusOn(state.selected, { lift: desktopSheet() ? 0.5 : 0.25 });
}

/** 「誰かが、あなたと…と言っています」 leads here: the 会 with its participants
 * shown, so the person you might talk to (their card, then their profile) is one tap away. */
export async function openParticipantsOf(postId) {
  if (!await navigate('#/map')) return;
  let post = state.postsById.get(postId) || null;
  if (!post && postId) post = await data.getPost(postId).catch(() => null);
  if (post && isRecruiting(post)) await showParticipants(post);
  else if (post) await openLinkedPost(post.id);
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

function playNewPost(post, thenOpen = null, afterLand = null) {
  introduced.add(post.id);
  clearMatchBeams();
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
      // afterLand takes the place of opening the card (the first post: the nearby posts come instead,
      // and it opens `thenOpen` itself once it is closed).
      if (afterLand) await afterLand();
      else await openLinkedPost(thenOpen || post.id);
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
  if (scope.mode === 'none') {
    // Nothing to read: a notice stands where the map would be.
    if (state.posts.length) setPosts([], { saturated: false, bounds: null });
    loadedKey = scopeKey();
    mapError = false;
    paintMapStatus();
    return true;
  }
  if (fitFirst) {
    loadedKey = scopeKey();
    try {
      if (scoped()) {
        // /api/map/bounds frames every community. Frame this one's own posts.
        const world = config().world;
        const span = (world.max - world.min) * 2;
        const all = await readPosts({ minX: world.min - span, minY: world.min - span,
          maxX: world.max + span, maxY: world.max + span }, config().limits.map_post_limit);
        if (generation !== mapRequest) return false;
        worldCount = all.length;
        state.worldPosts = all;
        state.worldSaturated = all.length >= config().limits.map_post_limit;
        fitCamera([], postsExtent(all, radiusOf), { reset: true });
      } else {
        const result = await api.get('/api/map/bounds');
        if (generation !== mapRequest) return false;
        worldCount = Number.isFinite(result.count) ? result.count : null;
        fitCamera([], result.bounds);
      }
    } catch { fitCamera(); }
  }
  const bounds = viewport();
  const limit = config().limits.map_post_limit;
  try {
    const posts = await readPosts(bounds, limit);
    if (generation !== mapRequest) return false;
    mapError = false;
    const saturated = posts.length >= limit;
    setPosts(posts, { saturated, bounds });
    if (scoped()) applyIslands();
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
        // The ground is made from one community's posts (members only: required, and for its members).
        // While the switch is off the server ignores it, and the address stays the one it always was.
        if (scoped() && membersOnly()) params.set('community', scope.id);
        const grid = await api.get(`/api/terrain?${params}`);
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
    // Islands are made from, and shown to, one community's members: say which one.
    const asked = scopeKey();
    // (While the switch is off the address stays the one it always was: the server ignores the community there.)
    const result = await api.get(scoped() && membersOnly()
      ? `/api/islands?${new URLSearchParams({ community: scope.id })}` : '/api/islands');
    // The map was switched while this was on its way: these islands belong to the other one.
    if (asked !== scopeKey()) return;
    rawIslands = result.islands || [];
    applyIslands();
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
  // The dotted lines run between posts on this map: on a community's map, my posts of that
  // community only (the server keeps their neighbours inside it).
  // Members only and no community map shown (signed out of all, or left): my posts there are not ours to
  // search around, and the server answers such a question with 404.
  const here = scoped() ? state.myPosts.filter((post) => post.community_id === scope.id)
    : (membersOnly() ? [] : state.myPosts);
  const keep = new Set(here.map((post) => post.id));
  [...state.neighbors.keys()].forEach((id) => { if (!keep.has(id)) state.neighbors.delete(id); });
  await Promise.all(here.map(async (post) => {
    const held = state.neighbors.get(post.id);
    if (!force && held && now - held.at < NEIGHBORS_STALE_MS) return;
    try {
      const result = await api.get(
        `/api/neighbors?post=${encodeURIComponent(post.id)}&limit=${NEIGHBORS_FOR_KIN}`);
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
    // On a community's map only that community's lines (the server scopes them).
    const query = new URLSearchParams();
    if (fresh) query.set('fresh', '1');
    if (scoped()) query.set('community', scope.id);
    const asked = scopeKey();
    const queryText = query.toString();
    const result = await api.get(`/api/connections${queryText ? `?${queryText}` : ''}`,
      fresh ? { cache: 'no-store' } : {});
    // The map was switched while this was on its way: these lines belong to the other one.
    if (asked !== scopeKey()) return;
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
  // Members only: no footprint from somebody who is not signed in (they cannot read the post at all).
  if (membersOnly() && !state.account) return;
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

// ---------------------------------------------------------------- new islands

// An island glows while it holds a post of the last seven days that I have not opened (my own never
// count). The rules are in fresh-rules.js; the map module only draws the glow for the ids it is given.
function paintFresh() {
  const meId = state.account ? state.account.id : null;
  const seen = meId ? loadSeen(browserStorage(), meId) : new Map();
  setFreshPosts(freshPostIds(state.posts, { meId, seen }));
}

/** Opening a post's card puts its glow out. */
function markPostSeen(post) {
  if (!state.account || !post || post.author_id === state.account.id) return;
  markSeen(browserStorage(), state.account.id, post.id);
  paintFresh();
}

/** Signing out (or the session ending): nothing of what the last person could read stays in memory or in
 * the card that is closed but still in the page. */
export function forgetMapData() {
  mapRequest += 1;
  try { closeSheet(); } catch { /* nothing open */ }
  clear($('sheetBody'));
  clear($('sheetFoot'));
  setPosts([], { saturated: false, bounds: null });
  rawIslands = [];
  state.islands = [];
  state.connections = [];
  state.terrainGrid = null;
  state.changeMarks = [];
  loadedKey = null;
  clearDigest();
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

/** The search box opens inside the header (the community button and the search icon step aside) and
 * closes again with its ✕, which also clears what was typed. */
function setSearchOpen(open) {
  $('mapHeader').classList.toggle('searching', open);
  $('mapSearchBox').hidden = !open;
  $('mapSearchOpen').setAttribute('aria-expanded', String(open));
  if (open) $('mapSearch').focus();
}

function closeSearch() {
  const search = $('mapSearch');
  const typed = Boolean(search.value || state.filters.query);
  search.value = '';
  state.filters.query = '';
  setSearchOpen(false);
  if (typed) filtersChanged();
  $('mapSearchOpen').focus({ preventScroll: true });
}

function setupChrome() {
  const search = $('mapSearch');
  search.addEventListener('input', () => {
    state.filters.query = search.value.trim();
    filtersChanged();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSearch();
  });
  $('mapSearchOpen').addEventListener('click', () => {
    playSe('hardClick');
    $('mapFilterPanel').hidden = true;
    setSearchOpen(true);
  });
  $('mapSearchClear').addEventListener('click', closeSearch);
  // An empty search box gives the bar back to the community name as soon as the map (or anything
  // outside the header) is touched. Capture phase: the map may stop the event before the page sees it.
  const closeEmptySearch = (event) => {
    const open = !$('mapSearchBox').hidden;
    if (!open) return;
    const inside = $('mapHeader').contains(event.target);
    if (!searchClosesOnTouch({ open, value: $('mapSearch').value, query: state.filters.query, inside })) return;
    $('mapSearch').value = '';
    setSearchOpen(false);
    $('mapSearch').blur();
  };
  document.addEventListener('pointerdown', closeEmptySearch, true);
  document.addEventListener('wheel', closeEmptySearch, { capture: true, passive: true });
  $('mapPost').addEventListener('click', () => {
    playSe('click');
    primeKeyboard();
    navigate('#/post');
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
  $('trialWrite').addEventListener('click', () => { primeKeyboard(); navigate('#/post'); });
  $('mapCommunity').addEventListener('click', () => {
    playSe('hardClick');
    openCommunitySheet();
  });
  $('mapNoticeLogin').addEventListener('click', () => navigate('#/auth?intent=login'));
  $('mapNoticeHome').addEventListener('click', () => navigate('#/map'));
  $('mapNoticeRetry').addEventListener('click', async () => {
    const button = $('mapNoticeRetry');
    button.disabled = true;
    try {
      await refreshCommunities();
      applyScope(null);
      if (scopeKey() !== loadedKey) await loadScope();
    } finally {
      button.disabled = false;
    }
  });
  // Another tab or a claim changed which communities I am in.
  subscribe((reason) => {
    if (reason === 'community') paintCommunity();
    else if (reason === 'posts') paintFresh();
  });
  // Signing out: nothing glows for a visitor.
  window.addEventListener('islands:signout', paintFresh);
  window.addEventListener('islands:signout', forgetMapData);
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
  clearMatchBeams();
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
  markPostSeen(post);
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
    onOpenProfile: (id) => {
      restorePost = post.id;
      closeSheet();
      navigate(id === state.account?.id ? '#/me' : `#/u/${id}`);
    },
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
    const patch = { id: postId, [column]: Math.max(0, (post[column] || 0) + (on ? -1 : 1)) };
    // A post on several communities: the joins of all copies move too (the server's count follows below).
    if (kind === 'join' && post.group_join_count != null) {
      patch.group_join_count = Math.max(0, Number(post.group_join_count) + (on ? -1 : 1));
    }
    upsertPost(patch);
  }
  try {
    if (on) await data.removeReaction(postId, kind);
    else {
      await data.addReaction(postId, kind);
      if (kind === 'join') celebrate();
    }
    // Only 参加 (and messages) draw a route since 2026-10-22: いいね and
    // 手伝えるかも have nothing new to fetch.
    if (kind === 'join') {
      // The guess above cannot know whether I was in already through another copy: read the count back.
      if (post.group_join_count != null) data.getPost(postId).then(upsertPost).catch(() => {});
      refreshConnections({ fresh: true });
      // Joining or leaving a 会 changes who I may press 「話してみたい」 for (on their profile).
      refreshTalk();
    }
  } catch (error) {
    if (on) state.reactions.add(reactionKey(postId, kind));
    else state.reactions.delete(reactionKey(postId, kind));
    if (post) {
      const back = { id: postId, [column]: post[column] || 0 };
      if (kind === 'join' && post.group_join_count != null) back.group_join_count = post.group_join_count;
      upsertPost(back);
      // The guess for a post on several communities may be off either way: read the true count back.
      if (kind === 'join' && post.group_join_count != null) data.getPost(postId).then(upsertPost).catch(() => {});
    }
    toast(error.message);
  }
}

async function removeOwnPost(post) {
  try {
    // A post on several communities' maps asks: this community only, or all of them (share.js).
    if (!(await deleteOwnPost(post)).length) return;
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
    // The cards to swipe sideways (showMatchCards) stay as they are: no growing to full height.
    if (sheet.classList.contains('match-mode')) return;
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
    if (sheet.classList.contains('match-mode')) return;
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
    const result = await api.get(`/api/local/posts/${encodeURIComponent(post.id)}/joiners`);
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
    if (scope.mode === 'none') return;
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

/** Work out the scope on every entry; a linked post's community comes first. */
async function decideScope(query) {
  // My communities could not be read earlier (a weak connection): ask again before deciding,
  // so a member is not told they are in none.
  if (communitiesActive() && state.account && !state.communitiesLoaded) await refreshCommunities();
  let linked = null;
  let closed = false;
  const linkedId = query ? query.get('post') : null;
  if (currentScope().mode !== 'legacy' && validPostId(linkedId)) {
    if (membersOnly() && !state.account) {
      // Signed out: there is nothing to look up (it would be refused). The link waits for the sign-in.
      closed = true;
    } else {
      let status = null;
      let post = null;
      try {
        post = await data.getPost(linkedId);
      } catch (error) {
        // A bad connection is not "closed": the post itself will say it cannot be read.
        status = Number.isFinite(error?.status) ? error.status : 0;
      }
      linked = await communityOfPost(post);
      if (membersOnly()) {
        const listKnown = state.communitiesLoaded;
        closed = linkIsClosed({
          signedIn: true, found: Boolean(linked), status, listKnown,
          mine: Boolean(post && state.account && post.author_id === state.account.id),
        });
        // I cannot tell whether I am a member (my list did not load): do not judge the link either way.
        if (!listKnown) linked = null;
      }
    }
  }
  applyScope(linked, closed);
}

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
      clearMatchBeams();
      landing = null;
      if (participantView()) {
        setParticipantView(null);
        paintParticipantBar();
      }
    },
    async enter(_params, query) {
      setAmbient(true);
      startMap();   // no-op the first time: initMap starts the loop itself
      // Which community's map is this? A link to a post says so by the post itself.
      await decideScope(query);
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
          scope.mode === 'none' ? null : refreshIslands(), refreshMyPosts(), refreshMyReactions(),
          scope.mode === 'none' ? null : refreshConnections(),
        ]);
        refreshNeighbors();
        startPolling();
        closeInFlat();
      } else {
        resize();
        // The community changed since the posts on screen were read (a claim, a
        // sign-in, a link): read the whole map again rather than patch it.
        const changed = scopeKey() !== loadedKey;
        if (changed) await loadScope();
        else {
          await refreshMap();
          if (scope.mode !== 'none') { refreshIslands(); refreshConnections(); }
        }
        refreshNeighbors();
      }
      paintChrome();
      paintFresh();
      paintTrial();
      refreshMyViews();
      // An invite QR's 会 still to join (a new person who left before their first post comes back).
      if (state.account) joinFromInvite().catch(() => {});
      // Not awaited: the map is already up, and the pill can arrive a moment later.
      loadDigest();
      // #/map?post=<id>: a link to one post, which opens for anybody. A visitor
      // who is not signed in keeps it, so signing in or registering (even through
      // Google, which leaves the page) brings them back to it.
      const linked = query ? query.get('post') : null;
      // Back on an address whose link was opened already - the back button of a
      // profile opened from another post - is not a new link: the post that was
      // open when the map was left comes back instead (2026-10-31: it was always
      // the linked post, often your own from a notification).
      if (validPostId(linked) && !linkOpened(linked) && activeScreen() === 'map') {
        restorePost = null;
        markLinkOpened(linked);
        if (!state.account) savePendingPost(browserStorage(), linked);
        // A link that cannot be read is a notice where the map would be, and nothing opens.
        if (!(scope.mode === 'none' && scope.reason === 'closed')) await openLinkedPost(linked);
      } else if (restorePost && activeScreen() === 'map') {
        const postId = restorePost;
        restorePost = null;
        await openPost(postId);
      }
      // The map is up and nothing is open over it: the catch-up (catchup.js) may come.
      document.dispatchEvent(new CustomEvent('map:ready'));
    },
  });
}
