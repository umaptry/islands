// コミュニティと招待リンク（仕様2）。手元モードのサーバーに、ブラウザ数個（管理者・新しい人・既存の人）でつなぐ。
// 手元モードの補助口（/api/local/communities, /api/local/settings/invite-only, /api/local/invites/{id}/expire）を使う。
import { test, expect } from '@playwright/test';

const unique = () => Math.random().toString(36).slice(2, 10);

async function openContext(browser, testInfo) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  return { context, page };
}

// メールのコードで入った、名前つきのアカウント（invite_only が false の間だけ作れる）。
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

const setInviteOnly = (who, value) => call(who, 'post', '/api/local/settings/invite-only', { value });

// 管理者のコミュニティ編集画面（#/community/:id）で招待リンクを作り、リンク（# から後ろ）を返す。
async function makeInviteLink(admin, communityId, { postId, key } = {}) {
  await admin.page.goto(`/?me=${unique()}#/community/${communityId}`);
  const card = admin.page.locator(`#communityEditBody .community-invites[data-community-id="${communityId}"]`);
  await card.waitFor({ timeout: 15000 });
  await card.locator('.invite-open').click();
  if (key) await card.locator(`.invite-chip[data-key="${key}"]`).click();
  await card.locator('.invite-approval').uncheck();
  await card.locator('.invite-make').click();
  await card.locator('.invite-qr').waitFor();
  if (postId) {
    await card.locator('.invite-with-post').check();
    await card.locator('.invite-post-select').selectOption(postId);
  }
  const url = await card.locator('.invite-url').inputValue();
  expect(url).toContain('#/invite/');
  return { url: url.slice(url.indexOf('#')), card };
}

const noSideScroll = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

async function signUpByEmail(page, name) {
  await page.locator('#inviteRegister').click();
  await page.locator('#registerName').fill(name);
  await page.locator('#registerAffiliation').fill('テスト');
  await page.locator('#authEmail').fill(`new-${crypto.randomUUID()}@example.com`);
  await page.locator('#authSend').click();
  await expect(page.locator('#authDevCode .dev-code-value')).toBeVisible();
  await page.locator('#authCode').fill(await page.locator('#authDevCode .dev-code-value').innerText());
  await page.locator('#authVerify').click();
}

test('管理者が招待リンクを作り、新しい人がそのリンクから登録して、最初の投稿がそのコミュニティの地図に出て、会の投稿が開く', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '管理のあき');
  const bar = await makeCommunity(admin, `BAR ${unique()}`);
  const eventId = await makePost(admin, bar.community_id, '土曜の夜、BAR でゆるく飲む会をひらきます', ['参加者募集中']);
  const { url } = await makeInviteLink(admin, bar.community_id, { postId: eventId });
  expect(url).toContain(`?post=${eventId}`);

  const guest = await openContext(browser, testInfo);
  await guest.page.goto(`/${url}`);
  await expect(guest.page.locator('#invite')).toHaveClass(/active/);
  await expect(guest.page.locator('#inviteTitle')).toContainText(`${bar.name} への招待です`);
  await noSideScroll(guest.page);
  await signUpByEmail(guest.page, '新しい人');
  await expect(guest.page.locator('#setup')).toHaveClass(/active/, { timeout: 15000 });
  await guest.page.locator('#setupSave').click();
  await expect(guest.page.locator('#guidance')).toHaveClass(/active/);
  await guest.page.locator('#guidanceSkip').click();
  await expect(guest.page.locator('#compose')).toHaveClass(/active/);
  await guest.page.locator('#composeBody').fill('最近はコーヒーを自分で焙煎しています');
  await guest.page.locator('#composeNext').click();
  await guest.page.locator('#composeMotivation').evaluate((node) => { node.value = '55'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await guest.page.locator('#composeNext2').click();
  await guest.page.locator('#composeSubmit').click();

  // 終わったら、そのコミュニティの地図で、会の投稿が開く。
  await expect(guest.page.locator('#map')).toHaveClass(/active/, { timeout: 30000 });
  // 最初の投稿のあとは「あなたの近くの投稿」のカードが先に出る。閉じると、招待で一緒に開く投稿が開く。
  await guest.page.locator('#nearbyClose').click({ timeout: 30000 });
  await guest.page.locator('#sheet.on .post-card').waitFor({ timeout: 30000 });
  await expect(guest.page.locator('#sheet.on .post-card')).toContainText('BAR でゆるく飲む会');
  await expect(guest.page.locator('#mapCommunity')).toContainText(bar.name);
  // 参加者募集中の投稿の QR から入った人は、その会に参加した状態で始まる（2026-10-31）。
  await expect(guest.page.locator('#sheet.on .post-join-button')).toContainText('参加済み', { timeout: 15000 });
  const joiners = await guest.page.evaluate(async (id) => (await import('/static/js/net.js')).data.reactorsOf(id, 'join'), eventId);
  expect(JSON.stringify(joiners)).toContain('新しい人');
  const bodies = await guest.page.evaluate(async () => (await import('/static/js/state.js')).state.posts.map((p) => p.body));
  expect(bodies.some((b) => b.includes('焙煎'))).toBe(true);
  // 最初の投稿は、サーバー側でそのコミュニティの投稿になっている。
  const mapRows = await call(admin, 'get', `/api/local/communities/${bar.community_id}/map`);
  expect(mapRows.posts.some((p) => p.body.includes('焙煎'))).toBe(true);

  // 投稿画面にも行き先が出る。（フォームで登録した人は、次に開いたときにフルネームのお願いが出る。ここでは確かめ済みにしておく）
  await guest.page.evaluate(async () => (await import('/static/js/net.js')).api.put('/api/account/me', { name_confirmed: true }));
  await guest.page.goto(`/?c=${unique()}#/post`);
  await expect(guest.page.locator('#composeCommunity')).toContainText(`${bar.name} に投稿`);
  await noSideScroll(guest.page);

  // ログインしていない人がリンク（?post=）から来ても、その会の地図を読みだけで見られる。
  const visitor = await openContext(browser, testInfo);
  await visitor.page.goto(`/#/map?post=${eventId}`);
  await visitor.page.locator('#sheet.on .post-card').waitFor({ timeout: 15000 });
  await expect(visitor.page.locator('#sheet.on .post-card')).toContainText('BAR でゆるく飲む会');
  const visible = await visitor.page.evaluate(async () => (await import('/static/js/state.js')).state.posts.length);
  expect(visible).toBeGreaterThanOrEqual(2);
});

test('招待制のとき、招待なしでは登録できず、招待リンクからは登録の入口が出る', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '管理のいち');
  const community = await makeCommunity(admin, `招待制 ${unique()}`);
  const { url } = await makeInviteLink(admin, community.community_id);
  await setInviteOnly(admin, true);
  try {
    const closed = await openContext(browser, testInfo);
    await closed.page.goto('/');
    await expect(closed.page.locator('#welcome')).toHaveClass(/active/);
    await expect(closed.page.locator('#welcomeInviteNote')).toContainText('招待制');
    await expect(closed.page.locator('#welcomeRegister')).toBeHidden();
    await expect(closed.page.locator('#welcomeLogin')).toBeVisible();
    await noSideScroll(closed.page);

    await closed.page.goto('/#/auth?intent=register');
    await expect(closed.page.locator('#auth')).toHaveClass(/active/);
    await expect(closed.page.locator('#registerFields')).toBeHidden();
    await expect(closed.page.locator('#authInviteNote')).toBeVisible();

    // 招待のない新しいメールでログインしても、入口に戻される。
    await closed.page.locator('#authEmail').fill(`stray-${crypto.randomUUID()}@example.com`);
    await closed.page.locator('#authSend').click();
    await expect(closed.page.locator('#authDevCode .dev-code-value')).toBeVisible();
    await closed.page.locator('#authCode').fill(await closed.page.locator('#authDevCode .dev-code-value').innerText());
    await closed.page.locator('#authVerify').click();
    await expect(closed.page.locator('#welcome')).toHaveClass(/active/, { timeout: 15000 });
    expect(await closed.page.evaluate(async () => (await import('/static/js/session.js')).session.signedIn())).toBe(false);

    // サーバーも止める（画面を通らずに作ろうとしても）。
    const direct = await closed.page.evaluate(async () => {
      const { session } = await import('/static/js/session.js');
      const { api } = await import('/static/js/net.js');
      const email = `direct-${crypto.randomUUID()}@example.com`;
      const otp = await session.requestCode(email);
      await session.verifyCode(email, otp.devCode);
      try { await api.put('/api/account/me', { display_name: 'すり抜け', affiliation: 'テスト', name_confirmed: true, icon_id: 'photo' }); return 'ok'; }
      catch (error) { return `error ${error.status ?? ''}`; }
    });
    expect(direct).toMatch(/^error 403/);

    // 招待リンクからなら登録できる。
    const invited = await openContext(browser, testInfo);
    await invited.page.goto(`/${url}`);
    await expect(invited.page.locator('#inviteRegister')).toBeVisible();
    await signUpByEmail(invited.page, '招待された人');
    await expect(invited.page.locator('#setup')).toHaveClass(/active/, { timeout: 15000 });
  } finally {
    await setInviteOnly(admin, false);
  }
});

test('2つのコミュニティに入っている人は、地図の左上で切り替えられ、覚えている', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '管理のに');
  const first = await makeCommunity(admin, `一つ目 ${unique()}`);
  const second = await makeCommunity(admin, `二つ目 ${unique()}`);
  await makePost(admin, first.community_id, '土曜の夜、BAR でゆるく飲む会をひらきます');
  await makePost(admin, second.community_id, '今月は短編小説を読んで感想を話します');

  await admin.page.goto(`/?m=${unique()}#/map`);
  await expect(admin.page.locator('#map')).toHaveClass(/active/);
  await expect(admin.page.locator('#mapCommunity')).toContainText('▾');
  await admin.page.locator('#mapCommunity').click();
  await admin.page.locator('#sheet.on #communityList').waitFor();
  await expect(admin.page.locator('.community-row')).toHaveCount(2);
  const other = admin.page.locator('.community-row:not(.on)');
  const otherName = (await other.locator('.stack-who').innerText()).trim();
  await other.click();
  await expect(admin.page.locator('#mapCommunity')).toContainText(otherName);
  await expect.poll(() => admin.page.evaluate(async () => (await import('/static/js/state.js')).state.posts.length)).toBe(1);
  await admin.page.goto(`/?m=${unique()}#/map`);
  await expect(admin.page.locator('#mapCommunity')).toContainText(otherName);
  await noSideScroll(admin.page);
});

test('期限切れ・止めたリンク・見つからないリンクは、登録の入口を出さずに理由を案内する', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '管理のさん');
  const community = await makeCommunity(admin, `期限 ${unique()}`);
  const expired = await makeInviteLink(admin, community.community_id, { key: '1h' });
  const list = await call(admin, 'get', `/api/local/invites?community_id=${community.community_id}`);
  await call(admin, 'post', `/api/local/invites/${list.invites[0].id}/expire`, {});

  const visitor = await openContext(browser, testInfo);
  await visitor.page.goto(`/?e=${unique()}${expired.url}`);
  await expect(visitor.page.locator('#inviteLede')).toContainText('期限が切れ');
  await expect(visitor.page.locator('#inviteRegister')).toBeHidden();
  await expect(visitor.page.locator('#inviteHome')).toBeVisible();
  await noSideScroll(visitor.page);

  // 管理者が止めたリンク
  const live = await makeInviteLink(admin, community.community_id, { key: '3h' });
  await expect(live.card.locator('.invite-qr')).toBeVisible();
  await live.card.locator('.invite-revoke').click();
  await admin.page.locator('.modal-actions .btn-danger').click();
  await expect(live.card.locator('.invite-open')).toBeVisible();
  await visitor.page.goto(`/?r=${unique()}${live.url}`);
  await expect(visitor.page.locator('#inviteLede')).toContainText('止められ');
  await expect(visitor.page.locator('#inviteRegister')).toBeHidden();

  await visitor.page.goto(`/?u=${unique()}#/invite/this-code-does-not-exist-123`);
  await expect(visitor.page.locator('#inviteLede')).toContainText('見つかりません');
});

test('すでにアカウントがある人がリンクを開くと、そのコミュニティに入る', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '管理のよん');
  const community = await makeCommunity(admin, `参加先 ${unique()}`);
  await makePost(admin, community.community_id, '毎週水曜に朝の散歩をしています');
  const { url } = await makeInviteLink(admin, community.community_id);

  const member = await person(browser, testInfo, 'もうアカウントがある人');
  // どこにも入っていない間は、地図の代わりに案内が出る。
  await member.page.goto(`/?n=${unique()}#/map`);
  await expect(member.page.locator('#mapNoticeTitle')).toContainText('まだコミュニティに入っていません');
  await noSideScroll(member.page);

  await member.page.goto(`/${url}`);
  await expect(member.page.locator('#inviteJoin')).toBeVisible();
  await member.page.locator('#inviteJoin').click();
  await expect(member.page.locator('#map')).toHaveClass(/active/);
  await expect(member.page.locator('#mapCommunity')).toContainText(community.name);
  await expect.poll(() => member.page.evaluate(async () => (await import('/static/js/state.js')).state.posts.length)).toBe(1);
  const mine = await call(member, 'get', '/api/local/communities/mine');
  expect(mine.communities.map((c) => c.name)).toEqual([community.name]);
});

test('招待に付ける投稿は、そのコミュニティの投稿だけ。リンクを開いただけでは招待は残らず、押したときに残る', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '管理のご');
  const bar = await makeCommunity(admin, `BAR ${unique()}`);
  const book = await makeCommunity(admin, `読書 ${unique()}`);
  const barPost = await makePost(admin, bar.community_id, 'BAR の夜の会です', ['参加者募集中']);
  await makePost(admin, book.community_id, '読書会の本を決めます', ['参加者募集中']);

  // 選べる投稿は、そのコミュニティの投稿だけ（読書会の投稿は出ない）
  const { url, card } = await makeInviteLink(admin, bar.community_id, { postId: barPost });
  await expect.poll(() => card.locator('.invite-post-select option').evaluateAll((nodes) => nodes.map((node) => node.value))).toEqual([barPost]);
  expect(url).toContain(`?post=${barPost}`);
  const visitor = await openContext(browser, testInfo);
  await visitor.page.goto(`/${url}`);
  await expect(visitor.page.locator('#inviteTitle')).toContainText('への招待です');
  expect(await visitor.page.evaluate(() => localStorage.getItem('islands-invite-pending'))).toBeNull();
  await visitor.page.locator('#inviteRegister').click();
  expect(await visitor.page.evaluate(() => localStorage.getItem('islands-invite-pending'))).not.toBeNull();
});

test('コミュニティの一覧を読めなかったとき、会員は「入っていません」と言われずやり直せる。入っていない人の投稿画面は入力欄が隠れる', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '管理のろく');
  const community = await makeCommunity(admin, `回線 ${unique()}`);
  await makePost(admin, community.community_id, '毎週水曜に朝の散歩をしています');

  await admin.page.route('**/api/local/communities/mine', (route) => route.abort());
  await admin.page.goto(`/?f=${unique()}#/map`);
  await expect(admin.page.locator('#mapNoticeTitle')).toContainText('読み込めませんでした');
  await expect(admin.page.locator('#mapNoticeTitle')).not.toContainText('入っていません');
  await expect(admin.page.locator('#mapNoticeRetry')).toBeVisible();
  // つながったら、「もう一度」で会員の地図に戻る。
  await admin.page.unroute('**/api/local/communities/mine');
  await admin.page.locator('#mapNoticeRetry').click();
  await expect(admin.page.locator('#mapCommunity')).toContainText(community.name);
  await expect(admin.page.locator('#mapNotice')).toBeHidden();
  // 投稿画面は、読めないときは地図へ飛ばさず、言葉で止める。
  await admin.page.route('**/api/local/communities/mine', (route) => route.abort());
  await admin.page.goto(`/?g=${unique()}#/post`);
  await expect(admin.page.locator('#compose')).toHaveClass(/active/);
  await expect(admin.page.locator('#composeCommunity')).toContainText('読み込めませんでした');
  await expect(admin.page.locator('#composeSubmit')).toBeDisabled();
  await expect(admin.page.locator('#composeNext')).toBeHidden();
  await admin.page.unroute('**/api/local/communities/mine');

  // どこにも入っていない人: 地図の案内と、入力欄のない投稿画面。
  const outsider = await person(browser, testInfo, 'どこにも入っていない人');
  await outsider.page.goto(`/?o=${unique()}#/post`);
  await expect(outsider.page.locator('#composeCommunity')).toContainText('コミュニティに入っていない');
  await expect(outsider.page.locator('#composeBody')).toBeHidden();
  await noSideScroll(outsider.page);
});

test('編集画面を URL で直接開いても、自分の投稿が読み込まれて「会の投稿も一緒に開く」が押せる', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '直接のご');
  const bar = await makeCommunity(admin, `BAR ${unique()}`);
  const barPost = await makePost(admin, bar.community_id, 'BAR の夜の会です', ['参加者募集中']);
  await makeInviteLink(admin, bar.community_id);
  // 開き直す: 地図を通らないので、自分の投稿はまだ読み込まれていない
  await admin.page.goto(`/?again=${unique()}#/community/${bar.community_id}`);
  const card = admin.page.locator(`#communityEditBody .community-invites[data-community-id="${bar.community_id}"]`);
  await card.locator('.invite-qr').waitFor({ timeout: 15000 });
  await expect(card.locator('.invite-with-post')).toBeEnabled({ timeout: 10000 });
  await card.locator('.invite-with-post').check();
  await expect.poll(() => card.locator('.invite-post-select option').evaluateAll((nodes) => nodes.map((node) => node.value))).toEqual([barPost]);
});

test('コミュニティを切り替えると、効果音・振動・海の波が出て、600ms 以内に消え、名前が入れ替わる', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '切替のひと');
  await makeCommunity(admin, `一つ目 ${unique()}`);
  await makeCommunity(admin, `二つ目 ${unique()}`);
  await admin.context.addInitScript(() => {
    window.__buzz = [];
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (pattern) => { window.__buzz.push(pattern); return true; } });
  });
  await admin.page.goto(`/?m=${unique()}#/map`);
  await expect(admin.page.locator('#mapCommunity')).toContainText('▾');
  await admin.page.locator('#mapCommunity').click();
  await admin.page.locator('#sheet.on #communityList').waitFor();
  const other = admin.page.locator('.community-row:not(.on)');
  const otherName = (await other.locator('.stack-who').innerText()).trim();
  await admin.page.evaluate(() => {
    window.__washSeen = 0;
    new MutationObserver(() => { if (document.querySelector('.switch-wash')) window.__washSeen += 1; })
      .observe(document.getElementById('map'), { childList: true });
  });
  await other.click();
  await expect(admin.page.locator('.switch-wash')).toBeAttached();
  await expect(admin.page.locator('#mapCommunity')).toHaveClass(/switched/);
  await admin.page.waitForTimeout(250);
  await admin.page.screenshot({ path: `C:/Users/tatsu/Desktop/Claude Code/islands_261012/_pw_tmp/fb2/rest/switch-wash-${testInfo.project.name}.png` });
  await expect(admin.page.locator('.switch-wash')).toHaveCount(0, { timeout: 1000 });
  await expect(admin.page.locator('#mapCommunity')).toContainText(otherName);
  expect(await admin.page.evaluate(() => window.__buzz)).toEqual([[12, 50, 22]]);
  // 同じコミュニティをもう一度選んでも、何も起きない
  await admin.page.locator('#mapCommunity').click();
  await admin.page.locator('#sheet.on #communityList').waitFor();
  await admin.page.locator('.community-row.on').click();
  await admin.page.waitForTimeout(150);
  await expect(admin.page.locator('.switch-wash')).toHaveCount(0);
  expect(await admin.page.evaluate(() => window.__buzz)).toHaveLength(1);
});

test('動きを減らす設定のときは、波の演出は出さず、振動だけ出る', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '切替のふたり');
  await makeCommunity(admin, `一つ目 ${unique()}`);
  await makeCommunity(admin, `二つ目 ${unique()}`);
  await admin.context.addInitScript(() => {
    window.__buzz = [];
    localStorage.setItem('islands.feedback', JSON.stringify({ sound: true, vibrate: true, reduceMotion: true }));
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (pattern) => { window.__buzz.push(pattern); return true; } });
  });
  await admin.page.goto(`/?m=${unique()}#/map`);
  await expect(admin.page.locator('#mapCommunity')).toContainText('▾');
  await admin.page.locator('#mapCommunity').click();
  await admin.page.locator('#sheet.on #communityList').waitFor();
  await admin.page.locator('.community-row:not(.on)').click();
  await admin.page.waitForTimeout(300);
  await expect(admin.page.locator('.switch-wash')).toHaveCount(0);
  expect(await admin.page.evaluate(() => window.__buzz)).toEqual([[12, 50, 22]]);
});
