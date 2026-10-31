// メンバー限定（members_only）: コミュニティの投稿は、そのコミュニティのメンバーだけが読める。
// このファイルの大半は、スイッチが「入」のサーバー（ISLANDS_LOCAL_MEMBERS_ONLY=1 で起動した手元モード）でだけ動く。
// 「切」のサーバーでは、スキップされ、これまでの見え方が変わっていないことを確かめる1本だけが動く。
import { test, expect } from '@playwright/test';

const unique = () => Math.random().toString(36).slice(2, 10);

let switchedOn = false;
test.beforeAll(async ({ request }) => {
  const config = await (await request.get('/api/config')).json();
  switchedOn = config.features?.members_only === true;
});

async function openContext(browser, testInfo) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  // 画面の中で起きた「捕まえられなかった例外」と、読み込みの失敗（401・422・5xx）を集める。
  const problems = { errors: [], failed: [], consoleErrors: [] };
  page.on('pageerror', (error) => problems.errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') problems.consoleErrors.push(message.text()); });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/') && [401, 422].includes(response.status())) {
      problems.failed.push(`${response.status()} ${url.pathname}${url.search}`);
    }
    if (url.pathname.startsWith('/api/') && response.status() >= 500) problems.failed.push(`${response.status()} ${url.pathname}`);
  });
  return { context, page, problems };
}

async function person(browser, testInfo, name) {
  const who = await openContext(browser, testInfo);
  await who.page.goto('/');
  await expect(who.page.locator('#welcome')).toHaveClass(/active/);
  const email = `${name}-${crypto.randomUUID()}@example.com`;
  await who.page.evaluate(async ({ email, name }) => {
    const { session } = await import('/static/js/session.js');
    const { api } = await import('/static/js/net.js');
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await api.put('/api/account/me', { display_name: name, affiliation: 'テスト', name_confirmed: true, icon_id: 'photo' });
  }, { email, name });
  who.name = name;
  who.id = await who.page.evaluate(async () => (await import('/static/js/session.js')).session.userId());
  return who;
}

const call = (who, method, path, body) => who.page.evaluate(async ({ method, path, body }) => {
  const { api } = await import('/static/js/net.js');
  return method === 'get' ? api.get(path) : api.post(path, body, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
}, { method, path, body });

const makeCommunity = (who, name) => call(who, 'post', '/api/local/communities', { name, slug: `t-${unique()}` });

const makePost = (who, communityId, body, tags = []) => who.page.evaluate(async ({ communityId, body, tags }) => {
  const { api } = await import('/static/js/net.js');
  const made = await api.post('/api/posts', { body, tags, motivation: 55, community_id: communityId },
    { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  return made.id;
}, { communityId, body, tags });

// 管理者が招待のコードを作り、もう1人がそれを使って入る（画面を通さない近道）。
async function bringIn(admin, communityId, guest) {
  const invite = await call(admin, 'post', '/api/local/invites', { community_id: communityId, minutes: 60, until_end_of_day: false });
  await call(guest, 'post', '/api/local/invites/claim', { code: invite.code });
  return invite;
}

const noSideScroll = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

const NOTICE = 'このコミュニティのメンバーだけが見られます';

test.describe('スイッチ「切」のとき', () => {
  test('これまでと同じ: 招待なしで地図を見られ、登録せずに見るボタンもある', async ({ browser }, testInfo) => {
    test.skip(switchedOn, 'スイッチ「入」のサーバーでは別の見え方');
    const guest = await openContext(browser, testInfo);
    await guest.page.goto('/');
    await expect(guest.page.locator('#welcome')).toHaveClass(/active/);
    await expect(guest.page.locator('#welcomeBrowse')).toBeVisible();
    await expect(guest.page.locator('#welcomeMembersNote')).toBeHidden();
    await guest.page.locator('#welcomeBrowse').click();
    await expect(guest.page.locator('#map')).toHaveClass(/active/);
    await expect(guest.page.locator('#mapNoticeTitle')).not.toContainText('メンバーだけ');
    expect(guest.problems.errors).toEqual([]);
  });
});

test.describe('スイッチ「入」のとき', () => {
  test.beforeEach(() => {
    test.skip(!switchedOn, 'スイッチ「入」のサーバー（ISLANDS_LOCAL_MEMBERS_ONLY=1）でだけ動く');
  });

  test('メンバーは、地図・島・線・点線・カード・地形を、セッションつきで読める（401・422が出ない）', async ({ browser }, testInfo) => {
    const admin = await person(browser, testInfo, 'めんばーのあき');
    const bar = await makeCommunity(admin, `BAR ${unique()}`);
    const friend = await person(browser, testInfo, 'めんばーのとも');
    await bringIn(admin, bar.community_id, friend);
    const mine = await makePost(admin, bar.community_id, '土曜の夜、BAR でゆるく飲む会をひらきます', ['参加者募集中']);
    await makePost(friend, bar.community_id, '土曜の夜に、BAR で飲むのが好きです');
    // 反応を押し合って線（航路）を作る。
    await call(friend, 'post', '/api/local/reactions', { post_id: mine, kind: 'join' });

    const seen = [];
    admin.page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/')) seen.push({ path: url.pathname, search: url.search, status: response.status() });
    });
    await admin.page.goto(`/?m=${unique()}#/map`);
    await expect(admin.page.locator('#map')).toHaveClass(/active/);
    await expect(admin.page.locator('#mapCommunity')).toContainText(bar.name);
    await expect(admin.page.locator('#mapNotice')).toBeHidden();
    await expect.poll(() => admin.page.evaluate(async () => (await import('/static/js/state.js')).state.posts.length)).toBe(2);
    await expect.poll(() => admin.page.evaluate(async () => (await import('/static/js/state.js')).state.islands.length)).toBeGreaterThan(0);
    await expect.poll(() => admin.page.evaluate(async () => (await import('/static/js/state.js')).state.connections.length)).toBeGreaterThan(0);
    // 自分の投稿の近くの人（点線）
    await expect.poll(() => admin.page.evaluate(async () => (await import('/static/js/state.js')).state.neighbors.size)).toBeGreaterThan(0);

    // 島と線は、いまのコミュニティを名指しして読んでいる。
    expect(seen.some((r) => r.path === '/api/islands' && r.search.includes(`community=${bar.community_id}`) && r.status === 200)).toBe(true);
    expect(seen.some((r) => r.path === '/api/connections' && r.search.includes(`community=${bar.community_id}`) && r.status === 200)).toBe(true);
    expect(seen.some((r) => r.path === '/api/neighbors' && r.status === 200)).toBe(true);

    // 地形は、表示範囲が投稿数の上限を超えたときだけ読む。上限を1にして、同じ道を通す。
    await admin.page.evaluate(async () => {
      const { config } = await import('/static/js/config.js');
      config().limits.map_post_limit = 1;
      const map = await import('/static/js/screens/map.js');
      await map.refreshMap();
    });
    const terrain = seen.filter((r) => r.path === '/api/terrain');
    expect(terrain.length).toBeGreaterThan(0);
    expect(terrain.every((r) => r.status === 200 && r.search.includes(`community=${bar.community_id}`))).toBe(true);

    // カードが開く（メッセージ・反応した人の一覧も）。
    await admin.page.evaluate(async (postId) => (await import('/static/js/screens/map.js')).openPost(postId), mine);
    await admin.page.locator('#sheet.on .post-card').waitFor();
    await expect(admin.page.locator('#sheet.on .post-card')).toContainText('BAR でゆるく飲む会');
    const reactors = await admin.page.evaluate(async (postId) => (await import('/static/js/net.js')).data.reactorsOf(postId, 'join'), mine);
    expect(reactors.length).toBe(1);
    await noSideScroll(admin.page);

    expect(admin.problems.failed).toEqual([]);
    expect(admin.problems.errors).toEqual([]);
    expect(admin.problems.consoleErrors).toEqual([]);
  });

  test('ログインしていない人: ようこそ画面に「登録せずに見る」は無く、招待リンクの案内が出る。地図は案内だけでエラーも出ない', async ({ browser }, testInfo) => {
    const guest = await openContext(browser, testInfo);
    await guest.page.goto('/');
    await expect(guest.page.locator('#welcome')).toHaveClass(/active/);
    await expect(guest.page.locator('#welcomeBrowse')).toBeHidden();
    await expect(guest.page.locator('#welcomeMembersNote')).toContainText('招待リンク');
    await expect(guest.page.getByText('登録せずにマップを見てみる')).toHaveCount(1);   // HTMLには残るが、見えない
    await expect(guest.page.getByText('登録せずにマップを見てみる')).toBeHidden();
    await noSideScroll(guest.page);

    await guest.page.goto(`/?s=${unique()}#/map`);
    await expect(guest.page.locator('#map')).toHaveClass(/active/);
    await expect(guest.page.locator('#mapNotice')).toBeVisible();
    await expect(guest.page.locator('#mapNoticeTitle')).toContainText('メンバーだけ');
    await expect(guest.page.locator('#mapNoticeLogin')).toBeVisible();
    await expect(guest.page.locator('#mapPost')).toBeHidden();
    await noSideScroll(guest.page);
    await guest.page.waitForTimeout(1500);   // 起動直後の読み込みが落ち着くのを待つ
    expect(guest.problems.failed).toEqual([]);
    expect(guest.problems.errors).toEqual([]);
    expect(guest.problems.consoleErrors).toEqual([]);
  });

  test('読めないリンク（ログインなし・メンバーでない・投稿がない）は、どれも同じ案内になる', async ({ browser }, testInfo) => {
    const admin = await person(browser, testInfo, 'りんくのあき');
    const secret = await makeCommunity(admin, `ひみつ ${unique()}`);
    const postId = await makePost(admin, secret.community_id, 'ここだけの話をします。メンバー以外には見えません');

    const read = async (page) => ({
      title: await page.locator('#mapNoticeTitle').innerText(),
      sub: await page.locator('#mapNoticeSub').innerText(),
    });

    // 1) ログインしていない
    const visitor = await openContext(browser, testInfo);
    await visitor.page.goto(`/?v=${unique()}#/map?post=${postId}`);
    await expect(visitor.page.locator('#mapNoticeTitle')).toHaveText(NOTICE);
    await expect(visitor.page.locator('#mapNoticeLogin')).toBeVisible();
    await expect(visitor.page.locator('#sheet.on')).toHaveCount(0);
    await expect(visitor.page.locator('body')).not.toContainText('ここだけの話');
    await noSideScroll(visitor.page);
    const signedOut = await read(visitor.page);
    expect(signedOut.sub).toContain('招待リンク');
    // ログインしたら開けるように、リンクは覚えておく。
    expect(await visitor.page.evaluate(() => localStorage.getItem('islands-return-post'))).toContain(postId);

    // 2) ログインしているが、メンバーではない
    const stranger = await person(browser, testInfo, 'そとのひと');
    await stranger.page.goto(`/?x=${unique()}#/map?post=${postId}`);
    await expect(stranger.page.locator('#mapNoticeTitle')).toHaveText(NOTICE);
    await expect(stranger.page.locator('#mapNoticeLogin')).toBeHidden();
    await expect(stranger.page.locator('#sheet.on')).toHaveCount(0);
    await expect(stranger.page.locator('body')).not.toContainText('ここだけの話');
    const outsider = await read(stranger.page);
    expect(outsider.sub).toContain('招待リンク');

    // 3) 投稿がない（存在しない id）: 「ない」とも「見られない」とも言わず、同じ言葉
    await stranger.page.goto(`/?y=${unique()}#/map?post=6f1c1b0e-5a53-4a43-9a52-3b8f0c2d9e11`);
    await expect(stranger.page.locator('#mapNoticeTitle')).toHaveText(NOTICE);
    expect(await read(stranger.page)).toEqual(outsider);
    expect(stranger.problems.errors).toEqual([]);

    // 4) 抜けた人: いったん入って、抜けたあとも同じ
    const leaver = await person(browser, testInfo, 'ぬけたひと');
    await bringIn(admin, secret.community_id, leaver);
    await leaver.page.goto(`/?l=${unique()}#/map?post=${postId}`);
    await leaver.page.locator('#sheet.on .post-card').waitFor();
    await call(leaver, 'post', `/api/local/communities/${secret.community_id}/leave`, {});
    await leaver.page.goto(`/?l2=${unique()}#/map?post=${postId}`);
    await expect(leaver.page.locator('#mapNoticeTitle')).toHaveText(NOTICE);
    await expect(leaver.page.locator('#sheet.on')).toHaveCount(0);
    expect(await read(leaver.page)).toEqual(outsider);

    // 入っている別のコミュニティがあれば、「自分の地図を見る」で戻れる。
    const other = await makeCommunity(leaver, `べつの ${unique()}`);
    await leaver.page.goto(`/?l3=${unique()}#/map?post=${postId}`);
    await expect(leaver.page.locator('#mapNoticeTitle')).toHaveText(NOTICE);
    await leaver.page.locator('#mapNoticeHome').click();
    await expect(leaver.page.locator('#mapNotice')).toBeHidden();
    await expect(leaver.page.locator('#mapCommunity')).toContainText(other.name);
  });

  test('招待リンクに投稿がついていると、入った直後にその投稿が開く（すでにアカウントのある人）', async ({ browser }, testInfo) => {
    const admin = await person(browser, testInfo, 'しょうたいのあき');
    const bar = await makeCommunity(admin, `BAR ${unique()}`);
    const postId = await makePost(admin, bar.community_id, '土曜の夜、BAR でゆるく飲む会をひらきます', ['参加者募集中']);
    const invite = await call(admin, 'post', '/api/local/invites', { community_id: bar.community_id, minutes: 60, until_end_of_day: false });

    const guest = await person(browser, testInfo, 'はいる人');
    // 入る前は読めない
    await guest.page.goto(`/?a=${unique()}#/map?post=${postId}`);
    await expect(guest.page.locator('#mapNoticeTitle')).toHaveText(NOTICE);

    await guest.page.goto(`/?b=${unique()}#/invite/${invite.code}?post=${postId}`);
    await expect(guest.page.locator('#inviteJoin')).toBeVisible();
    await guest.page.locator('#inviteJoin').click();
    await expect(guest.page.locator('#map')).toHaveClass(/active/);
    await guest.page.locator('#sheet.on .post-card').waitFor({ timeout: 20000 });
    await expect(guest.page.locator('#sheet.on .post-card')).toContainText('BAR でゆるく飲む会');
    await expect(guest.page.locator('#mapCommunity')).toContainText(bar.name);
    await expect(guest.page.locator('#mapNotice')).toBeHidden();
    expect(guest.problems.errors).toEqual([]);
  });

  test('招待リンクから新しく登録した人も、入った直後にその投稿が読める', async ({ browser }, testInfo) => {
    const admin = await person(browser, testInfo, 'しんきのあき');
    const bar = await makeCommunity(admin, `BAR ${unique()}`);
    const postId = await makePost(admin, bar.community_id, '毎週水曜に朝の散歩をしています');
    const invite = await call(admin, 'post', '/api/local/invites', { community_id: bar.community_id, minutes: 60, until_end_of_day: false });

    const guest = await openContext(browser, testInfo);
    await guest.page.goto(`/#/invite/${invite.code}?post=${postId}`);
    await expect(guest.page.locator('#invite')).toHaveClass(/active/);
    await guest.page.locator('#inviteRegister').click();
    await guest.page.locator('#registerName').fill('あたらしい人');
    await guest.page.locator('#registerAffiliation').fill('テスト');
    await guest.page.locator('#authEmail').fill(`new-${crypto.randomUUID()}@example.com`);
    await guest.page.locator('#authSend').click();
    await expect(guest.page.locator('#authDevCode .dev-code-value')).toBeVisible();
    await guest.page.locator('#authCode').fill(await guest.page.locator('#authDevCode .dev-code-value').innerText());
    await guest.page.locator('#authVerify').click();
    await expect(guest.page.locator('#setup')).toHaveClass(/active/, { timeout: 15000 });
    // 入った直後（名前を決める前）から、その投稿は読める。
    const readable = await guest.page.evaluate(async (id) => {
      const { data } = await import('/static/js/net.js');
      const post = await data.getPost(id);
      return post ? post.body : null;
    }, postId);
    expect(readable).toContain('朝の散歩');
    await guest.page.locator('#setupSave').click();
    await expect(guest.page.locator('#guidance')).toHaveClass(/active/);
    await guest.page.locator('#guidanceSkip').click();
    await expect(guest.page.locator('#compose')).toHaveClass(/active/);
    await guest.page.locator('#composeBody').fill('最近はコーヒーを自分で焙煎しています');
    await guest.page.locator('#composeNext').click();
    await guest.page.locator('#composeMotivation').evaluate((node) => { node.value = '55'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await guest.page.locator('#composeNext2').click();
    await guest.page.locator('#composeSubmit').click();
    await expect(guest.page.locator('#map')).toHaveClass(/active/, { timeout: 30000 });
    // 最初の投稿のあとは「あなたの近くの投稿」のカードが先に出る。閉じると、招待で一緒に開く投稿が開く。
    await guest.page.locator('#nearbyClose').click({ timeout: 30000 });
    await guest.page.locator('#sheet.on .post-card').waitFor({ timeout: 30000 });
    await expect(guest.page.locator('#sheet.on .post-card')).toContainText('朝の散歩');
    expect(guest.problems.errors).toEqual([]);
  });

  test('プロフィール: 他の人のページには共通のコミュニティの投稿だけ。自分のページは全部で、コミュニティ名が小さく付く', async ({ browser }, testInfo) => {
    const alice = await person(browser, testInfo, 'ありす');
    const north = await makeCommunity(alice, `北の会 ${unique()}`);
    const south = await makeCommunity(alice, `南の会 ${unique()}`);
    const northPost = await makePost(alice, north.community_id, '北の会で話したい、冬の登山の計画');
    await makePost(alice, south.community_id, '南の会で話したい、海辺のカフェめぐり');
    const bob = await person(browser, testInfo, 'ぼぶ');
    await bringIn(alice, north.community_id, bob);

    // ぼぶ → ありすのページ: 北の会の投稿だけ
    await bob.page.goto(`/?p=${unique()}#/u/${alice.id}`);
    await expect(bob.page.locator('#user .post-card')).toHaveCount(1);
    await expect(bob.page.locator('#user .post-card')).toContainText('冬の登山');
    await expect(bob.page.locator('#userBody')).not.toContainText('海辺のカフェ');
    await expect(bob.page.locator('#userBody .profile-shared-note')).toHaveText('共通のコミュニティの投稿だけが表示されます');
    await expect(bob.page.locator('#user .profile-tab-count').first()).toHaveText('1');
    await noSideScroll(bob.page);

    // メッセージのタブも、見えている投稿のぶんだけ
    await call(bob, 'post', '/api/local/comments', { post_id: northPost, body: '私も登ってみたいです' });
    await bob.page.goto(`/?p2=${unique()}#/u/${alice.id}`);
    await bob.page.locator('#user .profile-tab', { hasText: 'メッセージ' }).click();
    await expect(bob.page.locator('#user .profile-summary')).toContainText('1 件');

    // ありす自身のページ: 全部、名前つき
    await alice.page.goto(`/?q=${unique()}#/me`);
    await expect(alice.page.locator('#me .post-card')).toHaveCount(2);
    await expect(alice.page.locator('#me .post-card', { hasText: '冬の登山' }).locator('.post-community')).toHaveText(north.name);
    await expect(alice.page.locator('#me .post-card', { hasText: '海辺のカフェ' }).locator('.post-community')).toHaveText(south.name);
    await expect(alice.page.locator('#meBody .profile-shared-note')).toHaveCount(0);

    // ログインしていない人は、人のページを開いても案内だけ
    const visitor = await openContext(browser, testInfo);
    await visitor.page.goto(`/?r=${unique()}#/u/${alice.id}`);
    await expect(visitor.page.locator('#userBody .members-only-title')).toHaveText(NOTICE);
    await expect(visitor.page.locator('#userBody')).not.toContainText('冬の登山');
    expect(visitor.problems.errors).toEqual([]);
  });

  test('通知: 行ごとにコミュニティ名が小さく出て、押すとそのコミュニティの地図で投稿が開く。「話してみたい」は匿名のまま', async ({ browser }, testInfo) => {
    const alice = await person(browser, testInfo, 'つうちのあり');
    const north = await makeCommunity(alice, `北の会 ${unique()}`);
    const south = await makeCommunity(alice, `南の会 ${unique()}`);
    const northPost = await makePost(alice, north.community_id, '北の会で話したい、冬の登山の計画');
    await makePost(alice, south.community_id, '南の会で話したい、海辺のカフェめぐり');
    const bob = await person(browser, testInfo, 'つうちのぼ');
    await bringIn(alice, north.community_id, bob);
    await call(bob, 'post', '/api/local/reactions', { post_id: northPost, kind: 'like' });

    // 地図は南の会を見ているところから、北の会の通知を押す（見ているコミュニティは覚えられる）。
    await alice.page.goto(`/?n=${unique()}#/map`);
    await alice.page.evaluate(async (id) => (await import('/static/js/communities.js')).chooseCurrent(id), south.community_id);
    await alice.page.goto(`/?n2=${unique()}#/notifications`);
    const row = alice.page.locator('#notifList .notif', { hasText: 'いいね' });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.notif-community')).toHaveText(north.name);
    await noSideScroll(alice.page);

    // 「誰かが…話してみたい」の行は、コミュニティ名を出さない（匿名）
    await alice.page.route('**/api/local/notifications/feed*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.notifications.unshift({
        id: 'wish-1', type: 'talk_wish', category: 'reaction', post_id: null, actor_id: null, actors: [], others: 0,
        unread: true, ids: ['wish-1'], payload: {}, community_id: north.community_id, created_at: new Date().toISOString(),
      });
      await route.fulfill({ response, json: body });
    });
    await alice.page.reload();
    await expect(alice.page.locator('#notifList .notif')).toHaveCount(2);
    await expect(alice.page.locator('#notifList .notif', { hasText: 'いいね' }).locator('.notif-community')).toHaveText(north.name);
    const wish = alice.page.locator('#notifList .notif').first();
    await expect(wish).not.toContainText('いいね');
    await expect(wish.locator('.notif-community')).toBeHidden();
    await alice.page.unroute('**/api/local/notifications/feed*');
    await alice.page.reload();

    // 押すと北の会の地図に切り替わり、投稿が開く。
    await alice.page.locator('#notifList .notif', { hasText: 'いいね' }).click();
    await expect(alice.page.locator('#map')).toHaveClass(/active/);
    await alice.page.locator('#sheet.on .post-card').waitFor({ timeout: 20000 });
    await expect(alice.page.locator('#sheet.on .post-card')).toContainText('冬の登山');
    await expect(alice.page.locator('#mapCommunity')).toContainText(north.name);
    expect(alice.problems.errors).toEqual([]);
  });

  test('作る側: 投稿を試すとき・島の名前を読むときも、いまのコミュニティを名指しする（422が出ない）', async ({ browser }, testInfo) => {
    const admin = await person(browser, testInfo, 'かくひと');
    const first = await makeCommunity(admin, `一つ目 ${unique()}`);
    const second = await makeCommunity(admin, `二つ目 ${unique()}`);
    await makePost(admin, first.community_id, '土曜の夜、BAR でゆるく飲む会をひらきます');
    await admin.page.goto(`/?c=${unique()}#/map`);
    await expect(admin.page.locator('#mapCommunity')).toContainText('▾');
    // コミュニティが2つでも、試し書きは名指しで通る（指定がないと422）。
    const preview = await admin.page.evaluate(async () => {
      const { api } = await import('/static/js/net.js');
      const { currentScope } = await import('/static/js/communities.js');
      const scope = currentScope();
      return api.post('/api/posts/preview', { body: '海辺でコーヒーを飲むのが好きです', community_id: scope.id });
    });
    expect(preview.saved).toBe(false);
    expect(admin.problems.failed).toEqual([]);
  });

  // ---- 敵対レビューで見つかったものの再現

  test('抜けた人: 近くの人の問い合わせ（404）を出さず、自分のページから開こうとすると理由を言う', async ({ browser }, testInfo) => {
    const admin = await person(browser, testInfo, 'ぬけるあき');
    const room = await makeCommunity(admin, `ぬける部屋 ${unique()}`);
    const leaver = await person(browser, testInfo, 'ぬけるひと');
    await bringIn(admin, room.community_id, leaver);
    await makePost(leaver, room.community_id, '日曜の朝は、近所の川沿いを散歩しています');
    const theirs = await makePost(admin, room.community_id, '日曜の朝に川沿いを歩くのが好きです');
    await makeCommunity(leaver, `べつの部屋 ${unique()}`);   // 1つも無いと、起動のときに入口へ戻される（招待制の決まり）
    await call(leaver, 'post', `/api/local/communities/${room.community_id}/leave`, {});

    const bad = [];
    leaver.page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/') && [401, 404, 422].includes(response.status())) bad.push(`${response.status()} ${url.pathname}`);
    });
    // 抜けたコミュニティの投稿へのリンク: 案内の地図になる。自分の古い投稿の「近くの人」は聞きに行かない。
    await leaver.page.goto(`/?e=${unique()}#/map?post=${theirs}`);
    await expect(leaver.page.locator('#mapNoticeTitle')).toHaveText(NOTICE);
    await leaver.page.waitForTimeout(1200);
    expect(bad.filter((line) => line.includes('/api/neighbors'))).toEqual([]);
    expect(bad.filter((line) => line.includes('/api/local/communities/'))).toEqual([]);

    // 自分のページには自分の投稿の行がある。押すと、地図の案内ではなく理由が出る。
    await leaver.page.goto(`/?e2=${unique()}#/me`);
    await leaver.page.locator('#meBody').getByRole('button', { name: 'メッセージを開く' }).first().click();
    await expect(leaver.page.locator('#toast')).toContainText('抜けている');
    await expect(leaver.page.locator('#me')).toHaveClass(/active/);
    expect(leaver.problems.errors).toEqual([]);
  });

  test('ログアウトのあと、閉じたカードの中にも、前の人の投稿の本文が残らない', async ({ browser }, testInfo) => {
    const admin = await person(browser, testInfo, 'のこさないあき');
    const room = await makeCommunity(admin, `のこさない ${unique()}`);
    const postId = await makePost(admin, room.community_id, 'ひみつの本文：ここは外に出してはいけません');
    await admin.page.goto(`/?o=${unique()}#/map?post=${postId}`);
    await admin.page.locator('#sheet.on .post-card').waitFor();
    expect(await admin.page.evaluate(() => document.documentElement.innerHTML.includes('ひみつの本文'))).toBe(true);
    await admin.page.evaluate(async () => {
      const { session } = await import('/static/js/session.js');
      session.signOut();   // トークン切れと同じ道（onChange）
    });
    await expect.poll(() => admin.page.evaluate(() => document.documentElement.innerHTML.includes('ひみつの本文'))).toBe(false);
    const sizes = await admin.page.evaluate(async () => {
      const { state } = await import('/static/js/state.js');
      return [state.posts.length, state.postsById.size, state.islands.length, state.connections.length, state.changeMarks.length];
    });
    expect(sizes).toEqual([0, 0, 0, 0, 0]);
  });

  test('2つのコミュニティに入っている人: 「留守のあいだ」は、いま見ているコミュニティの出来事だけを地図に出す', async ({ browser }, testInfo) => {
    const me = await person(browser, testInfo, 'ふたつのひと');
    const one = await makeCommunity(me, `ひとつめ ${unique()}`);
    const two = await makeCommunity(me, `ふたつめ ${unique()}`);
    await makePost(me, one.community_id, '木曜の夜は、近所の銭湯に行っています');
    const row = (id, community, cx) => ({
      id, island_id: `i-${id}`, kind: 'born', cause: 'x', place: { cx, cy: 40 }, before: null, after: null,
      created_at: new Date().toISOString(), community_id: community, reason: 'mine', people: [], people_role: 'posts',
    });
    await me.page.route('**/api/changes/digest*', (route) => route.fulfill({
      json: { since: null, changes: [row(`${unique()}-1`, one.community_id, 10), row(`${unique()}-2`, two.community_id, 20), row(`${unique()}-3`, two.community_id, 30)] },
    }));
    const marks = () => me.page.evaluate(async () => (await import('/static/js/state.js')).state.changeMarks.map((m) => m.x).sort((a, b) => a - b));
    await me.page.goto(`/?d=${unique()}#/map`);
    await expect.poll(async () => (await marks()).length).toBeGreaterThan(0);
    const current = await me.page.evaluate(async () => (await import('/static/js/state.js')).state.communityId);
    expect(await marks()).toEqual(current === one.community_id ? [10] : [20, 30]);
    // もう一方に切り替えると、そちらの分になる。
    await me.page.evaluate(async (id) => {
      const { chooseCurrent } = await import('/static/js/communities.js');
      chooseCurrent(id);
      (await import('/static/js/screens/meet.js')).paintMarks();
    }, current === one.community_id ? two.community_id : one.community_id);
    expect(await marks()).toEqual(current === one.community_id ? [20, 30] : [10]);
  });

  test('開いたままのページ: スイッチが切り替わったと分かったら、設定を取り込んでお知らせを出す', async ({ browser }, testInfo) => {
    const me = await person(browser, testInfo, 'ひらきっぱなし');
    await me.page.goto(`/?s=${unique()}#/map`);
    await expect(me.page.locator('#mapVersionNotice')).toBeHidden();
    await me.page.route('**/api/config', async (route) => {
      const real = await (await route.fetch()).json();
      await route.fulfill({ json: { ...real, features: { ...real.features, members_only: false } } });
    });
    const changed = await me.page.evaluate(async () => {
      const config = await import('/static/js/config.js');
      const result = await config.checkMapVersion();
      return [result, config.membersOnly()];
    });
    expect(changed).toEqual([true, false]);
    await expect(me.page.locator('#mapVersionNotice')).toBeVisible();
  });

  test('自分のコミュニティ一覧が読めないメンバーに、「メンバーだけ」とは言わない', async ({ browser }, testInfo) => {
    const admin = await person(browser, testInfo, 'よめないあき');
    const room = await makeCommunity(admin, `よめない部屋 ${unique()}`);
    const postId = await makePost(admin, room.community_id, '金曜の夜は、友だちと映画を見ています');
    await admin.page.route('**/api/local/communities/mine', (route) => route.fulfill({ status: 500, json: { detail: 'x' } }));
    await admin.page.goto(`/?m=${unique()}#/map?post=${postId}`);
    await expect(admin.page.locator('#mapNotice')).toBeVisible();
    await expect(admin.page.locator('#mapNoticeTitle')).not.toHaveText(NOTICE);
    await admin.page.unroute('**/api/local/communities/mine');
  });

  test('通知のコミュニティ名の調べ直し: 一度失敗しても覚え込まず、次は読める', async ({ browser }, testInfo) => {
    const admin = await person(browser, testInfo, 'おぼえないあき');
    const room = await makeCommunity(admin, `おぼえない ${unique()}`);
    const postId = await makePost(admin, room.community_id, '土曜の昼は、図書館で本を読んでいます');
    await admin.page.goto(`/?r=${unique()}#/me`);
    const forget = () => admin.page.evaluate(async () => {
      const { state } = await import('/static/js/state.js');
      state.myPosts = [];
      state.postsById = new Map();
    });
    await forget();
    await admin.page.route(`**/api/local/post/${postId}`, (route) => route.abort());
    const first = await admin.page.evaluate(async (id) => (await import('/static/js/communities.js')).communityIdOfPost(id), postId);
    await admin.page.unroute(`**/api/local/post/${postId}`);
    const second = await admin.page.evaluate(async (id) => (await import('/static/js/communities.js')).communityIdOfPost(id), postId);
    expect(first).toBe('');
    expect(second).toBe(room.community_id);
  });

  test('話してみたい → 両思い → DM が、スイッチ「入」でも通る（通知は匿名のまま）', async ({ browser }, testInfo) => {
    const a = await person(browser, testInfo, 'とーくえー');
    const room = await makeCommunity(a, `とーく ${unique()}`);
    const b = await person(browser, testInfo, 'とーくびー');
    await bringIn(a, room.community_id, b);
    const pa = await makePost(a, room.community_id, '土曜の朝にみんなで公園ランニングをする会です', ['参加者募集中']);
    const pb = await makePost(b, room.community_id, '週末はコーヒー豆を焙煎して過ごしています');
    await call(b, 'post', '/api/local/reactions', { post_id: pa, kind: 'join' });
    await call(a, 'post', '/api/local/reactions', { post_id: pb, kind: 'like' });

    // 「もっと話してみたい」 is on the profile only, never on a post card.
    await a.page.goto(`/?t=${unique()}#/map?post=${pb}`);
    await a.page.locator('#sheet.on .post-card').waitFor();
    await expect(a.page.locator('#sheet .post-talk-button')).toHaveCount(0);
    await a.page.goto(`/?t3=${unique()}#/u/${b.id}`);
    await expect(a.page.locator('#userBody .profile-name')).toBeVisible({ timeout: 15000 });
    const mine = a.page.locator('#userBody .post-talk-button');
    await expect(mine.first()).toBeVisible();
    const before = await mine.first().getAttribute('data-state');
    await mine.first().click();
    await a.page.locator('.modal .btn:not(.btn-quiet)').click();
    await expect.poll(() => mine.first().getAttribute('data-state')).not.toBe(before);

    // 相手に届く通知は、誰からかもコミュニティ名も言わない。
    await b.page.goto(`/?t2=${unique()}#/notifications`);
    const row = b.page.locator('#notifList .notif').first();
    await expect(row).toBeVisible();
    await expect(row).not.toContainText(room.name);
    await expect(row).not.toContainText('とーくえー');
    for (const who of [a, b]) {
      expect(who.problems.failed).toEqual([]);
      expect(who.problems.errors).toEqual([]);
    }
  });
});
