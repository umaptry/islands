// 会を作る：投稿画面の「申し込みのある会にする」を選んだあとに重なる2ステップ（2026-11-01 第2回a。画像 5 の A・B）。
//   ① 会の中身（名前・開始・終了・場所・だれが申し込める？）  ② 申し込む人への質問（今・過去・これから）
// 終わると、入力を compose.js に返す（Promise）。投稿は compose.js が送る。やめるときは null。
// 判断は event-host-rules.js。

import { QUESTION_CHOICES, validateEventDraft } from '../event-host-rules.js';
import { config } from '../config.js';
import { $, clear, el } from '../ui.js';
import { show } from '../router.js';

let session = null;       // { resolve, capacity, isAdmin, step, visibility, questions:Set }

const QUESTION_NUMBER = Object.freeze({ now: 1, past: 2, future: 3 });

function paintStep() {
  const { step } = session;
  $('eventComposeStep1').hidden = step !== 1;
  $('eventComposeStep2').hidden = step !== 2;
  $('eventComposeProgress').setAttribute('aria-valuenow', String(step));
  $('eventComposeNext').textContent = step === 1 ? '次へ' : '会を作る';
  $('eventComposeTitle').textContent = step === 1 ? '会の中身' : '申し込む人への質問';
  $('eventComposeScroller').scrollTop = 0;
  $('eventComposeError').textContent = '';
}

function paintVisibility() {
  const pub = session.visibility === 'public';
  $('eventComposePublic').classList.toggle('on', pub);
  $('eventComposePublic').setAttribute('aria-checked', String(pub));
  $('eventComposeCommunity').classList.toggle('on', !pub);
  $('eventComposeCommunity').setAttribute('aria-checked', String(!pub));
  $('eventComposePublic').disabled = !session.isAdmin;
  $('eventComposePublic').querySelector('small').hidden = session.isAdmin;
}

function paintQuestions() {
  const list = clear($('eventComposeQuestions'));
  QUESTION_CHOICES.forEach((item) => {
    const on = session.questions.has(item.prompt);
    list.append(el('li', {},
      el('button', {
        className: `ev-question${on ? ' on' : ''}`, attrs: { type: 'button', 'aria-pressed': String(on), 'data-prompt': item.prompt },
        on: {
          click: () => {
            if (session.questions.has(item.prompt)) session.questions.delete(item.prompt);
            else session.questions.add(item.prompt);
            paintQuestions();
          },
        },
      },
        el('i', { className: 'ev-question-no', text: QUESTION_NUMBER[item.prompt] }),
        el('span', { className: 'ev-question-text' },
          el('b', { text: item.label }), el('small', { text: item.hint })),
        el('span', { className: 'ev-question-x', attrs: { 'aria-hidden': 'true' }, text: on ? '×' : '＋' }))));
  });
  const need = Number(config().limits?.event_answers_min) || 2;
  $('eventComposeQLede').textContent = session.visibility === 'public'
    ? `公開の会は、質問を${need}つ以上入れてください。申し込む人は${need}つ以上答えます。`
    : 'メンバーは質問なしで申し込めます。ここで選ぶ質問は、あとで公開にしたときに使います。';
}

function finish(value) {
  if (!session) return;
  const { resolve } = session;
  session = null;
  resolve(value);
}

function next() {
  if (!session) return;
  const raw = {
    title: $('eventComposeName').value, place: $('eventComposePlace').value,
    start: $('eventComposeStart').value, end: $('eventComposeEnd').value,
    visibility: session.visibility, questions: [...session.questions],
  };
  const check = validateEventDraft(raw, { cfg: config(), isAdmin: session.isAdmin, capacity: session.capacity });
  if (session.step === 1) {
    // ① で検めるのは ① の項目だけ。質問は ② で。
    if (!check.ok && check.field !== 'questions') {
      $('eventComposeError').textContent = check.message;
      return;
    }
    session.step = 2;
    paintStep();
    paintQuestions();
    return;
  }
  if (!check.ok) {
    $('eventComposeError').textContent = check.message;
    if (check.field !== 'questions') { session.step = 1; paintStep(); $('eventComposeError').textContent = check.message; }
    return;
  }
  finish(check.event);
}

function back() {
  if (!session) return;
  if (session.step === 2) { session.step = 1; paintStep(); return; }
  finish(null);
}

/**
 * 会の中身を聞く。{ capacity, isAdmin } を渡すと、入力が済んだら { title, place, starts_at, ends_at, visibility, questions }、
 * やめたら null で返る。画面は投稿画面の上（show('eventCompose')）に出る。
 */
export function askEventDraft({ capacity, isAdmin }) {
  if (session) finish(null);
  return new Promise((resolve) => {
    session = { resolve, capacity, isAdmin: Boolean(isAdmin), step: 1, visibility: 'community', questions: new Set(['now', 'past', 'future']) };
    $('eventComposeCapacity').textContent = capacity ? `先着 ${capacity}人（前の画面で決めた人数です）` : '';
    paintVisibility();
    paintStep();
    show('eventCompose');
  });
}

export function setupEventCompose() {
  $('eventComposeBack').addEventListener('click', back);
  $('eventComposeNext').addEventListener('click', next);
  $('eventComposePublic').addEventListener('click', () => {
    if (!session || !session.isAdmin) return;
    session.visibility = 'public';
    paintVisibility();
  });
  $('eventComposeCommunity').addEventListener('click', () => {
    if (!session) return;
    session.visibility = 'community';
    paintVisibility();
  });
}
