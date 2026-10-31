// DM のメッセージへの絵文字の反応（2026-10-31）: 吹き出しを長押し → 帯とコピー → 付ける・付け替える・外す。
// 手元モードのサーバーに、ブラウザ2つ（主催者と参加者）でつなぐ。相手には5秒ごとの確認で届く。
import { test, expect } from '@playwright/test';

const SECOND = 'Idempotency-Key';

async function newPerson(browser, testInfo, name) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const page = await context.newPage();
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
  await page.goto('/?again=1#/map');
  await expect(page.locator('#map')).toHaveClass(/active/);
  return { page, context, name };
}

const myId = (who) => who.page.evaluate(async () => (await import('/static/js/state.js')).state.account.id);

/** host と guest が同じ会に入り、お互いに押して DM の部屋を開く。部屋の id を返す。 */
async function matchedRoom(browser, testInfo) {
  const host = await newPerson(browser, testInfo, '主催のあき');
  const guest = await newPerson(browser, testInfo, '参加のべん');
  const eventId = await host.page.evaluate(async (key) => {
    const { api } = await import('/static/js/net.js');
    const made = await api.post('/api/posts',
      { body: '土曜の朝にみんなで公園ランニングをする会です', tags: ['参加者募集中'], motivation: 55 },
      { headers: { [key]: crypto.randomUUID() } });
    return made.id;
  }, SECOND);
  await guest.page.evaluate(async (id) => {
    const { data } = await import('/static/js/net.js');
    await data.addReaction(id, 'join');
  }, eventId);
  const hostId = await myId(host);
  const guestId = await myId(guest);
  await guest.page.evaluate(async (id) => (await import('/static/js/net.js')).data.pressTalk(id), hostId);
  await host.page.evaluate(async (id) => (await import('/static/js/net.js')).data.pressTalk(id), guestId);
  const roomId = await host.page.evaluate(async (id) => {
    const rows = await (await import('/static/js/net.js')).data.talkState();
    return rows.find((row) => row.target === id && row.state === 'matched').room_id;
  }, guestId);
  return { host, guest, roomId };
}

const say = (who, roomId, body) => who.page.evaluate(
  async ({ roomId, body }) => (await import('/static/js/net.js')).data.sendDm(roomId, body), { roomId, body });

const openRoom = async (who, roomId) => {
  await who.page.goto(`/#/dm/${roomId}`);
  await expect(who.page.locator('#dmThread .dm-intro')).toBeVisible({ timeout: 15000 });
};

/** 吹き出しを長押しする（0.5秒で開く）。 */
async function hold(who, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  await who.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await who.page.mouse.down();
  await who.page.waitForTimeout(700);
  await who.page.mouse.up();
  await who.page.waitForTimeout(450);   // 押したあとのクリックを飲む時間
}

const bubble = (who, text) => who.page.locator('#dmThread .dm-line', { hasText: text });
const chips = (who, text) => bubble(who, text).locator('.dm-chip');

async function react(who, text, kind) {
  await hold(who, bubble(who, text).locator('.dm-bubble'));
  await who.page.locator(`.dm-react-btn[data-kind="${kind}"]`).click();
  await expect(who.page.locator('.dm-menu')).toHaveCount(0);
}

const noticeCount = (who) => who.page.evaluate(
  async () => (await (await import('/static/js/net.js')).data.listNotificationFeed(100)).length);

test('長押しで帯とコピーが出て、付ける・付け替える・外すが相手にも届く（通知は出ない）', async ({ browser }, testInfo) => {
  const { host, guest, roomId } = await matchedRoom(browser, testInfo);
  await say(host, roomId, 'こんにちは、土曜は来られますか');
  await say(guest, roomId, '行きます、楽しみです');
  await openRoom(host, roomId);
  await openRoom(guest, roomId);
  await expect(bubble(host, '楽しみです')).toBeVisible({ timeout: 12000 });
  await expect(bubble(guest, 'こんにちは、土曜')).toBeVisible({ timeout: 12000 });
  const noticesBefore = [await noticeCount(host), await noticeCount(guest)];

  // 長押し: 暗くなり、持ち上げた吹き出しの上に6つの絵文字、下にコピー。
  await hold(host, bubble(host, '楽しみです').locator('.dm-bubble'));
  await expect(host.page.locator('.dm-menu')).toBeVisible();
  await expect(host.page.locator('.dm-menu-backdrop')).toBeVisible();
  await expect(host.page.locator('.dm-react-btn')).toHaveCount(6);
  await expect(host.page.locator('.dm-react-btn').nth(0)).toHaveAttribute('aria-label', 'ハート');
  await expect(host.page.locator('.dm-lifted')).toHaveText('行きます、楽しみです');
  const bar = await host.page.locator('.dm-react-bar').boundingBox();
  const lifted = await host.page.locator('.dm-lifted').boundingBox();
  const copy = await host.page.locator('.dm-copy').boundingBox();
  expect(bar.y + bar.height).toBeLessThanOrEqual(lifted.y + 1);
  expect(copy.y).toBeGreaterThanOrEqual(lifted.y + lifted.height - 1);
  const viewport = host.page.viewportSize();
  for (const box of [bar, lifted, copy]) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  }
  // 後ろを押すと閉じる。何も付かない。
  await host.page.locator('.dm-menu-backdrop').click({ position: { x: 4, y: 4 } });
  await expect(host.page.locator('.dm-menu')).toHaveCount(0);
  await expect(host.page.locator('.dm-chip')).toHaveCount(0);

  // コピー: 本文がクリップボードへ。トーストが出る。
  await hold(host, bubble(host, '楽しみです').locator('.dm-bubble'));
  await host.page.locator('.dm-copy').click();
  await expect(host.page.locator('#toast')).toHaveText('コピーしました');
  await expect(host.page.locator('.dm-menu')).toHaveCount(0);

  // ❤️ を付ける → すぐ自分の画面に出る → 相手の画面にも（ポーリング）
  await react(host, '楽しみです', 'heart');
  await expect(chips(host, '楽しみです')).toHaveCount(1);
  await expect(chips(host, '楽しみです').first()).toHaveAttribute('data-kind', 'heart');
  await expect(chips(host, '楽しみです').first()).toHaveAttribute('data-mine', '1');
  await expect(chips(guest, '楽しみです').first()).toHaveAttribute('data-kind', 'heart', { timeout: 14000 });
  await expect(chips(guest, '楽しみです').first()).toHaveAttribute('data-mine', '0');
  // 相手の吹き出しの右下、自分の吹き出しの左下
  const hostChip = await chips(host, '楽しみです').first().boundingBox();
  const hostBubble = await bubble(host, '楽しみです').locator('.dm-bubble').boundingBox();
  expect(hostChip.x + hostChip.width / 2).toBeGreaterThan(hostBubble.x + hostBubble.width / 2);
  const guestChip = await chips(guest, '楽しみです').first().boundingBox();
  const guestBubble = await bubble(guest, '楽しみです').locator('.dm-bubble').boundingBox();
  expect(guestChip.x + guestChip.width / 2).toBeLessThan(guestBubble.x + guestBubble.width / 2);

  // 別の絵文字で付け替える（1人1つ）
  await react(host, '楽しみです', 'pray');
  await expect(chips(host, '楽しみです')).toHaveCount(1);
  await expect(chips(host, '楽しみです').first()).toHaveAttribute('data-kind', 'pray');
  await expect(chips(guest, '楽しみです').first()).toHaveAttribute('data-kind', 'pray', { timeout: 14000 });

  // 2人とも同じ絵文字なら1つと「2」
  await react(guest, '楽しみです', 'pray');
  await expect(chips(guest, '楽しみです')).toHaveCount(1);
  await expect(chips(guest, '楽しみです').first().locator('.dm-chip-count')).toHaveText('2');
  await expect(chips(host, '楽しみです').first().locator('.dm-chip-count')).toHaveText('2', { timeout: 14000 });

  // 違う絵文字なら並ぶ
  await react(guest, '楽しみです', 'laugh');
  await expect(chips(guest, '楽しみです')).toHaveCount(2);
  await expect(chips(host, '楽しみです')).toHaveCount(2, { timeout: 14000 });

  // 同じものをもう一度で外れる
  await react(host, '楽しみです', 'pray');
  await expect(chips(host, '楽しみです')).toHaveCount(1);
  await expect(chips(host, '楽しみです').first()).toHaveAttribute('data-kind', 'laugh');
  await expect(chips(guest, '楽しみです')).toHaveCount(1, { timeout: 14000 });

  // 帯では、自分が付けている絵文字が押された状態で出る
  await hold(guest, bubble(guest, '楽しみです').locator('.dm-bubble'));
  await expect(guest.page.locator('.dm-react-btn[data-kind="laugh"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(guest.page.locator('.dm-react-btn[data-kind="heart"]')).toHaveAttribute('aria-pressed', 'false');
  await guest.page.keyboard.press('Escape');
  await expect(guest.page.locator('.dm-menu')).toHaveCount(0);

  // 反応は通知にならない
  expect([await noticeCount(host), await noticeCount(guest)]).toEqual(noticesBefore);
  for (const who of [host, guest]) {
    expect(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await host.context.close();
  await guest.context.close();
});

test('反応の表が無い間は、長押しでコピーだけが出て、エラーも出ない', async ({ browser }, testInfo) => {
  const { host, guest, roomId } = await matchedRoom(browser, testInfo);
  await say(guest, roomId, 'はじめまして');
  await host.page.route('**/api/local/dm/rooms/*/reactions', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"PGRST205","message":"Could not find the table public.dm_reactions in the schema cache"}' }));
  await openRoom(host, roomId);
  await expect(bubble(host, 'はじめまして')).toBeVisible({ timeout: 12000 });
  await host.page.waitForTimeout(300);
  await hold(host, bubble(host, 'はじめまして').locator('.dm-bubble'));
  await expect(host.page.locator('.dm-copy')).toBeVisible();
  await expect(host.page.locator('.dm-lifted')).toBeVisible();
  await expect(host.page.locator('.dm-react-bar')).toHaveCount(0);
  await expect(host.page.locator('#toast.on')).toHaveCount(0);
  await host.page.locator('.dm-copy').click();
  await expect(host.page.locator('#toast')).toHaveText('コピーしました');
  await host.context.close();
  await guest.context.close();
});

test('付けられなかったときは元に戻して知らせる', async ({ browser }, testInfo) => {
  const { host, guest, roomId } = await matchedRoom(browser, testInfo);
  await say(guest, roomId, 'お疲れさまです');
  await host.page.route('**/api/local/dm/messages/*/reaction', (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: '{"detail":"このメッセージには反応できません。"}' }));
  await openRoom(host, roomId);
  await expect(bubble(host, 'お疲れさまです')).toBeVisible({ timeout: 12000 });
  await react(host, 'お疲れさまです', 'heart');
  await expect(host.page.locator('#toast')).toHaveText('このメッセージには反応できません。');
  await expect(chips(host, 'お疲れさまです')).toHaveCount(0);
  await host.context.close();
  await guest.context.close();
});
