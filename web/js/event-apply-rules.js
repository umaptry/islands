// The rules of the application steps for a 会 (画面イメージ 16回目の2・20回目の3), kept free of the page so they can
// be tested in node (tests/frontend/event-apply-rules.test.mjs). No imports on purpose.
//
// Steps: あなたについて (name, age, 所属, 職種: only for somebody whose name nobody has confirmed) -> きっかけ
// (only for somebody who is not a member of the community) -> the questions (only for somebody who is not a
// member; at most three: now / past / future; two answers are enough) -> done. A member of the community applies
// with one tap and no questions. The agreement to the new terms is asked at the last step (E 19).

export const NAME_MAX = 24;
export const AFFILIATION_MAX = 32;
export const JOB_MAX = 32;
export const ANSWER_MAX = 140;   // as /api/config limits.event_answer_max and a post (2026-11-07: was 60)
export const ANSWERS_MIN = 2;
export const TERMS_PATH = '/terms/next';
export const PRIVACY_PATH = '/privacy/next';

export const APPLY_WORDS = Object.freeze({
  aboutTitle: 'あなたについて',
  nameLabel: 'フルネーム',
  nameNote: 'プロフィールに出ます（ほかの参加者にも見えます）',
  ageLabel: '年代',
  affiliationLabel: '会社・所属',
  affiliationPlaceholder: '例：コクヨ株式会社',
  affiliationNote: '正式な会社名で（会場の入館登録に使います）',
  jobLabel: '職種',
  jobPlaceholder: '例：エンジニア、店舗スタッフ',
  referralTitle: 'このイベントを知ったきっかけ',
  referralNote: '主催者と管理者だけに見えます',
  questionLead: '仕事でも趣味でもOK',
  questionOne: 'ひとつに絞って書いてください',
  early: '2問答えたので、ここで申し込めます',
  applyHere: 'ここまでで申し込む',
  fixAnswer: '上の答えを直すと進めます',
  next: '次へ',
  submit: '申し込む',
  memberTitle: 'この会に申し込みますか？',
  memberNote: '質問はありません。1週間前と当日に LINE でお知らせが届きます。',
  fullnameLead: '会場でお互いに誰か分かるように、フルネームを教えてください。',
});

/** 質問の下の説明。主催者の補足が「仕事でも趣味でも」なら、同じことを2回書かない（2026-11-06）。 */
export function questionLede(hint) {
  const lead = `${APPLY_WORDS.questionLead}、${APPLY_WORDS.questionOne}`;
  const extra = String(hint || '').trim();
  return extra && !APPLY_WORDS.questionLead.startsWith(extra) ? `${lead}（${extra}）` : lead;
}

/** 申し込みリンクのシェアの中身（公開ページ /e/<code>）。 */
export function eventShareData(info, code, origin) {
  const title = String((info && info.title) || '').trim();
  return { title, text: title ? `${title} の申し込みページ` : '会の申し込みページ', url: `${origin}/e/${code}` };
}

export const QUESTION_EXAMPLES = Object.freeze({
  now: '例：社内で新規事業の企画をしている',
  past: '例：学生時代はバスケ部だった',
  future: '例：陶芸の体験に行ってみたい',
});

/** How many answers are needed: two, or all of them when the 会 asks fewer. */
export function answersNeeded(questionCount, min = ANSWERS_MIN) {
  const count = Math.max(0, Number(questionCount) || 0);
  return Math.min(min, count);
}

/**
 * The steps to show, in order: 'profile' | 'referral' | `q:<prompt>`.
 *   nameConfirmed  somebody has confirmed this person's name and 所属 (accounts.name_confirmed_at)
 *   isMember       they are a member of the community of the 会 (one tap, no questions)
 *   questions      event.questions [{ prompt, label, hint }]
 * A member whose name is not confirmed yet is still asked for it (the server asks too).
 */
export function applySteps({ nameConfirmed = false, isMember = false, questions = [] } = {}) {
  const steps = [];
  if (!nameConfirmed) steps.push('profile');
  if (!isMember) {
    steps.push('referral');
    for (const item of Array.isArray(questions) ? questions : []) {
      if (item && ['now', 'past', 'future'].includes(item.prompt)) steps.push(`q:${item.prompt}`);
    }
  }
  return steps;
}

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const length = (text) => Array.from(text).length;

/**
 * { ok, profile, message } for the step あなたについて. `needGuest` is true for somebody who is not a member
 * (年代 is asked of them only; 職種 is optional).
 */
export function validateProfile(raw, { needGuest = true, ageKeys = null, nameMax = NAME_MAX } = {}) {
  const profile = {
    display_name: clean(raw && raw.name),
    affiliation: clean(raw && raw.affiliation),
  };
  const fail = (message) => ({ ok: false, profile, message });
  if (!profile.display_name) return fail('フルネームを入力してください。');
  if (length(profile.display_name) > nameMax) return fail(`フルネームは${nameMax}字までです。`);
  if (!profile.affiliation) return fail('会社・所属を入力してください。');
  if (length(profile.affiliation) > AFFILIATION_MAX) return fail(`会社・所属は${AFFILIATION_MAX}字までです。`);
  const age = String((raw && raw.age) || '');
  if (needGuest) {
    if (!age) return fail('年代を選んでください。');
    if (ageKeys && !ageKeys.includes(age)) return fail('年代が正しくありません。');
    profile.age_band = age;
  } else if (age && (!ageKeys || ageKeys.includes(age))) {
    profile.age_band = age;
  }
  const job = clean(raw && raw.job);
  if (length(job) > JOB_MAX) return fail(`職種は${JOB_MAX}字までです。`);
  if (job) profile.job_title = job;
  return { ok: true, profile, message: '' };
}

/** What was typed in a question -> { ok, body, message }. Empty is fine (the question was passed). */
export function cleanAnswer(text, max = ANSWER_MAX) {
  const body = clean(text);
  if (length(body) > max) return { ok: false, body, message: `答えは${max}字までです。` };
  return { ok: true, body, message: '' };
}

/** The answers that were written, in the order of the questions: [{ prompt, body }]. */
export function collectAnswers(questions, typed) {
  const out = [];
  for (const item of Array.isArray(questions) ? questions : []) {
    const body = clean(typed && typed[item.prompt]);
    if (body) out.push({ prompt: item.prompt, body });
  }
  return out;
}

/** Can the person apply with what has been answered so far? */
export function canSubmit(questions, typed, isMember) {
  if (isMember) return true;
  return collectAnswers(questions, typed).length >= answersNeeded((questions || []).length);
}

/** The body of POST /api/events/<code>/apply. Fields that are not needed are left out. */
export function applyBody({ profile = null, referral = '', answers = [] } = {}) {
  const body = { agree_terms: true };
  if (profile) body.profile = profile;
  if (referral) body.referral = referral;
  if (answers.length) body.answers = answers;
  return body;
}

/** A refusal of the apply call -> the sentence for the page and whether the person may try again. */
export function applyRefusalText(error) {
  const message = (error && error.message) || '申し込めませんでした。もう一度お試しください。';
  const status = error && error.status;
  return { message, final: status === 403 || status === 409 };
}

/** The age choices from /api/config age_bands, only the ones the picture shows (10代〜60代以上). */
export function ageChoices(bands) {
  const list = Array.isArray(bands) ? bands : [];
  return list.map((band) => ({ key: band.key, label: band.key === '60s' ? '60代以上' : band.label }));
}

/** Where a person goes in the steps: which step comes next / before. Index is clamped. */
export function stepAfter(steps, current) {
  const index = steps.indexOf(current);
  return index >= 0 && index + 1 < steps.length ? steps[index + 1] : null;
}

export function stepBefore(steps, current) {
  const index = steps.indexOf(current);
  return index > 0 ? steps[index - 1] : null;
}
