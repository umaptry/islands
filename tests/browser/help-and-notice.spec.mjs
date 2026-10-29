// 手伝えるかも は「助けてほしい」の投稿だけ / 2回目の投稿でもお題は4つ / つながりの通知（type match）の表示（2026-10-29）。
// 通知の行はサーバー側がまだ別なので、一覧の返事を page.route で差し替える。
import { test, expect } from '@playwright/test';

async function person(browser, testInfo, name, { create = null, join = null } = {}) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('#welcome')).toHaveClass(/active/);
  const email = `${name}-${crypto.randomUUID()}@example.com`;
  const made = await page.evaluate(async ({ email, name, create, join }) => {
    const { session } = await import('/static/js/session.js');
    const { api } = await import('/static/js/net.js');
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await api.put('/api/account/me', { display_name: name, affiliation: 'テスト', icon_id: '1' });
    if (create) return api.post('/api/local/communities', { name: create, slug: `t-${Math.random().toString(36).slice(2, 9)}` }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
    if (join) await api.post('/api/local/invites/claim', { code: join });
    return null;
  }, { email, name, create, join });
  return { page, context, name, made };
}

async function pair(browser, testInfo) {
  const me = await person(browser, testInfo, 'みる人', { create: 'テスト会' });
  const cid = me.made.community_id;
  const invite = await me.page.evaluate(async (id) => (await import('/static/js/net.js')).api.post('/api/local/invites', { community_id: id, minutes: 120, until_end_of_day: false }), cid);
  const other = await person(browser, testInfo, 'おく人', { join: invite.code });
  return { me, other, cid };
}

const makePost = (who, body, cid, tags = []) => who.page.evaluate(async ({ body, cid, tags }) => {
  const { api } = await import('/static/js/net.js');
  const made = await api.post('/api/posts', { body, tags, motivation: 55, community_id: cid }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  return made.id;
}, { body, cid, tags });

const openPost = async (page, id) => {
  await page.evaluate(async (postId) => {
    const { navigate } = await import('/static/js/router.js');
    await navigate('#/map');
    const { openOnMap } = await import('/static/js/screens/map.js');
    await openOnMap(postId);
  }, id);
  await expect(page.locator(`#sheet.on .post-card[data-post-id="${id}"]`)).toBeVisible({ timeout: 20000 });
};

test('手伝えるかも: タグなしの他人の投稿には無く、助けてほしいの投稿には有る', async ({ browser }, testInfo) => {
  const { me, other, cid } = await pair(browser, testInfo);
  const plain = await makePost(other, '週末は川沿いを走っています。', cid);
  const asking = await makePost(other, 'ミニトマトがうまく育ちません。', cid, ['助けてほしい']);
  await me.page.reload();
  await openPost(me.page, plain);
  await expect(me.page.locator('#sheet [data-reaction="like"]')).toBeVisible();
  await expect(me.page.locator('#sheet [data-reaction="help"]')).toHaveCount(0);
  await me.page.locator('#sheetClose').click();
  await openPost(me.page, asking);
  await expect(me.page.locator('#sheet [data-reaction="help"]')).toBeVisible();
  await me.context.close();
  await other.context.close();
});

test('2回目の投稿でもお題チップは4つ、困ってることで助けてほしいが付く', async ({ browser }, testInfo) => {
  const { me, cid } = await pair(browser, testInfo);
  await makePost(me, '最初の投稿です。', cid);
  await me.page.reload();
  await me.page.evaluate(async () => (await import('/static/js/router.js')).navigate('#/post'));
  const chips = me.page.locator('#composeExtraPromptList .extra-chip');
  await expect(chips).toHaveText(['昔がんばってたこと', '最近やってること', '今度やってみたいこと', '困ってること']);
  await chips.nth(3).click();
  await expect(me.page.locator('#composeTags .check[data-tag="助けてほしい"]')).toHaveAttribute('aria-checked', 'true');
  await me.context.close();
});

test('つながりの通知: 一覧に理由の文で出て、押すと地図でその投稿が開く', async ({ browser }, testInfo) => {
  const { me, other, cid } = await pair(browser, testInfo);
  const postId = await makePost(other, '公園で花の写真を撮るのが趣味です。', cid);
  await me.page.route('**/api/local/notifications/feed*', (route) => route.fulfill({
    json: {
      notifications: [{
        id: 'match-1', ids: ['match-1'], type: 'match', unread: true, others: 0, post_id: postId,
        actor_id: 'actor-1', actors: [{ id: 'actor-1', display_name: 'おく人', icon_id: '1', avatar_path: null }],
        community_id: cid, created_at: new Date().toISOString(),
        payload: { kind: 'need_have', other_post: 'q', reason: 'あなたの困りごとに、経験のある人が投稿しました' },
      }],
      unread: 1, settings: {},
    },
  }));
  await me.page.route('**/api/local/notifications/read', (route) => route.fulfill({ json: { updated: 1 } }));
  await me.page.goto('/?m=1#/notifications');
  const row = me.page.locator('.notif').first();
  await expect(row).toContainText('あなたの困りごとに、経験のある人が投稿しました');
  await expect(row).toContainText('おく人');
  await row.click();
  await expect(me.page.locator(`#sheet.on .post-card[data-post-id="${postId}"]`)).toBeVisible({ timeout: 20000 });
  await me.context.close();
  await other.context.close();
});
