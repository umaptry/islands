// Writing a post, and what happens straight after.
//
// islands' 投稿画面, with its four tag checkboxes and its エンジョイ↔ガチ slider,
// plus the two things that only exist because the coordinates mean something:
// the "this is being placed" animation, and the reveal that tells you which
// island you landed on and who is nearest.
//
// The image is downscaled and re-encoded in the browser before it is uploaded
// (see image.js). A 4MB phone photo would be the single biggest thing this app
// ever moves, and nobody looking at a card in a bottom sheet needs 4032 pixels.

import { config, islandColor } from '../config.js';
import { POST_IMAGE, prepareImage } from '../image.js';
import { api, data } from '../net.js';
import { navigate, screen, show } from '../router.js';
import { state, upsertPost } from '../state.js';
import { $, $$, clear, el, motivationColor, toast } from '../ui.js';
import { postRow } from '../components/postcard.js';

let editing = null;       // the post being edited, or null for a new one
let imagePath = null;     // the uploaded storage path
let imageBlob = null;     // chosen but not yet uploaded
let submitting = false;

// ---------------------------------------------------------------- image

function paintImage(url) {
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
  const ratio = Math.min(1, length / min);
  const ring = $('composeCounter').querySelector('.value');
  ring.style.strokeDashoffset = String(56.5 * (1 - ratio));
  $('composeCounter').classList.toggle('done', length >= min);
  $('composeCounter').classList.toggle('over', length > max);
  $('composeCounterText').textContent = `${length}/${max}`;
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
    });
    box.append(node);
  });
}

export function setupCompose() {
  const body = $('composeBody');
  body.addEventListener('input', paintCounter);
  $('composeMotivation').addEventListener('input', paintMotivation);

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
    enter: (params, query) => {
      const first = query && query.get('first') === '1';
      editing = null;
      imageBlob = null;
      imagePath = null;
      submitting = false;

      if (params && params.id) {
        editing = state.myPosts.find((post) => post.id === params.id)
          || state.postsById.get(params.id) || null;
      }

      $('composeTitle').textContent = editing ? '投稿を編集' : '新規投稿';
      $('composeSubmit').textContent = editing ? '保存' : '投稿する';
      $('composeMoveNotice').hidden = !editing;
      $('composeLede').textContent = first
        ? 'ためしに1つ、書いてみましょう。あなたの投稿に合わせて投稿される島の位置が決まります。'
        : '取り組みや関心を書いてください。あなたの投稿に合わせて投稿される島の位置が決まります。';

      body.value = editing ? editing.body : '';
      $('composeMotivation').value = editing
        ? editing.motivation
        : config().limits.motivation_default;
      paintTags(editing ? (editing.tags || []) : []);
      imagePath = editing ? (editing.image_path || null) : null;
      paintImage(imagePath ? data.imageUrl(imagePath) : null);
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
      toast(moved ? '保存しました。地図の位置も更新されました。' : '保存しました。');
      navigate('#/me');
      return;
    }

    const result = await runPlacement(payload);
    showReveal(result);
  } catch (error) {
    $('composeError').textContent = error.message;
    show('compose');
  } finally {
    submitting = false;
    $('composeSubmit').textContent = editing ? '保存' : '投稿する';
    paintCounter();
  }
}

/** The placing animation, and the request it is covering. */
async function runPlacement(payload) {
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
    const result = await api.post('/api/posts', payload);
    // Let the animation finish, so the reveal never flashes past. The wait is
    // capped by how long the request actually took, not added to it.
    const elapsed = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1800 - elapsed)));
    steps.forEach((step) => { step.classList.remove('on'); step.classList.add('done'); });
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

function showReveal(result) {
  revealTarget = result;
  const island = result.island;
  $('revealIsland').textContent = island ? island.label : 'まだ名前のない島';
  $('revealIsland').style.color = island ? islandColor(island.cluster_id) : '';

  const container = clear($('revealBody'));
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
        onClick: () => {
          navigate('#/map');
          setTimeout(() => document.dispatchEvent(
            new CustomEvent('map:open', { detail: { postId: person.id } })), 60);
        },
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
    navigate('#/map');
    if (revealTarget) {
      const target = revealTarget;
      setTimeout(() => document.dispatchEvent(
        new CustomEvent('map:focus', { detail: { postId: target.id } })), 60);
    }
  });
  screen('reveal', {});
  screen('computing', {});
}
