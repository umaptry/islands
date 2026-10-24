// 「話してみたい」（名前は /api/config の talk.label）と両思いの DM、投稿を直接開くリンク。
// 手元モードのサーバーに、ブラウザ2つ（主催者と参加者）でつなぐ。
import { test, expect } from '@playwright/test';

const SECOND = 'Idempotency-Key';

async function newPerson(browser, testInfo, name) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('#welcome')).toHaveClass(/active/);
  const email = `${name}-${crypto.randomUUID()}@example.com`;
  await page.evaluate(async ({ email, name }) => {
    const { session } = await import('/static/js/session.js');
    const { api } = await import('/static/js/net.js');
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await api.put('/api/account/me', { display_name: name, icon_id: 'photo' });
  }, { email, name });
  // セッションを持ったまま、もう一度ページを起こす。
  await page.goto('/?again=1#/map');
  await expect(page.locator('#map')).toHaveClass(/active/);
  return { page, context, name };
}

const post = (who, body, tags) => who.page.evaluate(async ({ body, tags, key }) => {
  const { api } = await import('/static/js/net.js');
  const made = await api.post('/api/posts', { body, tags, motivation: 55 }, { headers: { [key]: crypto.randomUUID() } });
  return made.id;
}, { body, tags, key: SECOND });

const join = (who, postId) => who.page.evaluate(async (id) => {
  const { data } = await import('/static/js/net.js');
  await data.addReaction(id, 'join');
}, postId);

const talkLabel = (who) => who.page.evaluate(async () => (await import('/static/js/config.js')).config().talk.label);

async function openPostCard(who, postId) {
  await who.page.goto(`/#/map?post=${postId}`);
  await who.page.locator('#sheet.on .post-card').waitFor({ timeout: 15000 });
}

async function setUp(browser, testInfo) {
  const host = await newPerson(browser, testInfo, '主催のあき');
  const guest = await newPerson(browser, testInfo, '参加のべん');
  const eventId = await post(host, '土曜の朝にみんなで公園ランニングをする会です', ['参加者募集中']);
  const guestPostId = await post(guest, '週末はコーヒー豆を焙煎して過ごしています', []);
  await join(guest, eventId);
  return { host, guest, eventId, guestPostId };
}

test('お互いに押すと両方に通知が届き、DM で1往復でき、ブロックすると送れない', async ({ browser }, testInfo) => {
  const { host, guest, eventId, guestPostId } = await setUp(browser, testInfo);
  const label = await talkLabel(guest);

  // 参加者が主催者の投稿で押す（初回は説明が出る）
  await openPostCard(guest, eventId);
  const button = guest.page.locator('.post-talk-button');
  await expect(button).toBeVisible();
  await expect(button).toHaveText(label);
  await button.click();
  await expect(guest.page.locator('.modal')).toContainText('お互いに押したときだけ DM が開通します');
  await guest.page.locator('.modal .btn:not(.btn-quiet)').click();
  await expect(button).toHaveAttribute('data-state', 'pressed');
  await expect(button).toContainText('（押しました）');
  await expect(guest.page.locator('.post-talk-note')).toContainText('押したことは相手には見えません');

  // 主催者は自分の投稿にはボタンが出ない。参加者の投稿では「押されていない」ように見える。
  await openPostCard(host, eventId);
  await host.page.waitForTimeout(800);
  await expect(host.page.locator('.post-talk:not([hidden])')).toHaveCount(0);
  await openPostCard(host, guestPostId);
  const hostButton = host.page.locator('.post-talk-button');
  await expect(hostButton).toBeVisible();
  await expect(hostButton).toHaveAttribute('data-state', 'none');
  await hostButton.click();
  await host.page.locator('.modal .btn:not(.btn-quiet)').click();
  await expect(hostButton).toHaveAttribute('data-state', 'matched', { timeout: 8000 });
  await expect(hostButton).toHaveText('DM を開く');

  // 両方に、名前つきの両思いの通知
  await guest.page.goto('/#/notifications');
  await expect(guest.page.locator('.notif', { hasText: '主催のあきさんと、お互いに' })).toBeVisible();
  await expect(guest.page.locator('.notif', { hasText: 'DMが開きました' })).toBeVisible();
  await host.page.goto('/#/notifications');
  await expect(host.page.locator('.notif', { hasText: '参加のべんさんと、お互いに' })).toBeVisible();

  // 通知から部屋へ
  await host.page.locator('.notif', { hasText: 'お互いに' }).first().click();
  await expect(host.page.locator('#dmRoom')).toHaveClass(/active/);
  await expect(host.page.locator('.dm-intro')).toContainText(`お互いに『${label}』を押しました`);
  await expect(host.page.locator('.dm-intro')).toContainText('2人だけ');

  // 1往復（5秒ごとの確認で相手に届く）
  await guest.page.goto('/#/dm');
  await guest.page.locator('.dm-row').first().click();
  await expect(guest.page.locator('#dmRoom .dm-intro')).toBeVisible();
  await host.page.locator('#dmFoot .chat-input').fill('はじめまして、土曜は来られそうですか？');
  await host.page.locator('#dmFoot .chat-send').click();
  await expect(host.page.locator('.dm-line.mine .dm-bubble').first()).toContainText('土曜は来られそう');
  await expect(guest.page.locator('.dm-line:not(.mine) .dm-bubble').first()).toContainText('土曜は来られそう', { timeout: 12000 });
  await guest.page.locator('#dmFoot .chat-input').fill('行きます！楽しみです');
  await guest.page.locator('#dmFoot .chat-send').click();
  await expect(host.page.locator('.dm-line:not(.mine) .dm-bubble').first()).toContainText('楽しみです', { timeout: 12000 });

  // ブロックすると、相手からは送れない（ブロックのことは知らされない）
  await host.page.locator('#dmRoomBlock').click();
  await host.page.locator('.modal .btn-danger').click();
  await expect(host.page.locator('.dm-blocked')).toBeVisible();
  await guest.page.locator('#dmFoot .chat-input').fill('届いてますか？');
  await guest.page.locator('#dmFoot .chat-send').click();
  await expect(guest.page.locator('#toast')).not.toBeEmpty();
  expect(await guest.page.locator('#toast').innerText()).not.toContain('ブロック');
  await expect(guest.page.locator('.dm-bubble', { hasText: '届いてますか' })).toHaveCount(0);
  // 自分の側からも送れず、解除すれば入力欄が戻る
  await expect(host.page.locator('#dmFoot .chat-input')).toHaveCount(0);
  await host.page.locator('#dmRoomBlock').click();
  await expect(host.page.locator('#dmFoot .chat-input')).toBeVisible();

  expect(await host.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await host.context.close();
  await guest.context.close();
});

test('片思いの通知には名前も人数も出ず、押した人は取り消せる', async ({ browser }, testInfo) => {
  const { host, guest, eventId } = await setUp(browser, testInfo);
  const label = await talkLabel(host);

  await openPostCard(guest, eventId);
  await guest.page.locator('.post-talk-button').click();
  await guest.page.locator('.modal .btn:not(.btn-quiet)').click();
  await expect(guest.page.locator('.post-talk-button')).toHaveAttribute('data-state', 'pressed');

  await host.page.goto('/#/notifications');
  const notice = host.page.locator('.notif').first();
  await expect(notice).toContainText(`誰かが、あなたと${label}と言っています`);
  const text = await notice.innerText();
  expect(text).not.toContain('参加のべん');
  expect(text).not.toContain('ほか');

  // もう一度押すと取り消しの確認。やめる → 押したまま。取り消す → 元に戻る。
  await guest.page.locator('.post-talk-button').click();
  await expect(guest.page.locator('.modal')).toContainText('取り消');
  await guest.page.locator('.modal .btn-quiet').click();
  await expect(guest.page.locator('.post-talk-button')).toHaveAttribute('data-state', 'pressed');
  await guest.page.locator('.post-talk-button').click();
  await guest.page.locator('.modal .btn:not(.btn-quiet)').click();
  await expect(guest.page.locator('.post-talk-button')).toHaveAttribute('data-state', 'none');

  await host.context.close();
  await guest.context.close();
});

test('#/map?post=<id> で投稿が開く（未ログインでも、ログインしたあとに戻れる）', async ({ browser }, testInfo) => {
  const { host, guest, eventId } = await setUp(browser, testInfo);
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  await page.goto(`/#/map?post=${eventId}`);
  await expect(page.locator('#sheet.on .post-body')).toContainText('公園ランニング', { timeout: 15000 });
  await expect(page.locator('.post-talk-button')).toHaveCount(0);

  // 登録・ログインの途中でも失わない
  await page.evaluate(() => { location.hash = '#/post'; });
  await expect(page.locator('#auth')).toHaveClass(/active/);
  await page.evaluate(async () => {
    const { session } = await import('/static/js/session.js');
    const { api } = await import('/static/js/net.js');
    const email = `back-${crypto.randomUUID()}@example.com`;
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await api.put('/api/account/me', { display_name: 'もどる', icon_id: 'photo' });
    const { afterSignIn } = await import('/static/js/screens/auth.js');
    await afterSignIn();
  });
  await expect(page.locator('#sheet.on .post-body')).toContainText('公園ランニング', { timeout: 15000 });
  expect(page.url()).toContain(`post=${eventId}`);

  await context.close();
  await host.context.close();
  await guest.context.close();
});
