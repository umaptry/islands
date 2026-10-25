// 「話してみたい」（名前は /api/config の talk.label）と両思いの DM、投稿を直接開くリンク。
// ボタンは「人」のもの: 押せるのはプロフィールだけで、投稿カードには出ない（2026-10-25）。
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

const myId = (who) => who.page.evaluate(async () => (await import('/static/js/state.js')).state.account.id);

// 押すボタンはプロフィールだけにある。
async function openProfile(who, accountId) {
  await who.page.goto(`/#/u/${accountId}`);
  await expect(who.page.locator('#userBody .profile-name')).toBeVisible({ timeout: 15000 });
  return who.page.locator('#userBody .post-talk-button');
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
  const { host, guest } = await setUp(browser, testInfo);
  const label = await talkLabel(guest);
  const hostId = await myId(host);
  const guestId = await myId(guest);

  // 参加者が主催者のプロフィールで押す（初回は説明が出る）
  const button = await openProfile(guest, hostId);
  await expect(button).toBeVisible({ timeout: 15000 });
  await expect(button).toHaveText(label);
  expect(label).toBe('もっと話してみたい');
  // 押す前から、相手の名前つきの小さな文が出ている
  await expect(guest.page.locator('#userBody .post-talk-note')).toHaveText('押したことは相手には見えず、お互いに押すと DM が開きます');
  await button.click();
  await expect(guest.page.locator('.modal')).toContainText('お互いに押したときだけ DM が開通します');
  await guest.page.locator('.modal .btn:not(.btn-quiet)').click();
  await expect(button).toHaveAttribute('data-state', 'pressed');
  await expect(button).toContainText('（押しました）');
  await expect(guest.page.locator('#userBody .post-talk-note')).toHaveText('主催のあきさんも押すと DM が開きます。もう一度押すと取り消せます');

  // 主催者の側では、参加者のプロフィールで「押されていない」ように見える。
  const hostButton = await openProfile(host, guestId);
  await expect(hostButton).toBeVisible({ timeout: 15000 });
  await expect(hostButton).toHaveAttribute('data-state', 'none');
  await hostButton.click();
  await host.page.locator('.modal .btn:not(.btn-quiet)').click();
  await expect(hostButton).toHaveAttribute('data-state', 'matched', { timeout: 8000 });
  await expect(hostButton).toHaveText('DM を開く');
  await expect(host.page.locator('#userBody .post-talk-note')).toHaveText('参加のべんさんと、お互いに押しました');

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
  const { host, guest } = await setUp(browser, testInfo);
  const label = await talkLabel(host);

  const pressed = await openProfile(guest, await myId(host));
  await pressed.click();
  await guest.page.locator('.modal .btn:not(.btn-quiet)').click();
  await expect(pressed).toHaveAttribute('data-state', 'pressed');

  await host.page.goto('/#/notifications');
  const notice = host.page.locator('.notif').first();
  await expect(notice).toContainText(`誰かが、あなたと${label}と言っています`);
  await expect(notice).toContainText('誰かが、あなたともっと話してみたいと言っています');
  const text = await notice.innerText();
  expect(text).not.toContain('参加のべん');
  expect(text).not.toContain('ほか');
  // 行き先の案内は、プロフィールを指す
  await expect(notice).toContainText('同じコミュニティの人のプロフィールから押せます');
  expect(text).not.toContain('地図で');

  // もう一度押すと取り消しの確認。やめる → 押したまま。取り消す → 元に戻る。
  await openProfile(guest, await myId(host));
  await expect(pressed).toHaveAttribute('data-state', 'pressed', { timeout: 15000 });
  await pressed.click();
  await expect(guest.page.locator('.modal')).toContainText('取り消');
  await guest.page.locator('.modal .btn-quiet').click();
  await expect(pressed).toHaveAttribute('data-state', 'pressed');
  await pressed.click();
  await guest.page.locator('.modal .btn:not(.btn-quiet)').click();
  await expect(pressed).toHaveAttribute('data-state', 'none');

  await host.context.close();
  await guest.context.close();
});

test('プロフィールのボタン: 名前のすぐ下にあり、3つの状態と取り消しの確認がある', async ({ browser }, testInfo) => {
  const { host, guest } = await setUp(browser, testInfo);
  const label = await talkLabel(guest);
  const hostId = await myId(host);
  const guestId = await myId(guest);
  const profileButton = (who) => who.page.locator('#userBody .post-talk-button');
  const profileNote = (who) => who.page.locator('#userBody .post-talk-note');

  // 自分のプロフィールには出ない
  await guest.page.goto('/#/me');
  await guest.page.waitForTimeout(800);
  await expect(guest.page.locator('.post-talk-button:visible')).toHaveCount(0);

  // 会の仲間のプロフィール: まだ押していない（押す前から小さな文が出る）
  await guest.page.goto(`/#/u/${hostId}`);
  await expect(profileButton(guest)).toBeVisible({ timeout: 15000 });
  await expect(profileButton(guest)).toHaveText(label);
  await expect(profileButton(guest)).toHaveAttribute('data-state', 'none');
  await expect(profileNote(guest)).toHaveText('押したことは相手には見えず、お互いに押すと DM が開きます');

  // 押す（初回の説明つき）→ プロフィールが「押しました」
  await profileButton(guest).click();
  await expect(guest.page.locator('.modal')).toContainText('お互いに押したときだけ DM が開通します');
  await guest.page.locator('.modal .btn:not(.btn-quiet)').click();
  await expect(profileButton(guest)).toHaveAttribute('data-state', 'pressed');
  await expect(profileButton(guest)).toContainText('（押しました）');
  await expect(profileNote(guest)).toHaveText('主催のあきさんも押すと DM が開きます。もう一度押すと取り消せます');

  // 名前のすぐ下（名前の次の要素）にある
  const nextToName = await guest.page.evaluate(() => document.querySelector('#userBody .profile-name').nextElementSibling.className);
  expect(nextToName).toContain('profile-talk');

  // 取り消しの確認。プロフィールで取り消すと元に戻る
  await guest.page.goto(`/#/u/${hostId}`);
  await expect(profileButton(guest)).toHaveAttribute('data-state', 'pressed', { timeout: 15000 });
  await profileButton(guest).click();
  await expect(guest.page.locator('.modal')).toContainText('取り消');
  await guest.page.locator('.modal .btn-quiet').click();
  await expect(profileButton(guest)).toHaveAttribute('data-state', 'pressed');
  await profileButton(guest).click();
  await guest.page.locator('.modal .btn:not(.btn-quiet)').click();
  await expect(profileButton(guest)).toHaveAttribute('data-state', 'none');

  // 押し直す → 相手がプロフィールで押すと両思い。DM を開く
  await guest.page.goto(`/#/u/${hostId}`);
  await expect(profileButton(guest)).toHaveAttribute('data-state', 'none', { timeout: 15000 });
  await profileButton(guest).click();
  await expect(profileButton(guest)).toHaveAttribute('data-state', 'pressed');
  await host.page.goto(`/#/u/${guestId}`);
  await expect(profileButton(host)).toHaveAttribute('data-state', 'none', { timeout: 15000 });
  await profileButton(host).click();
  await host.page.locator('.modal .btn:not(.btn-quiet)').click();
  await expect(profileButton(host)).toHaveAttribute('data-state', 'matched', { timeout: 8000 });
  await expect(profileButton(host)).toHaveText('DM を開く');
  await expect(profileNote(host)).toHaveText('参加のべんさんと、お互いに押しました');
  await host.page.goto(`/#/u/${guestId}`);
  await expect(profileButton(host)).toHaveAttribute('data-state', 'matched', { timeout: 15000 });
  await profileButton(host).click();
  await expect(host.page.locator('#dmRoom')).toHaveClass(/active/);

  expect(await guest.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await host.context.close();
  await guest.context.close();
});

test('投稿カードには押すボタンが出ない（参加者どうしでも）。アイコンと名前はプロフィールを開く', async ({ browser }, testInfo) => {
  const { host, guest, eventId, guestPostId } = await setUp(browser, testInfo);
  const guestId = await myId(guest);
  const none = (who) => who.page.locator('.post-card .post-talk, .post-card .post-talk-button, #sheet .post-talk-button');

  // 地図の下から出るカード: 参加者から主催者の投稿、主催者から参加者の投稿。ボタンは出ない。
  await openPostCard(guest, eventId);
  await guest.page.waitForTimeout(800);
  await expect(none(guest)).toHaveCount(0);
  await openPostCard(host, guestPostId);
  await host.page.waitForTimeout(800);
  await expect(none(host)).toHaveCount(0);

  // アイコン・名前を押すと、その人のプロフィール
  await host.page.locator('#sheet .post-author').click();
  await expect(host.page).toHaveURL(new RegExp(`#/u/${guestId}`));
  await expect(host.page.locator('#userBody .profile-name')).toContainText('参加のべん', { timeout: 15000 });
  // そこにはボタンがある。プロフィールの投稿カードにはない。
  await expect(host.page.locator('#userBody .post-talk-button')).toBeVisible({ timeout: 15000 });
  await expect(host.page.locator('#userBody .post-card').first()).toBeVisible();
  await expect(host.page.locator('#userBody .post-card .post-talk-button')).toHaveCount(0);
  await expect(host.page.locator('#userBody .post-card .post-talk')).toHaveCount(0);
  // プロフィールのカードの名前を押しても、同じ人のプロフィール
  await host.page.locator('#userBody .post-card .post-author').first().click();
  await expect(host.page).toHaveURL(new RegExp(`#/u/${guestId}`));

  // 自分のページのカードにも出ない。名前を押すと自分のページ
  await host.page.goto('/#/me');
  await expect(host.page.locator('#meBody .post-card').first()).toBeVisible({ timeout: 15000 });
  await expect(host.page.locator('#meBody .post-card .post-talk-button')).toHaveCount(0);
  await host.page.locator('#meBody .post-card .post-author').first().click();
  await expect(host.page).toHaveURL(/#\/me/);

  await host.context.close();
  await guest.context.close();
});

test('会の仲間でない人と、ログインしていない人のプロフィールにはボタンが出ない', async ({ browser }, testInfo) => {
  const { host, guest } = await setUp(browser, testInfo);
  const stranger = await newPerson(browser, testInfo, '通りすがり');
  const hostId = await myId(host);
  await stranger.page.goto(`/#/u/${hostId}`);
  await expect(stranger.page.locator('#userBody .profile-name')).toContainText('主催のあき', { timeout: 15000 });
  await stranger.page.waitForTimeout(800);
  await expect(stranger.page.locator('#userBody .post-talk:not([hidden])')).toHaveCount(0);

  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  await page.goto(`/#/u/${hostId}`);
  await page.waitForTimeout(1500);
  await expect(page.locator('#userBody .post-talk:not([hidden])')).toHaveCount(0);

  await context.close();
  await stranger.context.close();
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

// 2026-10-26: 押せる相手は「同じコミュニティのメンバー」。会（参加者募集中）に一緒に参加していなくても押せる。
// コミュニティの外の人には、ボタンが出ない。
test('同じコミュニティなら、会に参加していなくても押せる。外の人には出ない', async ({ browser }, testInfo) => {
  const owner = await newPerson(browser, testInfo, '世話役のさき');
  const member = await newPerson(browser, testInfo, '仲間のたく');
  const outsider = await newPerson(browser, testInfo, '外のゆい');
  const cid = await owner.page.evaluate(async () => {
    const { api } = await import('/static/js/net.js');
    const made = await api.post('/api/local/communities', { name: '読書会', slug: `t-${Math.random().toString(36).slice(2, 9)}` },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } });
    return made.community_id;
  });
  const invite = await owner.page.evaluate(async (id) => (await import('/static/js/net.js')).api.post('/api/local/invites',
    { community_id: id, minutes: 120, until_end_of_day: false }), cid);
  await member.page.evaluate(async (code) => (await import('/static/js/net.js')).api.post('/api/local/invites/claim', { code }), invite.code);
  const ownerId = await myId(owner);

  const button = await openProfile(member, ownerId);
  await expect(button).toBeVisible({ timeout: 15000 });
  await button.click();
  await expect(member.page.locator('.modal')).toContainText('お互いに押したときだけ DM が開通します');
  await member.page.locator('.modal .btn:not(.btn-quiet)').click();
  await expect(button).toHaveAttribute('data-state', 'pressed');

  // 外の人のプロフィールでは、ボタンは隠れたまま（押せる相手の一覧が読めてからも出てこない）。
  const outside = await openProfile(outsider, ownerId);
  await outsider.page.waitForFunction(async () => Boolean((await import('/static/js/state.js')).state.talk.at), null, { timeout: 15000 });
  await expect(outside).toBeHidden();
  await owner.context.close();
  await member.context.close();
  await outsider.context.close();
});
