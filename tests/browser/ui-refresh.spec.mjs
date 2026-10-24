// 画面の作り直し（2026-10-26）: 地図の上のバー、コミュニティの一覧と編集、丸い投稿ボタン、
// 新しい島の光、下のバー（マップ／DM／通知／マイページ）と DM のバッジ。
// 手元モードのサーバーに、ブラウザ数個でつなぐ。
import { test, expect } from '@playwright/test';

const unique = () => Math.random().toString(36).slice(2, 10);
const KEY = 'Idempotency-Key';

async function person(browser, testInfo, name, { create = null, join = null, init = null } = {}) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('#welcome')).toHaveClass(/active/);
  const email = `${name}-${crypto.randomUUID()}@example.com`;
  const made = await page.evaluate(async ({ email, name, create, join }) => {
    const { session } = await import('/static/js/session.js');
    const { api } = await import('/static/js/net.js');
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await api.put('/api/account/me', { display_name: name, icon_id: 'photo' });
    if (create) return api.post('/api/local/communities', { name: create, slug: `t-${Math.random().toString(36).slice(2, 9)}` }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
    if (join) await api.post('/api/local/invites/claim', { code: join });
    return null;
  }, { email, name, create, join });
  const id = await page.evaluate(async () => (await import('/static/js/session.js')).session.userId());
  return { page, context, name, made, id };
}

const toMap = async (who) => {
  await who.page.goto(`/?m=${unique()}#/map`);
  await expect(who.page.locator('#map')).toHaveClass(/active/);
};

const makePost = (who, body, communityId = null, tags = []) => who.page.evaluate(async ({ body, communityId, tags, key }) => {
  const { api } = await import('/static/js/net.js');
  const made = await api.post('/api/posts', { body, tags, motivation: 55, ...(communityId ? { community_id: communityId } : {}) },
    { headers: { [key]: crypto.randomUUID() } });
  return made.id;
}, { body, communityId, tags, key: KEY });

const noSideScroll = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

test('ログインしていない人: バーには islands とだけ出て、DM のタブも投稿ボタンも出ない', async ({ page }) => {
  await page.goto('/#/map');
  await expect(page.locator('#map')).toHaveClass(/active/);
  await expect(page.locator('#mapCommunity')).toHaveText('islands');
  await expect(page.locator('#mapCommunity')).toBeDisabled();
  await expect(page.locator('#mapSearchOpen')).toBeHidden();
  await expect(page.locator('#mapPost')).toBeHidden();
  await expect(page.locator('#navDm')).toBeHidden();
  await expect(page.locator('#bottomNav .nav-item:visible .nav-label')).toHaveText(['マップ', '通知', 'マイページ']);
  await noSideScroll(page);
});

test('地図の上の1本のバー: 左にコミュニティ、右に検索とタグ。地図はバーの下から始まる', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '管理のひとつめ', { create: `バー確認 ${unique()}` });
  await makePost(admin, '朝の散歩をしている人と話したいです', admin.made.community_id);
  await toMap(admin);
  const header = admin.page.locator('#mapHeader');
  await expect(admin.page.locator('#mapCommunity')).toContainText('▾');
  await expect(admin.page.locator('#mapCommunity')).toBeEnabled();
  const bar = await header.boundingBox();
  const viewport = admin.page.viewportSize();
  expect(bar.x).toBeLessThanOrEqual(1);
  expect(bar.width).toBeGreaterThanOrEqual(viewport.width - 1);
  expect(bar.height).toBeGreaterThanOrEqual(50);
  // 左がコミュニティ、右が検索とタグ
  const left = await admin.page.locator('#mapCommunity').boundingBox();
  const search = await admin.page.locator('#mapSearchOpen').boundingBox();
  const filter = await admin.page.locator('#mapFilterBtn').boundingBox();
  expect(left.x).toBeLessThan(search.x);
  expect(search.x).toBeLessThan(filter.x);
  for (const box of [left, search, filter]) {
    expect(box.y).toBeGreaterThanOrEqual(bar.y);
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height + 1);
  }
  // 中身は、いまの真ん中の幅（520）におさまる
  expect(filter.x + filter.width - left.x).toBeLessThanOrEqual(548);
  // 地図の絵（島の名前の札）はバーの下に置かれる
  expect(await admin.page.evaluate(() => document.querySelector('#map .map-top').getBoundingClientRect().height)).toBeGreaterThanOrEqual(bar.height);
  // タグの絞り込みは、これまでどおりパネルが開く
  await admin.page.locator('#mapFilterBtn').click();
  await expect(admin.page.locator('#mapFilterPanel')).toBeVisible();
  await admin.page.locator('#mapFilterPanel .filter-tag').first().click();
  await expect(admin.page.locator('#mapFilterCount')).toHaveText('1');
  await admin.page.locator('#mapFilterPanel .filter-tag').first().click();
  await noSideScroll(admin.page);
});

test('長いコミュニティ名は、バーからはみ出さずに省略される', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '管理のながい', { create: 'あ'.repeat(40) });
  await toMap(admin);
  const text = (await admin.page.locator('#mapCommunity').innerText()).replace(/\s+/g, ' ');
  expect(text).toContain('…');
  expect(text).toContain('▾');
  const box = await admin.page.locator('#mapCommunity').boundingBox();
  const search = await admin.page.locator('#mapSearchOpen').boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(search.x + 1);
  await noSideScroll(admin.page);
});

test('検索: アイコンを押すとバーの中に検索欄が開き、✕で消して閉じる', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '検索のひと', { create: `検索 ${unique()}` });
  await makePost(admin, '川沿いをゆっくり走っています', admin.made.community_id);
  await toMap(admin);
  await expect(admin.page.locator('#mapSearchBox')).toBeHidden();
  await admin.page.locator('#mapSearchOpen').click();
  await expect(admin.page.locator('#mapSearchBox')).toBeVisible();
  await expect(admin.page.locator('#mapCommunity')).toBeHidden();
  await expect(admin.page.locator('#mapSearch')).toBeFocused();
  const box = await admin.page.locator('#mapSearchBox').boundingBox();
  const bar = await admin.page.locator('#mapHeader').boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(bar.y);
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height + 1);
  await admin.page.locator('#mapSearch').fill('川沿い');
  await expect.poll(() => admin.page.evaluate(async () => (await import('/static/js/state.js')).state.filters.query)).toBe('川沿い');
  await expect(admin.page.locator('#mapStatusText')).toContainText('該当');
  await noSideScroll(admin.page);
  await admin.page.locator('#mapSearchClear').click();
  await expect(admin.page.locator('#mapSearchBox')).toBeHidden();
  await expect(admin.page.locator('#mapCommunity')).toBeVisible();
  await expect(admin.page.locator('#mapSearch')).toHaveValue('');
  expect(await admin.page.evaluate(async () => (await import('/static/js/state.js')).state.filters.query)).toBe('');
});

test('コミュニティの一覧: 1つでも開き、管理者の行にだけ「編集」。名前を変えるとバーもすぐ変わる', async ({ browser }, testInfo) => {
  const name = `編集 ${unique()}`;
  const admin = await person(browser, testInfo, '管理のへんしゅう', { create: name });
  await toMap(admin);
  await expect(admin.page.locator('#mapCommunity')).toContainText(name);
  await admin.page.locator('#mapCommunity').click();
  await admin.page.locator('#sheet.on #communityList').waitFor();
  await expect(admin.page.locator('.community-row')).toHaveCount(1);
  await expect(admin.page.locator('.community-row.on')).toContainText(name);
  await expect(admin.page.locator('.community-edit')).toHaveCount(1);
  await expect(admin.page.getByText('コミュニティを作成')).toHaveCount(0);

  await admin.page.locator('.community-edit').click();
  await expect(admin.page.locator('#communityEdit')).toHaveClass(/active/);
  expect(await admin.page.evaluate(() => location.hash)).toBe(`#/community/${admin.made.community_id}`);
  await expect(admin.page.locator('#communityEditName')).toHaveText(name);
  await expect(admin.page.locator('#communityName')).toHaveValue(name);
  // 招待リンクの管理は、ここにある
  await expect(admin.page.locator('.invite-open')).toBeVisible();

  // 長さの決まり（前後の空白を取って 1〜40 字）
  await admin.page.locator('#communityName').fill('   ');
  await admin.page.locator('#communityRename').click();
  await expect(admin.page.locator('#communityNameError')).toContainText('1〜40文字');
  await admin.page.locator('#communityName').fill('あ'.repeat(41));
  await admin.page.locator('#communityRename').click();
  await expect(admin.page.locator('#communityNameError')).toContainText('1〜40文字');
  await expect(admin.page.locator('#communityEditName')).toHaveText(name);

  // 変える
  const next = `新しい名前 ${unique()}`;
  await admin.page.locator('#communityName').fill(`　 ${next} `);
  await admin.page.locator('#communityRename').click();
  await expect(admin.page.locator('#communityEditName')).toHaveText(next);
  await expect(admin.page.locator('#communityNameError')).toBeEmpty();
  await noSideScroll(admin.page);

  // 戻ると、再読み込みなしでバーもシートも新しい名前
  await admin.page.locator('#communityEditBack').click();
  await expect(admin.page.locator('#map')).toHaveClass(/active/);
  await expect(admin.page.locator('#mapCommunity')).toContainText(next);
  await admin.page.locator('#mapCommunity').click();
  await expect(admin.page.locator('.community-row.on')).toContainText(next);
  // 本体（サーバー）にも残っている
  await admin.page.goto(`/?again=${unique()}#/map`);
  await expect(admin.page.locator('#mapCommunity')).toContainText(next);
});

test('管理者でない人の一覧には「編集」がなく、編集の画面を開いても管理者だけと言われる。マイページには会の欄も DM の行もない', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '管理のあきら', { create: `権限 ${unique()}` });
  const invite = await admin.page.evaluate(async (id) => (await (await import('/static/js/net.js')).api.post('/api/local/invites', { community_id: id, minutes: 120, until_end_of_day: false })), admin.made.community_id);
  const member = await person(browser, testInfo, '参加のめんば', { join: invite.code });
  await toMap(member);
  await member.page.locator('#mapCommunity').click();
  await member.page.locator('#sheet.on #communityList').waitFor();
  await expect(member.page.locator('.community-row')).toHaveCount(1);
  await expect(member.page.locator('.community-edit')).toHaveCount(0);

  await member.page.goto(`/?e=${unique()}#/community/${admin.made.community_id}`);
  await expect(member.page.locator('#communityEditNote')).toContainText('管理者だけ');
  await expect(member.page.locator('#communityName')).toHaveCount(0);

  await member.page.goto(`/?me=${unique()}#/me`);
  await expect(member.page.locator('#me .profile-name')).toBeVisible();
  await expect(member.page.locator('#meCommunities')).toHaveCount(0);
  await expect(member.page.locator('#meDm')).toHaveCount(0);
  await expect(member.page.locator('.invite-open')).toHaveCount(0);
});

test('丸い投稿ボタン: 地図の右下、全体表示ボタンはその上。押すと今の会に投稿する画面', async ({ browser }, testInfo) => {
  const name = `投稿 ${unique()}`;
  const admin = await person(browser, testInfo, '投稿のひと', { create: name });
  await toMap(admin);
  const fab = admin.page.locator('#mapPost');
  await expect(fab).toBeVisible();
  await expect(fab).toHaveAttribute('aria-label', '投稿する');
  const bottomNav = await admin.page.locator('#bottomNav').boundingBox();
  const fabBox = await fab.boundingBox();
  const globe = await admin.page.locator('#mapOverview').boundingBox();
  const viewport = admin.page.viewportSize();
  expect(fabBox.x + fabBox.width).toBeGreaterThan(viewport.width - 40);
  expect(fabBox.y + fabBox.height).toBeLessThanOrEqual(bottomNav.y);
  expect(globe.y + globe.height).toBeLessThanOrEqual(fabBox.y + 1);
  expect(Math.abs(fabBox.width - fabBox.height)).toBeLessThan(1);
  await expect(admin.page.locator('[data-route="#/post"]')).toHaveCount(0);
  await fab.click();
  await expect(admin.page.locator('#compose')).toHaveClass(/active/);
  await expect(admin.page.locator('#composeCommunity')).toContainText(`${name} に投稿`);
  await noSideScroll(admin.page);

  // どこにも入っていない人には出ない
  const outsider = await person(browser, testInfo, 'どこにもいない人');
  await toMap(outsider);
  await expect(outsider.page.locator('#mapNotice')).toBeVisible();
  await expect(outsider.page.locator('#mapPost')).toBeHidden();
  await expect(outsider.page.locator('#mapCommunity')).toHaveText('islands');
});

test('読むだけで見ている別のコミュニティでは、投稿ボタンは出ない', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '管理のよむだけ', { create: `読む ${unique()}` });
  const postId = await makePost(admin, '毎週水曜に朝の散歩をしています', admin.made.community_id);
  const guest = await person(browser, testInfo, '通りすがり');
  await guest.page.goto(`/?v=${unique()}#/map?post=${postId}`);
  await expect(guest.page.locator('#sheet.on .post-card')).toBeVisible({ timeout: 15000 });
  await expect(guest.page.locator('#mapPost')).toBeHidden();
  await expect(guest.page.locator('#mapCommunity')).toBeDisabled();
});

test('新しい島の光: 7日以内の自分以外の投稿が、開くまで光る。開くと消え、読み直しても戻らない', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '管理のひかり', { create: `光 ${unique()}` });
  const cid = admin.made.community_id;
  const invite = await admin.page.evaluate(async (id) => (await (await import('/static/js/net.js')).api.post('/api/local/invites', { community_id: id, minutes: 120, until_end_of_day: false })), cid);
  const mine = await makePost(admin, '自分の投稿は光りません。朝のランニングが日課です', cid);
  const friend = await person(browser, testInfo, '参加のひかり', { join: invite.code });
  const theirs = await makePost(friend, '週末はコーヒー豆を焙煎して過ごしています', cid);

  const glow = (page, ids) => page.evaluate(async (ids) => {
    // 島の名前は 1 分ほど遅れて届くので、ここでは決めた島を置いて確かめる。
    const { state, notify } = await import('/static/js/state.js');
    state.islands = [{ island_id: 'i-mine', label: 'a', cx: 0, cy: 0, post_ids: [ids.mine] },
      { island_id: 'i-theirs', label: 'b', cx: 10, cy: 10, post_ids: [ids.theirs] }];
    notify('posts');
    return [...(await import('/static/js/map/index.js')).freshIslandSet()];
  }, ids);

  await toMap(admin);
  await expect.poll(() => admin.page.evaluate(async () => (await import('/static/js/state.js')).state.posts.length)).toBe(2);
  expect(await glow(admin.page, { mine, theirs })).toEqual(['i-theirs']);
  // 開く（地図からカードを開くのと同じ入口）
  await admin.page.evaluate(async (id) => (await import('/static/js/screens/map.js')).openPost(id), theirs);
  await expect(admin.page.locator('#sheet.on .post-card')).toBeVisible();
  expect(await glow(admin.page, { mine, theirs })).toEqual([]);
  // 読み直しても（ブラウザに残っているので）戻らない
  await toMap(admin);
  await expect.poll(() => admin.page.evaluate(async () => (await import('/static/js/state.js')).state.posts.length)).toBe(2);
  expect(await glow(admin.page, { mine, theirs })).toEqual([]);
  // ログインしていない人は光らない
  const stranger = await (await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: testInfo.project.use.viewport })).newPage();
  await stranger.goto('/#/map');
  await expect(stranger.locator('#map')).toHaveClass(/active/);
  expect(await glow(stranger, { mine, theirs })).toEqual([]);
});

test('新しい島の光: ブラウザに保存できなくても、その回のあいだは開いた投稿を覚えている', async ({ browser }, testInfo) => {
  const blockSeen = () => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) { if (String(key).startsWith('islands-seen-posts:')) throw new Error('blocked'); return get.call(this, key); };
    Storage.prototype.setItem = function (key, value) { if (String(key).startsWith('islands-seen-posts:')) throw new Error('blocked'); return set.call(this, key, value); };
  };
  const admin = await person(browser, testInfo, '管理のきおく', { create: `記憶 ${unique()}`, init: blockSeen });
  const invite = await admin.page.evaluate(async (id) => (await (await import('/static/js/net.js')).api.post('/api/local/invites', { community_id: id, minutes: 120, until_end_of_day: false })), admin.made.community_id);
  const friend = await person(browser, testInfo, '参加のきおく', { join: invite.code });
  const theirs = await makePost(friend, '古いカメラで街を撮り歩くのが好きです', admin.made.community_id);
  await toMap(admin);
  await expect.poll(() => admin.page.evaluate(async () => (await import('/static/js/state.js')).state.posts.length)).toBe(1);
  const glow = () => admin.page.evaluate(async (id) => {
    const { state, notify } = await import('/static/js/state.js');
    state.islands = [{ island_id: 'i-theirs', label: 'b', cx: 10, cy: 10, post_ids: [id] }];
    notify('posts');
    return [...(await import('/static/js/map/index.js')).freshIslandSet()];
  }, theirs);
  expect(await glow()).toEqual(['i-theirs']);
  await admin.page.evaluate(async (id) => (await import('/static/js/screens/map.js')).openPost(id), theirs);
  await expect(admin.page.locator('#sheet.on .post-card')).toBeVisible();
  expect(await glow()).toEqual([]);
});

test('下のバーは マップ／DM／通知／マイページ。今週の反応のスイッチはもうない', async ({ browser }, testInfo) => {
  const who = await person(browser, testInfo, 'バーのひと', { create: `下 ${unique()}` });
  await toMap(who);
  await expect(who.page.locator('#bottomNav .nav-item:visible .nav-label')).toHaveText(['マップ', 'DM', '通知', 'マイページ']);
  expect(await who.page.locator('#bottomNav').boundingBox().then((box) => box.height)).toBe(64);
  await expect(who.page.locator('#busyToggle')).toHaveCount(0);
  await who.page.locator('[data-route="#/dm"]').click();
  await expect(who.page.locator('#dmList')).toHaveClass(/active/);
  await expect(who.page.locator('[data-route="#/dm"]')).toHaveAttribute('aria-current', 'page');
  await expect(who.page.locator('#dmEmpty')).toContainText('お互いに『もっと話してみたい』を押すと、ここに DM が開きます');
  await expect(who.page.locator('#dmBadge')).toBeHidden();
  await noSideScroll(who.page);
  await who.page.locator('[data-route="#/notifications"]').click();
  await expect(who.page.locator('#notifications')).toHaveClass(/active/);
  await who.page.locator('[data-route="#/me"]').click();
  await expect(who.page.locator('#me')).toHaveClass(/active/);
});

test('DM のタブ: 別の人からの新しいメッセージでバッジが出て、部屋を開くと消える。通知の一覧と数には DM のメッセージが入らない', async ({ browser }, testInfo) => {
  const host = await person(browser, testInfo, '主催のあき');
  const guest = await person(browser, testInfo, '参加のべん');
  const eventId = await makePost(host, '土曜の朝にみんなで公園ランニングをする会です', null, ['参加者募集中']);
  await guest.page.evaluate(async (id) => (await import('/static/js/net.js')).data.addReaction(id, 'join'), eventId);
  await toMap(host);
  await toMap(guest);
  // お互いに押す → 部屋が開く
  await guest.page.evaluate(async (target) => (await import('/static/js/net.js')).data.pressTalk(target), host.id);
  const roomId = await host.page.evaluate(async (target) => {
    const { data } = await import('/static/js/net.js');
    return (await data.pressTalk(target)).room_id;
  }, guest.id);
  expect(roomId).toBeTruthy();
  // 主催者が1通送る
  await host.page.evaluate(async (id) => (await import('/static/js/net.js')).data.sendDm(id, 'はじめまして、土曜は来られそうですか？'), roomId);

  // 参加者の側: 開き直すと、タブにバッジ
  await toMap(guest);
  await expect(guest.page.locator('#dmBadge')).toBeVisible({ timeout: 15000 });
  await expect(guest.page.locator('#dmBadge')).toHaveText('1');
  // 通知の一覧には「お互いに」は残り、DM のメッセージは入らない
  await guest.page.locator('[data-route="#/notifications"]').click();
  await expect(guest.page.locator('.notif', { hasText: 'お互いに' }).first()).toBeVisible();
  await expect(guest.page.locator('.notif', { hasText: 'メッセージが届きました' })).toHaveCount(0);
  // DM の一覧: 未読の行。開くとバッジが消える
  await guest.page.locator('[data-route="#/dm"]').click();
  await expect(guest.page.locator('.dm-row.unread')).toHaveCount(1);
  await guest.page.locator('.dm-row').first().click();
  await expect(guest.page.locator('#dmRoom .dm-bubble').first()).toContainText('土曜は来られそう');
  await expect(guest.page.locator('#dmBadge')).toBeHidden();
  await guest.page.goBack();
  await expect(guest.page.locator('#dmList')).toHaveClass(/active/);
  await expect(guest.page.locator('.dm-row.unread')).toHaveCount(0);
  // 自分が送ったものでは、バッジは付かない
  await guest.page.locator('.dm-row').first().click();
  await guest.page.locator('#dmFoot .chat-input').fill('はい、行けます');
  await guest.page.locator('#dmFoot .chat-send').click();
  await expect(guest.page.locator('.dm-line.mine .dm-bubble').first()).toContainText('行けます');
  await toMap(guest);
  await guest.page.waitForTimeout(1500);
  await expect(guest.page.locator('#dmBadge')).toBeHidden();
  await noSideScroll(guest.page);
});
