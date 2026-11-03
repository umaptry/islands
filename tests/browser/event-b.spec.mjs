// 会（第2回b）：開催の条件（最小開催人数・判定日・キャンセル期限・会のあとの入り方）、イベント限定ページ、受付、会のあと。
// 手元モードのサーバーに、ブラウザ数個（主催者・参加者）でつなぐ。会を作る画面以外は、会を API で作って時刻を
// 手元だけの道（/api/local/events/<code>/set-times・force）で動かす。
// 依頼の確認5点：①メンバーでない参加者は限定ページの外に出られない ②最小人数の表示が申し込み・キャンセルで変わる
// ③判定日の前後で 募集中→開催決定／中止 ④キャンセル期限を過ぎるとボタンが消える ⑤「本人に確認」は押した人だけメンバー。
// 時間がかかるので 390px の幅だけで流す。写真：環境変数 EVB_SHOTS_DIR があれば、そこに番号つきで保存する。
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

test.use({ actionTimeout: 15000 });
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== '390px', '会の第2回b は 390px だけで流す（人数の多い筋書きで時間がかかるため）');
});

const unique = () => Math.random().toString(36).slice(2, 10);
const SHOTS = process.env.EVB_SHOTS_DIR || '';

async function shot(page, name, { full = true } = {}) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
}

/** 中で縦に流れる本文（.ev-body など）も含めて、全体が1枚に入るように縦を伸ばして撮る。 */
async function tallShot(page, name, scroller) {
  if (!SHOTS) return;
  const height = await page.evaluate((selector) => {
    const node = selector ? document.querySelector(selector) : null;
    const extra = node ? Math.max(0, node.scrollHeight - node.clientHeight) : 0;
    return Math.min(4000, Math.max(innerHeight, document.documentElement.scrollHeight) + extra);
  }, scroller);
  const before = page.viewportSize();
  await page.setViewportSize({ width: before.width, height });
  await shot(page, name, { full: false });
  await page.setViewportSize(before);
}

async function openContext(browser, testInfo) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  const problems = { errors: [], failed: [] };
  page.on('pageerror', (error) => problems.errors.push(String(error)));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/') && response.status() >= 500) problems.failed.push(`${response.status()} ${url.pathname}`);
  });
  return { context, page, problems };
}

async function person(browser, testInfo, name, { affiliation = 'テスト会社', confirmed = true } = {}) {
  const who = await openContext(browser, testInfo);
  await who.page.goto('/');
  await who.page.waitForFunction(() => { const on = document.querySelector('.screen.active'); return on && on.id !== 'booting'; });
  const email = `p-${crypto.randomUUID()}@example.com`;
  await who.page.evaluate(async ({ email, name, affiliation, confirmed }) => {
    const { session } = await import('/static/js/session.js');
    const { api } = await import('/static/js/net.js');
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await api.put('/api/account/me', { display_name: name, affiliation, icon_id: 'photo', ...(confirmed ? { name_confirmed: true } : {}) });
  }, { email, name, affiliation, confirmed });
  who.name = name;
  who.id = await who.page.evaluate(async () => (await import('/static/js/session.js')).session.userId());
  return who;
}

/** API を呼ぶ。失敗は投げずに { error: status, detail } で返す（断られることを確かめるため）。 */
const call = (who, method, path, body) => who.page.evaluate(async ({ method, path, body }) => {
  const { api } = await import('/static/js/net.js');
  try {
    if (method === 'get') return await api.get(path);
    return await api.post(path, body || {}, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  } catch (error) {
    return { error: error.status || 0, detail: error.message };
  }
}, { method, path, body });

const iso = (hours) => new Date(Date.now() + hours * 3600000).toISOString();
/** 日本時間の「今日から days 日後」の日付（YYYY-MM-DD）。 */
function jstDay(days) {
  const d = new Date(Date.now() + days * 86400000 + 9 * 3600000);
  return d.toISOString().slice(0, 10);
}
/** 日本時間の「何日後の何時」を、datetime-local の値にする。 */
function jstLocal(days, hour = 19) {
  return `${jstDay(days)}T${String(hour).padStart(2, '0')}:00`;
}

const noSideScroll = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

/** 主催者がコミュニティと会を作る（API）。返り値は code・checkin_code・post_id・community。 */
async function makeEvent(host, { title = 'The Night Office BAR #3', capacity = 6, min, decideIn = 5, cancelIn, join = 'ask', visibility = 'public' } = {}) {
  const community = await call(host, 'post', '/api/local/communities', { name: `夜のBAR ${unique()}`, slug: `t-${unique()}` });
  const event = {
    title, starts_at: `${jstDay(10)}T19:00:00+09:00`, ends_at: `${jstDay(10)}T22:00:00+09:00`, place: '渋谷 ○○ビル 3F', visibility, agree_terms: true,
    join_policy: join,
    questions: [{ prompt: 'now', label: '今やってること', hint: '' }, { prompt: 'past', label: '昔やってたこと', hint: '' }],
  };
  if (min) Object.assign(event, { min_participants: min, decide_on: jstDay(decideIn) });
  if (cancelIn !== undefined) event.cancel_deadline = `${jstDay(cancelIn)}T18:00:00+09:00`;
  const made = await call(host, 'post', '/api/posts', {
    body: '夜のBARでゆるく飲む会を開きます。気軽に来てください', tags: ['参加者募集中'], motivation: 55,
    community_id: community.community_id, recruit_capacity: capacity, event,
  });
  expect(made.error, JSON.stringify(made)).toBeUndefined();
  const code = made.event.public_code;
  const info = await call(host, 'get', `/api/events/${code}`);
  return { code, checkin: made.event.checkin_code || info.checkin_code, postId: made.id, community };
}

const PROFILE = (name, job = 'デザイナー') => ({ display_name: name, affiliation: '○○株式会社', age_band: '30s', job_title: job });

/** メンバーでない人として申し込む（API）。 */
async function applyAs(who, code, { job = 'デザイナー', now = '週末は山でキャンプ飯を作っています' } = {}) {
  const result = await call(who, 'post', `/api/events/${code}/apply`, {
    agree_terms: true, referral: 'SNSで見た', profile: PROFILE(who.name, job),
    answers: [{ prompt: 'now', body: now }, { prompt: 'past', body: '学生のころはバスケ部でした' }],
  });
  return result;
}

const force = (host, code, fields) => call(host, 'post', `/api/local/events/${code}/force`, fields);
/** 受付の時間にする（始まって30分）。 */
const openDoor = (host, code) => call(host, 'post', `/api/local/events/${code}/set-times`, { starts_at: iso(-0.5), ends_at: iso(2.5) });

async function guestView(browser, testInfo, code) {
  const guest = await openContext(browser, testInfo);
  await guest.page.goto(`/?g=${unique()}#/e/${code}`);
  await expect(guest.page.locator('#eventApply')).toHaveClass(/active/);
  await expect(guest.page.locator('#eventApplyBody .ev-title')).toBeVisible({ timeout: 15000 });
  return guest;
}

async function openMe(who, code) {
  await who.page.goto(`/?m=${unique()}#/e/${code}/me`);
  await expect(who.page.locator('#eventMeTitle')).toBeVisible({ timeout: 15000 });
}

function noProblems(...people) {
  for (const who of people) {
    expect(who.problems.errors, `${who.name || '見る人'} の画面の例外`).toEqual([]);
    expect(who.problems.failed, `${who.name || '見る人'} の 5xx`).toEqual([]);
  }
}

// ---------------------------------------------------------------------------------------------

test('会を作る画面の3ステップ：開催の条件の4項目が送られ、主催者の画面に状態の札が出る', async ({ browser }, testInfo) => {
  test.setTimeout(150000);
  const host = await person(browser, testInfo, '主催のひろ');
  const community = await call(host, 'post', '/api/local/communities', { name: `BAR ${unique()}`, slug: `t-${unique()}` });
  const { page } = host;
  await page.goto(`/?host=${unique()}#/post`);
  await expect(page.locator('#composeCommunity')).toContainText(`${community.name} に投稿`);
  await page.locator('#composeBody').fill('夜のBARでゆるく飲む会を開きます。気軽に来てください');
  await page.locator('#composeNext').click();
  await page.locator('#composeMotivation').evaluate((node) => { node.value = '55'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#composeNext2').click();
  await page.locator('#composeTags [data-tag="参加者募集中"]').click();
  await page.locator('#composeCapacity').fill('8');
  await page.locator('#composeEventOn').check();
  await page.locator('#composeSubmit').click();

  // ① 会の中身
  await expect(page.locator('#eventComposeTitle')).toHaveText('会の中身');
  await page.locator('#eventComposeName').fill('The Night Office BAR #3');
  await page.locator('#eventComposeStart').fill(jstLocal(10));
  await page.locator('#eventComposeEnd').fill(jstLocal(10, 22));
  await page.locator('#eventComposePlace').fill('渋谷 ○○ビル 3F');
  await page.locator('#eventComposeNext').click();

  // ② 開催の条件：判定日は最小人数を入れたときだけ出る。入り方の初期値は「本人に確認」
  await expect(page.locator('#eventComposeTitle')).toHaveText('開催の条件');
  await expect(page.locator('#eventComposeDecideField')).toBeHidden();
  await expect(page.locator('#eventComposeJoin [data-join="ask"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#eventComposeMin').fill('3');
  await expect(page.locator('#eventComposeDecideField')).toBeVisible();
  // 判定日なしでは進めない
  await page.locator('#eventComposeNext').click();
  await expect(page.locator('#eventComposeError')).not.toHaveText('');
  await expect(page.locator('#eventComposeTitle')).toHaveText('開催の条件');
  // 定員（8人）より多い最小人数は断られる
  await page.locator('#eventComposeMin').fill('9');
  await page.locator('#eventComposeDecide').fill(jstDay(5));
  await page.locator('#eventComposeNext').click();
  await expect(page.locator('#eventComposeError')).not.toHaveText('');
  await page.locator('#eventComposeMin').fill('3');
  await expect(page.locator('#eventComposeError')).toHaveText('');     // 直したら断りの文は消える
  await page.locator('#eventComposeCancel').fill(jstLocal(8, 18));
  await page.locator('#eventComposeJoin [data-join="none"]').click();
  await page.locator('#eventComposeJoin [data-join="ask"]').click();
  await expect(page.locator('#eventComposeJoin [data-join="ask"]')).toHaveAttribute('aria-checked', 'true');
  await noSideScroll(page);
  await tallShot(page, '01_会を作る_開催の条件', '#eventComposeScroller');
  await page.locator('#eventComposeNext').click();

  // ③ 質問 → 作る
  await expect(page.locator('#eventComposeTitle')).toHaveText('申し込む人への質問');
  await expect(page.locator('#eventComposeNext')).toHaveText('会を作る');
  await page.locator('#eventComposeNext').click();
  await expect(page.locator('#eventHost')).toHaveClass(/active/, { timeout: 30000 });
  const link = await page.locator('#eventHostLink').inputValue();
  const code = link.split('/e/')[1];
  const info = await call(host, 'get', `/api/events/${code}`);
  expect(info.event.min_participants).toBe(3);
  expect(info.event.decide_on).toBe(jstDay(5));
  expect(new Date(info.event.cancel_deadline).toISOString()).toBe(new Date(`${jstLocal(8, 18)}:00+09:00`).toISOString());
  expect(info.event.join_policy).toBe('ask');
  expect(info.event.phase).toBe('recruiting');

  // 主催者の画面：「null」などの文字が紛れ込まない。日時は白地に濃い字
  expect(await page.locator('#eventHostBody').evaluate((node) => [...node.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent))).toEqual([]);
  const lineColor = await page.locator('#eventHost .ev-card .ev-line').first().evaluate((node) => getComputedStyle(node).color);
  expect(lineColor).not.toBe('rgb(255, 255, 255)');
  // 主催者の画面：状態の札「募集中」と人数
  await expect(page.locator('#eventHostGo')).toHaveAttribute('data-phase', 'recruiting');
  await expect(page.locator('#eventHostGo')).toContainText('募集中');
  await expect(page.locator('#eventHostGo')).toContainText('あと3人で開催決定');
  await expect(page.locator('#eventHost')).toContainText('会のあと：本人に確認');

  // 内容を変える：4項目が出る。判定の前は最小人数を変えられる
  await page.locator('#eventHostEdit').click();
  await expect(page.locator('#eventEditMin')).toHaveValue('3');
  await expect(page.locator('#eventEditMin')).toBeEnabled();
  await expect(page.locator('#eventEditDeadline')).not.toHaveValue('');
  await expect(page.locator('#eventEditJoin [data-join="ask"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#eventEditJoin [data-join="auto"]').click();
  await page.locator('#eventEditSave').click();
  await expect(page.locator('#eventHost')).toContainText('会のあと：自動で加入', { timeout: 15000 });
  await page.locator('#eventHostEdit').click();
  await page.locator('#eventEditCancel').click();          // 「やめる」（期限の入力欄とは別の id）
  await expect(page.locator('#eventHostGo')).toBeVisible();
  noProblems(host);
  await host.context.close();
});

test('②③ 最小人数の表示が申し込み・キャンセルで変わり、届くと開催決定（そのあと減っても決定のまま）', async ({ browser }, testInfo) => {
  test.setTimeout(180000);
  const host = await person(browser, testInfo, '主催のひろ');
  const { code } = await makeEvent(host, { min: 3, cancelIn: 7 });
  const ann = await person(browser, testInfo, '山田 花子');
  const bob = await person(browser, testInfo, '佐藤 次郎');
  const cat = await person(browser, testInfo, '鈴木 三郎');

  // 0人：あと3人
  let guest = await guestView(browser, testInfo, code);
  await expect(guest.page.locator('#eventGoalBadge')).toHaveText('募集中');
  await expect(guest.page.locator('#eventGoal')).toContainText('現在0人申込／あと3人で開催決定');
  await guest.context.close();

  expect((await applyAs(ann, code)).status).toBe('applied');
  guest = await guestView(browser, testInfo, code);
  await expect(guest.page.locator('#eventGoal')).toContainText('現在1人申込／あと2人で開催決定');
  const [, month, day] = /^\d{4}-(\d{2})-(\d{2})$/.exec(jstDay(5));
  await expect(guest.page.locator('#eventGoal')).toContainText(`${Number(month)}月${Number(day)}日`);
  await expect(guest.page.locator('#eventGoal')).toContainText('3人集まれば開催');
  await expect(guest.page.locator('#eventGoal')).toContainText('キャンセルは');
  await expect(guest.page.locator('#eventGoal')).toContainText('会のあと、コミュニティに参加するかを選べます');
  await expect(guest.page.locator('#eventApplyNow')).toBeVisible();
  await noSideScroll(guest.page);
  await tallShot(guest.page, '02_申し込みページ_募集中_あと2人', '#eventApplyBody');
  await guest.context.close();

  // 2人目が申し込む → あと1人。キャンセルすると あと2人 に戻る（主催者の画面と限定ページで見る）
  expect((await applyAs(bob, code, { job: 'エンジニア' })).status).toBe('applied');
  await host.page.goto(`/?h=${unique()}#/e/${code}/host`);
  await expect(host.page.locator('#eventHostGo')).toContainText('あと1人で開催決定', { timeout: 15000 });
  await openMe(ann, code);
  await expect(ann.page.locator('#eventMeStage')).toContainText('募集中');
  await expect(ann.page.locator('#eventMeStage')).toContainText('あと1人で開催決定');

  expect((await call(bob, 'post', `/api/events/${code}/cancel`, {})).error).toBeUndefined();
  await host.page.goto(`/?h=${unique()}#/e/${code}/host`);
  await expect(host.page.locator('#eventHostGo')).toContainText('現在1人申込／あと2人で開催決定', { timeout: 15000 });
  await openMe(ann, code);
  await expect(ann.page.locator('#eventMeStage')).toContainText('あと2人で開催決定');

  // もう一度申し込み、3人目も申し込む → 届いた時点で開催決定（判定日を待たない）
  expect((await applyAs(bob, code, { job: 'エンジニア' })).status).toBe('applied');
  const third = await applyAs(cat, code, { job: '編集者' });
  expect(third.status).toBe('applied');
  expect(third.phase).toBe('held');
  await host.page.goto(`/?h=${unique()}#/e/${code}/host`);
  await expect(host.page.locator('#eventHostGo')).toHaveAttribute('data-phase', 'held', { timeout: 15000 });
  await expect(host.page.locator('#eventHostGo')).toContainText('開催決定');
  guest = await guestView(browser, testInfo, code);
  await expect(guest.page.locator('#eventGoalBadge')).toHaveText('開催決定');
  await expect(guest.page.locator('#eventGoal')).toContainText('現在3人申込／開催決定');
  await expect(guest.page.locator('#eventApplyNow')).toBeVisible();     // 定員までは申し込める
  await tallShot(guest.page, '03_申し込みページ_開催決定', '#eventApplyBody');
  await guest.context.close();
  await openMe(ann, code);
  await expect(ann.page.locator('#eventMeStage')).toContainText('開催決定');

  // 決定のあとで1人取り消しても、開催決定のまま
  expect((await call(cat, 'post', `/api/events/${code}/cancel`, {})).error).toBeUndefined();
  const after = await call(host, 'get', `/api/events/${code}`);
  expect(after.event.phase).toBe('held');
  expect(after.event.applied_count).toBe(2);
  await host.page.goto(`/?h=${unique()}#/e/${code}/host`);
  await expect(host.page.locator('#eventHostGo')).toHaveAttribute('data-phase', 'held', { timeout: 15000 });
  await expect(host.page.locator('#eventHostGo')).toContainText('現在2人申込');
  // 判定のあとは最小人数と判定日を変えられない（灰色）
  await host.page.locator('#eventHostEdit').click();
  await expect(host.page.locator('#eventEditMin')).toBeDisabled();
  await expect(host.page.locator('#eventEditGoal')).toContainText('判定のあとは変えられません');
  await host.page.locator('#eventEditCancel').click();
  noProblems(host, ann, bob, cat);
  for (const who of [host, ann, bob, cat]) await who.context.close();
});

test('③ 判定日を過ぎて届いていなければ中止：申し込めず、限定ページと主催者の画面に出る', async ({ browser }, testInfo) => {
  test.setTimeout(150000);
  const host = await person(browser, testInfo, '主催のひろ');
  const { code } = await makeEvent(host, { min: 3 });
  const ann = await person(browser, testInfo, '山田 花子');
  const late = await person(browser, testInfo, '遅れて来た人');
  expect((await applyAs(ann, code)).status).toBe('applied');

  // 判定日の前（今日が判定日でも、その日の終わりまでは募集中）
  await force(host, code, { decide_on: jstDay(0) });
  expect((await call(host, 'get', `/api/events/${code}`)).event.phase).toBe('recruiting');
  // 判定日を昨日にする → 届いていないので中止
  await force(host, code, { decide_on: jstDay(-1) });
  const info = await call(ann, 'get', `/api/events/${code}`);
  expect(info.event.phase).toBe('not_held');
  expect(info.event.closed).toBe('not_held');
  expect(info.me.can_cancel).toBe(false);

  // 申し込みページ：赤い帯、申し込むボタンなし。API でも断られる
  const guest = await guestView(browser, testInfo, code);
  await expect(guest.page.locator('#eventBand').first()).toContainText('人数が集まらなかったため、この会は中止になりました');
  await expect(guest.page.locator('#eventGoalBadge')).toHaveText('中止');
  await expect(guest.page.locator('#eventApplyNow')).toHaveCount(0);
  await expect(guest.page.locator('#eventProbeOpen')).toHaveCount(0);
  await noSideScroll(guest.page);
  await tallShot(guest.page, '04_申し込みページ_中止', '#eventApplyBody');
  await guest.context.close();
  const refused = await applyAs(late, code);
  expect(refused.error).toBe(409);
  expect(refused.detail).toContain('中止');

  // 限定ページ：中止の段階、参加者リストとキャンセルボタンは出ない
  await openMe(ann, code);
  await expect(ann.page.locator('#eventMe')).toContainText('中止');
  await expect(ann.page.locator('#eventMePeople')).toHaveCount(0);
  await expect(ann.page.locator('#eventMeCancel')).toHaveCount(0);
  await expect(ann.page.locator('#eventMeLate')).toHaveCount(0);
  await expect(ann.page.locator('#eventMePlace')).toHaveCount(0);
  await expect(ann.page.locator('#eventMeFriendBand')).toHaveCount(0);
  await expect(ann.page.locator('#eventMe')).not.toContainText('申し込み済み');
  await tallShot(ann.page, '05_限定ページ_中止', '#eventMeBody');

  // 主催者の画面：札と赤い帯
  await host.page.goto(`/?h=${unique()}#/e/${code}/host`);
  await expect(host.page.locator('#eventHostGo')).toHaveAttribute('data-phase', 'not_held', { timeout: 15000 });
  await expect(host.page.locator('#eventHostNotHeld')).toHaveText('人数が集まらず中止になりました');
  // 中止の会は受付もできない
  noProblems(host, ann);
  for (const who of [host, ann, late]) await who.context.close();
});

test('④ 限定ページ：参加者リスト・キャンセル期限の文 → 期限を過ぎるとボタンが消えて「主催者に連絡」', async ({ browser }, testInfo) => {
  test.setTimeout(150000);
  const host = await person(browser, testInfo, '主催のひろ');
  const { code } = await makeEvent(host, { min: 2, cancelIn: 7 });
  const ann = await person(browser, testInfo, '山田 花子');
  const bob = await person(browser, testInfo, '佐藤 次郎');
  await applyAs(ann, code, { now: '週末は山でキャンプ飯を作っています' });
  await applyAs(bob, code, { job: 'エンジニア', now: 'キャンプ道具を集めています' });

  await openMe(ann, code);
  const { page } = ann;
  await expect(page.locator('#eventMeStatus')).toContainText('申し込み済み');
  await expect(page.locator('#eventMeStage')).toContainText('開催決定');
  // 参加者リスト：自分（あなた）・主催者・もう1人。会社・職種・回答。年代は出ない
  await expect(page.locator('#eventMePeopleTitle')).toHaveText('参加者 3人');
  const people = page.locator('#eventMePeople, #eventMeNear');
  await expect(people.locator('.evb-person', { hasText: '山田 花子' })).toContainText('あなた');
  await expect(people.locator('.evb-person', { hasText: '主催のひろ' })).toContainText('主催者');
  await expect(people.locator('.evb-person', { hasText: '佐藤 次郎' })).toContainText('テスト会社・エンジニア');
  await expect(people.locator('.evb-person', { hasText: '佐藤 次郎' })).toContainText('キャンプ道具を集めています');
  await expect(page.locator('#eventMeBody')).not.toContainText('30代');
  // キャンセル：ボタンと期限の文
  await expect(page.locator('#eventMeCancel')).toBeVisible();
  await expect(page.locator('#eventMeCancelNote')).toContainText('キャンセルは');
  await expect(page.locator('#eventMeCancelNote')).toContainText('まで');
  await noSideScroll(page);
  await tallShot(page, '06_限定ページ_参加者リストとキャンセル', '#eventMeBody');

  // 期限を1時間前にする → ボタンが消えて、主催者に連絡の文
  await force(host, code, { cancel_deadline: iso(-1) });
  await openMe(ann, code);
  await expect(page.locator('#eventMeStatus')).toContainText('申し込み済み');
  await expect(page.locator('#eventMeCancel')).toHaveCount(0);
  await expect(page.locator('#eventMeCancelNote')).toHaveText('期限後のキャンセルは主催者に連絡してください');
  await tallShot(page, '07_限定ページ_キャンセル期限のあと', '#eventMeBody');
  // API でも取り消せない
  const refused = await call(ann, 'post', `/api/events/${code}/cancel`, {});
  expect(refused.error).toBe(409);
  expect(refused.detail).toContain('期限');
  noProblems(host, ann, bob);
  for (const who of [host, ann, bob]) await who.context.close();
});

test('① メンバーでない参加者は、限定ページの外（地図・マイページ・通知・コミュニティ・人）に出られず、API も中身を返さない', async ({ browser }, testInfo) => {
  test.setTimeout(150000);
  const host = await person(browser, testInfo, '主催のひろ');
  const first = await makeEvent(host, { min: 2, join: 'ask' });
  const other = await makeEvent(host, { title: 'ほかの会', join: 'ask' });
  const member = await person(browser, testInfo, 'メンバーの人');
  await applyAs(member, other.code);           // ほかの会の参加者リストを見られる人（比べるため）
  const ann = await person(browser, testInfo, '山田 花子');
  await applyAs(ann, first.code);
  await openMe(ann, first.code);
  const { page } = ann;
  const me = `#/e/${first.code}/me`;

  for (const hash of ['#/map', '#/me', '#/notifications', '#/dm', '#/post', `#/community/${first.community.community_id}`,
    `#/u/${host.id}`, `#/map?post=${first.postId}`, `#/e/${first.code}/host`]) {
    await page.goto(`/?x=${unique()}${hash}`);
    await expect.poll(() => page.evaluate(() => location.hash), { message: `${hash} から限定ページへ` }).toBe(me);
    await expect(page.locator('#eventMe')).toHaveClass(/active/);
    await expect(page.locator('#bottomNav')).toBeHidden();
  }
  // ほかの会の自分用ページは、その会の公開ページに（中身は公開の集計だけ）
  await page.goto(`/?x=${unique()}#/e/${other.code}/me`);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/e/${other.code}`);
  await expect(page.locator('#eventApplyBody')).not.toContainText('メンバーの人');

  // API：ほかの会の参加者リスト・名簿・会のあとは 404/403。自分の会の名簿（主催者だけ）も見られない
  expect((await call(ann, 'get', `/api/events/${other.code}/participants`)).error).toBe(404);
  expect((await call(member, 'get', `/api/events/${other.code}/participants`)).people.length).toBeGreaterThan(0);
  expect([403, 404]).toContain((await call(ann, 'get', `/api/events/${first.code}/roster`)).error);
  expect([403, 404]).toContain((await call(ann, 'get', `/api/events/${other.code}/after`)).error);
  expect([403, 404]).toContain((await call(ann, 'get', `/api/events/${first.code}/after`)).error);   // 受付前
  expect((await call(ann, 'get', `/api/events/${first.code}/participants`)).people.length).toBe(2);

  // コミュニティの中身（メンバー限定のスイッチが入りのとき＝本番と同じ守り）
  const before = (await call(host, 'get', '/api/local/settings/members-only')).members_only;
  try {
    await call(host, 'post', '/api/local/settings/members-only', { value: true });
    const map = await call(ann, 'get', `/api/local/communities/${first.community.community_id}/map`);
    expect(map.posts || []).toEqual([]);
    expect((await call(ann, 'get', `/api/local/communities/${first.community.community_id}`)).error).toBe(404);
    const hostMap = await call(host, 'get', `/api/local/communities/${first.community.community_id}/map`);
    expect((hostMap.posts || []).length).toBeGreaterThan(0);
  } finally {
    await call(host, 'post', '/api/local/settings/members-only', { value: Boolean(before) });
  }
  noProblems(ann);
  for (const who of [host, member, ann]) await who.context.close();
});

test('⑤ 入り方：「本人に確認」は受付のあと参加ボタンを押した人だけメンバー。自動は受付でメンバー、加入させないはならない', async ({ browser }, testInfo) => {
  test.setTimeout(240000);
  const host = await person(browser, testInfo, '主催のひろ');
  const ask = await makeEvent(host, { join: 'ask' });
  const auto = await makeEvent(host, { join: 'auto', title: '自動で加入の会' });
  const none = await makeEvent(host, { join: 'none', title: '加入させない会' });
  for (const event of [ask, auto, none]) await openDoor(host, event.code);

  const ann = await person(browser, testInfo, '山田 花子');     // ask・押す
  const bob = await person(browser, testInfo, '佐藤 次郎');     // ask・押さない
  const cat = await person(browser, testInfo, '鈴木 三郎');     // auto
  const dan = await person(browser, testInfo, '田中 四郎');     // none
  await applyAs(ann, ask.code);
  await applyAs(bob, ask.code, { job: 'エンジニア' });
  await applyAs(cat, auto.code);
  await applyAs(dan, none.code);

  // 受付（QR の道 /c/<checkin_code>）：申し込み済みなら「受付する」
  async function checkInByQr(who, event, name) {
    await who.page.goto(`/c/${event.checkin}`);
    await expect.poll(() => who.page.evaluate(() => location.hash)).toBe(`#/c/${event.checkin}`);
    await expect(who.page.locator('#eventCheckinGo')).toBeVisible({ timeout: 15000 });
    if (name) await tallShot(who.page, name, '#eventCheckinBody');
    await who.page.locator('#eventCheckinGo').click();
    await expect(who.page.locator('#eventCheckinDone')).toHaveText('受付しました', { timeout: 15000 });
  }
  await checkInByQr(ann, ask, '10_受付_受付する');
  await expect(ann.page.locator('#eventCheckinDoneNote')).not.toContainText('メンバーになりました');
  await tallShot(ann.page, '11_受付_受付しました', '#eventCheckinBody');
  await checkInByQr(bob, ask);
  await checkInByQr(cat, auto);
  await expect(cat.page.locator('#eventCheckinDoneNote')).toContainText('のメンバーになりました');
  await checkInByQr(dan, none);
  await expect(dan.page.locator('#eventCheckinDoneNote')).not.toContainText('メンバーになりました');

  const isMember = async (who, event) => (await call(who, 'get', `/api/events/${event.code}`)).me.is_member;
  expect(await isMember(ann, ask)).toBe(false);
  expect(await isMember(bob, ask)).toBe(false);
  expect(await isMember(cat, auto)).toBe(true);
  expect(await isMember(dan, none)).toBe(false);

  // 「本人に確認」：受付した人の限定ページに参加のカード。押すと確かめてからメンバーに
  await ann.page.locator('#eventCheckinToMe').click();
  await expect(ann.page.locator('#eventMeJoinCard')).toBeVisible({ timeout: 15000 });
  await expect(ann.page.locator('#eventMeJoinCard')).toContainText('のメンバーになると、地図やほかの人の投稿が見られます');
  await expect(ann.page.locator('#eventMeStatus')).toContainText('受付しました');
  await noSideScroll(ann.page);
  await tallShot(ann.page, '08_限定ページ_このコミュニティに参加する', '#eventMeBody');
  // まだメンバーでないので、地図には出られない
  await ann.page.evaluate(() => { location.hash = '#/map'; });
  await expect.poll(() => ann.page.evaluate(() => location.hash)).toBe(`#/e/${ask.code}/me`);
  await expect(ann.page.locator('#eventMeJoin')).toBeVisible({ timeout: 15000 });
  await ann.page.locator('#eventMeJoin').click();
  await expect(ann.page.locator('.modal')).toContainText('に参加しますか？');
  await ann.page.locator('.modal').getByRole('button', { name: '参加する', exact: true }).click();
  await expect(ann.page.locator('#eventMeJoined')).toContainText('メンバーになりました', { timeout: 15000 });
  await expect(ann.page.locator('#eventMeJoin')).toHaveCount(0);
  await tallShot(ann.page, '09_限定ページ_参加したあと', '#eventMeBody');
  expect(await isMember(ann, ask)).toBe(true);
  // マップを開ける（もう限定ページに戻されない）
  await ann.page.locator('#eventMeJoinedMap').click();
  await expect(ann.page.locator('#map')).toHaveClass(/active/, { timeout: 20000 });
  expect(await ann.page.evaluate(() => location.hash)).toMatch(/^#\/map/);

  // 押さない人はメンバーにならず、カードが出たまま
  await openMe(bob, ask.code);
  await expect(bob.page.locator('#eventMeJoin')).toBeVisible();
  expect(await isMember(bob, ask)).toBe(false);
  // 加入させない会：カードは出ず、API でも入れない
  await openMe(dan, none.code);
  await expect(dan.page.locator('#eventMeStatus')).toContainText('受付しました');
  await expect(dan.page.locator('#eventMeJoin')).toHaveCount(0);
  expect((await call(dan, 'post', `/api/events/${none.code}/join`, {})).error).toBe(409);
  expect(await isMember(dan, none)).toBe(false);
  await dan.page.evaluate(() => { location.hash = '#/map'; });
  await expect.poll(() => dan.page.evaluate(() => location.hash)).toBe(`#/e/${none.code}/me`);
  // 受付の前は参加できない
  const eve = await person(browser, testInfo, '伊藤 五郎');
  await applyAs(eve, ask.code);
  expect((await call(eve, 'post', `/api/events/${ask.code}/join`, {})).error).toBe(403);
  noProblems(host, ann, bob, cat, dan);
  for (const who of [host, ann, bob, cat, dan, eve]) await who.context.close();
});

test('飛び入り：受付待ち → 主催者が名簿で受付 → 本人の画面が自動で「受付しました」。却下もできる', async ({ browser }, testInfo) => {
  test.setTimeout(180000);
  const host = await person(browser, testInfo, '主催のひろ');
  const event = await makeEvent(host, { min: 2, join: 'ask' });
  const ann = await person(browser, testInfo, '山田 花子');
  const bob = await person(browser, testInfo, '佐藤 次郎');
  await applyAs(ann, event.code);
  await applyAs(bob, event.code, { job: 'エンジニア' });

  // 受付の時間の前は「まだ」
  // フルネームの確認がまだの人（確認済みの人の名前と会社は、受付の画面で変えても今のまま。DB と同じ）
  const walk = await person(browser, testInfo, 'ろくこ', { confirmed: false });
  await walk.page.goto(`/c/${event.checkin}`);
  await expect(walk.page.locator('#eventCheckinNote')).toHaveText('受付はまだ始まっていません', { timeout: 15000 });
  await openDoor(host, event.code);

  // 申し込みの無い人：名前と会社 → 受付をお願いする → 受付待ち
  await walk.page.goto(`/?w=${unique()}#/c/${event.checkin}`);
  await expect(walk.page.locator('#eventCheckinSend')).toBeVisible({ timeout: 15000 });
  await walk.page.locator('#eventCheckinName').fill('飛び入り 六子');
  await walk.page.locator('#eventCheckinAffiliation').fill('六子デザイン');
  await tallShot(walk.page, '12_受付_飛び入りの入力', '#eventCheckinBody');
  await walk.page.locator('#eventCheckinSend').click();
  await expect(walk.page.locator('#eventCheckinWaiting')).toHaveText('受付を待っています', { timeout: 15000 });
  await tallShot(walk.page, '13_受付_受付待ち', '#eventCheckinBody');

  // もう1人の飛び入りは却下される
  const nope = await person(browser, testInfo, '却下 七子');
  await nope.page.goto(`/?w=${unique()}#/c/${event.checkin}`);
  await nope.page.locator('#eventCheckinSend').click();
  await expect(nope.page.locator('#eventCheckinWaiting')).toBeVisible({ timeout: 15000 });

  // 主催者の画面：受付待ち 2人、受付する・却下
  await host.page.goto(`/?h=${unique()}#/e/${event.code}/host`);
  const waiting = host.page.locator('.ev-person[data-status="waiting"]');
  await expect(waiting).toHaveCount(2, { timeout: 15000 });
  await expect(host.page.locator('#eventHost')).toContainText('受付待ち');
  await expect(waiting.filter({ hasText: '飛び入り 六子' })).toContainText('六子デザイン');
  await expect(host.page.locator('#eventHostGo')).toContainText('開催決定');
  await noSideScroll(host.page);
  await host.page.locator('#eventRosterCounts').scrollIntoViewIfNeeded();
  await tallShot(host.page, '14_主催者の画面_状態の札と受付待ち', '#eventHostBody');

  await waiting.filter({ hasText: '却下 七子' }).locator('.ev-reject').click();
  await host.page.locator('.modal .btn-danger').click();
  await expect(waiting).toHaveCount(1, { timeout: 15000 });
  await waiting.filter({ hasText: '飛び入り 六子' }).locator('.ev-checkin').click();
  await expect(host.page.locator('.ev-person[data-status="waiting"]')).toHaveCount(0, { timeout: 15000 });
  await expect(host.page.locator('.ev-person[data-status="attended"]', { hasText: '飛び入り 六子' })).toHaveCount(1);

  // 本人の画面は数秒ごとに読み直して「受付しました」へ
  await expect(walk.page.locator('#eventCheckinDone')).toHaveText('受付しました', { timeout: 20000 });
  await expect(nope.page.locator('#eventCheckinRejected')).toHaveText('受付できませんでした', { timeout: 20000 });
  await tallShot(nope.page, '15_受付_却下', '#eventCheckinBody');

  // 申し込み済みの人は「•••」から受付できる（受付時間に関係なく）
  const annRow = host.page.locator('.ev-person', { hasText: '山田 花子' });
  await annRow.locator('.ev-more').click();
  await annRow.locator('.ev-checkin-menu').click();
  await expect(host.page.locator('.ev-person[data-status="attended"]', { hasText: '山田 花子' })).toHaveCount(1, { timeout: 15000 });
  noProblems(host, walk, nope);
  for (const who of [host, ann, bob, walk, nope]) await who.context.close();
});

test('会のあと：限定ページの「会った人を選ぶ」→ 会えてよかった（トグル）。メンバーでない人には参加の案内', async ({ browser }, testInfo) => {
  test.setTimeout(180000);
  const host = await person(browser, testInfo, '主催のひろ');
  const event = await makeEvent(host, { join: 'ask' });
  const ann = await person(browser, testInfo, '山田 花子');
  const bob = await person(browser, testInfo, '佐藤 次郎');
  const cat = await person(browser, testInfo, '鈴木 三郎');
  await applyAs(ann, event.code);
  await applyAs(bob, event.code, { job: 'エンジニア' });
  await applyAs(cat, event.code, { job: '編集者' });
  await openDoor(host, event.code);
  for (const who of [ann, bob]) expect((await call(who, 'post', `/api/checkin/${event.checkin}`, {})).result).toBe('attended');
  // 会が終わった（3時間前に始まって1時間前に終わった）
  await call(host, 'post', `/api/local/events/${event.code}/set-times`, { starts_at: iso(-3), ends_at: iso(-1) });

  await openMe(ann, event.code);
  await expect(ann.page.locator('#eventMeAfter')).toHaveText('会った人を選ぶ');
  await ann.page.locator('#eventMeAfter').click();
  await expect(ann.page.locator('#eventAfterTitle')).toHaveText('今日の会で会った人', { timeout: 15000 });
  // 受付が済んだ人だけ（申し込んだだけの鈴木さんは出ない）
  await expect(ann.page.locator('#eventAfterList .evb-person')).toHaveCount(1);
  await expect(ann.page.locator('#eventAfterList')).toContainText('佐藤 次郎');
  await expect(ann.page.locator('#eventAfterList')).not.toContainText('鈴木 三郎');
  await expect(ann.page.locator('#eventAfterJoinCard')).toContainText('コミュニティに参加すると「もっと話してみたい」も押せます');
  const met = ann.page.locator('#eventAfterList [data-met]');
  await expect(met).toHaveAttribute('aria-pressed', 'false');
  await met.click();
  await expect(met).toHaveAttribute('aria-pressed', 'true');
  await noSideScroll(ann.page);
  await tallShot(ann.page, '16_会のあと_会えてよかった', '#eventAfterBody');
  const read = await call(ann, 'get', `/api/events/${event.code}/after`);
  expect(read.people.find((p) => p.account_id === bob.id).met).toBe(true);
  // 押し直すと消える
  await met.click();
  await expect(met).toHaveAttribute('aria-pressed', 'false');
  expect((await call(ann, 'get', `/api/events/${event.code}/after`)).people[0].met).toBe(false);
  // 受付していない人は会のあとを開けず、自分のページへ
  await cat.page.goto(`/?a=${unique()}#/e/${event.code}/after`);
  await expect.poll(() => cat.page.evaluate(() => location.hash)).toBe(`#/e/${event.code}/me`);
  // 「終わる」で限定ページへ
  await ann.page.locator('#eventAfterDone').click();
  await expect.poll(() => ann.page.evaluate(() => location.hash)).toBe(`#/e/${event.code}/me`);
  noProblems(host, ann, bob, cat);
  for (const who of [host, ann, bob, cat]) await who.context.close();
});
