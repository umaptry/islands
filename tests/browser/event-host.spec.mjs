// 会（第2回a）：主催者とメンバーの画面。手元モードのサーバーに、ブラウザ数個（主催者・メンバー2人）でつなぐ。
// 筋書き：主催者が投稿画面で「会」を作る → 申し込みのリンクと受付 QR が出る → メンバーが1タップで申し込む
// → 名前が未確認のメンバーは先に #/fullname を通って戻り、申し込む → 主催者が名簿で見る → 遅れる連絡が主催者の通知に
// → お断り（確かめてから）→ 会を中止（確かめてから）→ メンバーの通知に「中止」。
// 確認写真：環境変数 EV_SHOTS_DIR があれば、そこに主な状態の写真を保存する（幅 390px のときだけ）。
import { test, expect } from '@playwright/test';

const unique = () => Math.random().toString(36).slice(2, 10);

async function openContext(browser, testInfo) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  const problems = { errors: [], failed: [] };
  page.on('pageerror', (error) => problems.errors.push(String(error)));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/') && response.status() >= 500) problems.failed.push(`${response.status()} ${url.pathname}`);
  });
  return { context, page, problems };
}

async function person(browser, testInfo, name, { confirmed = true } = {}) {
  const who = await openContext(browser, testInfo);
  await who.page.goto('/');
  await expect(who.page.locator('#welcome')).toHaveClass(/active/);
  const email = `${name}-${crypto.randomUUID()}@example.com`;
  await who.page.evaluate(async ({ email, name, confirmed }) => {
    const { session } = await import('/static/js/session.js');
    const { api } = await import('/static/js/net.js');
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await api.put('/api/account/me', {
      display_name: name, affiliation: 'テスト会社', icon_id: 'photo', ...(confirmed ? { name_confirmed: true } : {}),
    });
  }, { email, name, confirmed });
  who.name = name;
  who.id = await who.page.evaluate(async () => (await import('/static/js/session.js')).session.userId());
  return who;
}

const call = (who, method, path, body) => who.page.evaluate(async ({ method, path, body }) => {
  const { api } = await import('/static/js/net.js');
  if (method === 'get') return api.get(path);
  return api.post(path, body, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
}, { method, path, body });

const makeCommunity = (who, name) => call(who, 'post', '/api/local/communities', { name, slug: `t-${unique()}` });

async function bringIn(admin, communityId, guest) {
  const invite = await call(admin, 'post', '/api/local/invites', { community_id: communityId, minutes: 60, until_end_of_day: false });
  await call(guest, 'post', '/api/local/invites/claim', { code: invite.code });
}

const noSideScroll = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

// 日本時間の「何日後の 19:00」を、datetime-local の値にする。
function jstLocal(days, hour = 19) {
  const moved = new Date(Date.now() + days * 86400000 + 9 * 3600000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}T${pad(hour)}:00`;
}

const SHOTS = process.env.EV_SHOTS_DIR || '';
async function shot(page, testInfo, name) {
  if (!SHOTS || testInfo.project.name !== '390px') return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const TITLE = 'The Night Office BAR #2';

// 投稿画面で、会を作るところまで（主催者）。
async function createEventByUi(host, testInfo, community) {
  const { page } = host;
  await page.goto(`/?host=${unique()}#/post`);
  await expect(page.locator('#composeCommunity')).toContainText(`${community.name} に投稿`);
  await page.locator('#composeBody').fill('夜のBARでゆるく飲む会を開きます。気軽に来てください');
  await page.locator('#composeNext').click();
  await page.locator('#composeMotivation').evaluate((node) => { node.value = '55'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#composeNext2').click();
  // ふつうの投稿のままなら、会のスイッチは出ない
  await expect(page.locator('#composeEventRow')).toBeHidden();
  await page.locator('#composeTags [data-tag="参加者募集中"]').click();
  await expect(page.locator('#composeEventRow')).toBeVisible();
  await expect(page.locator('#composeSubmit')).toHaveText('投稿する');
  await page.locator('#composeCapacity').fill('5');
  await page.locator('#composeEventOn').check();
  await expect(page.locator('#composeSubmit')).toHaveText('次へ（会の中身）');
  await shot(page, testInfo, '01_会にする（投稿画面の③）');
  await page.locator('#composeSubmit').click();

  // ① 会の中身
  await expect(page.locator('#eventCompose')).toHaveClass(/active/);
  await expect(page.locator('#eventComposeCapacity')).toContainText('先着 5人');
  await page.locator('#eventComposeNext').click();
  await expect(page.locator('#eventComposeError')).toContainText('会の名前');
  await page.locator('#eventComposeName').fill(TITLE);
  await page.locator('#eventComposeStart').fill(jstLocal(10));
  await page.locator('#eventComposeEnd').fill(jstLocal(10, 22));
  await page.locator('#eventComposePlace').fill('渋谷 ○○ビル 3F');
  // メンバー（管理者でない人）は公開を選べない。ここは管理者の主催者なので選べる
  await expect(page.locator('#eventComposePublic')).toBeEnabled();
  await noSideScroll(page);
  await shot(page, testInfo, '02_会の中身');
  await page.locator('#eventComposeNext').click();

  // ② 開催の条件（第2回b）：どれも空欄・初期値のままで次へ
  await expect(page.locator('#eventComposeTitle')).toHaveText('開催の条件');
  await page.locator('#eventComposeNext').click();

  // ③ 質問：固定の3つ。公開にして質問を1つにすると断られ、コミュニティの中だけに戻して作る
  await expect(page.locator('#eventComposeQuestions .ev-question')).toHaveCount(3);
  await expect(page.locator('#eventComposeQuestions')).toContainText('今やってること');
  await expect(page.locator('#eventComposeQuestions')).not.toContainText('当日話したい');
  await shot(page, testInfo, '03_申し込む人への質問');
  await page.locator('#eventComposeBack').click();
  await page.locator('#eventComposeBack').click();
  await page.locator('#eventComposePublic').click();
  await page.locator('#eventComposeNext').click();
  await page.locator('#eventComposeNext').click();
  await page.locator('#eventComposeQuestions [data-prompt="past"]').click();
  await page.locator('#eventComposeQuestions [data-prompt="future"]').click();
  await page.locator('#eventComposeNext').click();
  await expect(page.locator('#eventComposeError')).toContainText('質問を2つ以上');
  await page.locator('#eventComposeQuestions [data-prompt="future"]').click();
  await page.locator('#eventComposeNext').click();   // 公開・質問2つで作る
  await expect(page.locator('#eventHost')).toHaveClass(/active/, { timeout: 30000 });
}

test('会を作る → 1タップ申し込み → 名簿 → お断り → 中止まで', async ({ browser }, testInfo) => {
  test.setTimeout(180000);
  const host = await person(browser, testInfo, '主催のひろ');
  const community = await makeCommunity(host, `BAR ${unique()}`);

  // ---- 1. 会を作る
  await createEventByUi(host, testInfo, community);
  await expect(host.page.locator('#eventHostFresh')).toContainText('申し込みページができました');
  const link = await host.page.locator('#eventHostLink').inputValue();
  expect(link).toMatch(/\/e\/[A-Za-z0-9_-]{8,}$/);
  const code = link.split('/e/')[1];
  await expect(host.page.locator('#eventHostQr svg')).toBeVisible();
  await expect(host.page.locator('#eventHostTitle')).toHaveText(TITLE);
  await expect(host.page.locator('#eventHost')).toContainText('公開（リンクを知っている人は誰でも申し込める）');
  await noSideScroll(host.page);
  await shot(host.page, testInfo, '04_できあがり（リンクと受付QR）');
  const info = await call(host, 'get', `/api/events/${code}`);
  const postId = info.event.post_id;
  expect(info.is_host).toBe(true);

  // 会の投稿は地図に載り、主催者のカードには「主催者メニュー」が出る（「参加」ではなく）
  await host.page.goto(`/?again=${unique()}#/map?post=${postId}`);
  await host.page.locator('#sheet.on .post-card').waitFor({ timeout: 30000 });
  await expect(host.page.locator('#sheet.on .ev-host')).toBeVisible();
  await expect(host.page.locator('#sheet.on .post-join-button')).toBeHidden();
  await expect(host.page.locator('#sheet.on .ev-apply-btn')).toHaveCount(0);
  await shot(host.page, testInfo, '05_主催者のカード（主催者メニューの帯）');

  // ---- 2. メンバーA：確認済み → カードから1タップ申し込み
  const ann = await person(browser, testInfo, 'メンバーあん');
  await bringIn(host, community.community_id, ann);
  await ann.page.goto(`/?ann=${unique()}#/map?post=${postId}`);
  await ann.page.locator('#sheet.on .post-card').waitFor({ timeout: 30000 });
  const apply = ann.page.locator('#sheet.on .ev-apply-btn');
  await expect(apply).toHaveText('申し込む');
  await expect(ann.page.locator('#sheet.on .post-join-button')).toBeHidden();
  await expect(ann.page.locator('#sheet.on .ev-host')).toHaveCount(0);
  await shot(ann.page, testInfo, '06_メンバーのカード（申し込む）');
  await apply.click();
  const modal = ann.page.locator('.ev-modal');
  await expect(modal).toContainText('この会に申し込みますか？');
  await expect(modal).toContainText(TITLE);
  await expect(modal).toContainText('質問はありません');
  await expect(modal.locator('a[href="/terms/next"]')).toBeVisible();
  await expect(modal.locator('a[href="/privacy/next"]')).toBeVisible();
  await shot(ann.page, testInfo, '07_申し込みの確認');
  await modal.locator('.ev-confirm').click();
  await expect(ann.page.locator('#sheet.on .ev-apply-btn')).toHaveText('✓ 申し込み済み');
  await shot(ann.page, testInfo, '08_申し込み済み');
  // 取り消しは確かめてから。やめると申し込み済みのまま
  await ann.page.locator('#sheet.on .ev-apply-btn').click();
  await expect(ann.page.locator('.modal')).toContainText('申し込みを取り消しますか？');
  await ann.page.locator('.modal .btn-quiet').click();
  await expect(ann.page.locator('#sheet.on .ev-apply-btn')).toHaveText('✓ 申し込み済み');

  // ---- 3. メンバーB：名前が未確認 → 先に #/fullname を通って、戻ってきて申し込む
  const bob = await person(browser, testInfo, 'メンバーぼぶ', { confirmed: false });
  await bringIn(host, community.community_id, bob);
  await bob.page.goto(`/?bob=${unique()}#/map?post=${postId}`);
  // 起動したとき（お願いの期間）はフルネームの画面で止まる。「あとで」で閉じて、カードから申し込む
  let viaCard = false;
  await bob.page.waitForFunction(() => document.querySelector('#fullname.active') || document.querySelector('#sheet.on .post-card'), null, { timeout: 30000 });
  if (await bob.page.locator('#fullname.active').count()) {
    if (await bob.page.locator('#fullnameLater').isVisible()) {
      await bob.page.locator('#fullnameLater').click();
      viaCard = true;
    } else {
      // 必須の期間：確かめるまで先へ進めない。ここで確かめて、あとは確認済みと同じ
      await bob.page.locator('#fullnameName').fill('ぼぶ 太郎');
      await bob.page.locator('#fullnameSave').click();
    }
  }
  await bob.page.locator('#sheet.on .post-card').waitFor({ timeout: 30000 });
  const bobApply = bob.page.locator('#sheet.on .ev-apply-btn');
  await expect(bobApply).toHaveText('申し込む');
  await bobApply.click();
  if (viaCard) {
    await expect(bob.page.locator('#fullname')).toHaveClass(/active/);
    await shot(bob.page, testInfo, '09_名前が未確認なら先にフルネーム');
    await bob.page.locator('#fullnameName').fill('ぼぶ 太郎');
    await bob.page.locator('#fullnameAffiliation').fill('ボブ株式会社');
    await bob.page.locator('#fullnameSave').click();
    // 確認のあと、同じ会のカードに戻り、確認が自動で開く
    await expect(bob.page.locator('.ev-modal')).toBeVisible({ timeout: 15000 });
    await expect(bob.page.locator('#sheet.on .post-card')).toContainText('夜のBAR');
  }
  await bob.page.locator('.ev-modal .ev-confirm').click();
  await expect(bob.page.locator('#sheet.on .ev-apply-btn')).toHaveText('✓ 申し込み済み', { timeout: 15000 });

  // ---- 4. 遅れる連絡（メンバーA）→ 主催者の通知
  await call(ann, 'post', `/api/events/${code}/late`, { minutes: 30 });

  // ---- 5. 主催者が名簿で見る
  await host.page.goto(`/?roster=${unique()}#/e/${code}/host`);
  await expect(host.page.locator('#eventRosterCounts')).toBeVisible({ timeout: 15000 });
  await expect(host.page.locator('#eventRosterCounts [data-count="applied"] b')).toHaveText('2');
  await expect(host.page.locator('#eventRosterCounts [data-count="late"] b')).toHaveText('1');
  const rowAnn = host.page.locator('.ev-person', { hasText: 'メンバーあん' });
  await expect(rowAnn).toContainText('30分遅れ');
  await expect(rowAnn).toContainText('招待');
  await expect(host.page.locator('.ev-person', { hasText: 'メンバーぼぶ' }).or(host.page.locator('.ev-person', { hasText: 'ぼぶ 太郎' }))).toHaveCount(1);
  await expect(host.page.locator('#eventHost')).toContainText('きっかけは主催者と管理者だけに見えます');
  await noSideScroll(host.page);
  await host.page.locator('.ev-card', { hasText: '出欠つき名簿' }).scrollIntoViewIfNeeded();
  await shot(host.page, testInfo, '10_名簿');

  // ---- 6. お断り（確かめてから）
  const bobRow = host.page.locator('.ev-person').filter({ hasNotText: 'メンバーあん' }).first();
  await bobRow.locator('.ev-more').click();
  await expect(bobRow.locator('.ev-decline')).toBeVisible();
  await shot(host.page, testInfo, '11_行の「•••」からお断りする');
  await bobRow.locator('.ev-decline').click();
  const sure = host.page.locator('.modal');
  await expect(sure).toContainText('をお断りしますか？');
  await expect(sure).toContainText('定員などの都合により、今回はご参加をお受けできないことになりました');
  await expect(sure).toContainText('QR も使えなくなります');
  await shot(host.page, testInfo, '12_お断りの確認');
  await sure.locator('.btn-quiet').click();                       // やめる：何も変わらない
  await expect(host.page.locator('#eventRosterCounts [data-count="declined"] b')).toHaveText('0');
  await bobRow.locator('.ev-decline').click();
  await host.page.locator('.modal .btn-danger').click();           // お断りする
  await expect(host.page.locator('#eventRosterCounts [data-count="declined"] b')).toHaveText('1', { timeout: 15000 });
  await expect(host.page.locator('#eventRosterCounts [data-count="applied"] b')).toHaveText('1');
  await expect(host.page.locator('.ev-group[data-group="closed"]')).toContainText('お断り');
  // お断りされた人のカードは、申し込めない表示になる
  await bob.page.goto(`/?bob2=${unique()}#/map?post=${postId}`);
  await bob.page.locator('#sheet.on .post-card').waitFor({ timeout: 30000 });
  await expect(bob.page.locator('#sheet.on .ev-apply-btn')).toHaveText('今回はお受けできません');
  await expect(bob.page.locator('#sheet.on .ev-apply-btn')).toBeDisabled();

  // ---- 7. 内容を変える（場所だけ）
  await host.page.locator('#eventHostEdit').click();
  await expect(host.page.locator('#eventEditTitle')).toHaveValue(TITLE);
  await host.page.locator('#eventEditPlace').fill('渋谷 △△ビル 5F');
  await shot(host.page, testInfo, '13_会の内容を変える');
  await host.page.locator('#eventEditSave').click();
  await expect(host.page.locator('#eventHost')).toContainText('場所：渋谷 △△ビル 5F', { timeout: 15000 });
  await host.page.locator('#eventHostEdit').click();
  await host.page.locator('#eventEditEnd').fill(jstLocal(10, 18));      // 開始より前
  await host.page.locator('#eventEditSave').click();
  await expect(host.page.locator('#eventEditError')).toContainText('終了は開始より後');
  await host.page.locator('#eventEditCancel').click();

  // ---- 8. 主催者の通知：遅れる連絡 → 押すと名簿へ
  await host.page.goto(`/?notice=${unique()}#/notifications`);
  const late = host.page.locator('.notif', { hasText: '30分ほど遅れます' });
  await expect(late.first()).toBeVisible({ timeout: 15000 });
  await shot(host.page, testInfo, '14_主催者の通知（遅れる）');
  await late.first().click();
  await expect(host.page.locator('#eventHost')).toHaveClass(/active/);
  await expect(host.page.locator('#eventHostTitle')).toHaveText(TITLE);

  // ---- 9. 会を中止する（確かめてから）
  await host.page.locator('#eventHostCancel').click();
  const confirmCancel = host.page.locator('.modal');
  await expect(confirmCancel).toContainText(`「${TITLE}」を中止しますか？`);
  await expect(confirmCancel).toContainText('申し込んでいる1人');
  await shot(host.page, testInfo, '15_会の中止の確認');
  await confirmCancel.locator('.btn-quiet').click();               // やめる
  await expect(host.page.locator('#eventHost')).toHaveClass(/active/);
  await host.page.locator('#eventHostCancel').click();
  await host.page.locator('.modal .btn-danger').click();
  await expect(host.page.locator('#map')).toHaveClass(/active/, { timeout: 15000 });
  const after = await call(host, 'get', `/api/events/${code}`);
  expect(after.event.cancelled).toBe(true);

  // ---- 10. メンバー側：申し込んでいたメンバーに「中止」の通知。お断りした人には来ない
  await ann.page.goto(`/?ann2=${unique()}#/notifications`);
  const cancelled = ann.page.locator('.notif', { hasText: `「${TITLE}」は中止になりました` });
  await expect(cancelled.first()).toBeVisible({ timeout: 15000 });
  await shot(ann.page, testInfo, '16_メンバーの通知（中止）');
  await noSideScroll(ann.page);
  await cancelled.first().click();
  await expect(ann.page.locator('#map')).toHaveClass(/active/, { timeout: 15000 });
  await bob.page.goto(`/?bob3=${unique()}#/notifications`);
  await expect(bob.page.locator('#notifications')).toHaveClass(/active/);
  await expect(bob.page.locator('.notif', { hasText: '中止になりました' })).toHaveCount(0);

  for (const who of [host, ann, bob]) {
    expect(who.problems.errors, `${who.name} の画面の例外`).toEqual([]);
    expect(who.problems.failed, `${who.name} の 5xx`).toEqual([]);
  }
});

test('会ではない募集の投稿は、今までどおり「参加」で、主催者でない人には主催者メニューが出ない', async ({ browser }, testInfo) => {
  const host = await person(browser, testInfo, 'ふつうの主催');
  const community = await makeCommunity(host, `ふつう ${unique()}`);
  const made = await host.page.evaluate(async (cid) => {
    const { api } = await import('/static/js/net.js');
    return api.post('/api/posts', { body: '土曜の朝に公園でランニングします。誰でもどうぞ', tags: ['参加者募集中'], motivation: 55, community_id: cid, recruit_capacity: 5 },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  }, community.community_id);
  const guest = await person(browser, testInfo, 'ふつうのあなた');
  await bringIn(host, community.community_id, guest);
  await guest.page.goto(`/?plain=${unique()}#/map?post=${made.id}`);
  await guest.page.locator('#sheet.on .post-card').waitFor({ timeout: 30000 });
  await expect(guest.page.locator('#sheet.on .post-join-button')).toBeVisible({ timeout: 15000 });
  await expect(guest.page.locator('#sheet.on .ev-block .ev-apply-btn')).toHaveCount(0);
  await expect(guest.page.locator('#sheet.on .ev-host')).toHaveCount(0);
  // 主催者でない人は、他人の会の名簿を開けない
  await host.page.goto(`/?x=${unique()}`);
  const other = await call(host, 'post', '/api/posts', {
    body: '夜のBARでゆるく飲む会を開きます。気軽に来てください', tags: ['参加者募集中'], motivation: 55,
    community_id: community.community_id, recruit_capacity: 3,
    event: { title: '内輪の会', starts_at: new Date(Date.now() + 8 * 86400000).toISOString(), ends_at: new Date(Date.now() + 8 * 86400000 + 3 * 3600000).toISOString(), place: 'どこか', visibility: 'community', questions: [], agree_terms: true },
  });
  await guest.page.goto(`/?deny=${unique()}#/e/${other.event.public_code}/host`);
  await expect(guest.page.locator('#map')).toHaveClass(/active/, { timeout: 15000 });
});

test('名前が未確認のメンバー：カードの「申し込む」→ フルネームで「あとで」→ カードに戻って、また名前の画面へ送られない', async ({ browser }, testInfo) => {
  test.setTimeout(120000);
  const host = await person(browser, testInfo, '主催のひろ');
  const community = await makeCommunity(host, `BAR ${unique()}`);
  const made = await host.page.evaluate(async ({ communityId, start, end }) => {
    const { api } = await import('/static/js/net.js');
    return api.post('/api/posts', {
      body: '夜の会をひらきます。話してみたい人は来てください。', tags: ['参加者募集中'], motivation: 55, community_id: communityId,
      recruit_capacity: 5,
      event: { title: 'The Night Office BAR #2', starts_at: start, ends_at: end, place: '渋谷', visibility: 'community', agree_terms: true,
        questions: [{ prompt: 'now', label: '今', hint: '' }, { prompt: 'past', label: '昔', hint: '' }, { prompt: 'future', label: '先', hint: '' }] },
    }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  }, { communityId: community.community_id, start: new Date(Date.now() + 10 * 86400000).toISOString(), end: new Date(Date.now() + 10 * 86400000 + 3 * 3600000).toISOString() });
  const bob = await person(browser, testInfo, 'メンバーぼぶ', { confirmed: false });
  await bringIn(host, community.community_id, bob);
  await bob.page.goto(`/?bob=${unique()}#/map?post=${made.id}`);
  await bob.page.waitForFunction(() => document.querySelector('#fullname.active') || document.querySelector('#sheet.on .post-card'), null, { timeout: 30000 });
  if (await bob.page.locator('#fullname.active').count()) {
    test.skip(!(await bob.page.locator('#fullnameLater').isVisible()), '必須の期間は「あとで」がない');
    await bob.page.locator('#fullnameLater').click();
  }
  await bob.page.locator('#sheet.on .post-card').waitFor({ timeout: 30000 });
  await bob.page.locator('#sheet.on .ev-apply-btn').click();
  await expect(bob.page.locator('#fullname')).toHaveClass(/active/);
  await bob.page.locator('#fullnameLater').click();
  await expect(bob.page.locator('#sheet.on .post-card')).toBeVisible({ timeout: 15000 });
  await bob.page.waitForTimeout(1500);
  await expect(bob.page.locator('#fullname')).not.toHaveClass(/active/);
  await expect(bob.page.locator('.ev-modal')).toHaveCount(0);
  await expect(bob.page.locator('#sheet.on .ev-apply-btn')).toHaveText('申し込む');
  await bob.context.close();
  await host.context.close();
});
