// ほかのコミュニティにも出す（2026-10-29）: 1つの投稿を、自分が入っている別のコミュニティの地図にも出す。
// メンバー限定（members_only）のスイッチが「入」のサーバー（ISLANDS_LOCAL_MEMBERS_ONLY=1 の手元モード）でだけ動く。
// 「切」のサーバー（CI）では、出す欄が出ないことだけを確かめる。
import { test, expect } from '@playwright/test';

const unique = () => Math.random().toString(36).slice(2, 10);

let switchedOn = false;
test.beforeAll(async ({ request }) => {
  const config = await (await request.get('/api/config')).json();
  switchedOn = config.features?.members_only === true && config.features?.share === true;
});

async function person(browser, testInfo, name) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/') && response.status() >= 500) problems.push(`${response.status()} ${url.pathname}`);
  });
  await page.goto('/');
  await expect(page.locator('#welcome')).toHaveClass(/active/);
  const email = `${name}-${crypto.randomUUID()}@example.com`;
  await page.evaluate(async ({ email, name }) => {
    const { session } = await import('/static/js/session.js');
    const { api } = await import('/static/js/net.js');
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await api.put('/api/account/me', { display_name: name, affiliation: 'テスト', icon_id: 'photo' });
  }, { email, name });
  const id = await page.evaluate(async () => (await import('/static/js/session.js')).session.userId());
  return { context, page, problems, id, name };
}

const call = (who, method, path, body) => who.page.evaluate(async ({ method, path, body }) => {
  const { api } = await import('/static/js/net.js');
  return method === 'get' ? api.get(path) : api.post(path, body, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
}, { method, path, body });

const makeCommunity = async (who, name) => {
  const made = await call(who, 'post', '/api/local/communities', { name, slug: `s-${unique()}` });
  return { id: made.community_id, name: made.name };
};

async function bringIn(admin, communityId, guest) {
  const invite = await call(admin, 'post', '/api/local/invites', { community_id: communityId, minutes: 60, until_end_of_day: false });
  await call(guest, 'post', '/api/local/invites/claim', { code: invite.code });
}

const makePost = (who, communityId, body, extra = {}) => call(who, 'post', '/api/posts',
  { body, tags: [], motivation: 55, community_id: communityId, ...extra });

const shot = (page, testInfo, name) => (testInfo.project.name === '390px'
  ? page.screenshot({ path: `output/share-shots/${name}.png` }) : Promise.resolve());

test('スイッチ「切」: 編集画面に「ほかのコミュニティにも出す」は出ない', async ({ browser }, testInfo) => {
  test.skip(switchedOn, 'スイッチ「入」のサーバーでは出す欄がある');
  const host = await person(browser, testInfo, 'ホスト');
  const post = await call(host, 'post', '/api/posts', { body: `朝の散歩 ${unique()}`, tags: [], motivation: 50 });
  await host.page.goto(`/?s=${unique()}#/post/${post.id}/edit`);
  await expect(host.page.locator('#compose')).toHaveClass(/active/);
  await expect(host.page.locator('#composeShare')).toBeHidden();
  expect(host.problems).toEqual([]);
  await host.context.close();
});

test('編集画面から出す → プロフィールは1枚に2つの名前 → 片方だけ外す', async ({ browser }, testInfo) => {
  test.skip(!switchedOn, 'メンバー限定のスイッチが「入」のサーバーでだけ');
  test.setTimeout(120000);
  const host = await person(browser, testInfo, 'ホスト');
  const guest = await person(browser, testInfo, 'ゲスト');
  const north = await makeCommunity(host, `北の会${unique().slice(0, 3)}`);
  const south = await makeCommunity(host, `南の会${unique().slice(0, 3)}`);
  await bringIn(host, south.id, guest);
  const body = `週末に川沿いを自転車で走っています ${unique().slice(0, 4)}`;
  const post = await makePost(host, north.id, body);

  // 編集画面: 南の会だけが選べる（北の会はこの投稿のコミュニティ）。
  await host.page.goto(`/?e=${unique()}#/post/${post.id}/edit`);
  await expect(host.page.locator('#compose')).toHaveClass(/active/);
  // 3つのステップ（2026-10-27）: 出す欄は ③ にある。編集では熱量は答え済みなので、そのまま進める。
  await host.page.locator('#composeNext').click();
  await host.page.locator('#composeNext2').click();
  const box = host.page.locator('#composeShare');
  await expect(box).toBeVisible();
  await expect(box.locator('.check')).toHaveCount(1);
  await expect(box.locator('.check')).toContainText(south.name);
  await box.locator('.check').click();
  await expect(box.locator('.check')).toHaveAttribute('aria-checked', 'true');
  await box.scrollIntoViewIfNeeded();
  await shot(host.page, testInfo, '1_編集画面_ほかのコミュニティにも出す');
  await host.page.locator('#composeSubmit').click();
  await expect(host.page.locator('#toast')).toContainText(`${south.name}にも出しました`);

  // 自分のプロフィール: 1枚のカードに2つのコミュニティの名前。
  await host.page.goto(`/?m=${unique()}#/me`);
  const card = host.page.locator('#me .post-card', { hasText: body });
  await expect(card).toHaveCount(1);
  await expect(card.locator('.post-community')).toContainText(north.name);
  await expect(card.locator('.post-community')).toContainText(south.name);
  await expect(host.page.locator('#me .profile-tab').first()).toContainText('1');
  await card.scrollIntoViewIfNeeded();
  await shot(host.page, testInfo, '2_プロフィール_1枚に2つの名前');

  // 南の会だけの人から見ると、南の会の分だけ。
  await guest.page.goto(`/?u=${unique()}#/u/${host.id}`);
  const seen = guest.page.locator('#user .post-card', { hasText: body });
  await expect(seen).toHaveCount(1);
  await expect(seen.locator('.post-community')).toHaveText(south.name);

  // もう一度編集画面を開くと、南の会は「出しています」。
  await host.page.goto(`/?e2=${unique()}#/post/${post.id}/edit`);
  await host.page.locator('#composeNext').click();
  await host.page.locator('#composeNext2').click();
  await expect(host.page.locator('#composeShare .check.fixed')).toContainText('出しています');

  // 削除: 3つの答え。片方だけ外すと、カードはもう片方の名前だけになる。
  await host.page.goto(`/?d=${unique()}#/me`);
  const mine = host.page.locator('#me .post-card', { hasText: body });
  await mine.locator('.post-menu .icon-button').click();
  await mine.locator('.post-menu-item.danger').click();
  const dialog = host.page.locator('.modal');
  await expect(dialog).toContainText(`${north.name}・${south.name}に出しています`);
  await expect(dialog.locator('.btn')).toHaveCount(3);
  await shot(host.page, testInfo, '3_削除_このコミュニティだけ外す');
  await expect(dialog.locator('.btn', { hasText: 'だけ外す' })).toHaveCount(1);
  await dialog.locator('.btn', { hasText: 'だけ外す' }).click();
  await expect(host.page.locator('#toast')).toContainText('削除しました');
  await host.page.goto(`/?d2=${unique()}#/me`);
  await expect(host.page.locator('#me .post-card', { hasText: body })).toHaveCount(1);
  await expect(host.page.locator('#me .post-card', { hasText: body }).locator('.post-community')).not.toContainText('・');

  expect(host.problems).toEqual([]);
  expect(guest.problems).toEqual([]);
  await host.context.close();
  await guest.context.close();
});

test('参加者募集中を出す: 先着人数は出したコミュニティの合計で数える', async ({ browser }, testInfo) => {
  test.skip(!switchedOn, 'メンバー限定のスイッチが「入」のサーバーでだけ');
  test.setTimeout(120000);
  const host = await person(browser, testInfo, 'ホスト');
  const northGuest = await person(browser, testInfo, '北の人');
  const southGuest = await person(browser, testInfo, '南の人');
  const north = await makeCommunity(host, `北${unique().slice(0, 3)}`);
  const south = await makeCommunity(host, `南${unique().slice(0, 3)}`);
  await bringIn(host, north.id, northGuest);
  await bringIn(host, south.id, southGuest);
  const config = await call(host, 'get', '/api/config');
  const post = await makePost(host, north.id, `日曜の朝に公園でゆっくりジョギング ${unique().slice(0, 4)}`,
    { tags: [config.tags.find((tag) => tag === '参加者募集中')], recruit_capacity: 1 });
  const shared = await call(host, 'post', `/api/posts/${post.id}/share`, { community_ids: [south.id] });
  const copy = shared.posts.find((row) => row.community_id === south.id);
  await call(northGuest, 'post', '/api/local/reactions', { post_id: post.id, kind: 'join' });

  // 南の人の地図: 北で1人参加したので、先着1人は満員。
  await southGuest.page.goto(`/?p=${unique()}#/map?post=${copy.id}`);
  const card = southGuest.page.locator('#sheet.on .post-card');
  await card.waitFor({ timeout: 30000 });
  await expect(card.locator('.post-join-button')).toContainText('満員');
  await expect(card.locator('.post-join-button')).toContainText('ほかのコミュニティの参加も含む');
  await expect(card.locator('.post-join-button')).toContainText('現在1人参加');
  await shot(southGuest.page, testInfo, '4_募集_合計で満員');
  expect(southGuest.problems).toEqual([]);
  for (const who of [host, northGuest, southGuest]) await who.context.close();
});
