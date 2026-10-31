// 新しい住人のキャッチアップ（2026-10-26）: 地図が出たとき、未読の「新しい住人」の通知を
// 1枚ずつ見せる。サーバー側の通知づくりはまだ別なので、通知一覧だけを偽のデータに差し替える。
import { test, expect } from '@playwright/test';

const unique = () => Math.random().toString(36).slice(2, 10);
const KEY = 'Idempotency-Key';

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
    await api.put('/api/account/me', { display_name: name, affiliation: 'テスト', name_confirmed: true, icon_id: 'photo' });
    if (create) return api.post('/api/local/communities', { name: create, slug: `t-${Math.random().toString(36).slice(2, 9)}` }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
    if (join) await api.post('/api/local/invites/claim', { code: join });
    return null;
  }, { email, name, create, join });
  return { page, context, name, made };
}

// Two people in one community: the one on the map, and the one who moved in.
async function pair(browser, testInfo) {
  const me = await person(browser, testInfo, '住人係', { create: 'キャンプ会' });
  const cid = me.made.community_id;
  const invite = await me.page.evaluate(async (id) => (await import('/static/js/net.js')).api.post('/api/local/invites', { community_id: id, minutes: 120, until_end_of_day: false }), cid);
  const other = await person(browser, testInfo, 'はなさん', { join: invite.code });
  return { me, other, cid };
}

const makePost = (who, body, cid) => who.page.evaluate(async ({ body, key, cid }) => {
  const { api } = await import('/static/js/net.js');
  const made = await api.post('/api/posts', { body, tags: [], motivation: 55, community_id: cid }, { headers: { [key]: crypto.randomUUID() } });
  return made.id;
}, { body, key: KEY, cid });

const residentRow = (n, postId, name, cid) => ({
  id: `res-${n}`, ids: [`res-${n}`], type: 'island', unread: true, others: 0, post_id: postId,
  actor_id: `actor-${n}`, actors: [{ id: `actor-${n}`, display_name: name, icon_id: '3', avatar_path: null }],
  community_id: cid, created_at: `2026-10-26T10:0${n}:00Z`,
  payload: { kind: 'resident', name: 'キャンプ島', cause: `${name}さんが引っ越してきました` },
});

test('キャッチアップ: 未読の新しい住人を1枚ずつ見て、最後は地図にもどる。見た分は既読になる', async ({ browser }, testInfo) => {
  const { me, other, cid } = await pair(browser, testInfo);
  const first = await makePost(other, 'キャンプが好きです。週末に山へ行きます。', cid);
  const second = await makePost(other, '二つ目の投稿です。', cid);
  const reads = [];
  await me.page.route('**/api/local/notifications/read', (route) => {
    reads.push(route.request().postDataJSON());
    route.fulfill({ json: { updated: 1 } });
  });
  await me.page.route('**/api/local/notifications/feed*', (route) => route.fulfill({
    json: { notifications: [residentRow(2, second, 'さくら', cid), residentRow(1, first, 'はな', cid)], unread: 2, settings: {} },
  }));
  await me.page.goto(`/?m=${unique()}#/map`);

  const box = me.page.locator('#catchup');
  await expect(box).toBeVisible();
  await expect(box).toContainText('はなさんがキャンプ島の住人になりました');   // oldest first
  await expect(box).toContainText('キャンプが好きです');
  await expect(box.locator('.catchup-step')).toHaveText('1 / 2');

  await me.page.keyboard.press('ArrowRight');
  await expect(box.locator('.catchup-step')).toHaveText('2 / 2');
  await expect(box).toContainText('さくらさんがキャンプ島の住人になりました');
  await expect(box.locator('.catchup-next')).toHaveText('地図にもどる');
  await expect(box.locator('.catchup-slide')).toHaveCount(1);

  await box.locator('.catchup-next').click();
  await expect(box).toBeHidden();
  expect(reads.flatMap((body) => body.ids).sort()).toEqual(['res-1', 'res-2']);

  // Once seen in this page, it does not come back when the app returns to the front.
  await me.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await me.page.waitForTimeout(500);
  await expect(box).toBeHidden();
  await me.context.close();
  await other.context.close();
});

test('キャッチアップ: スワイプで進み、×で途中でやめられる。残りも既読になる', async ({ browser }, testInfo) => {
  const { me, other, cid } = await pair(browser, testInfo);
  const first = await makePost(other, '一つ目の投稿です。海辺でコーヒーを飲みたい。', cid);
  const second = await makePost(other, '二つ目の投稿です。山でキャンプをしたい。', cid);
  const reads = [];
  await me.page.route('**/api/local/notifications/read', (route) => {
    reads.push(route.request().postDataJSON());
    route.fulfill({ json: { updated: 1 } });
  });
  await me.page.route('**/api/local/notifications/feed*', (route) => route.fulfill({
    json: { notifications: [residentRow(2, second, 'さくら', cid), residentRow(1, first, 'はな', cid)], unread: 2, settings: {} },
  }));
  await me.page.goto(`/?m=${unique()}#/map`);
  const box = me.page.locator('#catchup');
  await expect(box).toBeVisible();
  const view = await box.locator('.catchup-view').boundingBox();
  const x = view.x + view.width * 0.8;
  const y = view.y + view.height / 2;
  await me.page.mouse.move(x, y);
  await me.page.mouse.down();
  await me.page.mouse.move(x - 120, y, { steps: 5 });
  await me.page.mouse.up();
  await expect(box.locator('.catchup-step')).toHaveText('2 / 2');
  await box.locator('.catchup-close').click();
  await expect(box).toBeHidden();
  expect(reads.flatMap((body) => body.ids).sort()).toEqual(['res-1', 'res-2']);
  await me.context.close();
  await other.context.close();
});

// With the server's own rows (no stand-in list): a resident posts, a newcomer posts on the same island, and the
// resident's map shows the catch-up. The island also carries its intro and its residents' faces.
test('キャッチアップ（サーバーとつないで）: 同じ島に新しい人が投稿すると、住人の地図に出る', async ({ browser }, testInfo) => {
  const { me, other, cid } = await pair(browser, testInfo);
  const mine = await makePost(me, '週末はソロキャンプに出かけて、焚き火を眺めながら静かに過ごすのが好きです。', cid);
  const theirs = await makePost(other, '山で野営をするのが趣味で、薪を割って火をおこす時間がいちばん落ち着きます。', cid);

  const island = await me.page.evaluate(async ({ cid, mine, theirs }) => {
    const { api } = await import('/static/js/net.js');
    const islands = await api.get(`/api/islands?community=${cid}`);
    return (Array.isArray(islands) ? islands : islands.islands || [])
      .find((one) => (one.post_ids || []).includes(mine) && (one.post_ids || []).includes(theirs)) || null;
  }, { cid, mine, theirs });
  expect(island).not.toBeNull();
  expect(island.residents.map((one) => one.display_name)).toEqual(expect.arrayContaining(['住人係', 'はなさん']));
  expect(island).toHaveProperty('intro');

  await me.page.goto(`/?m=${unique()}#/map`);
  const box = me.page.locator('#catchup');
  await expect(box).toBeVisible({ timeout: 20000 });
  await expect(box).toContainText('はなさんが');
  await expect(box).toContainText('の住人になりました');
  await expect(box).toContainText('山で野営');
  await box.locator('.catchup-close').click();
  await expect(box).toBeHidden();
  await me.context.close();
  await other.context.close();
});
