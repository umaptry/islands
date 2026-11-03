// 会を作る：投稿画面の「申し込みのある会にする」を選んだあとに重なる3ステップ（第2回a の画像 5 の A・B、第2回b で②を足した）。
//   ① 会の中身（名前・開始・終了・場所・だれが申し込める？）  ② 開催の条件（最小人数・判定日・キャンセル期限・会のあとの入り方）
//   ③ 申し込む人への質問（今・過去・これから）
// 終わると、入力を compose.js に返す（Promise）。投稿は compose.js が送る。やめるときは null。
// 判断は event-host-rules.js。

import {
  GO_WORDS, JOIN_CHOICES, JOIN_DEFAULT, QUESTION_CHOICES, decideRange, stepOfField, validateEventDraft,
} from '../event-host-rules.js';
import { config } from '../config.js';
import { $, clear, el } from '../ui.js';
import { show } from '../router.js';

let session = null;       // { resolve, capacity, isAdmin, step, visibility, join, questions:Set }

const QUESTION_NUMBER = Object.freeze({ now: 1, past: 2, future: 3 });

const STEP_TITLE = Object.freeze({ 1: '会の中身', 2: '開催の条件', 3: '申し込む人への質問' });

function paintStep() {
  const { step } = session;
  $('eventComposeStep1').hidden = step !== 1;
  $('eventComposeStep2').hidden = step !== 2;
  $('eventComposeStep3').hidden = step !== 3;
  $('eventComposeProgress').setAttribute('aria-valuenow', String(step));
  $('eventComposeNext').textContent = step === 3 ? '会を作る' : '次へ';
  $('eventComposeTitle').textContent = STEP_TITLE[step];
  $('eventComposeScroller').scrollTop = 0;
  $('eventComposeError').textContent = '';
}

/** 最小人数を入れたときだけ判定日を出す。選べる日は今日から開始日の前の日まで。 */
function paintGoal() {
  const withMin = $('eventComposeMin').value.trim() !== '';
  $('eventComposeDecideField').hidden = !withMin;
  const range = decideRange($('eventComposeStart').value);
  const decide = $('eventComposeDecide');
  decide.min = range.min;
  if (range.max) decide.max = range.max; else decide.removeAttribute('max');
  $('eventComposeDecideHint').textContent = range.max
    ? `${GO_WORDS.decideNote}会の開始日より前の日を選んでください。` : GO_WORDS.decideNote;
  const cancel = $('eventComposeCancel');
  if ($('eventComposeStart').value) cancel.max = $('eventComposeStart').value; else cancel.removeAttribute('max');
}

function paintJoin() {
  const list = clear($('eventComposeJoin'));
  JOIN_CHOICES.forEach((item) => {
    const on = session.join === item.value;
    list.append(el('button', {
      className: `ev-choice${on ? ' on' : ''}`, attrs: { type: 'button', role: 'radio', 'aria-checked': String(on), 'data-join': item.value },
      on: { click: () => { session.join = item.value; paintJoin(); } },
    }, el('b', { text: item.label }), el('span', { text: item.note })));
  });
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
    min: $('eventComposeMin').value, decide: $('eventComposeDecide').value,
    cancel: $('eventComposeCancel').value, join: session.join,
  };
  const check = validateEventDraft(raw, { cfg: config(), isAdmin: session.isAdmin, capacity: session.capacity });
  // 検めは項目の順（①→②→③）に最初の失敗を返す。今のステップより後ろの項目の失敗は、まだ見ない。
  const failedAt = check.ok ? 4 : stepOfField(check.field);
  if (failedAt <= session.step) {
    const message = check.message;
    if (failedAt < session.step) { session.step = failedAt; paintStep(); }
    $('eventComposeError').textContent = message;
    return;
  }
  if (session.step < 3) {
    session.step += 1;
    paintStep();
    if (session.step === 2) paintGoal();
    if (session.step === 3) paintQuestions();
    return;
  }
  finish(check.event);
}

function back() {
  if (!session) return;
  if (session.step > 1) { session.step -= 1; paintStep(); return; }
  finish(null);
}

/**
 * 会の中身を聞く。{ capacity, isAdmin } を渡すと、入力が済んだら
 * { title, place, starts_at, ends_at, visibility, questions, join_policy, （あれば）min_participants・decide_on・cancel_deadline }、
 * やめたら null で返る。画面は投稿画面の上（show('eventCompose')）に出る。
 */
export function askEventDraft({ capacity, isAdmin }) {
  if (session) finish(null);
  return new Promise((resolve) => {
    session = {
      resolve, capacity, isAdmin: Boolean(isAdmin), step: 1, visibility: 'community', join: JOIN_DEFAULT,
      questions: new Set(['now', 'past', 'future']),
    };
    for (const id of ['eventComposeMin', 'eventComposeDecide', 'eventComposeCancel']) $(id).value = '';
    paintJoin();
    $('eventComposeCapacity').textContent = capacity ? `先着 ${capacity}人（前の画面で決めた人数です）` : '';
    paintVisibility();
    paintStep();
    show('eventCompose');
  });
}

export function setupEventCompose() {
  $('eventComposeBack').addEventListener('click', back);
  $('eventComposeMin').addEventListener('input', paintGoal);
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
