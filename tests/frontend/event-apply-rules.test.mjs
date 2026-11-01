import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/event-apply-rules.js', import.meta.url), 'utf8');
const rules = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const questions = [
  { prompt: 'now', label: '今やってること', hint: '' },
  { prompt: 'past', label: '昔やってたこと', hint: '' },
  { prompt: 'future', label: 'やってみたいこと', hint: '' },
];
const AGES = ['10s', '20s', '30s', '40s', '50s', '60s'];

test('ステップ：ゲストは あなたについて → きっかけ → 質問3つ', () => {
  assert.deepEqual(rules.applySteps({ nameConfirmed: false, isMember: false, questions }),
    ['profile', 'referral', 'q:now', 'q:past', 'q:future']);
});

test('ステップ：名前が確かめ済みなら、あなたについては出ない', () => {
  assert.deepEqual(rules.applySteps({ nameConfirmed: true, isMember: false, questions }), ['referral', 'q:now', 'q:past', 'q:future']);
});

test('ステップ：メンバーは1タップ（質問なし・きっかけなし）。名前が未確認ならそれだけ聞く', () => {
  assert.deepEqual(rules.applySteps({ nameConfirmed: true, isMember: true, questions }), []);
  assert.deepEqual(rules.applySteps({ nameConfirmed: false, isMember: true, questions }), ['profile']);
});

test('ステップ：4問目（当日話したいこと）は出ない。質問がない会はきっかけまで', () => {
  const four = [...questions, { prompt: 'talk', label: '当日話したいこと' }, { prompt: 'help', label: '困ってること' }];
  assert.deepEqual(rules.applySteps({ isMember: false, nameConfirmed: true, questions: four }), ['referral', 'q:now', 'q:past', 'q:future']);
  assert.deepEqual(rules.applySteps({ isMember: false, nameConfirmed: true, questions: [] }), ['referral']);
});

test('答える数：2つ。質問が2つ未満の会は、その数', () => {
  assert.equal(rules.answersNeeded(3), 2);
  assert.equal(rules.answersNeeded(2), 2);
  assert.equal(rules.answersNeeded(1), 1);
  assert.equal(rules.answersNeeded(0), 0);
});

test('2つ以上答えれば申し込める（メンバーは何もいらない）', () => {
  assert.equal(rules.canSubmit(questions, {}, false), false);
  assert.equal(rules.canSubmit(questions, { now: 'a' }, false), false);
  assert.equal(rules.canSubmit(questions, { now: 'a', future: 'b' }, false), true);
  assert.equal(rules.canSubmit(questions, { now: 'a', past: '   ' }, false), false);
  assert.equal(rules.canSubmit(questions, {}, true), true);
  assert.equal(rules.canSubmit([questions[0]], { now: 'a' }, false), true);
});

test('答えを集める：書いたものだけ、質問の順に', () => {
  assert.deepEqual(rules.collectAnswers(questions, { future: ' b ', now: 'a', past: '' }),
    [{ prompt: 'now', body: 'a' }, { prompt: 'future', body: 'b' }]);
});

test('答えは60字まで（数えるのは文字）', () => {
  assert.equal(rules.cleanAnswer('あ'.repeat(60)).ok, true);
  assert.equal(rules.cleanAnswer('あ'.repeat(61)).ok, false);
  assert.equal(rules.cleanAnswer('😀'.repeat(60)).ok, true);
  assert.equal(rules.cleanAnswer('  ').body, '');
});

test('プロフィール：フルネーム24字・所属・年代（ゲストは必須）・職種（任意）', () => {
  const ok = rules.validateProfile({ name: ' 山田  花子 ', affiliation: 'コクヨ株式会社', age: '30s', job: 'デザイナー' }, { ageKeys: AGES });
  assert.deepEqual(ok, { ok: true, profile: { display_name: '山田 花子', affiliation: 'コクヨ株式会社', age_band: '30s', job_title: 'デザイナー' }, message: '' });
  assert.equal(rules.validateProfile({ name: '', affiliation: 'a', age: '30s' }, { ageKeys: AGES }).message, 'フルネームを入力してください。');
  assert.equal(rules.validateProfile({ name: 'a', affiliation: '', age: '30s' }, { ageKeys: AGES }).message, '会社・所属を入力してください。');
  assert.equal(rules.validateProfile({ name: 'a', affiliation: 'b', age: '' }, { ageKeys: AGES }).message, '年代を選んでください。');
  assert.equal(rules.validateProfile({ name: 'a', affiliation: 'b', age: '99s' }, { ageKeys: AGES }).ok, false);
  assert.equal(rules.validateProfile({ name: 'あ'.repeat(25), affiliation: 'b', age: '30s' }, { ageKeys: AGES }).message, 'フルネームは24字までです。');
  assert.equal(rules.validateProfile({ name: 'あ'.repeat(24), affiliation: 'b', age: '30s' }, { ageKeys: AGES }).ok, true);
  assert.equal(rules.validateProfile({ name: 'a', affiliation: 'あ'.repeat(33), age: '30s' }, { ageKeys: AGES }).ok, false);
  assert.equal(rules.validateProfile({ name: 'a', affiliation: 'b', age: '30s', job: 'あ'.repeat(33) }, { ageKeys: AGES }).ok, false);
  // 職種は空でよく、profile にも入らない
  assert.equal('job_title' in rules.validateProfile({ name: 'a', affiliation: 'b', age: '30s' }, { ageKeys: AGES }).profile, false);
});

test('プロフィール：メンバー（年代は聞かない）は年代なしでよい', () => {
  const check = rules.validateProfile({ name: 'みずき', affiliation: 'コクヨ' }, { needGuest: false });
  assert.equal(check.ok, true);
  assert.equal('age_band' in check.profile, false);
});

test('申し込みの本文：同意は必ず付け、要らないものは入れない', () => {
  assert.deepEqual(rules.applyBody({}), { agree_terms: true });
  assert.deepEqual(rules.applyBody({
    profile: { display_name: 'a', affiliation: 'b' }, referral: 'SNSで見た', answers: [{ prompt: 'now', body: 'x' }],
  }), { agree_terms: true, profile: { display_name: 'a', affiliation: 'b' }, referral: 'SNSで見た', answers: [{ prompt: 'now', body: 'x' }] });
});

test('同意の文のリンクは新しい規約とポリシー', () => {
  assert.equal(rules.TERMS_PATH, '/terms/next');
  assert.equal(rules.PRIVACY_PATH, '/privacy/next');
});

test('年代の選び肢：60代は「60代以上」と出す', () => {
  const labels = rules.ageChoices([{ key: '50s', label: '50代' }, { key: '60s', label: '60代' }]);
  assert.deepEqual(labels, [{ key: '50s', label: '50代' }, { key: '60s', label: '60代以上' }]);
  assert.deepEqual(rules.ageChoices(undefined), []);
});

test('断られたときの文：サーバーの日本語をそのまま、やり直せないものは final', () => {
  assert.deepEqual(rules.applyRefusalText({ message: 'このコミュニティの会には申し込めません。', status: 403 }),
    { message: 'このコミュニティの会には申し込めません。', final: true });
  assert.equal(rules.applyRefusalText({ message: '質問は2つ以上答えてください。', status: 422 }).final, false);
});

test('ステップの前後', () => {
  const steps = ['profile', 'referral', 'q:now'];
  assert.equal(rules.stepAfter(steps, 'profile'), 'referral');
  assert.equal(rules.stepAfter(steps, 'q:now'), null);
  assert.equal(rules.stepBefore(steps, 'profile'), null);
  assert.equal(rules.stepBefore(steps, 'q:now'), 'referral');
  assert.equal(rules.stepAfter(steps, 'nope'), null);
});

test('画面の文に「島」を使わない', () => {
  assert.equal(Object.values(rules.APPLY_WORDS).join('').includes('島'), false);
  assert.equal(Object.values(rules.QUESTION_EXAMPLES).join('').includes('島'), false);
});

test('きっかけの説明は、主催者と管理者だけに見えると言う（規約の約束）', () => {
  assert.equal(rules.APPLY_WORDS.referralNote, '主催者と管理者だけに見えます');
});
