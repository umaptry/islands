import { test, expect } from '@playwright/test';

// 投稿へのメッセージ (2026-10-29): 「↩ 返信する」はメッセージの下。返信は、もとのメッセージの下に一段下げて
// 折りたたむ（YouTube のコメント欄）。返信への返信は同じ会話に @名前 つきで入り、その人に通知が届く。
// 名前・アイコンを押すと、その人のプロフィールが開く。

const unique = () => Math.random().toString(36).slice(2, 7);

async function person(page, name) {
  const email = `${name}-${unique()}@example.com`;
  const otp = await (await page.request.post('/api/local/auth/otp', { data: { email } })).json();
  const got = await (await page.request.post('/api/local/auth/verify', { data: { email, code: otp.code } })).json();
  const headers = { Authorization: `Bearer ${got.access_token}` };
  const account = (await (await page.request.put('/api/account/me', {
    data: { display_name: name, icon_id: 'photo', affiliation: 'テスト', name_confirmed: true }, headers,
  })).json()).account;
  await page.request.post('/api/local/invites/claim', { data: { code: 'demo-invite-code-local-0001' }, headers });
  const mine = await (await page.request.get('/api/local/communities/mine', { headers })).json();
  return { headers, id: account.id, community: mine.communities[0].id || mine.communities[0].community_id };
}

async function say(page, who, postId, body, replyTo = null) {
  const response = await page.request.post('/api/local/comments', {
    data: { post_id: postId, body, ...(replyTo ? { reply_to: replyTo } : {}) }, headers: who.headers,
  });
  const row = await response.json();
  return row.id || row.comment?.id;
}

async function signIn(page, name) {
  await page.goto('/');
  await expect(page.locator('#welcome')).toHaveClass(/active/);
  return page.evaluate(async (label) => {
    const { session } = await import('/static/js/session.js');
    const { api } = await import('/static/js/net.js');
    const { state } = await import('/static/js/state.js');
    const email = `${label}-${crypto.randomUUID()}@example.com`;
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await api.post('/api/local/invites/claim', { code: 'demo-invite-code-local-0001' });
    await (await import('/static/js/communities.js')).refreshCommunities();
    state.account = (await api.put('/api/account/me', { display_name: label, icon_id: 'photo', affiliation: 'テスト', name_confirmed: true })).account;
    return state.account.id;
  }, name);
}

async function openThread(page, postId) {
  await page.evaluate(async (id) => {
    await (await import('/static/js/router.js')).navigate('#/map');
    await (await import('/static/js/screens/map.js')).openOnMap(id);
    (await import('/static/js/ui.js')).expandSheet(true);
  }, postId);
  await expect(page.locator('#sheet.on .chat-line').first()).toBeVisible({ timeout: 30000 });
}

async function setUp(page) {
  const owner = await person(page, `たくみ${unique()}`);
  const haruka = await person(page, `はるか${unique()}`);
  const post = await (await page.request.post('/api/posts', {
    data: { body: '週末にロードバイクで海沿いを走っています。一緒に走れる人を探しています。', tags: [], motivation: 70, community_id: owner.community },
    headers: owner.headers,
  })).json();
  return { owner, haruka, postId: post.id || post.post?.id };
}

test('answers fold under their message; an answer to an answer joins it with @名前 and tells that person', async ({ page }) => {
  const { owner, haruka, postId } = await setUp(page);
  const c1 = await say(page, haruka, postId, '初心者でも参加できますか？');
  const r1 = await say(page, owner, postId, 'もちろんです。ゆっくり走ります。', c1);
  await signIn(page, `みなと${unique()}`);
  await openThread(page, postId);

  const top = page.locator(`.chat-line[data-comment-id="${c1}"]`);
  await expect(top.locator('.chat-reply')).toHaveText('返信する');
  const show = page.locator(`.chat-thread-open[data-thread="${c1}"]`);
  const hide = page.locator(`.chat-thread-close[data-thread="${c1}"]`);
  await expect(show).toHaveText('返信 1件を見る');
  await expect(hide).toBeHidden();
  const answer = page.locator(`.chat-replies .chat-line[data-comment-id="${r1}"]`);
  await expect(answer).toBeHidden();
  await show.click();
  await expect(answer).toBeVisible();
  await expect(show).toBeHidden();
  // 「返信を閉じる」 is under the last answer.
  await expect(hide).toHaveText('返信を閉じる');
  expect((await hide.boundingBox()).y).toBeGreaterThan((await answer.boundingBox()).y);
  await hide.click();
  await expect(answer).toBeHidden();
  await expect(show).toBeVisible();
  await show.click();
  // One step in from the message it answers.
  const [topBox, answerBox] = [await top.boundingBox(), await answer.boundingBox()];
  expect(answerBox.x).toBeGreaterThan(topBox.x + 20);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // 返信する on the answer: the bar names its writer, and the new message lands in the same thread with @名前.
  await answer.locator('.chat-reply').click();
  await expect(page.locator('.chat-reply-bar')).toBeVisible();
  await expect(page.locator('.chat-reply-text')).toContainText('さんへ返信');
  await page.locator('.chat-input').fill('クロスバイクでも大丈夫ですか？');
  await page.locator('.chat-send').click();
  const mine = page.locator('.chat-replies .chat-line', { hasText: 'クロスバイクでも大丈夫ですか？' });
  await expect(mine).toBeVisible({ timeout: 15000 });
  await expect(mine.locator('.chat-at')).toContainText('@たくみ');
  await expect(hide).toBeVisible();

  // The person answered is told (a 'reply' row), not only the post's author.
  await expect.poll(async () => {
    const feed = await (await page.request.get('/api/local/notifications/feed?limit=20', { headers: owner.headers })).json();
    return feed.notifications.some((row) => row.type === 'reply');
  }, { timeout: 15000 }).toBe(true);
});

test('a thread where somebody answered me is open from the start', async ({ page }) => {
  const { owner, postId } = await setUp(page);
  await signIn(page, `あおい${unique()}`);
  const c1 = await page.evaluate(async (id) => (await (await import('/static/js/net.js')).data.addComment(id, '何時ごろ集合ですか？')).id, postId);
  await say(page, owner, postId, '朝7時に駅前です！', c1);
  await openThread(page, postId);
  await expect(page.locator('.chat-replies .chat-line', { hasText: '朝7時に駅前です！' })).toBeVisible();
  await expect(page.locator(`.chat-thread-close[data-thread="${c1}"]`)).toBeVisible();
  // My own message has no 返信する.
  await expect(page.locator(`.chat-line[data-comment-id="${c1}"] .chat-reply`)).toHaveCount(0);
});

test('the name and the face of a message open that person\'s page', async ({ page }) => {
  const { haruka, postId } = await setUp(page);
  await say(page, haruka, postId, 'いいですね！');
  await signIn(page, `そら${unique()}`);
  await openThread(page, postId);
  await page.locator('.chat-line', { hasText: 'いいですね！' }).locator('.chat-who:not(.chat-face)').click();
  await expect(page.locator('#user')).toHaveClass(/active/);
  expect(await page.evaluate(() => location.hash)).toBe(`#/u/${haruka.id}`);
  // Back on the map, the post opens again (as from a post card's author).
  await page.goBack();
  await expect(page.locator('#map')).toHaveClass(/active/);
  await expect(page.locator('#sheet.on .post-card')).toBeVisible({ timeout: 30000 });
  await page.evaluate(async () => (await import('/static/js/ui.js')).expandSheet(true));
  await page.locator('#sheet.on .chat-line', { hasText: 'いいですね！' }).locator('.chat-face').click({ timeout: 30000 });
  await expect(page.locator('#user')).toHaveClass(/active/);
});
