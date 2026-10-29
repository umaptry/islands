// 投稿のあとの「つながりそうな人」カード（2026-10-29, screens/map.js showMatchCards）。
// サーバーの /api/matches は手元では常に空（ISLANDS_MATCH_CARDS=0）なので、page.route で返事を差し替える。
// 相手の投稿は、別の人として本当に投稿して作る。
import { test, expect } from '@playwright/test';

const WHY = ['あなたの困りごとを、この人は経験しています', 'この人も同じことをやりたがっています', '同じ公園で写真を撮っています'];

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
    state.account = (await api.put('/api/account/me', { display_name: name, affiliation: 'テスト', icon_id: '1' })).account;
  }, label);
}

// CI's headless Chromium answers Notification.permission with 'denied'; a phone never asked says 'default'.
const neverAsked = (page) => page.addInitScript(() => {
  try { Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'default' }); } catch { /* none */ }
});

// Three other people, each with a real post in the demo community; returns the rows /api/matches would give.
async function seedMatches(page, tag) {
  const rows = [];
  const people = [
    { name: `あき${tag}`, body: '休日に公園を散歩しながら季節の花を撮影しています。', prompt: 'help' },
    { name: `いく${tag}`, body: '休日は写真を撮りながら街を歩くのが好きです。', prompt: 'future' },
    { name: `うた${tag}`, body: '公園で花の写真を撮るのが趣味です。', prompt: null },
  ];
  for (const [index, person] of people.entries()) {
    const email = `${person.name}-${Math.random().toString(36).slice(2)}@example.com`;
    const otp = await (await page.request.post('/api/local/auth/otp', { data: { email } })).json();
    const got = await (await page.request.post('/api/local/auth/verify', { data: { email, code: otp.code } })).json();
    const headers = { Authorization: `Bearer ${got.access_token}` };
    const account = (await (await page.request.put('/api/account/me', { data: { display_name: person.name, affiliation: 'テスト', icon_id: '1' }, headers })).json()).account;
    await page.request.post('/api/local/invites/claim', { data: { code: 'demo-invite-code-local-0001' }, headers });
    const mine = await (await page.request.get('/api/local/communities/mine', { headers })).json();
    const communityId = mine.communities[0].id || mine.communities[0].community_id;
    const made = await (await page.request.post('/api/posts', {
      data: { body: person.body, tags: [], motivation: 50, community_id: communityId }, headers,
    })).json();
    rows.push({
      id: made.id, author_id: account.id, display_name: person.name, icon_id: '1', avatar_path: null,
      body: person.body, tags: [], motivation: 50, x: made.x, y: made.y, cluster_id: made.cluster_id,
      similarity: 80, cosine: 0.8, shared: [], note: '', prompt: person.prompt,
      reason: WHY[index], kind: 'help_experience',
    });
  }
  return rows;
}

const answerWith = (page, rows, { delay = 0 } = {}) => page.route('**/api/matches*', async (route) => {
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  const post = new URL(route.request().url()).searchParams.get('post');
  await route.fulfill({ json: { post, matches: rows } });
});

async function write(page, body, { first = true } = {}) {
  await page.evaluate(async (isFirst) => (await import('/static/js/router.js')).navigate(isFirst ? '#/post?first=1' : '#/post'), first);
  await page.locator('#composeBody').fill(body);
  await page.locator('#composeNext').click();
  await page.locator('#composeMotivation').fill('60');
  await page.locator('#composeNext2').click();
  await page.locator('#composeSubmit').click();
  await expect(page.locator('#map')).toHaveClass(/active/, { timeout: 30000 });
}

const NO_MATCH = /^まだ、つながりそうな投稿はありません。\s*似た話が投稿されたら、通知でお知らせします$/;
const FIRST = '休日に公園を散歩しながら季節の花を撮影しています。写真を楽しめる仲間と交流してみたいです。';

test('最初の投稿のあとカードが出て、めくると 2 / 3 になり、閉じると通知の案内が出る', async ({ page }) => {
  await neverAsked(page);
  const tag = Math.random().toString(36).slice(2, 6);
  const rows = await seedMatches(page, tag);
  await answerWith(page, rows);
  await signIn(page, `match-${tag}`);
  await write(page, FIRST);

  const track = page.locator('#matchTrack');
  await expect(track).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#sheet .stack-title')).toHaveText('あなたの話とつながりそうな人');
  await expect(page.locator('#matchCount')).toHaveText('1 / 3');
  await expect(page.locator('.match-slide')).toHaveCount(3);
  await expect(page.locator('.match-slide').first().locator('.match-why')).toHaveText(WHY[0]);
  // The card is the ordinary post card: name, words, the reactions.
  const card = page.locator('.match-slide').first().locator('.post-card');
  await expect(card).toHaveAttribute('data-post-id', rows[0].id);
  await expect(card.locator('.post-author-name')).toHaveText(rows[0].display_name);
  await expect(card.locator('[data-reaction="like"]')).toBeVisible();
  // The prompt is not named on the card: the tags already say as much.
  await expect(page.locator('.match-slide .match-prompt')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await track.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);

  // Turning the page: the number and the dots follow.
  await track.evaluate((node) => node.scrollTo({ left: node.children[1].offsetLeft - node.children[0].offsetLeft }));
  await expect(page.locator('#matchCount')).toHaveText('2 / 3');
  await expect(page.locator('.match-dots i').nth(1)).toHaveClass(/on/);
  // The sheet stays short: swiping does not grow it to full height.
  await expect(page.locator('#sheet')).not.toHaveClass(/full/);

  await page.locator('#matchClose').click();
  await expect(page.locator('#sheet')).not.toHaveClass(/on/);
  // The ask to take notifications comes after the cards just as it did after the nearby posts.
  await expect(page.locator('#sheet.on #pushAsk')).toBeVisible({ timeout: 10000 });
});

const FALLBACKS = [
  ['空', (page) => page.route('**/api/matches*', (route) => route.fulfill({ json: { post: 'x', matches: [] } }))],
  ['500', (page) => page.route('**/api/matches*', (route) => route.fulfill({ status: 500, json: { detail: 'boom' } }))],
  ['4秒かかる', (page) => answerWith(page, [], { delay: 4000 })],
];
for (const [label, install] of FALLBACKS) {
  test(`/api/matches が${label}ときは、今までの「あなたの近くの投稿」`, async ({ page }) => {
    await neverAsked(page);
    await install(page);
    await signIn(page, `match-fb-${Math.random().toString(36).slice(2, 6)}`);
    await write(page, FIRST);
    await expect(page.locator('#nearbyList, #nearbyEmpty').first()).toBeVisible({ timeout: 40000 });
    await expect(page.locator('#sheet .stack-title')).toHaveText('あなたの近くの投稿');
    await expect(page.locator('#matchTrack')).toHaveCount(0);
    await expect(page.locator('#toast')).not.toHaveClass(/on/);      // the first post shows the nearest instead
    await page.locator('#nearbyClose').click();
    await expect(page.locator('#sheet.on #pushAsk')).toBeVisible({ timeout: 10000 });
  });
}

test('2回目の投稿：差し替えありならカード、なしなら自分の投稿カード', async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 6);
  const rows = await seedMatches(page, tag);
  await signIn(page, `match2-${tag}`);
  await write(page, FIRST);
  await page.locator('#nearbyClose').click({ timeout: 30000 });

  // 差し替えなし（手元のサーバーは止めてあり「unknown」）: 自分の投稿カードが開き、一文は出ない
  await write(page, '二つ目の投稿です。週末は川沿いを走っています。', { first: false });
  await expect(page.locator('#sheet.on .post-card')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#matchTrack')).toHaveCount(0);
  await expect(page.locator('#toast')).not.toHaveClass(/on/);
  await page.locator('#sheetClose').click();

  // だれもいない（サーバーの答えが空）: 自分の投稿カードに加えて、一文が出る
  await answerWith(page, []);
  await write(page, '四つ目の投稿です。猫アレルギーなので、猫カフェに行けません。', { first: false });
  await expect(page.locator('#sheet.on .post-card')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#toast.on')).toHaveText(NO_MATCH, { timeout: 10000 });
  await expect(page.locator('#matchTrack')).toHaveCount(0);
  // On a phone it stands above the own post card, not over its buttons.
  if ((page.viewportSize()?.width || 0) < 768) {
    await expect.poll(async () => {
      const [note, sheet] = await Promise.all([page.locator('#toast').boundingBox(), page.locator('#sheet').boundingBox()]);
      return note.y + note.height <= sheet.y + 1;
    }).toBe(true);
  }
  await page.locator('#sheetClose').click();

  // 差し替えあり: カード（二度目は通知の案内を増やさない）
  await answerWith(page, rows);
  await write(page, '三つ目の投稿です。休日は公園で写真を撮っています。', { first: false });
  await expect(page.locator('#matchTrack')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#matchCount')).toHaveText('1 / 3');
  await page.locator('#matchClose').click();
  await expect(page.locator('#sheet')).not.toHaveClass(/on/);
  await expect(page.locator('#pushAsk')).toHaveCount(0);
});
