// BAR（2026-10-30）で出た地図の直し：プロフィールから戻ったときに開く投稿と、ダブルタップのズーム。
// 手元モードのサーバーに、ブラウザ2つでつなぐ。
import { test, expect } from '@playwright/test';

const INVITE = 'demo-invite-code-local-0001';

async function newPerson(browser, testInfo, name, extra = {}) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport, ...extra });
  const page = await context.newPage();
  await page.goto(`/#/invite/${INVITE}`);
  // The settings are read as the app starts; on a busy machine the page can be ready before they are.
  await expect(page.locator('#inviteRegister')).toBeVisible({ timeout: 20000 });
  await page.evaluate(async ({ email, name, code }) => {
    const { session } = await import('/static/js/session.js');
    const { api, data } = await import('/static/js/net.js');
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await data.claimInvite(code);
    await api.put('/api/account/me', { display_name: name, affiliation: 'テスト', icon_id: 'photo' });
  }, { email: `${name}-${crypto.randomUUID()}@example.com`, name, code: INVITE });
  return { page, context };
}

const post = (who, body) => who.page.evaluate(async (body) => {
  const { api } = await import('/static/js/net.js');
  const made = await api.post('/api/posts', { body, tags: [], motivation: 55 }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  return made.id;
}, body);

test('リンクで自分の投稿を開いたあと、ほかの人の投稿からプロフィールへ行って戻ると、ほかの人の投稿が開く', async ({ browser }, testInfo) => {
  const other = await newPerson(browser, testInfo, 'けんた');
  const theirs = await post(other, '週末はコーヒー豆を焙煎して過ごしています。おすすめの豆を交換したいです');
  const me = await newPerson(browser, testInfo, 'みさき');
  const mine = await post(me, '朝のランニングを1年続けています。いっしょに走れる人を探しています');

  await me.page.goto(`/?again=1#/map?post=${mine}`);
  await expect(me.page.locator('#sheet.on .post-body')).toContainText('ランニング', { timeout: 15000 });
  await me.page.evaluate(async (id) => { const { openPost } = await import('/static/js/screens/map.js'); await openPost(id); }, theirs);
  await expect(me.page.locator('#sheet.on .post-body')).toContainText('コーヒー');

  await me.page.locator('#sheet.on .post-author').click();
  await expect(me.page.locator('#user')).toHaveClass(/active/);
  await me.page.locator('#userBack').click();
  await expect(me.page.locator('#map')).toHaveClass(/active/);
  // 2026-10-31 まではアドレスに残った自分の投稿（?post=）が毎回開いていた
  await expect(me.page.locator('#sheet.on .post-body')).toContainText('コーヒー', { timeout: 15000 });

  // 通知などから同じ投稿をもう一度開くと、ちゃんと開く
  await me.page.evaluate(async (id) => { const { openOnMap } = await import('/static/js/screens/map.js'); await openOnMap(id); }, mine);
  await expect(me.page.locator('#sheet.on .post-body')).toContainText('ランニング', { timeout: 15000 });

  await me.context.close();
  await other.context.close();
});

test('地図の何もない所をダブルタップすると、その場所を中心に寄る。1回だけなら寄らない', async ({ browser }, testInfo) => {
  const me = await newPerson(browser, testInfo, 'たっぷ', { hasTouch: true });
  await me.page.goto('/?again=1#/map');
  await expect(me.page.locator('#map')).toHaveClass(/active/);
  const camera = () => me.page.evaluate(async () => ({ ...(await import('/static/js/state.js')).state.camera }));
  // 最初の全体表示のアニメーションが終わってから、島を画面の外へ（たたく所が海だけになる）
  await me.page.waitForTimeout(2000);
  await me.page.evaluate(async () => { (await import('/static/js/state.js')).state.camera.x += 6000; });
  await me.page.waitForTimeout(300);
  const start = await camera();
  const { width, height } = testInfo.project.use.viewport;
  const spot = { x: Math.round(width * 0.15), y: Math.round(height * 0.7) };
  await me.page.touchscreen.tap(spot.x, spot.y);
  await me.page.waitForTimeout(700);
  expect((await camera()).scale).toBeCloseTo(start.scale, 5);

  await me.page.touchscreen.tap(spot.x, spot.y);
  await me.page.waitForTimeout(60);
  await me.page.touchscreen.tap(spot.x, spot.y);
  await expect.poll(async () => (await camera()).scale / start.scale, { timeout: 5000 }).toBeCloseTo(4, 2);
  // たたいた場所は、指の下に残る
  const end = await camera();
  const worldOf = (c) => ({ x: (spot.x - c.x) / c.scale, y: (spot.y - c.y) / c.scale });
  expect(worldOf(end).x).toBeCloseTo(worldOf(start).x, 0);
  expect(worldOf(end).y).toBeCloseTo(worldOf(start).y, 0);
  await me.context.close();
});

test('登録のアイコン写真の画面で保存に失敗しても、「写真はあとで設定して進む」で先に進める', async ({ page }, testInfo) => {
  await page.goto(`/#/invite/${INVITE}`);
  await page.locator('#inviteRegister').click();
  await page.locator('#authEmail').fill(`skip-${crypto.randomUUID()}@example.com`);
  await page.locator('#registerName').fill('すすむ');
  await page.locator('#registerAffiliation').fill('islands');
  await page.locator('#authSend').click();
  await expect(page.locator('.dev-code-value')).toBeVisible();
  await page.locator('#authCode').fill(await page.locator('.dev-code-value').innerText());
  await page.locator('#authVerify').click();
  await expect(page.locator('#setup')).toHaveClass(/active/);
  await expect(page.locator('#setupSkip')).toBeHidden();

  // 10/28 の夜の本番と同じ：保存が 503 で断られる
  await page.route('**/api/account/me', (route) => (route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: '保存に失敗しました。もう一度お試しください。' }) })
    : route.continue()));
  await page.locator('#setupSave').click();
  await expect(page.locator('#setupError')).toContainText('保存に失敗しました');
  await expect(page.locator('#setupSkip')).toBeVisible();
  if (testInfo.project.name === '390px') await page.screenshot({ path: testInfo.outputPath('setup-skip-390.png') });
  await page.locator('#setupSkip').click();
  await expect(page.locator('#guidance')).toHaveClass(/active/);
});
