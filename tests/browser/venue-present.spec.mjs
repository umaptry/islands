// 会場で映す: 招待のシートから開く、プロジェクター向けの全画面（QR と通知の手順）。
import { test, expect } from '@playwright/test';

const unique = () => Math.random().toString(36).slice(2, 10);

async function person(browser, testInfo, name, { create = null, join = null, init = null } = {}) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('#welcome')).toHaveClass(/active/);
  const email = `${name}-${crypto.randomUUID()}@example.com`;
  const made = await page.evaluate(async ({ email, name, create, join }) => {
    const { session } = await import('/static/js/session.js');
    const { api } = await import('/static/js/net.js');
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await api.put('/api/account/me', { display_name: name, icon_id: 'photo', affiliation: 'テスト', name_confirmed: true });
    if (create) return api.post('/api/local/communities', { name: create, slug: `t-${Math.random().toString(36).slice(2, 9)}` }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
    if (join) await api.post('/api/local/invites/claim', { code: join });
    return null;
  }, { email, name, create, join });
  return { page, context, made };
}


const openEdit = async (who, communityId) => {
  await who.page.goto(`/?me=${unique()}#/community/${communityId}`);
  const card = who.page.locator(`#communityEditBody .community-invites[data-community-id="${communityId}"]`);
  await card.waitFor({ timeout: 15000 });
  return card;
};

const withShare = () => {
  Object.defineProperty(navigator, 'share', { configurable: true, value: async () => {} });
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
};

async function openVenue(browser, testInfo) {
  const name = `会場 ${unique()}`;
  const admin = await person(browser, testInfo, '会場のひと', { create: name, init: withShare });
  const id = admin.made.community_id;
  const card = await openEdit(admin, id);
  await expect(card.locator('.invite-venue')).toHaveCount(0);   // QR が出るまでは無い
  await card.locator('.invite-open').click();
  await card.locator('.invite-approval').uncheck();
  await card.locator('.invite-make').click();
  await expect(card.locator('.invite-qr svg')).toBeVisible();
  return { admin, card, name };
}

test('「会場で映す」: 全画面の重ね表示に、QR・コミュニティ名・3つの手順が出る。リンクはシートと同じ。Esc と ✕ で閉じる', async ({ browser }, testInfo) => {
  const { admin, card, name } = await openVenue(browser, testInfo);
  const page = admin.page;
  const dialog = page.getByRole('dialog', { name: '会場で映す' });
  await expect(dialog).toHaveCount(0);
  await card.locator('.invite-venue').click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.venue-who')).toHaveText(name);
  await expect(dialog.locator('svg.invite-qr-svg')).toBeVisible();
  await expect(dialog.locator('.venue-title')).toHaveText('反応やメッセージを、スマホで受け取る');
  await expect(dialog.locator('.venue-list li b')).toHaveText(['QR を読み取って、登録する', 'ホーム画面に追加する', '「通知を受け取る」を押す']);
  await expect(dialog.locator('.venue-list li').nth(1)).toContainText('Android：Chrome の［⋮］→［ホーム画面に追加］');

  // 同じリンク: シートの QR と、映す画面の QR は同じ図
  const sheetPath = await card.locator('.invite-qr svg path').getAttribute('d');
  expect(await dialog.locator('svg path').getAttribute('d')).toBe(sheetPath);

  // いちばん上に出ている
  expect(await page.evaluate(() => {
    const box = document.querySelector('.venue').getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return Boolean(top && top.closest('.venue'));
  })).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await card.locator('.invite-venue').click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '閉じる' }).click();
  await expect(dialog).toHaveCount(0);
});

test('「会場で映す」: 投稿のスイッチで変わったリンクを、開くたびに映す', async ({ browser }, testInfo) => {
  const { admin, card } = await openVenue(browser, testInfo);
  const page = admin.page;
  const id = admin.made.community_id;
  await page.evaluate(async (id) => {
    const { api } = await import('/static/js/net.js');
    await api.post('/api/posts', { body: '会場の投稿', tags: ['参加者募集中'], motivation: 55, community_id: id }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  }, id);
  await page.reload();
  const again = page.locator(`#communityEditBody .community-invites[data-community-id="${id}"]`);
  await again.waitFor({ timeout: 15000 });
  await again.locator('.invite-open, .invite-qr').first().waitFor();
  await expect(again.locator('.invite-with-post')).toBeEnabled({ timeout: 10000 });
  await again.locator('.invite-switch:not(.invite-approval-switch)').click();
  await expect(again.locator('.invite-url')).toHaveValue(/[?]post=/);
  await again.locator('.invite-venue').click();
  const dialog = page.getByRole('dialog', { name: '会場で映す' });
  expect(await dialog.locator('svg path').getAttribute('d')).toBe(await again.locator('.invite-qr svg path').getAttribute('d'));
  await page.keyboard.press('Escape');
  void card;
});

for (const [width, height] of [[1280, 720], [1366, 768], [1920, 1080]]) {
  test(`「会場で映す」: ${width}x${height} でスクロールなし・はみ出しなしで全部見える`, async ({ browser }, testInfo) => {
    const { admin, card } = await openVenue(browser, testInfo);
    const page = admin.page;
    await page.setViewportSize({ width, height });
    await card.locator('.invite-venue').scrollIntoViewIfNeeded();
    await card.locator('.invite-venue').click();
    const dialog = page.getByRole('dialog', { name: '会場で映す' });
    await expect(dialog).toBeVisible();
    const fit = await dialog.evaluate((node) => {
      const inside = (sel) => { const r = document.querySelector(sel).getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; };
      return { h: node.scrollHeight <= node.clientHeight, w: node.scrollWidth <= node.clientWidth,
        card: inside('.venue-card'), steps: inside('.venue-steps'), last: inside('.venue-list li:last-child'),
        qr: document.querySelector('.venue-qr svg').getBoundingClientRect().width };
    });
    expect(fit).toMatchObject({ h: true, w: true, card: true, steps: true, last: true });
    expect(fit.qr).toBeGreaterThanOrEqual(height * 0.4);
  });
}
