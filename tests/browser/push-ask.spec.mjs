import { test, expect } from '@playwright/test';

// 通知を受け取ってもらう案内 (2026-10-29, push-ask.js): ① 初めての投稿のあと「近くの投稿」を閉じたらカード、
// ③ 通知画面の一番上。受け取り済み・やめた人・非対応のブラウザには出さない。

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1';

async function signIn(page, label) {
  await page.goto('/');
  await expect(page.locator('#welcome')).toHaveClass(/active/);
  await page.evaluate(async (name) => {
    const { session } = await import('/static/js/session.js');
    const { api } = await import('/static/js/net.js');
    const { state } = await import('/static/js/state.js');
    const email = `${name}-${crypto.randomUUID()}@example.com`;
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await api.post('/api/local/invites/claim', { code: 'demo-invite-code-local-0001' });
    await (await import('/static/js/communities.js')).refreshCommunities();
    state.account = (await api.put('/api/account/me', { display_name: name, affiliation: 'テスト', icon_id: 'photo' })).account;
  }, label);
}

async function firstPostThenCloseNearby(page) {
  await page.evaluate(async () => (await import('/static/js/router.js')).navigate('#/post?first=1'));
  await page.locator('#composeBody').fill('休日に公園を散歩しながら季節の花を撮影しています。写真の仲間を探しています。');
  await page.locator('#composeNext').click();
  await page.locator('#composeMotivation').fill('60');
  await page.locator('#composeNext2').click();
  await page.locator('#composeSubmit').click();
  await expect(page.locator('#map')).toHaveClass(/active/, { timeout: 30000 });
  await page.locator('#nearbyClose').click({ timeout: 30000 });
}

const goTo = (page, hash) => page.evaluate(async (target) => (await import('/static/js/router.js')).navigate(target), hash);

// CI's headless Chromium answers Notification.permission with 'denied' (a phone that refused, which is
// rightly never asked). A phone that was never asked says 'default': make this browser one of those.
const neverAsked = (page) => page.addInitScript(() => {
  try { Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'default' }); } catch { /* none */ }
});

test('after the first post the card asks once; 「あとで」 ends it, and the 通知 screen still says so', async ({ page }) => {
  await neverAsked(page);
  await signIn(page, 'push-ask');
  await firstPostThenCloseNearby(page);
  const card = page.locator('#sheet.on #pushAsk');
  await expect(card).toBeVisible({ timeout: 10000 });
  await expect(card.locator('.stack-title')).toHaveText('反応が来たら、お知らせします');
  await expect(card.locator('#pushAccept')).toHaveText('通知を受け取る');
  await card.locator('#pushLater').click();
  await expect(page.locator('#sheet')).not.toHaveClass(/on/);
  expect(await page.evaluate(() => localStorage.getItem('islands.push.later'))).toBe('1');

  await goTo(page, '#/notifications');
  const row = page.locator('#notifPush');
  await expect(row).toContainText('いまは、スマホに通知が届きません');
  await expect(row).toContainText('反応やメッセージに気づけるよう、通知を受け取ってください');
  await expect(row.locator('#notifPushButton')).toHaveText('通知を受け取る');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Back on the map, nothing asks again.
  await goTo(page, '#/map');
  await page.waitForTimeout(1500);
  await expect(page.locator('#sheet.on #pushAsk')).toHaveCount(0);
});

test('a device where やめる was pressed is not asked anywhere', async ({ page }) => {
  await neverAsked(page);
  await signIn(page, 'push-off');
  await page.evaluate(() => localStorage.setItem('islands.push.off', '1'));
  await firstPostThenCloseNearby(page);
  await page.waitForTimeout(1500);
  await expect(page.locator('#sheet.on #pushAsk')).toHaveCount(0);
  await goTo(page, '#/notifications');
  await expect(page.locator('#notifications')).toHaveClass(/active/);
  await page.waitForTimeout(500);
  await expect(page.locator('#notifPush')).toHaveCount(0);
});

test.describe('iPhone Safari', () => {
  test.use({ userAgent: IPHONE_SAFARI, hasTouch: true });

  test('the card shows the Home Screen steps, and 通知 opens them with 閉じる', async ({ page }) => {
    await signIn(page, 'push-ios');
    await firstPostThenCloseNearby(page);
    const card = page.locator('#sheet.on #pushAsk');
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.locator('.ios-step')).toHaveCount(3);
    await expect(card.locator('.ios-step').nth(2)).toContainText('ホーム画面から開いてログイン');
    await expect(card.locator('#pushAccept')).toHaveCount(0);
    await expect(card.locator('#pushLater')).toHaveText('あとで');
    await card.locator('#pushLater').click();

    await goTo(page, '#/notifications');
    const row = page.locator('#notifPush');
    await expect(row).toContainText('iPhone は、ホーム画面に追加すると届くようになります');
    await row.locator('#notifPushButton').click();
    await expect(page.locator('#sheet.on #pushAsk .ios-step')).toHaveCount(3);
    await expect(page.locator('#pushLater')).toHaveText('閉じる');
  });
});
