// メンバーを招待する（LINE のような、1コミュニティ1リンク + QR）。コミュニティ編集画面（#/community/:id）。
// 手元モードのサーバーに、管理者と、ふつうの会員のブラウザでつなぐ。
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const unique = () => Math.random().toString(36).slice(2, 10);

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
    await api.put('/api/account/me', { display_name: name, affiliation: 'テスト', icon_id: 'photo' });
    if (create) return api.post('/api/local/communities', { name: create, slug: `t-${Math.random().toString(36).slice(2, 9)}` }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
    if (join) await api.post('/api/local/invites/claim', { code: join });
    return null;
  }, { email, name, create, join });
  return { page, context, made };
}

const makePost = (who, body, communityId) => who.page.evaluate(async ({ body, communityId }) => {
  const { api } = await import('/static/js/net.js');
  const made = await api.post('/api/posts', { body, tags: [], motivation: 55, community_id: communityId },
    { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  return made.id;
}, { body, communityId });

// この会の、まだ使える招待（サーバー側の事実）
const activeCodes = (who, communityId) => who.page.evaluate(async (id) => {
  const { api } = await import('/static/js/net.js');
  const now = Date.now();
  return (await api.get(`/api/local/invites?community_id=${id}`)).invites
    .filter((row) => !row.revoked_at && Date.parse(row.expires_at) > now).map((row) => row.code);
}, communityId);

const addInvite = (who, communityId, minutes) => who.page.evaluate(async ({ communityId, minutes }) => {
  const { api } = await import('/static/js/net.js');
  return api.post('/api/local/invites', { community_id: communityId, minutes, until_end_of_day: false });
}, { communityId, minutes });

const noSideScroll = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

// シェアはできるが、画像ファイルは渡せない端末（デスクトップ）
const withShare = () => {
  window.__shared = [];
  Object.defineProperty(navigator, 'share', { configurable: true, value: async (payload) => { window.__shared.push(payload); } });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
};
// 画像ファイルまで渡せるタッチ端末（iPhone など）
const withFileShare = () => {
  window.__shared = [];
  Object.defineProperty(navigator, 'share', { configurable: true, value: async (payload) => { window.__shared.push({ ...payload, files: (payload.files || []).map((f) => `${f.name}|${f.type}|${f.size}`) }); } });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: (payload) => Boolean(payload && payload.files) });
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
};
const withoutShare = () => {
  Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
};

const openEdit = async (who, communityId) => {
  await who.page.goto(`/?me=${unique()}#/community/${communityId}`);
  const card = who.page.locator(`#communityEditBody .community-invites[data-community-id="${communityId}"]`);
  await card.waitFor({ timeout: 15000 });
  return card;
};

test('リンクがないとき「メンバーを招待する」→ 期限 → 「リンクを作る」で、QR と3つのボタンが出る', async ({ browser }, testInfo) => {
  const name = `招待 ${unique()}`;
  const admin = await person(browser, testInfo, '招待のひと', { create: name, init: withShare });
  const id = admin.made.community_id;
  const card = await openEdit(admin, id);
  await expect(card.locator('.invite-qr')).toHaveCount(0);
  await expect(card.locator('.invite-open')).toHaveText('メンバーを招待する');
  await card.locator('.invite-open').click();
  // 期限は今日中が初めから選ばれている
  await expect(card.locator('.invite-chip.on')).toHaveText('今日中');
  await expect(card.locator('.invite-chip')).toHaveCount(5);
  await card.locator('.invite-make').click();

  const svg = card.locator('.invite-qr svg');
  await expect(svg).toBeVisible();
  await expect(svg).toHaveAttribute('aria-label', '招待の QR コード');
  await expect(card.locator('.invite-line')).toContainText('あと');
  await expect(card.locator('.invite-line')).toContainText('まだ使われていません');
  await expect(card.getByRole('button', { name: 'リンクをコピー' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'シェア' })).toBeVisible();
  await expect(card.getByRole('button', { name: '保存' })).toBeVisible();
  await expect(card.locator('.invite-with-post')).toBeAttached();
  await expect(card.locator('.invite-renew')).toBeVisible();
  await expect(card.locator('.invite-revoke')).toBeVisible();
  expect(await activeCodes(admin, id)).toHaveLength(1);

  // 携帯のカメラが読める大きさ: 1コマ(モジュール)が画面で 3.5px 以上
  const box = await svg.boundingBox();
  const modules = Number(await svg.getAttribute('data-modules'));
  expect(box.width / modules).toBeGreaterThanOrEqual(3.5);
  expect(box.width).toBeGreaterThanOrEqual(Math.min(200, testInfo.project.use.viewport.width - 80));
  await noSideScroll(admin.page);
  // 開き直しても同じリンクがそのまま出る（誰が開いても同じ）
  const urlBefore = await card.locator('.invite-url').inputValue();
  const again = await openEdit(admin, id);
  await expect(again.locator('.invite-url')).toHaveValue(urlBefore);
});

test('「会の投稿も一緒に開く」を切り替えるとリンクと QR が変わるが、招待は増えない', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '招待のふたつめ', { create: `切替 ${unique()}`, init: withShare });
  const id = admin.made.community_id;
  const postId = await makePost(admin, '金曜の夜に集まります', id);
  const card = await openEdit(admin, id);
  await card.locator('.invite-open').click();
  await card.locator('.invite-make').click();
  const field = card.locator('.invite-url');
  await expect(field).toBeAttached();
  const plain = await field.inputValue();
  expect(plain).not.toContain('?post=');
  const qrBefore = await card.locator('.invite-qr svg path').getAttribute('d');
  const codes = await activeCodes(admin, id);

  await card.locator('.invite-switch').click();
  await expect(card.locator('.invite-with-post')).toBeChecked();
  await expect(card.locator('.invite-post-select')).toBeVisible();
  await expect(field).toHaveValue(`${plain}?post=${postId}`);
  expect(await card.locator('.invite-qr svg path').getAttribute('d')).not.toBe(qrBefore);
  expect(await activeCodes(admin, id)).toEqual(codes);

  await card.locator('.invite-switch').click();
  await expect(field).toHaveValue(plain);
  expect(await card.locator('.invite-qr svg path').getAttribute('d')).toBe(qrBefore);
  expect(await activeCodes(admin, id)).toEqual(codes);
  await noSideScroll(admin.page);
});

test('更新: 確かめてから作り直すと、前のリンクは止まり新しいものが出る。やめるなら何も変わらない', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '招待のみっつめ', { create: `更新 ${unique()}`, init: withShare });
  const id = admin.made.community_id;
  const card = await openEdit(admin, id);
  await card.locator('.invite-open').click();
  await card.locator('.invite-make').click();
  const field = card.locator('.invite-url');
  await expect(field).toBeAttached();
  const [oldCode] = await activeCodes(admin, id);

  await card.locator('.invite-renew').click();
  await expect(card.locator('.invite-chip.on')).toHaveText('今日中');
  await card.locator('.invite-chip[data-key="7d"]').click();
  await card.locator('.invite-make').click();
  await expect(admin.page.locator('.modal-title')).toHaveText('いまのリンクと QR は使えなくなります。作り直しますか？');
  // いったんやめる
  await admin.page.locator('.modal-actions .btn-quiet').click();
  expect(await activeCodes(admin, id)).toEqual([oldCode]);
  await card.locator('.invite-cancel').click();
  await expect(field).toHaveValue(new RegExp(oldCode));

  await card.locator('.invite-renew').click();
  await card.locator('.invite-chip[data-key="7d"]').click();
  await card.locator('.invite-make').click();
  await admin.page.locator('.modal-actions .btn-danger').click();
  await expect(card.locator('.invite-line')).toContainText('あと7日');
  const now = await activeCodes(admin, id);
  expect(now).toHaveLength(1);
  expect(now[0]).not.toBe(oldCode);
  await expect(card.locator('.invite-url')).toHaveValue(new RegExp(now[0]));
  await noSideScroll(admin.page);
});

test('止める: 確かめてから、いまあるリンクをすべて止めて「メンバーを招待する」に戻る。前から2本あれば、更新で1本になる', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '招待のよっつめ', { create: `停止 ${unique()}`, init: withShare });
  const id = admin.made.community_id;
  // 前からリンクが2本あった場合: 新しい方を見せ、止める・更新は両方に効く
  await addInvite(admin, id, 60);
  await addInvite(admin, id, 120);
  const card = await openEdit(admin, id);
  await expect(card.locator('.invite-qr')).toBeVisible();
  expect(await activeCodes(admin, id)).toHaveLength(2);
  await expect(card.locator('.invite-line')).toContainText('あと2時間');   // 新しい方（120分）
  await card.locator('.invite-revoke').click();
  await expect(admin.page.locator('.modal-title')).toHaveText('この招待リンクを止めますか？');
  await admin.page.locator('.modal-actions .btn-quiet').click();
  expect(await activeCodes(admin, id)).toHaveLength(2);
  await card.locator('.invite-revoke').click();
  await admin.page.locator('.modal-actions .btn-danger').click();
  await expect(card.locator('.invite-open')).toHaveText('メンバーを招待する');
  await expect(card.locator('.invite-qr')).toHaveCount(0);
  expect(await activeCodes(admin, id)).toHaveLength(0);

  // 2本あるときの「更新」は、全部止めて新しい1本だけにする
  await addInvite(admin, id, 30);
  await addInvite(admin, id, 90);
  const card2 = await openEdit(admin, id);
  await expect(card2.locator('.invite-qr')).toBeVisible();
  await card2.locator('.invite-renew').click();
  await card2.locator('.invite-make').click();
  await admin.page.locator('.modal-actions .btn-danger').click();
  await expect.poll(() => activeCodes(admin, id).then((list) => list.length)).toBe(1);
  await expect(card2.locator('.invite-qr')).toBeVisible();
});

test('コピー・シェア・保存: 文面と画像が決めどおりで、シェアが無い端末ではボタンが隠れる', async ({ browser }, testInfo) => {
  const name = `共有 ${unique()}`;
  const admin = await person(browser, testInfo, '招待のいつつめ', { create: name, init: withShare });
  const id = admin.made.community_id;
  const card = await openEdit(admin, id);
  await card.locator('.invite-open').click();
  await card.locator('.invite-make').click();
  await expect(card.locator('.invite-qr svg')).toBeVisible();
  const url = await card.locator('.invite-url').inputValue();

  await card.locator('.invite-copy').click();
  await expect(admin.page.locator('#toast.on')).toBeVisible();

  await card.locator('.invite-share').click();
  expect(await admin.page.evaluate(() => window.__shared))
    .toEqual([{ title: `${name} への招待`, text: `islands の「${name}」に招待します`, url }]);

  // 保存: この端末は共有で画像を渡せないので、PNG のダウンロードになる
  const [download] = await Promise.all([admin.page.waitForEvent('download'), card.locator('.invite-save').click()]);
  expect(download.suggestedFilename()).toBe(`islands_招待_${name}.png`);
  const bytes = readFileSync(await download.path());
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.length).toBeGreaterThan(3000);
  await testInfo.attach('saved-qr.png', { body: bytes, contentType: 'image/png' });

  // シェアが無い端末
  const plain = await person(browser, testInfo, '招待のむっつめ', { create: `共有なし ${unique()}`, init: withoutShare });
  const card2 = await openEdit(plain, plain.made.community_id);
  await card2.locator('.invite-open').click();
  await card2.locator('.invite-make').click();
  await expect(card2.locator('.invite-copy')).toBeVisible();
  await expect(card2.locator('.invite-save')).toBeVisible();
  await expect(card2.locator('.invite-share')).toHaveCount(0);
  await noSideScroll(plain.page);
});

test('管理者でない人は、招待の画面に入れない', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '招待のななつめ', { create: `権限 ${unique()}` });
  const id = admin.made.community_id;
  const invite = await addInvite(admin, id, 120);
  const member = await person(browser, testInfo, '招待のやっつめ', { join: invite.code });
  await member.page.goto(`/?e=${unique()}#/community/${id}`);
  await expect(member.page.locator('#communityEditNote')).toContainText('管理者だけ');
  await expect(member.page.locator('.invite-open')).toHaveCount(0);
  await expect(member.page.locator('.invite-qr')).toHaveCount(0);
  await expect(member.page.locator('.community-invites')).toHaveCount(0);
});

test('タッチ端末で画像を渡せるなら、保存は共有シート（画像を保存）に PNG を渡す。ダウンロードはしない', async ({ browser }, testInfo) => {
  const name = `写真 ${unique()}`;
  const admin = await person(browser, testInfo, '招待のここのつめ', { create: name, init: withFileShare });
  const card = await openEdit(admin, admin.made.community_id);
  await card.locator('.invite-open').click();
  await card.locator('.invite-make').click();
  await expect(card.locator('.invite-qr svg')).toBeVisible();
  let downloaded = false;
  admin.page.on('download', () => { downloaded = true; });
  await card.locator('.invite-save').click();
  await expect.poll(() => admin.page.evaluate(() => window.__shared.length)).toBe(1);
  const [shared] = await admin.page.evaluate(() => window.__shared);
  expect(shared.title).toBe(`${name} への招待`);
  expect(shared.files).toHaveLength(1);
  expect(shared.files[0]).toMatch(new RegExp(`^islands_招待_${name}\.png\|image/png\|\d{4,}$`));
  expect(downloaded).toBe(false);
});

test('止められなかったとき: 文が消えずに残り、更新で作ったリンクが増え続けない。止める前に一覧を取り直す', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '招待のじゅうめ', { create: `失敗 ${unique()}`, init: withShare });
  const id = admin.made.community_id;
  const card = await openEdit(admin, id);
  await card.locator('.invite-open').click();
  await card.locator('.invite-make').click();
  await expect(card.locator('.invite-qr svg')).toBeVisible();

  // 止める処理だけが失敗する
  await admin.page.route('**/api/local/invites/*/revoke', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"error"}' }));
  await card.locator('.invite-revoke').click();
  await admin.page.locator('.modal-actions .btn-danger').click();
  await expect(card.locator('.error')).toContainText('止められないリンク');
  await expect(card.locator('.invite-qr svg')).toBeVisible();

  // 更新: 新しいリンクは1本だけ増え、画面は期限選びに戻らず、古いのを止められなかったと伝える
  await card.locator('.invite-renew').click();
  await card.locator('.invite-make').click();
  await admin.page.locator('.modal-actions .btn-danger').click();
  await expect(card.locator('.error')).toContainText('古いリンクを止められませんでした');
  await expect(card.locator('.invite-renew')).toBeVisible();
  expect(await activeCodes(admin, id)).toHaveLength(2);

  // 別の管理者が画面を開いたあとに作った招待も、止めるときは含まれる
  await admin.page.unroute('**/api/local/invites/*/revoke');
  await addInvite(admin, id, 45);
  expect(await activeCodes(admin, id)).toHaveLength(3);
  await card.locator('.invite-revoke').click();
  await admin.page.locator('.modal-actions .btn-danger').click();
  await expect(card.locator('.invite-open')).toBeVisible();
  expect(await activeCodes(admin, id)).toHaveLength(0);
});

test('リンクを作る前に「会の投稿も一緒に開く」を決められる。作ったリンクは最初からその投稿つき', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '事前のひと', { create: `事前 ${unique()}`, init: withShare });
  const id = admin.made.community_id;
  const older = await makePost(admin, '古い投稿です', id);
  const newer = await makePost(admin, '新しい投稿です', id);
  const card = await openEdit(admin, id);
  await card.locator('.invite-open').click();
  // 期限のすぐ下に、投稿のスイッチがあり、「リンクを作る」はその後ろ
  await expect(card.locator('.invite-chip')).toHaveCount(5);
  await expect(card.locator('.invite-switch')).toBeVisible();
  await expect(card.locator('.invite-with-post')).toBeEnabled({ timeout: 10000 });
  await expect(card.locator('.invite-post-select')).toBeHidden();
  const order = await card.locator('.invite-form').evaluate((form) => [...form.children].map((child) => child.className));
  expect(order.findIndex((c) => c.includes('invite-chips'))).toBeLessThan(order.findIndex((c) => c.includes('invite-switch')));
  expect(order.findIndex((c) => c.includes('invite-switch'))).toBeLessThan(order.findIndex((c) => c.includes('invite-make')));
  await card.locator('.invite-switch').click();
  await expect(card.locator('.invite-post-select')).toBeVisible();
  await card.locator('.invite-post-select').selectOption(older);
  await card.screenshot({ path: `C:/Users/tatsu/Desktop/Claude Code/islands_261012/_pw_tmp/fb2/rest/invite-choose-${testInfo.project.name}.png` });
  await card.locator('.invite-make').click();
  await expect(card.locator('.invite-qr svg')).toBeVisible();
  const code = (await activeCodes(admin, id))[0];
  await expect(card.locator('.invite-url')).toHaveValue(new RegExp(`#/invite/${code}[?]post=${older}$`));
  await expect(card.locator('.invite-with-post')).toBeChecked();
  await expect(card.locator('.invite-post-select')).toHaveValue(older);
  // 上のスイッチは今までどおり使えて、切ると投稿なしのリンクになる
  await card.locator('.invite-switch').click();
  await expect(card.locator('.invite-url')).toHaveValue(new RegExp(`#/invite/${code}$`));
  expect(newer).not.toBe(older);
  expect(await activeCodes(admin, id)).toHaveLength(1);
  await noSideScroll(admin.page);
});

test('投稿をつけずに作ったリンクは、今までどおり投稿なし', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '事前のふたり', { create: `事前2 ${unique()}`, init: withShare });
  const id = admin.made.community_id;
  await makePost(admin, 'ひとつだけ', id);
  const card = await openEdit(admin, id);
  await card.locator('.invite-open').click();
  await card.locator('.invite-make').click();
  await expect(card.locator('.invite-url')).toHaveValue(/#\/invite\/[^?]+$/);
  await expect(card.locator('.invite-with-post')).not.toBeChecked();
});
