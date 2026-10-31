// 承認制（第1回の画面）。手元モードのサーバーに、ブラウザ数個（管理者・新しい人・ほかの会にいる人）でつなぐ。
// 筋書き：管理者がリンクを作る（最初からオン）→ 新しい人が同意の文を見て登録 → 待つ画面 → 管理者の通知と枠 →
// 承認 → 新しい人が地図へ（ガイダンスから）／断る →「参加できませんでした」／取り消す・ログアウト／
// 別の会にいる人の「承認待ち」。
import { test, expect } from '@playwright/test';

const unique = () => Math.random().toString(36).slice(2, 10);

async function openContext(browser, testInfo) {
  const { baseURL, viewport } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  return { context, page };
}

// メールのコードで入った、名前つき・フルネーム確認済みのアカウント。
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
    await api.put('/api/account/me', { display_name: name, affiliation: 'テスト', icon_id: 'photo', name_confirmed: true });
  }, { email, name });
  who.name = name;
  who.email = email;
  return who;
}

const call = (who, method, path, body) => who.page.evaluate(async ({ method, path, body }) => {
  const { api } = await import('/static/js/net.js');
  return method === 'get' ? api.get(path) : api.post(path, body, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
}, { method, path, body });

const makeCommunity = (who, name) => call(who, 'post', '/api/local/communities', { name, slug: `t-${unique()}` });

// 管理者の編集画面で招待リンクを作る。承認のスイッチは触らない（最初からオンのはず）。
async function makeApprovalLink(admin, communityId) {
  await admin.page.goto(`/?me=${unique()}#/community/${communityId}`);
  const card = admin.page.locator(`#communityEditBody .community-invites[data-community-id="${communityId}"]`);
  await card.waitFor({ timeout: 15000 });
  await card.locator('.invite-open').click();
  await expect(card.locator('.invite-approval')).toBeChecked();
  await card.locator('.invite-make').click();
  await card.locator('.invite-qr').waitFor();
  const url = await card.locator('.invite-url').inputValue();
  expect(url).toContain('#/invite/');
  return { url: url.slice(url.indexOf('#')), card };
}

const noSideScroll = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

async function signUpByEmail(page, name) {
  await page.locator('#inviteRegister').click();
  await page.locator('#registerName').fill(name);
  await page.locator('#registerAffiliation').fill('テスト会社');
  await page.locator('#authEmail').fill(`new-${crypto.randomUUID()}@example.com`);
  await page.locator('#authSend').click();
  await expect(page.locator('#authDevCode .dev-code-value')).toBeVisible();
  await page.locator('#authCode').fill(await page.locator('#authDevCode .dev-code-value').innerText());
  await page.locator('#authVerify').click();
}

// 新しい人が申し込んで、待つ画面まで行く。
async function applyAsNewPerson(browser, testInfo, url, community, name) {
  const guest = await openContext(browser, testInfo);
  await guest.page.goto(`/${url}`);
  await expect(guest.page.locator('#invite')).toHaveClass(/active/);
  await expect(guest.page.locator('#inviteTitle')).toHaveText(`「${community.name}」への参加の申し込み`);
  await signUpByEmail(guest.page, name);
  await expect(guest.page.locator('#setup')).toHaveClass(/active/, { timeout: 15000 });
  await guest.page.locator('#setupSave').click();
  await expect(guest.page.locator('#waiting')).toHaveClass(/active/, { timeout: 15000 });
  return guest;
}

// 待つ画面は30秒ごとに見直す。テストでは、画面が戻ってきたことにして今すぐ見直させる。
const lookAgain = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test('承認制：リンクは最初からオン。申し込んだ人は待つ画面で止まり、管理者が承認すると地図（ガイダンスから）に入れる', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '管理のあき');
  const bar = await makeCommunity(admin, `承認の会 ${unique()}`);
  const { url, card } = await makeApprovalLink(admin, bar.community_id);

  // 作ったあとも承認のスイッチはオン。会場で映すの注意の1行が出る。
  await expect(card.locator('.invite-approval')).toBeChecked();
  await expect(card.locator('.invite-venue-warn')).toBeVisible();
  await expect(card.locator('.invite-venue-warn')).toContainText('承認オンのままです');
  await noSideScroll(admin.page);

  // 新しい人：ログイン前の招待画面は「参加の申し込み」。管理者に見える内容と、新しい規約のリンク。
  const guest = await openContext(browser, testInfo);
  await guest.page.goto(`/${url}`);
  await expect(guest.page.locator('#inviteTitle')).toHaveText(`「${bar.name}」への参加の申し込み`);
  await expect(guest.page.locator('#inviteDisclose')).toContainText('管理者に名前・所属・メールアドレスが見えます');
  await expect(guest.page.locator('#inviteConsent a').first()).toHaveAttribute('href', '/terms/next');
  await expect(guest.page.locator('#inviteConsent a').nth(1)).toHaveAttribute('href', '/privacy/next');
  await expect(guest.page.locator('#inviteLogin')).toHaveText('ログインして申し込む');
  await noSideScroll(guest.page);
  await signUpByEmail(guest.page, '申し込むひと');
  await expect(guest.page.locator('#setup')).toHaveClass(/active/, { timeout: 15000 });
  await guest.page.locator('#setupSave').click();

  // 待つ画面。名前・所属・メールのカード、通知・名前直し・取り消し・ログアウト・退会の案内。
  await expect(guest.page.locator('#waiting')).toHaveClass(/active/, { timeout: 15000 });
  await expect(guest.page.locator('#waitingTitle')).toHaveText('参加の承認を待っています');
  await expect(guest.page.locator('#waitingLede')).toContainText(`「${bar.name}」の管理者が確認しています`);
  await expect(guest.page.locator('#waitingCard')).toContainText('申し込むひと');
  await expect(guest.page.locator('#waitingCard')).toContainText('テスト会社');
  await expect(guest.page.locator('#waitingCard')).toContainText('@example.com');
  await expect(guest.page.locator('#waitingEdit')).toBeVisible();
  await expect(guest.page.locator('#waitingCancel')).toBeVisible();
  await expect(guest.page.locator('#waitingLogout')).toBeVisible();
  await expect(guest.page.locator('#waitingLeave')).toContainText('退会したいとき');
  await noSideScroll(guest.page);
  // 待っている人が地図やほかの画面を開こうとしても、待つ画面に戻される。
  await guest.page.goto(`/?x=${unique()}#/map`);
  await expect(guest.page.locator('#waiting')).toHaveClass(/active/, { timeout: 15000 });

  // 名前・所属を直せる。
  await guest.page.locator('#waitingEdit').click();
  await guest.page.locator('#waitingName').fill('申し込む ひと');
  await guest.page.locator('#waitingFormSave').click();
  await expect(guest.page.locator('#waitingCard')).toContainText('申し込む ひと');

  // 管理者：通知（承認待ち）→ 編集画面のいちばん上の枠。
  await admin.page.goto(`/?n=${unique()}#/notifications`);
  const notice = admin.page.locator('.notif', { hasText: '参加を待っています' }).first();
  await expect(notice).toBeVisible({ timeout: 15000 });
  await notice.click();
  await expect(admin.page.locator('#communityEdit')).toHaveClass(/active/);
  const box = admin.page.locator('#joinRequests');
  await expect(box).toBeVisible({ timeout: 15000 });
  await expect(box).toContainText('参加を待っている人 1人');
  await expect(box).toContainText('申し込む ひと');
  await expect(box).toContainText('テスト会社');
  await expect(box).toContainText('@example.com');
  // いちばん上：会の名前の見出しのすぐ下で、名前の欄・招待の枠より前にある。
  const order = await admin.page.locator('#communityEditBody').evaluate((body) => [...body.children].map((child) => child.id || child.className));
  expect(order[1]).toBe('joinRequests');
  expect(order.findIndex((name) => String(name).includes('community-rename'))).toBeGreaterThan(1);
  await noSideScroll(admin.page);

  // 承認する。
  await box.locator('.join-request-yes').click();
  await expect(box).toBeHidden({ timeout: 15000 });

  // 新しい人：見直すと、その会の地図…の前に、ガイダンス（新しい人は最初から）。
  await lookAgain(guest.page);
  await expect(guest.page.locator('#guidance')).toHaveClass(/active/, { timeout: 15000 });
  const joined = await guest.page.evaluate(async () => (await import('/static/js/state.js')).state.communities.map((c) => c.id));
  expect(joined).toContain(bar.community_id);
});

test('承認制：断られた人には「参加できませんでした」だけが出る。取り消すと待つ人の枠から消える', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '管理のさき');
  const bar = await makeCommunity(admin, `断る会 ${unique()}`);
  const { url } = await makeApprovalLink(admin, bar.community_id);

  const refused = await applyAsNewPerson(browser, testInfo, url, bar, '断られるひと');
  const withdrawn = await applyAsNewPerson(browser, testInfo, url, bar, '取り消すひと');

  await admin.page.goto(`/?r=${unique()}#/community/${bar.community_id}`);
  const box = admin.page.locator('#joinRequests');
  await expect(box).toContainText('参加を待っている人 2人', { timeout: 15000 });

  // 取り消す：確認の文が出て、「やめる」で何も変わらず、「取り消す」で枠から消える。
  await withdrawn.page.locator('#waitingCancel').click();
  await expect(withdrawn.page.locator('.modal-title')).toContainText(`「${bar.name}」への申し込みを取り消しますか？`);
  await withdrawn.page.locator('.modal-actions .btn-quiet').click();
  await expect(withdrawn.page.locator('#waiting')).toHaveClass(/active/);
  await withdrawn.page.locator('#waitingCancel').click();
  await withdrawn.page.locator('.modal-actions .btn-danger').click();
  await expect(withdrawn.page.locator('#welcome')).toHaveClass(/active/, { timeout: 15000 });

  // 断る：確認が出る。
  await admin.page.reload();
  await expect(admin.page.locator('#joinRequests')).toContainText('参加を待っている人 1人', { timeout: 15000 });
  await expect(admin.page.locator('#joinRequests')).toContainText('断られるひと');
  await admin.page.locator('#joinRequests .join-request-no').click();
  await expect(admin.page.locator('.modal-title')).toContainText('断られるひとさんの参加を断りますか？');
  await admin.page.locator('.modal-actions .btn-danger').click();
  await expect(admin.page.locator('#joinRequests')).toBeHidden({ timeout: 15000 });

  await lookAgain(refused.page);
  await expect(refused.page.locator('#waitingTitle')).toHaveText(`「${bar.name}」に参加できませんでした`, { timeout: 15000 });
  await expect(refused.page.locator('#waitingLede')).toContainText('今回は参加を見送りました');
  await expect(refused.page.locator('#waitingNote')).toContainText('もう一度使うと、また申し込みになります');
  await expect(refused.page.locator('#waitingCancel')).toBeHidden();
  await expect(refused.page.locator('#waitingEdit')).toBeHidden();
  await expect(refused.page.locator('#waitingCard')).toBeHidden();
  await noSideScroll(refused.page);

  // ログアウトすると最初の画面。
  await refused.page.locator('#waitingLogout').click();
  await expect(refused.page.locator('#welcome')).toHaveClass(/active/, { timeout: 15000 });
});

test('承認制：別の会にいる人は、切り替えの一覧に「（承認待ち）」が出て、押すと待つ画面が開く', async ({ browser }, testInfo) => {
  const admin = await person(browser, testInfo, '管理のゆめ');
  const bar = await makeCommunity(admin, `別の会 ${unique()}`);
  const { url } = await makeApprovalLink(admin, bar.community_id);

  const member = await person(browser, testInfo, 'ほかの会のひと');
  const own = await makeCommunity(member, `自分の会 ${unique()}`);
  await member.page.goto(`/?m=${unique()}${url}`);
  await expect(member.page.locator('#inviteTitle')).toHaveText(`「${bar.name}」への参加の申し込み`);
  // ログイン済みの人にも同じ説明と、自分の名前・所属・メールのカード。
  await expect(member.page.locator('#inviteDisclose')).toContainText('管理者に見える内容');
  await expect(member.page.locator('#inviteDisclose')).toContainText('ほかの会のひと');
  await expect(member.page.locator('#inviteDisclose')).toContainText(member.email);
  await expect(member.page.locator('#inviteConsent')).toContainText('「参加を申し込む」を押すと、上のことに同意したことになります');
  await expect(member.page.locator('#inviteJoin')).toHaveText('参加を申し込む');
  await noSideScroll(member.page);
  await member.page.locator('#inviteJoin').click();
  // もう会にいる人は、そのまま地図へ。
  await expect(member.page.locator('#map')).toHaveClass(/active/, { timeout: 15000 });
  await member.page.locator('#mapCommunity').click();
  const waiting = member.page.locator('#communityWaitingList .community-row');
  await expect(waiting).toHaveText(new RegExp(`${bar.name}（承認待ち）`));
  await noSideScroll(member.page);
  await waiting.click();
  await expect(member.page.locator('#waiting')).toHaveClass(/active/);
  await expect(member.page.locator('#waitingTitle')).toHaveText('参加の承認を待っています');
  expect(own.community_id).toBeTruthy();
});
