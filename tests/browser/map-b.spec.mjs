// 地図B案（1つの大きな島）。手元モードのサーバーに、ブラウザでつなぐ。
// 2026-11-04 から旗（MAP_B_ENABLED）は既定でオン。①アドレスに何も付けなくても島の土台を読み、
// 地方の名前が出る ②?map=b でも同じ ③土台が503なら今までの地図のまま
import { test, expect } from '@playwright/test';

const INVITE = 'demo-invite-code-local-0001';

async function newPerson(browser, testInfo, name) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/#/invite/${INVITE}`);
  await expect(page.locator('#inviteRegister')).toBeVisible({ timeout: 20000 });
  await page.evaluate(async ({ email, name, code }) => {
    const { session } = await import('/static/js/session.js');
    const { api, data } = await import('/static/js/net.js');
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await data.claimInvite(code);
    await api.put('/api/account/me', { display_name: name, affiliation: 'テスト', name_confirmed: true, icon_id: 'photo' });
  }, { email: `${name}-${crypto.randomUUID()}@example.com`, name, code: INVITE });
  return { page, context, errors };
}

const post = (who, body) => who.page.evaluate(async (body) => {
  const { api } = await import('/static/js/net.js');
  const made = await api.post('/api/posts', { body, tags: [], motivation: 55 }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  return made.id;
}, body);

test('旗が既定でオン：?map=b を付けなくても島の土台を読み、地方の名前は地名ふう（「地方」を付けない）', async ({ browser }, testInfo) => {
  const me = await newPerson(browser, testInfo, 'はな');
  const asked = [];
  me.page.on('request', (request) => { if (request.url().includes('/api/map-b/base')) asked.push(request.url()); });
  await post(me, '朝のランニングを1年続けています。いっしょに走れる人を探しています');
  await me.page.goto('/?again=1#/map');
  await expect(me.page.locator('#map')).toHaveClass(/active/);
  await expect.poll(() => asked.length, { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(() => me.page.evaluate(async () => (await import('/static/js/map/island-b.js')).regionsB().length), { timeout: 20000 }).toBe(16);
  const texts = await me.page.evaluate(async () => {
    const island = await import('/static/js/map/island-b.js');
    const regions = await import('/static/js/map/regions-b.js');
    return island.regionsB().map((r) => regions.regionText(r));
  });
  expect(texts).toContain('食の森');
  texts.forEach((text) => expect(text).not.toContain('地方'));
  await me.page.waitForTimeout(3000);
  expect(me.errors).toEqual([]);
  await me.context.close();
});

test('?map=b で開くと島の土台を読み、16の地方があり、エラーが出ない', async ({ browser }, testInfo) => {
  const me = await newPerson(browser, testInfo, 'みなと');
  await post(me, '休みの日は山に登って写真を撮っています。同じ趣味の人と話したいです');
  await me.page.goto('/?again=1&map=b#/map');
  await expect(me.page.locator('#map')).toHaveClass(/active/);
  await expect.poll(() => me.page.evaluate(async () => {
    const island = await import('/static/js/map/island-b.js');
    return island.regionsB().length;
  }), { timeout: 20000 }).toBe(16);
  const names = await me.page.evaluate(async () => (await import('/static/js/map/island-b.js')).regionsB().map((r) => r.name));
  names.forEach((name) => expect(name.length).toBeGreaterThan(0));
  // 少し待って描かせても、エラーが出ない（地方の境界・名前・木の層）
  await me.page.waitForTimeout(3000);
  expect(me.errors).toEqual([]);
  await me.context.close();
});

test('島の土台が503のときは、今の地図のまま表示される', async ({ browser }, testInfo) => {
  const me = await newPerson(browser, testInfo, 'そら');
  await me.page.route('**/api/map-b/base', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"x"}' }));
  await post(me, '週末は海でカヤックに乗っています。いっしょに漕げる人を探しています');
  await me.page.goto('/?again=1&map=b#/map');
  await expect(me.page.locator('#map')).toHaveClass(/active/);
  await me.page.waitForTimeout(3000);
  const held = await me.page.evaluate(async () => (await import('/static/js/map/island-b.js')).islandB());
  expect(held).toBeNull();
  await expect(me.page.locator('#map canvas').first()).toBeVisible();
  expect(me.errors).toEqual([]);
  await me.context.close();
});
