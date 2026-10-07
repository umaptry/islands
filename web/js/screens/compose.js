// Writing a post, and what happens straight after.
//
// islands' 投稿画面, with its four tag checkboxes and its エンジョイ↔ガチ slider,
// plus the two things that only exist because the coordinates mean something:
// the "this is being placed" animation, and the reveal that tells you which
// island you landed on and who is nearest.
//
// Stage 5 added the small things around writing: a prompt for the week (Q37),
// a "talk to me" switch that is really the first tag (Q45), and the first post
// made by tapping an example sentence. The example is placed but never saved
// (Q40): it stands on the map as a ghost only this browser sees, until the
// person writes in their own words or closes it.
//
// The image is downscaled and re-encoded in the browser before it is uploaded
// (see image.js). A 4MB phone photo would be the single biggest thing this app
// ever moves, and nobody looking at a card in a bottom sheet needs 4032 pixels.

import { config, islandColor } from '../config.js';
import { POST_IMAGE, prepareImage } from '../image.js';
import { api, data } from '../net.js';
import { navigate, screen, show } from '../router.js';
import { state, upsertPost } from '../state.js';
import { setOnboardingStep } from '../onboarding.js';
import { $, $$, clear, el, motivationColor, toast } from '../ui.js';
import { postRow } from '../components/postcard.js';
import { buzz, moment } from '../feedback.js';
import { ripple } from '../map/index.js';
import { openOnMap, showTrial } from './map.js';

const OPEN_KEY = 'islands.openDefault';

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
  $('composeSubmit').disabled = submitting || length < min || length > max;
}

function paintMotivation() {
  const value = Number($('composeMotivation').value);
  const color = motivationColor(value);
  $('composeFill').style.width = `${value}%`;
  $('composeFill').style.background = `linear-gradient(to right, #ffffff, ${color})`;
  $('composeHandle').style.left = `calc(${value}% - 2px)`;
  $('composeHandle').style.backgroundColor = color;
}

function selectedTags() {
  const tags = $$('#composeTags .check.on').map((node) => node.dataset.tag);
  return $('composeOpen').checked ? [config().open_tag, ...tags] : tags;
}

/** The last choice of "talk to me", so it need not be set on every post. */
function openByDefault() {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberOpen(on) {
  try {
    localStorage.setItem(OPEN_KEY, on ? '1' : '0');
  } catch {
    // Not remembered; the switch still works for this post.
  }
}

function paintTags(selected = []) {
  const box = clear($('composeTags'));
  const open = config().open_tag;
  $('composeOpen').checked = selected.includes(open);
  config().tags.filter((tag) => tag !== open).forEach((tag) => {
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
    });
    box.append(node);
  });
}

function paintPrompt(show) {
  const prompt = config().weekly_prompt;
  $('composePrompt').hidden = !show || !prompt?.text;
  $('composePrompt').classList.remove('used');
  $('composePromptText').textContent = prompt?.text || '';
  $('composeBody').placeholder = `取り組みや活動内容（最大${config().limits.body_max}文字）`;
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
  $('composeTags').closest('.field').before($('composeImageBtn').closest('.field'));
  body.addEventListener('input', paintCounter);
  $('composeMotivation').addEventListener('input', paintMotivation);
  $('composeOpen').addEventListener('change', (event) => {
    rememberOpen(event.target.checked);
    buzz('tap');
  });
  $('composePromptUse').addEventListener('click', () => {
    const text = config().weekly_prompt?.text;
    if (!text) return;
    body.placeholder = `お題：${text}`;
    $('composePrompt').classList.add('used');
    body.focus();
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
        imagePath, imageBlob, requestKey, requestBody });
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
      paintTags(editing ? (editing.tags || []) : openByDefault() ? [config().open_tag] : []);
      paintPrompt(!editing && !firstPost);
      paintExamples(firstPost && !editing);
      imagePath = editing ? (editing.image_path || null) : null;
      paintImage(imagePath ? data.imageUrl(imagePath) : null);
      if (draft) {
        $('composeMotivation').value = draft.motivation;
        paintTags(draft.tags);
        imagePath = draft.imagePath;
        imageBlob = draft.imageBlob;
        paintImage(imageBlob ? URL.createObjectURL(imageBlob) : imagePath ? data.imageUrl(imagePath) : null);
      }
      $('composeError').textContent = '';
      paintCounter();
      paintMotivation();
    },
  });
}

async function submit() {
  if (submitting) return;
  submitting = true;
  $('composeSubmit').disabled = true;
  $('composeError').textContent = '';

  const payload = {
    body: $('composeBody').value.trim(),
    tags: selectedTags(),
    motivation: Number($('composeMotivation').value),
  };

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
      toast(moved ? '保存しました。地図の位置も更新されました。' : '保存しました。');
      navigate('#/me');
      return;
    }

    const result = await runPlacement(payload);
    setOnboardingStep(null);
    state.trialPost = null;
    drafts.delete(draftKey);
    draftKey = '';
    moment('post');
    if (firstPost) await landOnMap(result);
    else showReveal(result);
  } catch (error) {
    $('composeError').textContent = error.message;
    show('compose');
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
      icon_id: state.account?.icon_id, island: result.island,
    };
    setOnboardingStep(null);
    showReveal(result, { trial: true });
  } catch (error) {
    $('composeError').textContent = error.message;
    show('compose');
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

// ---------------------------------------------------------------- reveal

let revealTarget = null;
let revealTrial = false;

function showReveal(result, { trial = false } = {}) {
  revealTarget = result;
  revealTrial = trial;
  const island = result.island;
  $('revealIsland').textContent = island ? island.label : 'まだ名前のない島';
  $('revealIsland').style.color = island ? islandColor(island.cluster_id) : '';
  document.querySelector('#reveal .reveal-title').textContent = trial ? 'お試し：この文なら、ここに立ちます' : 'あなたの島';
  $('revealWrite').hidden = !trial;

  const container = clear($('revealBody'));
  if (trial) {
    container.append(el('p', {
      className: 'trial-note',
      text: `「${result.body}」\nこの文は保存していません。地図では、あなたにだけ見えます。`,
    }));
  }
  if (!result.neighbors || !result.neighbors.length) {
    container.append(el('p', {
      className: 'empty-note',
      text: 'まだあなただけです。URLを送ると相手も地図に出ます。',
    }));
  } else {
    container.append(el('div', { className: 'section-label', text: 'あなたに近い人' }));
    result.neighbors.forEach((person, position) => {
      const card = postRow(person, {
        trailing: el('span', { className: 'list-row-score num' },
          el('b', { text: String(person.similarity ?? '—') }),
          el('small', { text: '%' })),
        onClick: () => openOnMap(person.id),
      });
      card.style.animationDelay = `${position * 150}ms`;
      card.classList.add('appear');
      container.append(card);

      if (person.shared && person.shared.length) {
        container.append(el('div', { className: 'chips indent' },
          person.shared.map((word) => el('span', { className: 'chip', text: word }))));
      }
    });
  }
  show('reveal');
}

export function setupReveal() {
  $('revealToMap').addEventListener('click', () => {
    if (revealTrial) showTrial();
    else if (revealTarget) landOnMap(revealTarget);
    else navigate('#/map');
  });
  $('revealWrite').addEventListener('click', () => navigate('#/post'));
  screen('reveal', {});
  screen('computing', {});
}
