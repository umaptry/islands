// DM の既読を端から端まで確かめる（2026-10-31）。手元モード、ブラウザ2つで2人。差し替えなし（本物の markDmRead / dmReadState を使う）。
import { test, expect } from '@playwright/test';

// 2人と5秒ごとのポーリングを待つので重い。確かめることは画面の幅で変わらないため、390px だけで流す
// （CI のブラウザテストは 45 分で打ち切られる。2026-10-31 の最終チェック）。
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== '390px', '2人で使う既読の確認は 390px だけで流す');
});

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
const readMark = (who) => thread(who).locator('.dm-read');

test('相手が部屋を開くまで既読は出ず、開いたあと次のポーリングで出る', async ({ browser }, testInfo) => {
  test.setTimeout(150000);
  const { host, guest, roomId } = await matchedRoom(browser, testInfo);
  await say(host, roomId, 'こんにちは');
  await openRoom(host, roomId);
  await expect(thread(host).locator('.dm-line.mine')).toHaveCount(1, { timeout: 15000 });
  // 相手がまだ開いていない間は出ない（ポーリング1回ぶん待つ）
  await host.page.waitForTimeout(6500);
  await expect(readMark(host)).toHaveCount(0);
  // 相手が開く
  await openRoom(guest, roomId);
  await expect(readMark(host)).toHaveCount(1, { timeout: 20000 });
  await expect(readMark(host)).toHaveText('既読');
  // 吹き出しの左、時刻の上
  const line = thread(host).locator('.dm-line.mine').first();
  const readBox = await line.locator('.dm-read').boundingBox();
  const timeBox = await line.locator('.dm-time').boundingBox();
  const bubbleBox = await line.locator('.dm-bubble').boundingBox();
  expect(readBox.x + readBox.width).toBeLessThanOrEqual(bubbleBox.x + 1);
  expect(readBox.y).toBeLessThan(timeBox.y);
  // 相手の画面には自分のメッセージの「既読」は出ない
  await expect(readMark(guest)).toHaveCount(0);
  // 相手が部屋を出たあとに送ったものには、相手がまた読むまで出ない（開いたままなら読まれるので出てよい）
  await guest.page.goto('/#/map');
  await expect(guest.page.locator('#map')).toHaveClass(/active/);
  await say(host, roomId, 'つづき');
  await expect(thread(host).locator('.dm-line.mine')).toHaveCount(2, { timeout: 15000 });
  await host.page.waitForTimeout(6500);   // ポーリング1回ぶん待ってから確かめる
  await expect(thread(host).locator('.dm-line.mine', { hasText: 'つづき' }).locator('.dm-read')).toHaveCount(0);
  await host.context.close();
  await guest.context.close();
});

test('ブロックのあとに相手が開いても、既読は付かない', async ({ browser }, testInfo) => {
  test.setTimeout(150000);
  const { host, guest, roomId } = await matchedRoom(browser, testInfo);
  await say(host, roomId, 'こんにちは');
  const hostId = await myId(host);
  await guest.page.evaluate(async (id) => (await import('/static/js/net.js')).data.block(id), hostId);
  await openRoom(host, roomId);
  await expect(thread(host).locator('.dm-line.mine')).toHaveCount(1, { timeout: 15000 });
  await guest.page.goto(`/#/dm/${roomId}`);
  await expect(guest.page.locator('.dm-blocked')).toBeVisible({ timeout: 15000 });
  await host.page.waitForTimeout(12000);   // ポーリング2回以上
  await expect(readMark(host)).toHaveCount(0);
  await host.context.close();
  await guest.context.close();
});

test('既読が付いたあとにブロックされても、既読は消えない（ブロックされたことが分からない）', async ({ browser }, testInfo) => {
  test.setTimeout(150000);
  const { host, guest, roomId } = await matchedRoom(browser, testInfo);
  await say(host, roomId, 'こんにちは');
  await openRoom(host, roomId);
  await expect(thread(host).locator('.dm-line.mine')).toHaveCount(1, { timeout: 15000 });
  await openRoom(guest, roomId);
  await expect(readMark(host)).toHaveCount(1, { timeout: 20000 });
  // 相手（guest）が host をブロックする
  const hostId = await myId(host);
  await guest.page.evaluate(async (id) => (await import('/static/js/net.js')).data.block(id), hostId);
  // すでに同じ部屋を開いているので、いったん離れてから開き直す（ブロック中の画面にする）
  await guest.page.goto('/#/map');
  await expect(guest.page.locator('#map')).toHaveClass(/active/);
  await guest.page.goto(`/#/dm/${roomId}`);
  await expect(guest.page.locator('.dm-blocked')).toBeVisible({ timeout: 15000 });
  await host.page.waitForTimeout(12000);   // ポーリング2回以上
  await expect(readMark(host)).toHaveCount(1);
  await expect(readMark(host)).toHaveText('既読');
  await host.context.close();
  await guest.context.close();
});

test('相手の画面が隠れている間は記録されず、見えるようになると既読になる', async ({ browser }, testInfo) => {
  test.setTimeout(150000);
  const { host, guest, roomId } = await matchedRoom(browser, testInfo);
  await say(host, roomId, 'こんにちは');
  // guest のページは「隠れている」ことにする（document.hidden / visibilityState を差し替える）
  await guest.page.addInitScript(() => {
    window.__fakeHidden = true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__fakeHidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__fakeHidden });
  });
  await openRoom(host, roomId);
  await expect(thread(host).locator('.dm-line.mine')).toHaveCount(1, { timeout: 15000 });
  await guest.page.goto(`/#/dm/${roomId}`);
  await expect(guest.page.locator('#dmThread .dm-intro')).toBeVisible({ timeout: 15000 });
  await expect(thread(guest).locator('.dm-line')).toHaveCount(1);
  await host.page.waitForTimeout(12000);
  await expect(readMark(host)).toHaveCount(0);
  // 見えるようになった
  await guest.page.evaluate(() => {
    window.__fakeHidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(readMark(host)).toHaveCount(1, { timeout: 20000 });
  await host.context.close();
  await guest.context.close();
});
