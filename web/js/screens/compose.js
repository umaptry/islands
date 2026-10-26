// Writing a post, and what happens straight after.
//
// islands' 投稿画面, with its four tag checkboxes and its エンジョイ↔ガチ slider,
// plus the two things that only exist because the coordinates mean something:
// the "this is being placed" animation, and then the map, where the new post
// lands on its island.
//
// Stage 5 added the small things around writing: a prompt for the week (Q37),
// and the first post made by tapping an example sentence. "Talk to me" (Q45) is
// the first of the four tag checks, as in the mock. The example is placed but never saved
// (Q40): it stands on the map as a ghost only this browser sees, until the
// person writes in their own words or closes it.
//
// Following the mock (モック②), the post is not sent until the heat slider has been
// moved once (pressing 投稿する before that shows the slider), and a HeatObject above
// the slider shows what the number looks like on the map. The body stays at 60 characters.
//
// The image is downscaled and re-encoded in the browser before it is uploaded
// (see image.js). A 4MB phone photo would be the single biggest thing this app
// ever moves, and nobody looking at a card in a bottom sheet needs 4032 pixels.

import { RECRUIT_TAG } from '../map/reads.js';
import { config, islandColor, membersOnly } from '../config.js';
import { POST_IMAGE, prepareImage } from '../image.js';
import { api, data } from '../net.js';
import { navigate, screen, show } from '../router.js';
import { state, upsertPost } from '../state.js';
import { setOnboardingStep } from '../onboarding.js';
import { $, $$, clear, el, motivationColor, toast } from '../ui.js';
import { buzz, moment } from '../feedback.js';
import { heatObject } from '../components/heatobject.js';
import { REDUCED_MOTION } from '../map/decor.js';
import { ripple } from '../map/index.js';
import { availablePrompts, deadlineRange, extrasPayload, parseCapacity, promptPlaceholder } from '../recruit-rules.js';
import { openOnMap, showNearbyPosts, showTrial } from './map.js';
import { browserStorage } from '../talk.js';
import { takePendingPost } from '../return-post.js';
import { communitiesActive, currentScope, refreshCommunities } from '../communities.js';
import { communityNameIn, postingTarget, shareOn, shareTargets } from '../community-rules.js';
import { sharePost } from '../share.js';

let editing = null;       // the post being edited, or null for a new one
let imagePath = null;     // the uploaded storage path
let imageBlob = null;     // chosen but not yet uploaded
let submitting = false;
const drafts = new Map();
let draftKey = '';
let previewUrl = null;
let requestKey = null;
let requestBody = null;
let firstPost = false;
let touched = false;     // the heat slider has been moved (a new post cannot go without)
let heat = null;         // the HeatObject above the slider
let selectedPrompt = null;   // "weekly", an extra prompt's key, or null
let promptPosts = [];        // my posts, to hide the extra prompts already used
let postBlocked = false;     // communities are on and I am in none: there is no map to post to
let shareChosen = new Set(); // ほかのコミュニティにも出す: the communities ticked (not those that have the post already)

// The prompts and the recruit fields exist only once the database has the columns.
const extrasOn = () => Boolean(config().features?.post_extras);

// ---------------------------------------------------------------- image

function paintImage(url) {
  if (previewUrl?.startsWith('blob:') && previewUrl !== url) URL.revokeObjectURL(previewUrl);
  previewUrl = url;
  const preview = $('composeImagePreview');
  if (!url) {
    preview.hidden = true;
    $('composeImageImg').removeAttribute('src');
    return;
  }
  preview.hidden = false;
  $('composeImageImg').src = url;
}

// ---------------------------------------------------------------- form

function paintCounter() {
  const { body_min: min, body_max: max } = config().limits;
  const length = $('composeBody').value.trim().length;
  // No floor to reach any more (Q36), so the ring fills towards the cap.
  const ratio = Math.min(1, length / (min > 1 ? min : max));
  const ring = $('composeCounter').querySelector('.value');
  ring.style.strokeDashoffset = String(56.5 * (1 - ratio));
  $('composeCounter').classList.toggle('done', length >= min);
  $('composeCounter').classList.toggle('over', length > max);
  $('composeCounterText').textContent = `${length}/${max}${min > 1 && length < min ? `（${min}文字から）` : ''}`;
  // The button is not held back by the slider: pressing it before the slider has
  // been moved points at the slider instead (see nudgeSlider).
  $('composeSubmit').disabled = submitting || postBlocked || length < min || length > max;
  $('composeHint').hidden = Boolean(editing) || touched;
  if (touched) $('composeHint').classList.remove('alert');
}

/** Show the person where the answer is: scroll to the slider, shake it, and say it louder.
 * `submitted` is true when they pressed 投稿する without having moved it. */
function nudgeSlider(submitted) {
  const slider = $('composeSlider');
  const hint = $('composeHint');
  if (!touched && !editing) {
    hint.hidden = false;
    // Emptied first, so a screen reader says the words again (the live region only speaks a change).
    hint.textContent = '';
    requestAnimationFrame(() => { hint.textContent = 'バーを左右に動かして、どれくらい本気か選んでください'; });
    hint.classList.toggle('alert', submitted);
    // The bar itself takes the focus: the arrow keys (and a screen reader's swipe) answer from there.
    if (submitted) $('composeMotivation').focus({ preventScroll: true });
  }
  slider.scrollIntoView({ block: 'center', behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
  if (REDUCED_MOTION) return;
  slider.classList.remove('shake');
  void slider.offsetWidth;   // restart the animation
  slider.classList.add('shake');
  setTimeout(() => slider.classList.remove('shake'), 700);
}

/** The box of the first post used to stay shut behind the examples until "自分の言葉で書く" was
 * tapped; it is now open from the start (see enter). */
function setOwnOpen(open) {
  $('compose').classList.toggle('own-closed', firstPost && !open);
}

function paintMotivation() {
  const value = Number($('composeMotivation').value);
  const color = motivationColor(value);
  // Until it has been moved the bar shows no fill and no handle, and the ball
  // is grey: the number is only an answer once somebody has given it.
  $('composeSlider').classList.toggle('untouched', !touched);
  $('composeFill').style.width = `${value}%`;
  $('composeFill').style.background = `linear-gradient(to right, #ffffff, ${color})`;
  // Before the first answer the handle is a wide pill with arrows (see style.css).
  $('composeHandle').style.left = `calc(${value}% - 2px)`;
  $('composeHandle').style.backgroundColor = touched ? color : '';
  heat.set(value, !touched);
}

function selectedTags() {
  return $$('#composeTags .check.on').map((node) => node.dataset.tag);
}

function paintTags(selected = []) {
  const box = clear($('composeTags'));
  config().tags.forEach((tag) => {
    const node = el('button', {
      className: `check${selected.includes(tag) ? ' on' : ''}`,
      attrs: { type: 'button', role: 'checkbox', 'aria-checked': selected.includes(tag) },
    },
      el('span', { className: 'check-box', attrs: { 'aria-hidden': 'true' } }),
      el('span', { className: 'check-label', text: tag }),
    );
    node.dataset.tag = tag;
    node.addEventListener('click', () => {
      const on = node.classList.toggle('on');
      node.setAttribute('aria-checked', String(on));
      paintRecruit();
      buzz('tap');
    });
    box.append(node);
  });
}

/** The weekly prompt for a new post; the extra ones also on the first post,
 * under its examples. */
function paintPrompt(weeklyShown, extrasShown) {
  const prompt = config().weekly_prompt;
  $('composePrompt').hidden = !weeklyShown || !prompt?.text;
  $('composePromptText').textContent = prompt?.text || '';
  selectedPrompt = null;
  paintExtraPrompts(extrasShown);
  syncPrompt();
}

/** The three standing prompts, minus the ones this person has already posted with. */
function paintExtraPrompts(show) {
  const items = show ? availablePrompts(config().extra_prompts, promptPosts, extrasOn()) : [];
  const kept = [...items, ...starters()];
  if (selectedPrompt && selectedPrompt !== 'weekly' && !kept.some((item) => item.key === selectedPrompt)) selectedPrompt = null;
  // A weekly prompt kept in a draft is dropped where the weekly prompt is not
  // shown (the first post), or it would be sent without being seen.
  if (selectedPrompt === 'weekly' && $('composePrompt').hidden) selectedPrompt = null;
  $('composeExtraPrompts').hidden = !items.length;
  const list = clear($('composeExtraPromptList'));
  items.forEach((item) => {
    const chip = el('button', { className: 'extra-chip', text: item.text, attrs: { type: 'button' } });
    chip.dataset.key = item.key;
    chip.addEventListener('click', () => {
      selectedPrompt = selectedPrompt === item.key ? null : item.key;
      syncPrompt();
      if (selectedPrompt) $('composeBody').focus();
    });
    list.append(chip);
  });
  syncPrompt();
}

/** The opening words offered over the box of a first post. They stand in for the extra prompts there
 * and are recorded the same way (as the post's `prompt`, by the same key). */
function starters() {
  return firstPost && !editing ? (config().post_starters || []) : [];
}

function paintStarters() {
  const items = starters();
  $('composeStarters').hidden = !items.length;
  const list = clear($('composeStarterList'));
  items.forEach((item) => {
    const chip = el('button', { className: 'extra-chip', text: item.text, attrs: { type: 'button' } });
    chip.dataset.key = item.key;
    chip.addEventListener('click', () => useStarter(item));
    list.append(chip);
  });
  syncPrompt();
}

/** Choose (or unchoose) the prompt: its example sentence shows as the placeholder and the box is left
 * as it is, so nothing the person wrote is touched and nothing is put in for them to post as it stands. */
function useStarter(item) {
  selectedPrompt = selectedPrompt === item.key ? null : item.key;
  syncPrompt();
  buzz('tap');
  if (selectedPrompt) $('composeBody').focus();
}

// The opening words an older version put into the box (and into drafts kept by the browser).
const OLD_STARTERS = ['昔がんばってたのは、', '最近はまってるのは、', '今度やってみたいのは、'];

/** Show which prompt is chosen, and let it speak in the body's placeholder:
 * an example sentence for an extra prompt, the weekly prompt's own words. */
function syncPrompt() {
  const weekly = selectedPrompt === 'weekly';
  $('composePrompt').classList.toggle('used', weekly);
  $('composePromptUse').textContent = weekly ? 'お題を外す' : 'このお題で書く';
  $('composePromptUse').setAttribute('aria-pressed', String(weekly));
  $$('#composeExtraPromptList .extra-chip, #composeStarterList .extra-chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.key === selectedPrompt));
  });
  $('composeBody').placeholder = promptPlaceholder({
    // The first post always shows an example: 最近はまってること's, until a prompt is chosen.
    selected: selectedPrompt || (starters().length ? 'now' : null),
    weekly: config().weekly_prompt,
    extraPrompts: config().extra_prompts,
    max: config().limits.body_max,
  });
}

/** 申込期限 and 先着人数 open under the tags while 参加者募集中 is ticked, and
 * their values go when it is unticked. */
function paintRecruit() {
  const available = extrasOn();
  $('composeRecruit').hidden = !available;
  const open = available && selectedTags().includes(RECRUIT_TAG);
  $('composeShareRecruit').hidden = !open;
  $('composeRecruit').dataset.open = String(open);
  $('composeRecruitBox').inert = !open;
  if (!open) {
    $('composeDeadline').value = '';
    $('composeCapacity').value = '';
  }
}

// ---------------------------------------------------------------- ほかのコミュニティにも出す (2026-10-29)

/** The community the post is (or will be) in: the edited post's own, or the map that is open. */
function shareHere() {
  if (editing) return editing.community_id || null;
  const scope = currentScope();
  return scope.mode === 'community' ? scope.id : null;
}

/** My copies of the edited post (every community), from my posts. */
function editedCopies() {
  if (!editing) return [];
  const group = editing.share_group || state.myPosts.find((post) => post.id === editing.id)?.share_group;
  return group ? state.myPosts.filter((post) => post.share_group === group) : [editing];
}

/** The box under the tags: every other community of mine, ticked where the post is already. Not on the
 * first post (one thing at a time there), and only where the server offers it (features.share). */
function paintShare() {
  const here = shareHere();
  const targets = shareOn(config()) && !firstPost && !postBlocked && here
    ? shareTargets({ communities: state.communities, here, copies: editedCopies() })
    : [];
  $('composeShare').hidden = !targets.length;
  const list = clear($('composeShareList'));
  targets.forEach((target) => {
    const ticked = target.shared || shareChosen.has(target.id);
    const node = el('button', {
      className: `check${ticked ? ' on' : ''}${target.shared ? ' fixed' : ''}`,
      attrs: { type: 'button', role: 'checkbox', 'aria-checked': String(ticked), 'aria-disabled': String(target.shared) },
    },
      el('span', { className: 'check-box', attrs: { 'aria-hidden': 'true' } }),
      el('span', { className: 'check-label', text: target.name },
        target.shared ? el('span', { className: 'check-note', text: '出しています' }) : null),
    );
    node.dataset.community = target.id;
    if (!target.shared) {
      node.addEventListener('click', () => {
        if (shareChosen.has(target.id)) shareChosen.delete(target.id);
        else shareChosen.add(target.id);
        paintShare();
        buzz('tap');
      });
    }
    list.append(node);
  });
}

/** After the post is saved: put it on the ticked communities too. Says what happened; a failure costs
 * only the copies (the post itself is saved, and the edit screen offers the box again). */
async function shareAfterSave(postId) {
  const chosen = [...shareChosen];
  shareChosen = new Set();
  if (!chosen.length) return '';
  try {
    const result = await sharePost(postId, chosen);
    const names = (result?.added || []).map((id) => communityNameIn(state.communities, id)).filter(Boolean);
    return names.length ? `${names.join('・')}にも出しました。` : '';
  } catch (error) {
    return `ほかのコミュニティには出せませんでした（${error.message}）。編集画面からもう一度出せます。`;
  }
}

/** The example sentences (try-out) are no longer offered on the first post; they go with the rest of
 * the trial (tryExample, reveal) after 10/30. */
function paintExamples(show) {
  $('composeExamples').hidden = !show;
  const list = clear($('composeExampleList'));
  if (!show) return;
  (config().example_posts || []).forEach((text) => {
    const button = el('button', { className: 'example', attrs: { type: 'button' }, text });
    button.addEventListener('click', () => tryExample(text));
    list.append(button);
  });
}

export function setupCompose() {
  const body = $('composeBody');
  heat = heatObject(96);
  $('composeHeat').append(heat.node);
  body.addEventListener('input', paintCounter);
  // 'input' while dragging, 'change' for a keyboard or an assistive tool: either
  // counts as having answered.
  const moved = () => {
    touched = true;
    paintMotivation();
    paintCounter();
  };
  const slider = $('composeMotivation');
  slider.addEventListener('input', moved);
  slider.addEventListener('change', moved);
  // iPhone moves a range input only by dragging its (here invisible) thumb, so a tap on the bar
  // did nothing. The bar sets the value from where it is touched and goes on following the finger.
  let dragging = null;
  let before = null;       // the answer before this touch, given back if the touch turns into a scroll
  const setFromPointer = (event) => {
    const box = slider.getBoundingClientRect();
    if (!box.width) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    slider.value = String(Math.round(ratio * 100));
    moved();
  };
  slider.addEventListener('pointerdown', (event) => {
    if (event.button > 0) return;
    dragging = event.pointerId;
    before = { value: slider.value, touched };
    try { slider.setPointerCapture(event.pointerId); } catch { /* not capturable: moves still arrive over the bar */ }
    setFromPointer(event);
  });
  slider.addEventListener('pointermove', (event) => {
    if (dragging === event.pointerId) setFromPointer(event);
  });
  // The bar is touch-action: pan-y, so a finger that starts on it and goes up or down scrolls the
  // page and the browser cancels the pointer: that was a scroll, not an answer.
  slider.addEventListener('pointercancel', (event) => {
    if (dragging !== event.pointerId || !before) return;
    slider.value = before.value;
    touched = before.touched;
    paintMotivation();
    paintCounter();
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => {
    slider.addEventListener(type, (event) => {
      if (dragging === event.pointerId) { dragging = null; before = null; }
    });
  });
  // The ball above the slider looks like the thing to tap: answer by showing the bar.
  $('composeHeat').addEventListener('click', () => nudgeSlider(false));
  $('composeOwnBtn').addEventListener('click', () => {
    setOwnOpen(true);
    body.focus();
  });
  $('composePromptUse').addEventListener('click', () => {
    if (!config().weekly_prompt?.text) return;
    selectedPrompt = selectedPrompt === 'weekly' ? null : 'weekly';
    syncPrompt();
    if (selectedPrompt) body.focus();
  });

  $('composeBack').addEventListener('click', () => {
    navigate(editing ? '#/me' : '#/map');
  });

  $('composeImageBtn').addEventListener('click', () => $('composeImageInput').click());
  $('composeImageInput').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      imageBlob = await prepareImage(file, POST_IMAGE);
      imagePath = null;
      paintImage(URL.createObjectURL(imageBlob));
    } catch (error) {
      toast(error.message);
    }
  });
  $('composeImageClear').addEventListener('click', () => {
    imageBlob = null;
    imagePath = null;
    paintImage(null);
  });

  $('composeSubmit').addEventListener('click', submit);

  screen('compose', {
    leave() {
      if (draftKey) drafts.set(draftKey, { body: body.value, tags: selectedTags(), motivation: $('composeMotivation').value,
        touched, imagePath, imageBlob, requestKey, requestBody,
        prompt: selectedPrompt, deadline: $('composeDeadline').value, capacity: $('composeCapacity').value,
        share: [...shareChosen] });
    },
    enter: async (params, query) => {
      const first = query && query.get('first') === '1';
      firstPost = Boolean(first);
      $('compose').classList.toggle('first-post', firstPost);
      $('firstPostFooter').hidden = !firstPost;
      (firstPost ? $('firstPostFooter') : document.querySelector('#compose .topbar-inline')).append($('composeSubmit'));
      if (firstPost) {
        $('bottomNav').hidden = true;
        document.body.classList.remove('has-nav');
      }
      editing = null;
      imageBlob = null;
      imagePath = null;
      submitting = false;
      touched = false;

      if (params && params.id) {
        editing = state.myPosts.find((post) => post.id === params.id)
          || state.postsById.get(params.id) || await data.getPost(params.id);
        if (!editing || editing.author_id !== state.account?.id) {
          $('composeError').textContent = 'この投稿は編集できません。';
          $('composeSubmit').disabled = true;
          return;
        }
      }
      draftKey = `${state.account?.id}:${editing?.id || 'new'}`;
      const draft = drafts.get(draftKey);
      requestKey = draft?.requestKey || null;
      requestBody = draft?.requestBody || null;

      // 「{コミュニティ名} に投稿」: a post goes to the community whose map is open.
      // My communities could not be read earlier: ask again, and if that fails too, say so
      // (a post with no community is on nobody's map, and nobody is sent away over a bad connection).
      if (communitiesActive() && !editing && !state.communitiesLoaded) await refreshCommunities();
      const target = postingTarget({
        on: communitiesActive(), editing: Boolean(editing), scope: currentScope(), known: state.communitiesLoaded,
      });
      postBlocked = target.blocked;
      // Nothing to type into when nothing can be posted: the box is hidden, the ← still works.
      $('compose').classList.toggle('compose-blocked', target.blocked);
      $('composeCommunity').hidden = !target.show;
      $('composeCommunity').textContent = target.blocked ? target.message : target.text;
      $('composeCommunity').classList.toggle('blocked', target.blocked);
      if (target.blocked && !target.unknown && firstPost) {
        // A new account that is in no community has nowhere to post; do not leave it
        // stuck on the first-post step. The map says what to do.
        setOnboardingStep(null);
        navigate('#/map', { replace: true });
        return;
      }

      $('composeTitle').textContent = editing ? '投稿を編集' : '新規投稿';
      $('composeSubmit').textContent = editing ? '保存' : '投稿する';
      $('composeMoveNotice').hidden = !editing;
      $('composeLede').textContent = first
        ? 'ひとこと書いて、あなたの島を作りましょう。'
        : `取り組みや活動内容を${config().limits.body_max}文字までで書いてください。`;

      body.value = draft?.body ?? (editing ? editing.body : '');
      // A draft that holds only an old opening phrase is an empty box.
      if (!editing && OLD_STARTERS.includes(body.value.trim())) body.value = '';
      $('composeMotivation').value = editing
        ? editing.motivation
        : config().limits.motivation_default;
      // A post that exists already has an answer; only a new one has to be given one.
      touched = Boolean(editing);
      paintTags(editing ? (editing.tags || []) : []);
      promptPosts = state.myPosts;
      paintPrompt(!editing && !firstPost, !editing && !firstPost);
      paintStarters();
      refreshPromptPosts(editing);
      paintExamples(false);
      imagePath = editing ? (editing.image_path || null) : null;
      paintImage(imagePath ? data.imageUrl(imagePath) : null);
      if (draft) {
        $('composeMotivation').value = draft.motivation;
        touched = Boolean(draft.touched);
        paintTags(draft.tags);
        selectedPrompt = draft.prompt || null;
        paintExtraPrompts(!editing && !firstPost);
        paintStarters();
        imagePath = draft.imagePath;
        imageBlob = draft.imageBlob;
        paintImage(imageBlob ? URL.createObjectURL(imageBlob) : imagePath ? data.imageUrl(imagePath) : null);
      }
      paintRecruit();
      if (extrasOn()) {
        const { min, max } = deadlineRange(new Date(), editing?.recruit_deadline);
        $('composeDeadline').min = min;
        $('composeDeadline').max = max;
        $('composeDeadline').value = '';
        $('composeCapacity').value = '';
        if (draft) {
          $('composeDeadline').value = draft.deadline || '';
          $('composeCapacity').value = draft.capacity || '';
        } else if (editing && selectedTags().includes(RECRUIT_TAG)) {
          $('composeDeadline').value = editing.recruit_deadline || '';
          $('composeCapacity').value = editing.recruit_capacity || '';
        }
      }
      $('composeError').textContent = '';
      $('composeHint').classList.remove('alert');
      shareChosen = new Set(draft?.share || []);
      paintShare();
      refreshShare();
      setOwnOpen(true);
      paintCounter();
      paintMotivation();
    },
  });
}

/** The box needs my communities and, when editing, my copies of the post: read them if they may be old. */
function refreshShare() {
  if (!shareOn(config()) || firstPost || !state.account) return;
  const accountId = state.account.id;
  const editedId = editing?.id || null;
  const still = () => state.account?.id === accountId && (editing?.id || null) === editedId
    && $('compose').classList.contains('active');
  if (!state.communitiesLoaded) refreshCommunities().then(() => { if (still()) paintShare(); }).catch(() => {});
  if (editing) {
    data.postsByAuthor(accountId).then((rows) => {
      if (!Array.isArray(rows) || state.account?.id !== accountId) return;
      state.myPosts = rows;
      if (still()) paintShare();
    }).catch(() => {});
  }
}

/** My posts may not be loaded yet (they come with the map); read them so a used
 * prompt is hidden even on a fresh visit. */
function refreshPromptPosts(post) {
  if (post || !extrasOn() || !state.account) return;
  const accountId = state.account.id;
  data.postsByAuthor(accountId).then((rows) => {
    if (state.account?.id !== accountId || !Array.isArray(rows)) return;
    promptPosts = rows;
    if ($('compose').classList.contains('active')) paintExtraPrompts(!firstPost);
  }).catch(() => {});
}

/** show('compose') brings the bottom nav back; the first post is still in the way of it. */
function keepNavHidden() {
  if (!firstPost) return;
  $('bottomNav').hidden = true;
  document.body.classList.remove('has-nav');
}

/** What 参加者募集中 does, told to the author (who never sees the star). */
function recruitNote(tags) {
  return (tags || []).includes(RECRUIT_TAG)
    ? ' 参加者募集中の投稿は、ほかの人の地図に金の星で表示されます。'
    : '';
}

async function submit() {
  if (submitting) return;
  // The heat has not been answered yet: show the slider instead of sending.
  if (!editing && !touched) {
    nudgeSlider(true);
    return;
  }
  // A filled but invalid capacity must not quietly become "no limit".
  if (extrasOn() && selectedTags().includes(RECRUIT_TAG)
    && $('composeCapacity').value.trim() !== '' && parseCapacity($('composeCapacity').value) === null) {
    const message = '先着人数は1〜999の整数で入力してください';
    $('composeError').textContent = message;
    toast(message);
    return;
  }
  submitting = true;
  $('composeSubmit').disabled = true;
  $('composeError').textContent = '';

  const payload = {
    body: $('composeBody').value.trim(),
    tags: selectedTags(),
    motivation: Number($('composeMotivation').value),
  };
  if (communitiesActive() && !editing) {
    const scope = currentScope();
    if (scope.mode === 'community') payload.community_id = scope.id;
  }
  Object.assign(payload, extrasPayload({
    enabled: extrasOn(),
    editing: Boolean(editing),
    recruiting: payload.tags.includes(RECRUIT_TAG),
    prompt: selectedPrompt,
    deadline: $('composeDeadline').value,
    capacity: $('composeCapacity').value,
  }));

  try {
    if (imageBlob) {
      $('composeSubmit').textContent = '画像を送信中…';
      imagePath = await data.uploadImage(imageBlob);
      imageBlob = null;
    }
    payload.image_path = imagePath;

    if (editing) {
      const moved = payload.body !== editing.body;
      const updated = await api.patch(`/api/posts/${editing.id}`, {
        ...payload,
        clear_image: !imagePath,
      });
      upsertPost(updated);
      drafts.delete(draftKey);
      draftKey = '';
      const shared = await shareAfterSave(editing.id);
      toast((moved ? '保存しました。地図の位置も更新されました。' : '保存しました。') + shared + recruitNote(payload.tags));
      navigate('#/me');
      return;
    }

    const result = await runPlacement(payload);
    setOnboardingStep(null);
    state.trialPost = null;
    drafts.delete(draftKey);
    draftKey = '';
    moment('post');
    // The copies go while the post lands (they stand where it stands, on the other maps).
    const sharing = shareAfterSave(result.id);
    // Straight onto the map, where the new ground rises and the face lands
    // (as in the design mock). The 「あなたの島」 page that used to come first
    // had only the island's name left on it once its list of near people went.
    // A new person who arrived through a link to a post (#/map?post=...) lands on
    // their own island first, and then the post they were invited to opens.
    await landOnMap(result, firstPost ? takePendingPost(browserStorage()) : null);
    // The star is for other people; say so, or the author sees nothing happen.
    const said = (await sharing) + recruitNote(payload.tags);
    if (said.trim()) toast(said.trim());
  } catch (error) {
    $('composeError').textContent = error.message;
    // The server words its 422s for a person (a past deadline, a bad number).
    if (error.status === 422) toast(error.message);
    show('compose');
    keepNavHidden();
  } finally {
    submitting = false;
    $('composeSubmit').textContent = editing ? '保存' : '投稿する';
    paintCounter();
  }
}

/** Open the new post on the map, with a ripple where it landed. */
async function landOnMap(result, thenOpen = null) {
  // The first post is followed by the posts nearest to it (which opens `thenOpen`, if any, after it).
  await openOnMap(result.id, { thenOpen,
    afterLand: firstPost ? () => showNearbyPosts(result, { thenOpen }) : null });
  ripple(result.x, result.y, { big: true });
}

/** Q40: an example sentence, placed for a look and not kept.
 * Nothing on the first post calls this any more. 10/30 のあとに片づける (with showTrialReveal, the reveal
 * screen, the trial banner and /api/posts/preview). */
export async function tryExample(text) {
  if (submitting) return;
  submitting = true;
  $('composeError').textContent = '';
  buzz('tap');
  try {
    const result = await runPlacement({ body: text, ...tryoutCommunity() }, { tryout: true });
    state.trialPost = {
      x: result.x, y: result.y, body: text,
      icon_id: state.account?.icon_id, avatar_path: state.account?.avatar_path,
      island: result.island,
    };
    setOnboardingStep(null);
    showTrialReveal(result);
  } catch (error) {
    $('composeError').textContent = error.message;
    show('compose');
    keepNavHidden();
  } finally {
    submitting = false;
    paintCounter();
  }
}

/** The community a tried-out sentence would stand in (members only: the server wants to know which). */
function tryoutCommunity() {
  if (!membersOnly()) return {};   // while the switch is off the server does not ask, and the body stays as it was
  const scope = currentScope();
  return scope.mode === 'community' ? { community_id: scope.id } : {};
}

/** The placing animation, and the request it is covering. */
async function runPlacement(payload, { tryout = false } = {}) {
  show('computing');
  const steps = $$('.step');
  steps.forEach((step) => step.classList.remove('on', 'done'));
  let index = 0;
  steps[0].classList.add('on');
  const ticker = setInterval(() => {
    if (index < steps.length - 1) {
      steps[index].classList.replace('on', 'done');
      steps[index += 1].classList.add('on');
    }
  }, 620);

  const started = performance.now();
  try {
    let result;
    if (tryout) {
      result = await api.post('/api/posts/preview', payload);
    } else {
      const fingerprint = JSON.stringify(payload);
      if (requestBody !== fingerprint) { requestKey = crypto.randomUUID(); requestBody = fingerprint; }
      result = await api.post('/api/posts', payload, { headers: { 'Idempotency-Key': requestKey } });
    }
    // Let the animation finish, so the reveal never flashes past. The wait is
    // capped by how long the request actually took, not added to it.
    const elapsed = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1800 - elapsed)));
    steps.forEach((step) => { step.classList.remove('on'); step.classList.add('done'); });
    if (tryout) return result;
    upsertPost(result);
    state.myPosts = state.myPosts.filter((post) => post.id !== result.id).concat(result);
    state.activePostId = result.id;
    return result;
  } finally {
    clearInterval(ticker);
  }
}

// ---------------------------------------------------------------- tryout

/** Where the tried-out sentence would stand, before it is shown on the map.
 * (A real post goes straight to the map: see submit.) */
let trialToken = 0;
function showTrialReveal(result) {
  const island = result.island;
  // The name stays white on the sea; the island's own colour is the dot beside it.
  const nameBox = clear($('revealIsland'));
  if (island) {
    const dot = el('span', { className: 'reveal-swatch' });
    dot.style.background = islandColor(island.cluster_id);
    nameBox.append(dot);
  }
  nameBox.append(el('span', { text: island ? island.label : 'まだ名前のない島' }));
  const bodyBox = clear($('revealBody'));
  bodyBox.append(el('p', {
    className: 'trial-note',
    text: `「${result.body}」\nこの文は保存していません。地図では、あなたにだけ見えます。`,
  }));
  const mine = (trialToken += 1);
  paintNearIslands(bodyBox, result, state.islands);
  // The island list comes with the map; on a first visit it may not be here yet.
  if (!state.islands?.length) {
    const scope = membersOnly() ? currentScope() : { mode: 'legacy' };
    const path = scope.mode === 'community' ? `/api/islands?${new URLSearchParams({ community: scope.id })}` : '/api/islands';
    api.get(path).then((list) => {
      if (mine === trialToken) paintNearIslands(bodyBox, result, list?.islands);
    }).catch(() => {});
  }
  show('reveal');
}

/** The islands near the tried-out sentence, named, with how many people they hold. */
function paintNearIslands(bodyBox, result, islands) {
  bodyBox.querySelector('.reveal-near')?.remove();
  const near = nearIslands(result, 3, islands);
  if (!near.length) return;
  const list = el('ul', { className: 'reveal-near-list' });
  near.forEach((entry) => {
    const dot = el('span', { className: 'reveal-swatch' });
    dot.style.background = islandColor(entry.cluster_id);
    list.append(el('li', { className: 'reveal-near-item' },
      dot,
      el('span', { className: 'reveal-near-name', text: entry.label }),
      el('span', { className: 'reveal-near-people', text: `${entry.people ?? 0}人` }),
    ));
  });
  bodyBox.append(el('div', { className: 'reveal-near' },
    el('p', { className: 'reveal-near-lede', text: 'あなたの文に近い話をしている人は、このあたりにいます' }),
    list,
  ));
}

/** The named islands nearest to where the tried-out sentence stands. */
function nearIslands(result, count, islands) {
  const { x, y } = result;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
  return (islands || [])
    .filter((entry) => entry.label && Number.isFinite(entry.cx) && Number.isFinite(entry.cy))
    .map((entry) => ({ entry, d: Math.hypot(entry.cx - x, entry.cy - y) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, count)
    .map((item) => item.entry);
}

export function setupReveal() {
  $('revealToMap').addEventListener('click', () => showTrial());
  $('revealWrite').addEventListener('click', () => navigate('#/post'));
  screen('reveal', {});
  screen('computing', {});
}
