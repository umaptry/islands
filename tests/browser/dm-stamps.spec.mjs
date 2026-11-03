// DM の時刻・日付の区切り・既読（2026-10-31）。既読の仕組み本体は別の枝なので、data.markDmRead / data.dmReadState を差し替えて画面のつなぎこみを確かめる。
// 手元モードのサーバーに、ブラウザ2つ（主催者と参加者）でつなぐ。
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
    await api.put('/api/account/me', { display_name: name, affiliation: 'テスト', name_confirmed: true, icon_id: 'photo' });
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


const thread = (who) => who.page.locator('#dmThread');

test('時刻は吹き出しの横の下端、続けた行は詰まり、日付の区切りが出る', async ({ browser }, testInfo) => {
  test.setTimeout(120000);
  const { host, guest, roomId } = await matchedRoom(browser, testInfo);
  await say(host, roomId, 'いち');
  await say(host, roomId, 'に');
  await say(host, roomId, 'さん');
  await say(guest, roomId, 'へんじ');
  // いちばん古い1件を「昨日」の夜に見せる（画面に届く手前で書き換える）
  await host.page.route('**/api/local/dm/rooms/*/messages**', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (json.messages && json.messages[0]) {
      const at = new Date(); at.setDate(at.getDate() - 1); at.setHours(22, 41, 0, 0);
      json.messages[0].created_at = at.toISOString();
    }
    await route.fulfill({ response, json });
  });
  await openRoom(host, roomId);
  await expect(thread(host).locator('.dm-line')).toHaveCount(4, { timeout: 15000 });

  await expect(thread(host).locator('.dm-day-label')).toHaveText(['昨日', '今日']);

  const second = thread(host).locator('.dm-line', { hasText: 'に' }).first();
  await expect(second.locator('.dm-time')).toHaveText(/^\d{1,2}:\d{2}$/);
  await expect(thread(host).locator('.dm-line', { hasText: 'いち' }).locator('.dm-time')).toHaveText('22:41');
  const bubbleBox = await second.locator('.dm-bubble').boundingBox();
  const timeBox = await second.locator('.dm-time').boundingBox();
  expect(timeBox.x + timeBox.width).toBeLessThanOrEqual(bubbleBox.x + 1);
  expect(Math.abs((timeBox.y + timeBox.height) - (bubbleBox.y + bubbleBox.height))).toBeLessThanOrEqual(6);
  const theirs = thread(host).locator('.dm-line:not(.mine)');
  const theirBubble = await theirs.locator('.dm-bubble').boundingBox();
  const theirTime = await theirs.locator('.dm-time').boundingBox();
  expect(theirTime.x).toBeGreaterThanOrEqual(theirBubble.x + theirBubble.width - 1);
  expect(Math.abs((theirTime.y + theirTime.height) - (theirBubble.y + theirBubble.height))).toBeLessThanOrEqual(6);

  const lines = await thread(host).locator('.dm-line .dm-bubble').evaluateAll(
    (nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
  const gap = (a, b) => lines[b].top - lines[a].bottom;
  expect(gap(1, 2)).toBeGreaterThan(2);
  expect(gap(1, 2)).toBeLessThanOrEqual(8);
  expect(gap(2, 3)).toBeGreaterThan(gap(1, 2));

  await host.page.goto('/#/dm');
  await expect(host.page.locator('.dm-row .dm-row-time').first()).toBeVisible();
  await host.context.close();
  await guest.context.close();
});

test('リアクションのチップが次の行とぶつからない', async ({ browser }, testInfo) => {
  test.setTimeout(120000);
  const { host, guest, roomId } = await matchedRoom(browser, testInfo);
  await say(host, roomId, 'まえ');
  await say(host, roomId, 'うえ');
  await say(host, roomId, 'つぎ');
  await openRoom(host, roomId);
  await expect(thread(host).locator('.dm-line')).toHaveCount(3, { timeout: 15000 });
  await hold(host, thread(host).locator('.dm-line', { hasText: 'うえ' }).locator('.dm-bubble'));
  await host.page.locator('.dm-react-btn[data-kind="heart"]').click();
  const chip = thread(host).locator('.dm-line', { hasText: 'うえ' }).locator('.dm-chip').first();
  await expect(chip).toBeVisible();
  const chipBox = await chip.boundingBox();
  const next = await thread(host).locator('.dm-line', { hasText: 'つぎ' }).locator('.dm-bubble').boundingBox();
  expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(next.y);
  await host.context.close();
  await guest.context.close();
});

test('既読: 相手が読んだ時刻までの自分のメッセージにだけ出て、記録の呼び出しは必要なときだけ', async ({ browser }, testInfo) => {
  // ポーリングを待つので重い。確かめることは幅で変わらないため 390px だけ（CI の 45 分の制限）
  test.skip(testInfo.project.name !== '390px', '既読の呼び出しの確認は 390px だけで流す');
  test.setTimeout(120000);
  const { host, guest, roomId } = await matchedRoom(browser, testInfo);
  await say(host, roomId, 'よんだ');
  await say(host, roomId, 'まだ');
  await say(guest, roomId, 'こんにちは');
  await host.page.goto('/?again=1#/dm');
  await expect(host.page.locator('#dmList')).toHaveClass(/active/);
  await host.page.evaluate(async () => {
    const { data } = await import('/static/js/net.js');
    window.__marks = 0;
    window.__readAt = null;
    data.markDmRead = async () => { window.__marks += 1; };
    data.dmReadState = async () => ({ partner_read_at: window.__readAt });
  });
  await host.page.evaluate((id) => { location.hash = `#/dm/${id}`; }, roomId);
  await expect(thread(host).locator('.dm-line')).toHaveCount(3, { timeout: 15000 });
  await expect(thread(host).locator('.dm-read')).toHaveCount(0);
  expect(await host.page.evaluate(() => window.__marks)).toBe(1);
  await host.page.waitForTimeout(5600);
  expect(await host.page.evaluate(() => window.__marks)).toBe(1);

  const stamps = await host.page.evaluate(async (id) =>
    (await (await import('/static/js/net.js')).data.dmMessages(id, null)).map((m) => m.created_at), roomId);
  await host.page.evaluate((at) => { window.__readAt = at; }, stamps[0]);
  await expect(thread(host).locator('.dm-read')).toHaveCount(1, { timeout: 12000 });
  await expect(thread(host).locator('.dm-line', { hasText: 'よんだ' }).locator('.dm-read')).toHaveText('既読');
  await expect(thread(host).locator('.dm-line', { hasText: 'まだ' }).locator('.dm-read')).toHaveCount(0);
  await host.page.evaluate((at) => { window.__readAt = at; }, stamps[1]);
  await expect(thread(host).locator('.dm-read')).toHaveCount(2, { timeout: 12000 });
  const read = await thread(host).locator('.dm-line', { hasText: 'よんだ' }).locator('.dm-read').boundingBox();
  const time = await thread(host).locator('.dm-line', { hasText: 'よんだ' }).locator('.dm-time').boundingBox();
  expect(read.y + read.height).toBeLessThanOrEqual(time.y + 2);

  await say(guest, roomId, 'もうひとつ');
  await expect(thread(host).locator('.dm-line', { hasText: 'もうひとつ' })).toBeVisible({ timeout: 12000 });
  await expect.poll(() => host.page.evaluate(() => window.__marks)).toBe(2);
  await host.context.close();
  await guest.context.close();
});

test('既読の関数が失敗しても、DM は普通に開いて「既読」は出ない', async ({ browser }, testInfo) => {
  test.setTimeout(120000);
  const { host, guest, roomId } = await matchedRoom(browser, testInfo);
  await say(host, roomId, 'ひとつめ');
  await say(guest, roomId, 'ふたつめ');
  await host.page.goto('/?again=1#/dm');
  await expect(host.page.locator('#dmList')).toHaveClass(/active/);
  await host.page.evaluate(async () => {
    const { data } = await import('/static/js/net.js');
    data.markDmRead = async () => { throw new Error('boom'); };
    data.dmReadState = async () => { throw new Error('boom'); };
  });
  await host.page.evaluate((id) => { location.hash = `#/dm/${id}`; }, roomId);
  await expect(thread(host).locator('.dm-line')).toHaveCount(2, { timeout: 15000 });
  await expect(thread(host).locator('.dm-read')).toHaveCount(0);
  await host.context.close();
  await guest.context.close();
});
