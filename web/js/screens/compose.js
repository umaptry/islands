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
// Following the mock (モック②), the post cannot be sent until the heat slider
// has been moved once, and a HeatObject above the slider shows what the number
// looks like on the map. The body stays at 60 characters.
//
// The image is downscaled and re-encoded in the browser before it is uploaded
// (see image.js). A 4MB phone photo would be the single biggest thing this app
// ever moves, and nobody looking at a card in a bottom sheet needs 4032 pixels.

import { RECRUIT_TAG } from '../map/reads.js';
import { config, islandColor } from '../config.js';
import { POST_IMAGE, prepareImage } from '../image.js';
import { api, data } from '../net.js';
import { navigate, screen, show } from '../router.js';
import { state, upsertPost } from '../state.js';
import { setOnboardingStep } from '../onboarding.js';
import { $, $$, clear, el, motivationColor, toast } from '../ui.js';
import { buzz, moment } from '../feedback.js';
import { heatObject } from '../components/heatobject.js';
import { ripple } from '../map/index.js';
import { availablePrompts, deadlineRange, extrasPayload, parseCapacity, promptPlaceholder } from '../recruit-rules.js';
import { openOnMap, showTrial } from './map.js';

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
  $('composeSubmit').disabled = submitting || length < min || length > max || !touched;
}

function paintMotivation() {
  const value = Number($('composeMotivation').value);
  const color = motivationColor(value);
  // Until it has been moved the bar shows no fill and no handle, and the ball
  // is grey: the number is only an answer once somebody has given it.
  $('composeSlider').classList.toggle('untouched', !touched);
  $('composeFill').style.width = `${value}%`;
  $('composeFill').style.background = `linear-gradient(to right, #ffffff, ${color})`;
  $('composeHandle').style.left = `calc(${value}% - 2px)`;
  $('composeHandle').style.backgroundColor = color;
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
  if (selectedPrompt && selectedPrompt !== 'weekly' && !items.some((item) => item.key === selectedPrompt)) selectedPrompt = null;
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

/** Show which prompt is chosen, and let it speak in the body's placeholder:
 * an example sentence for an extra prompt, the weekly prompt's own words. */
function syncPrompt() {
  const weekly = selectedPrompt === 'weekly';
  $('composePrompt').classList.toggle('used', weekly);
  $('composePromptUse').textContent = weekly ? 'お題を外す' : 'このお題で書く';
  $('composePromptUse').setAttribute('aria-pressed', String(weekly));
  $$('#composeExtraPromptList .extra-chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.key === selectedPrompt));
  });
  $('composeBody').placeholder = promptPlaceholder({
    selected: selectedPrompt,
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
  $('composeRecruit').dataset.open = String(open);
  $('composeRecruitBox').inert = !open;
  if (!open) {
    $('composeDeadline').value = '';
    $('composeCapacity').value = '';
  }
}

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
  $('composeMotivation').addEventListener('input', moved);
  $('composeMotivation').addEventListener('change', moved);
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
        prompt: selectedPrompt, deadline: $('composeDeadline').value, capacity: $('composeCapacity').value });
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

      $('composeTitle').textContent = editing ? '投稿を編集' : '新規投稿';
      $('composeSubmit').textContent = editing ? '保存' : '投稿する';
      $('composeMoveNotice').hidden = !editing;
      $('composeLede').textContent = first
        ? 'ためしに１つ\n投稿してみましょう。'
        : `取り組みや活動内容を${config().limits.body_max}文字までで書いてください。`;

      body.value = draft?.body ?? (editing ? editing.body : '');
      $('composeMotivation').value = editing
        ? editing.motivation
        : config().limits.motivation_default;
      // A post that exists already has an answer; only a new one has to be given one.
      touched = Boolean(editing);
      paintTags(editing ? (editing.tags || []) : []);
      promptPosts = state.myPosts;
      paintPrompt(!editing && !firstPost, !editing);
      refreshPromptPosts(editing);
      paintExamples(firstPost && !editing);
      imagePath = editing ? (editing.image_path || null) : null;
      paintImage(imagePath ? data.imageUrl(imagePath) : null);
      if (draft) {
        $('composeMotivation').value = draft.motivation;
        touched = Boolean(draft.touched);
        paintTags(draft.tags);
        selectedPrompt = draft.prompt || null;
        paintExtraPrompts(!editing);
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
      paintCounter();
      paintMotivation();
    },
  });
}

/** My posts may not be loaded yet (they come with the map); read them so a used
 * prompt is hidden even on a fresh visit. */
function refreshPromptPosts(post) {
  if (post || !extrasOn() || !state.account) return;
  const accountId = state.account.id;
  data.postsByAuthor(accountId).then((rows) => {
    if (state.account?.id !== accountId || !Array.isArray(rows)) return;
    promptPosts = rows;
    if ($('compose').classList.contains('active')) paintExtraPrompts(true);
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
      toast((moved ? '保存しました。地図の位置も更新されました。' : '保存しました。') + recruitNote(payload.tags));
      navigate('#/me');
      return;
    }

    const result = await runPlacement(payload);
    setOnboardingStep(null);
    state.trialPost = null;
    drafts.delete(draftKey);
    draftKey = '';
    moment('post');
    // Straight onto the map, where the new ground rises and the face lands
    // (as in the design mock). The 「あなたの島」 page that used to come first
    // had only the island's name left on it once its list of near people went.
    await landOnMap(result);
    // The star is for other people; say so, or the author sees nothing happen.
    if (recruitNote(payload.tags)) toast(recruitNote(payload.tags).trim());
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
async function landOnMap(result) {
  await openOnMap(result.id);
  ripple(result.x, result.y, { big: true });
}

/** Q40: an example sentence, placed for a look and not kept. */
async function tryExample(text) {
  if (submitting) return;
  submitting = true;
  $('composeError').textContent = '';
  buzz('tap');
  try {
    const result = await runPlacement({ body: text }, { tryout: true });
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
  clear($('revealBody')).append(el('p', {
    className: 'trial-note',
    text: `「${result.body}」\nこの文は保存していません。地図では、あなたにだけ見えます。`,
  }));
  show('reveal');
}

export function setupReveal() {
  $('revealToMap').addEventListener('click', () => showTrial());
  $('revealWrite').addEventListener('click', () => navigate('#/post'));
  screen('reveal', {});
  screen('computing', {});
}
