// フルネームの確認（#/fullname）。既存メンバーで name_confirmed_at が空の人に、次に開いたとき出す。
// 日付の判断はサーバー（/api/config の fullname.required）。ここでは config を差し替えて、お願い版と必須版を両方見る。
import { test, expect } from '@playwright/test';

const FROM = '2026-11-16';

async function memberPage(browser, testInfo, { required }) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  await context.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.fullname = { required, from: FROM };
    await route.fulfill({ response, json: body });
  });
  await page.goto('/');
  await expect(page.locator('#welcome')).toHaveClass(/active/);
  const email = `fn-${crypto.randomUUID()}@example.com`;
  await page.evaluate(async (email) => {
    const { session } = await import('/static/js/session.js');
    const { api } = await import('/static/js/net.js');
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    // 確かめ済みにしない（name_confirmed を付けない）: 既存メンバーのつもり
    await api.put('/api/account/me', { display_name: 'みずき', affiliation: 'コクヨ株式会社', icon_id: 'photo' });
  }, email);
  return page;
}

const noSideScroll = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

test('お願い版：次に開いたときに出て、「あとで」で閉じられ、また開くとまた出る。保存すると出なくなる', async ({ browser }, testInfo) => {
  const page = await memberPage(browser, testInfo, { required: false });
  await page.goto(`/?a=${Math.random()}`);
  await expect(page.locator('#fullname')).toHaveClass(/active/, { timeout: 15000 });
  await expect(page.locator('#fullnameBadge')).toHaveText('お願い（11/15 まで）');
  await expect(page.locator('#fullnameTitle')).toHaveText('フルネームを教えてください');
  // いまのニックネームが下書き。年代・職種は聞かない。
  await expect(page.locator('#fullnameName')).toHaveValue('みずき');
  await expect(page.locator('#fullnameAffiliation')).toHaveValue('コクヨ株式会社');
  await expect(page.locator('#fullname')).not.toContainText('年代');
  await expect(page.locator('#fullname')).not.toContainText('職種');
  expect(await page.locator('#fullnameName').getAttribute('maxlength')).toBe('24');
  await expect(page.locator('#fullnameLater')).toBeVisible();
  await expect(page.locator('#fullnameStuck')).toBeHidden();
  await noSideScroll(page);

  // 「あとで」→ 地図。同じ画面のまま別の画面へ行っても、もう出ない。
  await page.locator('#fullnameLater').click();
  await expect(page.locator('#map')).toHaveClass(/active/, { timeout: 15000 });
  await page.evaluate(() => { location.hash = '#/notifications'; });
  await expect(page.locator('#notifications')).toHaveClass(/active/);

  // 次に開いたとき（読み込み直し）は、また出る。
  await page.goto(`/?b=${Math.random()}`);
  await expect(page.locator('#fullname')).toHaveClass(/active/, { timeout: 15000 });

  // 空にすると保存できない。入れて保存すると地図へ。
  await page.locator('#fullnameName').fill('');
  await expect(page.locator('#fullnameSave')).toBeDisabled();
  await page.locator('#fullnameName').fill('山田 瑞希');
  await page.locator('#fullnameAffiliation').fill('コクヨ株式会社');
  await page.locator('#fullnameSave').click();
  await expect(page.locator('#map')).toHaveClass(/active/, { timeout: 15000 });
  const account = await page.evaluate(async () => (await (await import('/static/js/net.js')).api.get('/api/account/me')).account);
  expect(account.display_name).toBe('山田 瑞希');
  expect(account.name_confirmed_at).toBeTruthy();

  // 保存したあとは、開き直しても出ない。
  await page.goto(`/?c=${Math.random()}`);
  await expect(page.locator('#map')).toHaveClass(/active/, { timeout: 15000 });
});

test('必須版：「あとで」がなく、入れるまで先に進めない', async ({ browser }, testInfo) => {
  const page = await memberPage(browser, testInfo, { required: true });
  await page.goto(`/?d=${Math.random()}`);
  await expect(page.locator('#fullname')).toHaveClass(/active/, { timeout: 15000 });
  await expect(page.locator('#fullnameBadge')).toHaveText('必須（11/16 から）');
  await expect(page.locator('#fullnameLater')).toBeHidden();
  await expect(page.locator('#fullnameStuck')).toHaveText('入れるまで、先には進めません');
  await noSideScroll(page);

  // 別の画面へ行こうとしても戻される。
  await page.evaluate(() => { location.hash = '#/notifications'; });
  await expect(page.locator('#fullname')).toHaveClass(/active/);
  await page.evaluate(() => { location.hash = '#/map'; });
  await expect(page.locator('#fullname')).toHaveClass(/active/);

  await page.locator('#fullnameName').fill('山田 瑞希');
  await page.locator('#fullnameSave').click();
  await expect(page.locator('#map')).toHaveClass(/active/, { timeout: 15000 });
});
