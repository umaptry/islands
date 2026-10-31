// 投稿の質（2026-10-31）：①は15字から、「次へ」で話題が2つ以上ならシートが出る。
// 手元モードのサーバーには鍵がないので、/api/posts/topic-check は page.route で差し替える。
import { test, expect } from '@playwright/test';

const INVITE = 'demo-invite-code-local-0001';
const MIXED = 'サッカーやってました。でも最近は野球が好き。大学はタイ';

async function openCompose(page) {
  await page.goto(`/#/invite/${INVITE}`);
  await page.evaluate(async ({ email, code }) => {
    // wait for the config to be loaded, or session.js / net.js race the app's own start-up
    await (await import('/static/js/config.js')).loadConfig();
    const { session } = await import('/static/js/session.js');
    const { api, data } = await import('/static/js/net.js');
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await data.claimInvite(code);
    await api.put('/api/account/me', { display_name: 'しつ', affiliation: 'テスト', name_confirmed: true, icon_id: 'photo' });
    // a post of one's own, so that this is not the first post (the first post has its own opening)
    await api.post('/api/posts', { body: '朝のランニングを1年続けています。いっしょに走れる人を探しています', tags: [], motivation: 55 },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  }, { email: `quality-${crypto.randomUUID()}@example.com`, code: INVITE });
  await page.goto('/?again=1#/post');
  await expect(page.locator('#compose')).toHaveClass(/active/);
}

const answer = (page, handler) => page.route('**/api/posts/topic-check', handler);
const topics = (list, calls) => (route) => {
  if (calls) calls.n += 1;
  return route.fulfill({ json: { topics: list } });
};

test('新しい投稿は15字から：14字では次へが押せず案内が出て、15字で押せる', async ({ page }) => {
  await openCompose(page);
  const next = page.locator('#composeNext');
  const note = page.locator('#composeShortNote');
  await expect(next).toBeDisabled();
  await expect(next).toHaveText('15字から投稿できます');
  await expect(note).toBeHidden();   // 0字は案内なし（ボタンの文字だけ）

  await page.locator('#composeBody').fill('アプリ開発');
  await expect(note).toHaveText('あと10字。どんなことを・どうして を足すと、近い人が見つけやすくなります');
  await expect(page.locator('#composeCounterText')).toHaveText('5 / 60');

  await page.locator('#composeBody').fill('あ'.repeat(14));
  await expect(note).toContainText('あと1字');
  await expect(next).toBeDisabled();

  await page.locator('#composeBody').fill('あ'.repeat(15));
  await expect(next).toBeEnabled();
  await expect(next).toHaveText('次へ');
  await expect(note).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('2つ以上：シートが出る → このまま次へで②へ → 戻って同じ本文で次へ → シートは出ない（聞き直さない）', async ({ page }, testInfo) => {
  await openCompose(page);
  const calls = { n: 0 };
  await answer(page, topics(['サッカー', '野球', 'タイ留学'], calls));
  await page.locator('#composeBody').fill(MIXED);
  await page.locator('#composeNext').click();

  const sheet = page.locator('#topicSheet');
  await expect(sheet).toBeVisible();
  await expect(page.locator('#topicHeading')).toHaveText('話題が3つ入っているみたいです');
  await expect(page.locator('#topicChips .topic-chip')).toHaveText(['サッカー', '野球', 'タイ留学']);
  await expect(page.locator('#topicKeep')).toHaveText('このまま次へ');
  if (testInfo.project.name === '390px') await page.screenshot({ path: testInfo.outputPath('topic-sheet-390.png') });

  await page.locator('#topicKeep').click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('#composeStep2')).toBeVisible();

  await page.locator('#composeBack').click();
  await expect(page.locator('#composeStep1')).toBeVisible();
  await page.locator('#composeNext').click();
  await expect(page.locator('#composeStep2')).toBeVisible();
  await expect(sheet).toBeHidden();
  expect(calls.n).toBe(1);

  // 本文を変えたら、また聞く
  await page.locator('#composeBack').click();
  await page.locator('#composeBody').fill(`${MIXED}です`);
  await page.locator('#composeNext').click();
  await expect(sheet).toBeVisible();
  expect(calls.n).toBe(2);
});

test('1つに絞って書き直す：シートが閉じて、入力欄にフォーカス（カーソルは末尾）。後ろを押す・Escも同じ', async ({ page }) => {
  await openCompose(page);
  await answer(page, topics(['サッカー', '野球']));
  await page.locator('#composeBody').fill(MIXED);
  await page.locator('#composeNext').click();
  await expect(page.locator('#topicSheet')).toBeVisible();
  await page.locator('#topicRewrite').click();
  await expect(page.locator('#topicSheet')).toBeHidden();
  await expect(page.locator('#composeStep1')).toBeVisible();
  await expect(page.locator('#composeBody')).toBeFocused();
  expect(await page.locator('#composeBody').evaluate((node) => [node.selectionStart, node.selectionEnd])).toEqual([MIXED.length, MIXED.length]);

  // 同じ本文でもう一度次へ：聞き直さずにシートが戻る
  await page.locator('#composeNext').click();
  await expect(page.locator('#topicSheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#topicSheet')).toBeHidden();
  await expect(page.locator('#composeStep1')).toBeVisible();

  await page.locator('#composeNext').click();
  await expect(page.locator('#topicSheet')).toBeVisible();
  await page.locator('#topicScrim').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('#topicSheet')).toBeHidden();
  await expect(page.locator('#composeStep1')).toBeVisible();
});

test('待っている間は次へが押せず「確かめています…」。1つ以下・エラー・時間切れは何も言わず②へ', async ({ page }) => {
  await openCompose(page);
  await page.locator('#composeBody').fill(MIXED);

  // 1つ以下
  await answer(page, topics([]));
  await page.locator('#composeNext').click();
  await expect(page.locator('#composeStep2')).toBeVisible();
  await expect(page.locator('#topicSheet')).toBeHidden();
  await page.locator('#composeBack').click();
  await page.unroute('**/api/posts/topic-check');

  // 500
  await page.locator('#composeBody').fill(`${MIXED}。`);
  await answer(page, (route) => route.fulfill({ status: 500, json: { detail: 'x' } }));
  await page.locator('#composeNext').click();
  await expect(page.locator('#composeStep2')).toBeVisible();
  await expect(page.locator('#topicSheet')).toBeHidden();
  await page.locator('#composeBack').click();
  await page.unroute('**/api/posts/topic-check');

  // 遅い答え：待っている間の見え方。4秒で諦めて②へ
  await page.locator('#composeBody').fill(`${MIXED}！`);
  await answer(page, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 6000));
    await route.fulfill({ json: { topics: ['a', 'b'] } }).catch(() => {});
  });
  await page.locator('#composeNext').click();
  await expect(page.locator('#composeNext')).toBeDisabled();
  await expect(page.locator('#composeNext')).toHaveText('確かめています…');
  await expect(page.locator('#composeStep2')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#topicSheet')).toBeHidden();
});
