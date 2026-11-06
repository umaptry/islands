// 会（イベント申し込み）の公開側：ログインなしの申し込みページ → 申し込み（ステップ）→ ゲスト用ページ → 遅れる → 取り消し、
// 中止・お断りの表示。手元モードのサーバーにつなぐ。会を作る部分は API を直接呼ぶ（主催者の画面は別の担当）。
// 写真：EV_PHOTOS にフォルダを入れると、幅 390px のときだけ主な状態を保存する。
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// 押せないボタンを待ち続けて、テスト全体が止まらないように
test.use({ actionTimeout: 15000 });

const unique = () => Math.random().toString(36).slice(2, 10);
const PHOTOS = process.env.EV_PHOTOS || '';
// 写真の番号は、ここに並べた順（テストごとに作り直される変数では、番号が重なるため）
const PHOTO_ORDER = [
  '申し込みページ_ログインなし', '近い人が来るか見てみる', 'ステップ_あなたについて', 'ステップ_きっかけ', 'ステップ_質問1',
  'ステップ_質問2_ここまでで申し込む', 'ステップ_質問3_同意', '完了_友だち追加', 'ゲスト用ページ_友だちでない', 'ゲスト用ページ_遅れる',
  'ゲスト用ページ_取り消した', 'ゲスト用ページ_中止', '申し込みページ_中止', 'ゲスト用ページ_お断り', 'メンバーの1タップ_確認',
];

async function shot(page, testInfo, name) {
  if (!PHOTOS || testInfo.project.name !== '390px') return;
  mkdirSync(PHOTOS, { recursive: true });
  const number = PHOTO_ORDER.indexOf(name) + 1;
  await page.screenshot({ path: `${PHOTOS}/${String(number).padStart(2, '0')}_${name}.png` });
}

const noSideScroll = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

const iso = (days, hours = 0) => new Date(Date.now() + days * 86400000 + hours * 3600000).toISOString();

// ふつうのメンバー（API を直接使う側）として入る
async function signedIn(browser, testInfo, name, { path = '/' } = {}) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  await page.goto(path);
  // 起動（設定の読み込み）が終わってから、ログインの部品を呼ぶ
  await page.waitForFunction(() => { const on = document.querySelector('.screen.active'); return on && on.id !== 'booting'; });
  const email = `${name}-${crypto.randomUUID()}@example.com`;
  await page.evaluate(async ({ email, name }) => {
    const { session } = await import('/static/js/session.js');
    const { api } = await import('/static/js/net.js');
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await api.put('/api/account/me', { display_name: name, affiliation: '夜の会社', name_confirmed: true, icon_id: 'photo' });
  }, { email, name });
  return { page, context };
}

// 管理者が、コミュニティと会（質問3つ）を作る。返り値は会の code と投稿の id
async function makeEvent(host, { title = 'The Night Office BAR #2', visibility = 'public', capacity = 20 } = {}) {
  return host.page.evaluate(async ({ title, visibility, capacity, start, end }) => {
    const { api } = await import('/static/js/net.js');
    const community = await api.post('/api/local/communities', { name: '夜のBAR', slug: `t-${Math.random().toString(36).slice(2, 9)}` },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } });
    const made = await api.post('/api/posts', {
      body: '夜の会をひらきます。話してみたい人は来てください。', tags: ['参加者募集中'], motivation: 55, community_id: community.community_id,
      recruit_capacity: capacity,
      event: {
        title, starts_at: start, ends_at: end, place: '渋谷 ○○ビル 3F', visibility, agree_terms: true,
        questions: [
          { prompt: 'now', label: '今やってること', hint: '' },
          { prompt: 'past', label: '昔やってたこと', hint: '' },
          { prompt: 'future', label: 'やってみたいこと', hint: '' },
        ],
      },
    }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
    return { code: made.event.public_code, postId: made.id, communityId: community.community_id };
  }, { title, visibility, capacity, start: iso(10), end: iso(10, 3) });
}

async function guestPage(browser, testInfo) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  return { context, page: await context.newPage() };
}

// メールで入って（申し込みページの画面で）、ステップのはじめまで進む
async function signInByMail(page, email) {
  await page.locator('#eventApplyNow').click();                // 申し込みに進む（または すぐ申し込む）
  await page.locator('#eventMail').click();
  await page.locator('#eventEmail').fill(email);
  await page.locator('#eventEmailNext').click();
  const code = (await page.locator('.dev-code-value').textContent()).trim();
  await page.locator('#eventCode').fill(code);
  await page.locator('#eventCodeNext').click();
}

async function fillProfile(page, { name, age = '30代', affiliation = '○○株式会社', job = 'デザイナー' }) {
  await page.locator('#eventName').fill(name);
  await page.locator('#eventAges').getByRole('button', { name: age, exact: true }).click();
  await page.locator('#eventAffiliation').fill(affiliation);
  await page.locator('#eventJob').fill(job);
  await page.locator('#eventStepNext').click();
}

test('ログインなしで会のページが開く：集計だけで、名前や文は出ない。中身は日本時間', async ({ browser }, testInfo) => {
  const host = await signedIn(browser, testInfo, '主催の坂内');
  const { code } = await makeEvent(host);
  const guest = await guestPage(browser, testInfo);
  const { page } = guest;
  const response = await page.goto(`/e/${code}`);
  expect(response.headers()['x-robots-tag']).toContain('noindex');
  await expect(page.locator('#eventApply')).toHaveClass(/active/);
  // /e/<code> は #/e/<code> に直る（LINE のログインはこの道に戻ってくる）
  await expect.poll(() => page.evaluate(() => location.pathname + location.hash)).toBe(`/#/e/${code}`);
  await expect(page.locator('#eventApplyBody .ev-title')).toHaveText('The Night Office BAR #2');
  await expect(page.locator('#eventApplyBody')).toContainText('会場：渋谷 ○○ビル 3F');
  await expect(page.locator('#eventApplyBody')).toContainText('主催：主催の坂内');
  await expect(page.locator('#eventCount')).toContainText('0');
  await expect(page.locator('#eventCount')).toContainText('参加予定');
  // 会の概要（2026-11-06）：主催者が書いた会の投稿の本文は出す。名前の下・日時の上
  await expect(page.locator('#eventDesc')).toContainText('夜の会をひらきます');
  await expect(page.locator('#bottomNav')).toBeHidden();
  await noSideScroll(page);
  await shot(page, testInfo, '申し込みページ_ログインなし');
  await guest.context.close();
  await host.context.close();
});

test('見つからない会・変なコード：やさしい文', async ({ browser }, testInfo) => {
  const guest = await guestPage(browser, testInfo);
  await guest.page.goto('/e/zzzzzzzzzzzz');
  await expect(guest.page.locator('#eventNotFound')).toHaveText('この会は見つかりません。');
  await guest.page.goto(`/?x=${unique()}#/e/a`);
  await expect(guest.page.locator('#eventApplyBody')).toContainText('この会は見つかりません。');
  await guest.context.close();
});

test('近い人が来るか見てみる：数は出さずにぼかす。入れた興味は「今やってること」の下書きになる', async ({ browser }, testInfo) => {
  const host = await signedIn(browser, testInfo, '主催の坂内');
  const { code } = await makeEvent(host);
  const guest = await guestPage(browser, testInfo);
  const { page } = guest;
  await page.goto(`/e/${code}`);
  await page.locator('#eventProbeOpen').click();
  await expect(page.locator('#eventProbeResult')).toContainText('興味を入れると');
  await page.locator('#eventInterest').fill('キャンプ飯');
  await page.locator('#eventInterest').press('Enter');
  await expect(page.locator('#eventInterests')).toContainText('キャンプ飯');
  await expect(page.locator('#eventProbeResult')).toContainText('いません', { timeout: 20000 });     // まだ誰も申し込んでいない
  await expect(page.locator('#eventProbeResult')).toContainText('名前や顔は出ません');
  await shot(page, testInfo, '近い人が来るか見てみる');
  // 2つめを足せる。3つめは足せない（入力欄が消える）
  await page.locator('#eventInterest').fill('陶芸');
  await page.locator('#eventInterestAdd').click();
  await expect(page.locator('#eventInterests')).toContainText('陶芸');
  await expect(page.locator('#eventInterest')).toHaveCount(0);
  await noSideScroll(page);
  await guest.context.close();
  await host.context.close();
});

test('申し込み（メール）：あなたについて → きっかけ → 質問 → 完了 → ゲスト用ページ → 遅れる → 取り消し → もう一度', async ({ browser }, testInfo) => {
  test.setTimeout(120000);
  const host = await signedIn(browser, testInfo, '主催の坂内');
  const { code } = await makeEvent(host);
  const guest = await guestPage(browser, testInfo);
  const { page } = guest;
  await page.goto(`/e/${code}`);

  // 興味を入れてから進む（下書きに入る）
  await page.locator('#eventProbeOpen').click();
  await page.locator('#eventInterest').fill('キャンプ飯');
  await page.locator('#eventInterest').press('Enter');
  await expect(page.locator('#eventProbeResult')).toContainText('名前や顔は出ません', { timeout: 20000 });
  await signInByMail(page, `guest-${crypto.randomUUID()}@example.com`);

  // 1. あなたについて：年代・所属が空のあいだは次へ進めない
  await expect(page.locator('#eventApplyBody .ev-title')).toHaveText('あなたについて');
  await expect(page.locator('#eventStepNext')).toBeDisabled();
  await expect(page.locator('#eventName')).toHaveAttribute('maxlength', '24');
  await shot(page, testInfo, 'ステップ_あなたについて');
  await noSideScroll(page);
  await fillProfile(page, { name: '山田 花子' });

  // 2. きっかけ：選ぶまで次へ進めない
  await expect(page.locator('#eventApplyBody .ev-title')).toHaveText('このイベントを知ったきっかけ');
  await expect(page.locator('#eventStepNext')).toBeDisabled();
  await expect(page.locator('#eventApplyBody')).toContainText('主催者と管理者だけに見えます');
  await shot(page, testInfo, 'ステップ_きっかけ');
  await page.getByRole('button', { name: 'SNSで見た', exact: true }).click();
  await page.locator('#eventStepNext').click();

  // 3. 質問1：下書きに、さっき入れた興味が入っている。「ここまでで申し込む」はまだ出ない
  await expect(page.locator('#eventApplyBody .ev-title')).toHaveText('今やってること');
  await expect(page.locator('#eventAnswer')).toHaveValue('キャンプ飯');
  await expect(page.locator('#eventApplyEarly')).toBeHidden();
  await shot(page, testInfo, 'ステップ_質問1');
  await page.locator('#eventAnswer').fill('週末は山でキャンプ飯を作っています');
  await page.locator('#eventStepNext').click();

  // 質問2：2つ答えたら「ここまでで申し込む」が出る
  await expect(page.locator('#eventApplyBody .ev-title')).toHaveText('昔やってたこと');
  await expect(page.locator('#eventStepNext')).toBeDisabled();
  await page.locator('#eventAnswer').fill('学生のころはバスケ部でした');
  await expect(page.locator('#eventApplyEarly')).toBeVisible();
  await expect(page.locator('#eventApplyBody .ev-early')).toHaveText('2問答えたので、ここで申し込めます');
  // 同意の文は最後の質問にだけ付く：ここにはまだない
  await expect(page.locator('#eventConsent')).toHaveCount(0);
  await shot(page, testInfo, 'ステップ_質問2_ここまでで申し込む');
  await page.locator('#eventStepNext').click();

  // 質問3（最後）：空のままでも申し込める。ボタンは「申し込む」、同意の文とリンク
  await expect(page.locator('#eventApplyBody .ev-title')).toHaveText('やってみたいこと');
  await expect(page.locator('#eventStepNext')).toHaveText('申し込む');
  await expect(page.locator('#eventStepNext')).toBeEnabled();
  const consent = page.locator('#eventConsent');
  await expect(consent).toContainText('同意したことになります');
  await expect(consent.locator('a').nth(0)).toHaveAttribute('href', '/terms/next');
  await expect(consent.locator('a').nth(1)).toHaveAttribute('href', '/privacy/next');
  await shot(page, testInfo, 'ステップ_質問3_同意');
  await page.locator('#eventStepNext').click();

  // 完了
  await expect(page.locator('#eventDoneTitle')).toHaveText('申し込みました');
  await expect(page.locator('#eventApplyBody')).toContainText('The Night Office BAR #2');
  await expect(page.locator('#eventFriend')).toHaveAttribute('href', 'https://lin.ee/test');
  await shot(page, testInfo, '完了_友だち追加');
  await page.locator('#eventToMe').click();

  // ゲスト用ページ
  await expect(page.locator('#eventMe')).toHaveClass(/active/);
  await expect(page.locator('#eventMeTitle')).toHaveText('The Night Office BAR #2 にようこそ');
  await expect(page.locator('#eventMeStatus')).toContainText('申し込み済み');
  await expect(page.locator('#eventMeFriendBand')).toContainText('LINE でお知らせが届きません');
  await expect(page.locator('#eventMeFriend')).toHaveAttribute('href', 'https://lin.ee/test');
  await expect(page.locator('#eventMePlace')).toHaveAttribute('href', /google\.com\/maps/);
  await expect(page.locator('#eventMe')).toContainText('受付は会場の QR で');
  await noSideScroll(page);
  await shot(page, testInfo, 'ゲスト用ページ_友だちでない');

  // 遅れる：30分を選ぶと、その印が付いて、主催者に伝わる
  await page.locator('#eventMeLate [data-minutes="30"]').click();
  await expect(page.locator('#eventMeLate [data-minutes="30"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#eventMeLateNote')).toContainText('30分くらい遅れる');
  await shot(page, testInfo, 'ゲスト用ページ_遅れる');
  const roster = await host.page.evaluate(async (code) => {
    const { api } = await import('/static/js/net.js');
    return api.get(`/api/events/${code}/roster`);
  }, code);
  const row = roster.people.find((person) => person.display_name === '山田 花子');
  expect(row.late_minutes).toBe(30);
  expect(row.status).toBe('applied');

  // 友だち追加（LINE の follow を手元で真似る）→ 帯が消える
  await page.evaluate(async () => {
    const { api } = await import('/static/js/net.js');
    await api.post('/api/local/line/follow', { line_user_id: `U${Math.random().toString(16).slice(2)}` });
  });
  await page.reload();
  await expect(page.locator('#eventMeStatus')).toContainText('申し込み済み');
  await expect(page.locator('#eventMeFriendBand')).toHaveCount(0);

  // 取り消し：確認を出して、取り消すと状態が変わる。遅れる・取り消すのボタンは消える
  await page.locator('#eventMeCancel').click();
  await expect(page.locator('.modal')).toContainText('申し込みを取り消しますか？');
  await page.locator('.modal').getByRole('button', { name: '取り消す', exact: true }).click();
  await expect(page.locator('#eventMeStatus')).toContainText('申し込みを取り消しました');
  await expect(page.locator('#eventMeLate')).toHaveCount(0);
  await expect(page.locator('#eventMeCancel')).toHaveCount(0);
  await shot(page, testInfo, 'ゲスト用ページ_取り消した');

  // もう一度申し込める（名前の確認は済んでいるので、きっかけと質問から）
  await page.locator('#eventMeReapply').click();
  await expect(page.locator('#eventApply')).toHaveClass(/active/);
  await page.locator('#eventApplyNow').click();
  await expect(page.locator('#eventApplyBody .ev-title')).toHaveText('このイベントを知ったきっかけ');
  await expect(page.locator('#eventApplyBody .ev-progress span')).toHaveCount(5 - 1);      // あなたについては出ない
  await guest.context.close();
  await host.context.close();
});

test('申し込み済みの人が /e/<code> を開き直すと、自分のページへ。マップなど他の画面へは行けない', async ({ browser }, testInfo) => {
  test.setTimeout(90000);
  const host = await signedIn(browser, testInfo, '主催の坂内');
  const { code } = await makeEvent(host);
  const person = await signedIn(browser, testInfo, 'ゲスト花子', { path: `/e/${code}` });
  const { page } = person;
  // API で申し込む（ゲスト：メンバーではない）
  await page.evaluate(async (code) => {
    const { api } = await import('/static/js/net.js');
    await api.post(`/api/events/${code}/apply`, {
      agree_terms: true, referral: 'SNSで見た',
      profile: { display_name: 'ゲスト 花子', affiliation: '○○株式会社', age_band: '30s', job_title: 'デザイナー' },
      answers: [{ prompt: 'now', body: '陶芸教室に通っています' }, { prompt: 'future', body: '朝のランニングを始めたい' }],
    });
  }, code);
  await page.goto(`/e/${code}`);
  await expect(page.locator('#eventMe')).toHaveClass(/active/, { timeout: 15000 });
  await expect(page.locator('#eventMeStatus')).toContainText('申し込み済み');
  // 会に入っていないゲストは、マップに出ず自分のページに戻される
  await page.evaluate(() => { location.hash = '#/map'; });
  await expect(page.locator('#eventMe')).toHaveClass(/active/);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/e/${code}/me`);
  await person.context.close();
  await host.context.close();
});

test('中止：ゲスト用ページは赤い帯、近い人を出さず、「またお知らせします」と書かない。ログインなしの申し込みページはボタンなし', async ({ browser }, testInfo) => {
  test.setTimeout(90000);
  const host = await signedIn(browser, testInfo, '主催の坂内');
  const { code, postId } = await makeEvent(host);
  const person = await signedIn(browser, testInfo, 'ゲスト花子', { path: `/e/${code}` });
  await person.page.evaluate(async (code) => {
    const { api } = await import('/static/js/net.js');
    await api.post(`/api/events/${code}/apply`, {
      agree_terms: true, referral: 'SNSで見た',
      profile: { display_name: 'ゲスト 花子', affiliation: '○○株式会社', age_band: '30s' },
      answers: [{ prompt: 'now', body: '陶芸教室に通っています' }, { prompt: 'future', body: '朝のランニングを始めたい' }],
    });
  }, code);
  // 主催者が会の投稿を消す＝中止
  await host.page.evaluate(async (postId) => {
    const { api } = await import('/static/js/net.js');
    await api.del(`/api/posts/${postId}`);
  }, postId);

  await person.page.goto(`/?c=${unique()}#/e/${code}/me`);
  await expect(person.page.locator('#eventMeBand')).toHaveText('この会は中止になりました');
  await expect(person.page.locator('#eventMeStatus')).toContainText('申し込みは取り消されています。');
  await expect(person.page.locator('#eventMe')).not.toContainText('またお知らせ');
  await expect(person.page.locator('#eventMe')).not.toContainText('あなたに近い人');
  await expect(person.page.locator('#eventMeLate')).toHaveCount(0);
  await expect(person.page.locator('#eventMeCancel')).toHaveCount(0);
  await expect(person.page.locator('#eventMePlace')).toHaveCount(0);
  await noSideScroll(person.page);
  await shot(person.page, testInfo, 'ゲスト用ページ_中止');

  const guest = await guestPage(browser, testInfo);
  await guest.page.goto(`/e/${code}`);
  await expect(guest.page.locator('#eventBand')).toHaveText('この会は中止になりました');
  await expect(guest.page.locator('#eventApplyNow')).toHaveCount(0);
  await expect(guest.page.locator('#eventProbeOpen')).toHaveCount(0);
  await shot(guest.page, testInfo, '申し込みページ_中止');
  await guest.context.close();
  await person.context.close();
  await host.context.close();
});

test('お断り：ゲスト用ページに文が出て、遅れる・取り消すは出ない', async ({ browser }, testInfo) => {
  test.setTimeout(90000);
  const host = await signedIn(browser, testInfo, '主催の坂内');
  const { code } = await makeEvent(host);
  const person = await signedIn(browser, testInfo, 'ゲスト花子', { path: `/e/${code}` });
  const accountId = await person.page.evaluate(async (code) => {
    const { api } = await import('/static/js/net.js');
    await api.post(`/api/events/${code}/apply`, {
      agree_terms: true, referral: 'SNSで見た',
      profile: { display_name: 'ゲスト 花子', affiliation: '○○株式会社', age_band: '30s' },
      answers: [{ prompt: 'now', body: '陶芸教室に通っています' }, { prompt: 'future', body: '朝のランニングを始めたい' }],
    });
    return (await api.get('/api/account/me')).account.id;
  }, code);
  await host.page.evaluate(async ({ code, accountId }) => {
    const { api } = await import('/static/js/net.js');
    await api.post(`/api/events/${code}/registrations/${accountId}/decline`, {});
  }, { code, accountId });
  await person.page.goto(`/?d=${unique()}#/e/${code}/me`);
  await expect(person.page.locator('#eventMeStatus')).toContainText('定員などの都合により、今回はご参加をお受けできないことになりました。');
  await expect(person.page.locator('#eventMeStatus')).toContainText('またの機会にぜひお越しください。');
  await expect(person.page.locator('#eventMeLate')).toHaveCount(0);
  await expect(person.page.locator('#eventMeCancel')).toHaveCount(0);
  await expect(person.page.locator('#eventMeFriendBand')).toHaveCount(0);
  await shot(person.page, testInfo, 'ゲスト用ページ_お断り');
  await person.context.close();
  await host.context.close();
});

test('メンバーの1タップ申し込み：質問なし、同意の文つき。申し込んだあとはゲスト用ページ', async ({ browser }, testInfo) => {
  test.setTimeout(90000);
  const host = await signedIn(browser, testInfo, '主催の坂内');
  const { code, communityId } = await makeEvent(host, { visibility: 'community' });
  const member = await signedIn(browser, testInfo, 'メンバー太郎');
  // コミュニティに入る（管理者が作った招待を使う）
  const invite = await host.page.evaluate(async (communityId) => {
    const { api } = await import('/static/js/net.js');
    return (await api.post('/api/local/invites', { community_id: communityId, minutes: 60, until_end_of_day: false })).code;
  }, communityId);
  await member.page.evaluate(async (invite) => {
    const { api } = await import('/static/js/net.js');
    await api.post('/api/local/invites/claim', { code: invite });
  }, invite);
  await member.page.goto(`/e/${code}`);
  await expect(member.page.locator('#eventApply')).toHaveClass(/active/);
  await member.page.locator('#eventApplyNow').click();
  await expect(member.page.locator('#eventApplyBody .ev-title')).toHaveText('この会に申し込みますか？');
  await expect(member.page.locator('#eventApplyBody')).toContainText('質問はありません。');
  await expect(member.page.locator('#eventConsent a').nth(0)).toHaveAttribute('href', '/terms/next');
  await shot(member.page, testInfo, 'メンバーの1タップ_確認');
  await member.page.locator('#eventMemberApply').click();
  await expect(member.page.locator('#eventDoneTitle')).toHaveText('申し込みました');
  await member.page.locator('#eventToMe').click();
  await expect(member.page.locator('#eventMeStatus')).toContainText('申し込み済み');
  await expect(member.page.locator('#eventMeMap')).toBeVisible();     // メンバーはマップへ戻れる
  await member.context.close();
  await host.context.close();
});

// ---- レビュー指摘の直し（第2回a）

test('コミュニティの中だけの会：メンバーでない人には、入力させずに案内し、新しく申し込む道を出さない', async ({ browser }, testInfo) => {
  test.setTimeout(90000);
  const host = await signedIn(browser, testInfo, '主催の坂内');
  const { code } = await makeEvent(host, { visibility: 'community' });
  // ログインなし
  const guest = await guestPage(browser, testInfo);
  await guest.page.goto(`/e/${code}`);
  await expect(guest.page.locator('#eventCommunityOnly')).toHaveText('この会は、コミュニティのメンバーだけが申し込めます');
  await expect(guest.page.locator('#eventApplyNow')).toHaveCount(0);
  await expect(guest.page.locator('#eventMail')).toHaveCount(0);
  await expect(guest.page.locator('#eventLine')).toHaveCount(0);
  await noSideScroll(guest.page);
  // ログイン済みでも、メンバーでなければ同じ
  const outsider = await signedIn(browser, testInfo, '外の人', { path: `/e/${code}` });
  await outsider.page.goto(`/e/${code}`);
  await expect(outsider.page.locator('#eventCommunityOnly')).toBeVisible();
  await expect(outsider.page.locator('#eventApplyNow')).toHaveCount(0);
  await outsider.context.close();
  await guest.context.close();
  await host.context.close();
});

test('申し込んでいない人がゲスト用ページを開くと公開ページへ。取り消したゲストはマップへ出られない', async ({ browser }, testInfo) => {
  test.setTimeout(90000);
  const host = await signedIn(browser, testInfo, '主催の坂内');
  const { code } = await makeEvent(host);
  const person = await signedIn(browser, testInfo, 'ゲスト花子', { path: `/e/${code}` });
  const { page } = person;
  // 申し込んでいない：空白ではなく公開ページ
  await page.goto(`/#/e/${code}/me`);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/e/${code}`);
  await expect(page.locator('#eventApply')).toHaveClass(/active/);
  // 申し込んで、取り消す
  await page.evaluate(async (code) => {
    const { api } = await import('/static/js/net.js');
    await api.post(`/api/events/${code}/apply`, {
      agree_terms: true, referral: 'SNSで見た',
      profile: { display_name: 'ゲスト 花子', affiliation: '○○株式会社', age_band: '30s', job_title: 'デザイナー' },
      answers: [{ prompt: 'now', body: '陶芸教室に通っています' }, { prompt: 'future', body: '朝のランニングを始めたい' }],
    });
    await api.post(`/api/events/${code}/cancel`, {});
  }, code);
  await page.goto('/');
  await page.evaluate(() => { location.hash = '#/map'; });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/e/${code}/me`);
  await expect(page.locator('#eventMeStatus')).toContainText('申し込みを取り消しました');
  await page.evaluate(() => { location.hash = '#/me'; });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/e/${code}/me`);
  await person.context.close();
  await host.context.close();
});

test('ログインしないで主催者の画面を開くと、ログインのあとにその会の主催者の画面へ戻る', async ({ browser }, testInfo) => {
  test.setTimeout(90000);
  const host = await signedIn(browser, testInfo, '主催の坂内');
  const { code } = await makeEvent(host);
  const guest = await guestPage(browser, testInfo);
  const { page } = guest;
  await page.goto(`/#/e/${code}/host`);
  await expect(page.locator('#auth')).toHaveClass(/active/, { timeout: 15000 });
  const stored = await page.evaluate(() => sessionStorage.getItem('islands-event-host-return') || localStorage.getItem('islands-event-host-return'));
  expect(stored).toContain(code);
  await guest.context.close();
  await host.context.close();
});

test('LINE から会のページに戻ると、時間がかかっても「あなたについて」から続く（出るときに覚えた戻り先が切れていても）', async ({ browser }, testInfo) => {
  const host = await signedIn(browser, testInfo, 'しゅさい');
  const { code } = await makeEvent(host);
  const guest = await guestPage(browser, testInfo);
  await guest.page.goto(`/e/${code}`);
  await expect(guest.page.locator('#eventApplyNow')).toBeVisible();
  // LINE から戻るときと同じ形のトークン（手元のサーバーで新しいアカウントを作り、ブラウザからは消しておく）。
  // 出るときに覚えた戻り先は、11/5 の本番のように 36 分たって切れている
  const tokens = await guest.page.evaluate(async ({ email, code }) => {
    const { session } = await import('/static/js/session.js');
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    const saved = JSON.parse(localStorage.getItem('kasanari-session'));
    localStorage.removeItem('kasanari-session');
    localStorage.setItem('islands-event-apply-return', JSON.stringify({ code, at: Date.now() - 36 * 60 * 1000 }));
    return { access: saved.access_token, refresh: saved.refresh_token };
  }, { email: `line-${crypto.randomUUID()}@example.com`, code });
  await guest.page.goto('about:blank');
  await guest.page.goto(`/e/${code}#access_token=${tokens.access}&refresh_token=${tokens.refresh}&expires_in=3600`);
  await expect(guest.page.locator('#eventName')).toBeVisible();
  expect(guest.page.url()).not.toContain('access_token');
  // ふつうに開き直したとき（戻りではない）は、会の案内のまま
  await guest.page.goto('about:blank');
  await guest.page.goto(`/e/${code}`);
  await expect(guest.page.locator('#eventApplyNow')).toBeVisible();
  await expect(guest.page.locator('#eventName')).toHaveCount(0);
  await guest.context.close();
  await host.context.close();
});
