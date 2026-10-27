import { test, expect } from '@playwright/test';

// 手元モードはコミュニティが有効なので、新しい人は先に「デモ」コミュニティに入る（招待コードは手元の起動時に用意される）。

test('landing, anonymous guard and navigation fit each viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#welcome')).toHaveClass(/active/);
  await page.goto('/#/map');
  await expect(page.locator('#map')).toHaveClass(/active/);
  await expect(page.locator('#bottomNav')).toBeVisible();
  const nav = await page.locator('#bottomNav').boundingBox();
  expect(nav.height).toBe(64);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // 投稿は下のバーにはなく、ログインしていない人には丸い投稿ボタンも出ない。DM のタブも出ない。
  await expect(page.locator('[data-route="#/post"]')).toHaveCount(0);
  await expect(page.locator('#mapPost')).toBeHidden();
  await expect(page.locator('#navDm')).toBeHidden();
  await page.evaluate(() => { location.hash = '#/post'; });
  await expect(page.locator('#auth')).toHaveClass(/active/);
});

test('new profile reaches guidance before the first post, including after reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#welcome')).toHaveClass(/active/);
  await page.evaluate(async () => {
    const { session } = await import('/static/js/session.js');
    const { navigate } = await import('/static/js/router.js');
    const email = `guide-${crypto.randomUUID()}@example.com`;
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await (await import('/static/js/net.js')).api.post('/api/local/invites/claim', { code: 'demo-invite-code-local-0001' });
    await (await import('/static/js/communities.js')).refreshCommunities();
    await navigate('#/setup');
  });
  await page.locator('#setupName').fill('ガイド確認');
  await page.locator('#setupSave').click();
  await expect(page.locator('#guidance')).toHaveClass(/active/);
  await expect(page.locator('#guidanceTrack > .slide').nth(0)).toBeVisible();
  await expect(page.locator('#guidanceTrack > .slide')).toHaveCount(5);
  await expect(page.locator('#guidanceDots .dot')).toHaveCount(5);
  await page.locator('#guidanceNext').click();
  await page.goto('/');
  await expect(page.locator('#guidance')).toHaveClass(/active/);
  await expect(page.locator('#guidanceTrack > .slide').nth(1)).toBeVisible();
  const slides = await page.locator('#guidanceTrack > *').count();
  for (let i = 1; i < slides; i++) await page.locator('#guidanceNext').click();
  await expect(page.locator('#compose')).toHaveClass(/active/);
  await expect(page.locator('#composeLede')).toHaveText('ひとこと書いて、あなたの島を作りましょう。');
  await expect(page.locator('#bottomNav')).toBeHidden();
  // 入力欄は最初から開いている。例文は出ない。
  await expect(page.locator('#composeBody')).toBeVisible();
  await expect(page.locator('#composeExamples')).toBeHidden();
  // 3つのステップ: ① の「次へ」は下に。最初の投稿には ← で戻る先がない。
  await expect(page.locator('#composeNext')).toBeVisible();
  await expect(page.locator('#composeBack')).toBeHidden();
});

test('reference registration saves profile and completes the first post', async ({ page }) => {
  await page.goto('/#/invite/demo-invite-code-local-0001');
  await page.locator('#inviteRegister').click();
  await page.locator('#authEmail').fill(`register-${crypto.randomUUID()}@example.com`);
  await expect(page.locator('#authSend')).toBeDisabled();
  await page.locator('#registerName').fill('登録の確認');
  await page.locator('#registerAffiliation').fill('islands');
  await page.locator('#authSend').click();
  await expect(page.locator('.dev-code-value')).toBeVisible();
  await page.locator('#authCode').fill(await page.locator('.dev-code-value').innerText());
  await page.locator('#authVerify').click();
  // モック②の流れ: パスコードのあとにアイコンの写真（選ばなくても進める）。
  await expect(page.locator('#setup')).toHaveClass(/active/);
  await expect(page.locator('#setupNameFields')).toBeHidden();
  await page.locator('#setupSave').click();
  await expect(page.locator('#guidance')).toHaveClass(/active/);
  await expect(page.locator('#guidance h2').first()).toHaveText('islandsへようこそ');
  const pages = await page.locator('#guidanceTrack > .slide').count();
  expect(pages).toBe(5);
  await expect(page.locator('#guidanceTrack > .slide').nth(3).locator('h2')).toHaveText('島の中で盛り上がる');
  // 5枚目（2026-10-27）: 1対1で話せること。そこから最初のひとことへ。
  await expect(page.locator('#guidanceTrack > .slide').nth(4).locator('h2')).toHaveText('1対1でもじっくり話せる');
  await expect(page.locator('#guidanceTrack > .slide').nth(4).locator('.guidance-first-only')).toContainText('では、実際にひとこと書いてみましょう');
  await expect(page.locator('#guidanceTrack .guidance-first-only')).toHaveCount(1);
  for (let i = 0; i < pages; i++) await page.locator('#guidanceNext').click();
  await page.locator('#composeBody').fill('休日に公園を散歩しながら季節の花を撮影しています。写真を楽しめる仲間と交流してみたいです。');
  await expect(page.locator('#composeNext')).toBeEnabled();
  await page.locator('#composeNext').click();
  // ② スライダーを一度動かすまでは ③ へ進まない。押すとスライダーを知らせる。
  await expect(page.locator('#composeHint')).toBeHidden();
  await page.locator('#composeNext2').click();
  await expect(page.locator('#compose')).toHaveAttribute('data-step', '2');
  await expect(page.locator('#composeHint')).toHaveClass(/alert/);
  await expect(page.locator('#composeHint')).toHaveText('バーを左右に動かして、どれくらい本気か選んでください');
  await page.locator('#composeMotivation').fill('70');
  await page.locator('#composeNext2').click();
  await expect(page.locator('#composeSubmit')).toBeEnabled();
  await page.locator('#composeSubmit').click();
  await expect(page.locator('#map')).toHaveClass(/active/);
  await page.goto('/');
  await expect(page.locator('#map')).toHaveClass(/active/);
});

test('draft survives navigation; panel cleanup and responsive modality', async ({ page }, info) => {
  await page.addInitScript(() => {
    const original = EventTarget.prototype.addEventListener;
    window.sheetListenerCount = 0;
    EventTarget.prototype.addEventListener = function(type, callback, options) {
      if (this === document && type === 'sheet:expand') {
        window.sheetListenerCount++;
        options?.signal?.addEventListener('abort', () => window.sheetListenerCount--, { once: true });
      }
      return original.call(this, type, callback, options);
    };
  });
  await page.goto('/#/map');
  await expect(page.locator('#map')).toHaveClass(/active/);
  const postId = await page.evaluate(async () => {
    const { session } = await import('/static/js/session.js');
    const { api } = await import('/static/js/net.js');
    const { state } = await import('/static/js/state.js');
    const email = `browser-${crypto.randomUUID()}@example.com`;
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await (await import('/static/js/net.js')).api.post('/api/local/invites/claim', { code: 'demo-invite-code-local-0001' });
    await (await import('/static/js/communities.js')).refreshCommunities();
    state.account = (await api.put('/api/account/me', { display_name: '比較用', icon_id: '1' })).account;
    return (await api.post('/api/posts', { body: '週末はソロキャンプに出かけて、焚き火を眺めながら静かに過ごすのが好きです。', motivation: 50 })).id;
  });
  await page.reload();
  await expect(page.locator('#map')).toHaveClass(/active/);
  await page.locator('#mapPost').click();
  await expect(page.locator('#compose')).toHaveClass(/active/);
  await page.locator('#composeBody').fill('画面を移動してもこの下書きを保持します。');
  // 書いている間は下のメニューがない（3つのステップのボタンがそこにある）。← で地図へ。
  await expect(page.locator('#bottomNav')).toBeHidden();
  await page.locator('#composeBack').click();
  await page.locator('#mapPost').click();
  await expect(page.locator('#composeBody')).toHaveValue('画面を移動してもこの下書きを保持します。');
  await page.evaluate(async (id) => {
    const { openOnMap } = await import('/static/js/screens/map.js');
    const { closeSheet } = await import('/static/js/ui.js');
    for (let i = 0; i < 20; i++) { await openOnMap(id); closeSheet(); }
    await openOnMap(id);
  }, postId);
  const mobile = page.viewportSize().width < 768;
  expect(await page.evaluate(() => window.sheetListenerCount)).toBe(1);
  // Never modal: the map stays live under an open post, on a phone too.
  await expect(page.locator('#sheet')).toHaveAttribute('aria-modal', 'false');
  await expect(page.locator('#map')).not.toHaveAttribute('inert', '');
  if (mobile) {
    // Half height, the card does not scroll; full height, it does.
    expect(await page.locator('#sheetScroll').evaluate((node) => getComputedStyle(node).overflowY)).toBe('hidden');
    await page.locator('#sheetGrip').click();
    await expect.poll(() => page.locator('#sheetScroll').evaluate((node) => getComputedStyle(node).overflowY)).toBe('auto');
    await expect.poll(async () => (await page.locator('#sheet').boundingBox()).height).toBeGreaterThan(700);
  } else {
    await expect(page.locator('#bottomNav')).not.toHaveAttribute('inert', '');
    expect((await page.locator('#sheet').boundingBox()).width).toBe(400);
  }
  await page.screenshot({ path: info.outputPath('map-panel.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.locator('#sheet')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#sheet')).not.toBeVisible();
  expect(await page.evaluate(() => window.sheetListenerCount)).toBe(0);

  const selected = await page.evaluate(async (id) => {
    const { state } = await import('/static/js/state.js');
    const { data } = await import('/static/js/net.js');
    const { openPost } = await import('/static/js/screens/map.js');
    const original = data.getPost;
    const base = await original(id);
    let release;
    data.getPost = (key) => key === 'slow-a'
      ? new Promise(resolve => { release = () => resolve({ ...base, id: key }); })
      : Promise.resolve({ ...base, id: key });
    try {
      const old = openPost('slow-a');
      await openPost('fast-b');
      release(); await old;
      return state.selected.id;
    } finally { data.getPost = original; }
  }, postId);
  expect(selected).toBe('fast-b');
});


test('a post image opens in the viewer with close and reactions, and closes by button, Escape and back', async ({ page }) => {
  await page.goto('/#/invite/demo-invite-code-local-0001');
  await page.locator('#inviteRegister').click();
  await page.locator('#authEmail').fill(`viewer-${crypto.randomUUID()}@example.com`);
  await page.locator('#registerName').fill('画像の確認');
  await page.locator('#registerAffiliation').fill('islands');
  await page.locator('#authSend').click();
  await expect(page.locator('.dev-code-value')).toBeVisible();
  await page.locator('#authCode').fill(await page.locator('.dev-code-value').innerText());
  await page.locator('#authVerify').click();
  await page.locator('#setupSave').click();
  await expect(page.locator('#guidance')).toHaveClass(/active/);
  const pages = await page.locator('#guidanceTrack > .slide').count();
  for (let i = 0; i < pages; i++) await page.locator('#guidanceNext').click();
  await page.locator('#composeBody').fill('休日に公園を散歩しながら季節の花を撮影しています。写真を楽しめる仲間と交流してみたいです。');
  // A 1x1 PNG is enough: the viewer does not care what the picture is.
  await page.locator('#composeImageInput').setInputFiles({
    name: 'dot.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  });
  // the picture shows under the words on ①, as on the card
  await expect(page.locator('#composeImagePreview')).toBeVisible();
  await page.locator('#composeNext').click();
  await page.locator('#composeMotivation').fill('70');
  await page.locator('#composeNext2').click();
  await page.locator('#composeSubmit').click();
  await expect(page.locator('#map')).toHaveClass(/active/);

  await page.goto('/#/me');
  const link = page.locator('.post-card .post-image a').first();
  await link.click();
  const viewer = page.locator('.image-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('button', { name: '閉じる' })).toBeFocused();
  await expect(viewer.locator('[data-count="like_count"]')).toHaveText('0');
  await viewer.getByRole('button', { name: 'いいね' }).click();
  await expect(viewer.locator('[data-count="like_count"]')).toHaveText('1');
  await expect(page.locator('.post-card [data-reaction="like"] [data-count]').first()).toHaveText('1');
  expect(await page.evaluate(() => location.hash)).toBe('#/me');

  await viewer.getByRole('button', { name: '閉じる' }).click();
  await expect(viewer).toHaveCount(0);
  await expect(link).toBeFocused();
  await link.click();
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await link.click();
  await page.goBack();
  await expect(viewer).toHaveCount(0);
  await expect(page.locator('#me')).toHaveClass(/active/);
});


test('a Google or LINE round trip: a failure is said and cleaned up, a success remembers how', async ({ page }) => {
  // Cancelled at the provider: Supabase comes back with the error in the fragment.
  await page.goto('/#error=access_denied&error_code=access_denied&error_description=User+cancelled');
  await expect(page.locator('#toast')).toContainText('ログインできませんでした');
  await expect(page.locator('#welcome')).toHaveClass(/active/);
  expect(page.url()).not.toContain('error');

  // A token as Supabase sends it back (not checked here: the server checks it on every request).
  const claims = { sub: '00000000-0000-4000-8000-000000000001', email: 'someone@example.com', app_metadata: { provider: 'google' } };
  const result = await page.evaluate(async (payload) => {
    const encode = (value) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
      .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const token = `${encode({ alg: 'HS256' })}.${encode(payload)}.signature`;
    history.replaceState(null, '', `/#access_token=${token}&expires_in=3600&refresh_token=r`);
    const { session } = await import('/static/js/session.js');
    const adopted = session.adoptRedirect();
    const seen = { adopted, email: session.email(), provider: session.provider(), hash: location.hash };
    session.signOut();
    return seen;
  }, claims);
  expect(result).toEqual({ adopted: 'adopted', email: 'someone@example.com', provider: 'google', hash: '' });
});

test('guidance can be skipped and the last button invites a first post', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#welcomeBrowse')).toHaveText('登録せずにマップを見てみる');
  await page.evaluate(async () => {
    const { session } = await import('/static/js/session.js');
    const { navigate } = await import('/static/js/router.js');
    const email = `skip-${crypto.randomUUID()}@example.com`;
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await (await import('/static/js/net.js')).api.post('/api/local/invites/claim', { code: 'demo-invite-code-local-0001' });
    await (await import('/static/js/communities.js')).refreshCommunities();
    await navigate('#/setup');
  });
  await page.locator('#setupName').fill('スキップ確認');
  await page.locator('#setupSave').click();
  await expect(page.locator('#guidance')).toHaveClass(/active/);
  const slides = await page.locator('#guidanceTrack > *').count();
  for (let i = 1; i < slides; i++) await page.locator('#guidanceNext').click();
  await expect(page.locator('#guidanceNext')).toHaveText('投稿してみる');
  await page.locator('#guidanceSkip').click();
  await expect(page.locator('#compose')).toHaveClass(/active/);
});

test('my page can reopen the guidance, and closing or skipping returns to my page', async ({ page }) => {
  await signInForFirstPost(page, 'howto-review');
  const go = (hash) => page.evaluate(async (h) => (await import('/static/js/router.js')).navigate(h), hash);
  await go('#/me');
  await expect(page.locator('#me')).toHaveClass(/active/);
  await page.locator('#meHowto').click();
  await expect(page.locator('#guidance')).toHaveClass(/active/);
  await expect(page.locator('#guidanceTrack > .slide').nth(0)).toBeVisible();
  const slides = await page.locator('#guidanceTrack > *').count();
  for (let i = 1; i < slides; i++) await page.locator('#guidanceNext').click();
  await expect(page.locator('#guidanceNext')).toHaveText('閉じる');
  await page.locator('#guidanceNext').click();
  await expect(page.locator('#me')).toHaveClass(/active/);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('islands-onboarding')).length)).toBe(0);
  // skip (閉じる) from the first slide
  await page.locator('#meHowto').click();
  await expect(page.locator('#guidanceSkip')).toHaveText('閉じる');
  await page.locator('#guidanceSkip').click();
  await expect(page.locator('#me')).toHaveClass(/active/);
  // the browser's back button
  await page.locator('#meHowto').click();
  await expect(page.locator('#guidance')).toHaveClass(/active/);
  await page.goBack();
  await expect(page.locator('#me')).toHaveClass(/active/);
});

async function signInForFirstPost(page, label) {
  await page.goto('/');
  await expect(page.locator('#welcome')).toHaveClass(/active/);
  await page.evaluate(async (name) => {
    const { session } = await import('/static/js/session.js');
    const { api } = await import('/static/js/net.js');
    const { state } = await import('/static/js/state.js');
    const email = `${name}-${crypto.randomUUID()}@example.com`;
    const otp = await session.requestCode(email);
    await session.verifyCode(email, otp.devCode);
    await (await import('/static/js/net.js')).api.post('/api/local/invites/claim', { code: 'demo-invite-code-local-0001' });
    await (await import('/static/js/communities.js')).refreshCommunities();
    state.account = (await api.put('/api/account/me', { display_name: name, icon_id: '1' })).account;
  }, label);
}

test('first post: no examples, the box is open, and an opening phrase goes into it', async ({ page }) => {
  await signInForFirstPost(page, 'starters');
  await page.evaluate(async () => (await import('/static/js/router.js')).navigate('#/post?first=1'));
  await expect(page.locator('#compose')).toHaveClass(/active/);
  await expect(page.locator('#composeExamples')).toBeHidden();
  await expect(page.locator('#composeOwnBtn')).toBeHidden();
  await expect(page.locator('#composeExtraPrompts')).toBeHidden();
  for (const id of ['#composeBody', '#composeNext']) {
    await expect(page.locator(id)).toBeVisible();
  }
  const chips = page.locator('#composeStarterList .extra-chip');
  await expect(page.locator('#composeStarters .weekly-label')).toHaveText('お題から選ぶ');
  await expect(chips).toHaveText(['昔がんばってたこと', '最近はまってること', '今度やってみたいこと', '困ってること']);
  // nothing chosen: the example of 最近はまってること is the placeholder
  const example = '例：仕事帰りにレイトショーを観るのにはまっています。洋画が多めです。おすすめがあれば教えてください。';
  await expect(page.locator('#composeBody')).toHaveAttribute('placeholder', example);
  await chips.nth(1).click();
  // the box stays empty (an example is never an input) and the example shows as the placeholder
  await expect(page.locator('#composeBody')).toHaveValue('');
  await expect(page.locator('#composeBody')).toHaveAttribute('placeholder', example);
  await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true');
  // nothing written: ① cannot go on
  await expect(page.locator('#composeNext')).toBeDisabled();
  // words the person wrote are never replaced
  await page.locator('#composeBody').fill('ボードゲームです');
  await chips.nth(0).click();
  await expect(page.locator('#composeBody')).toHaveValue('ボードゲームです');
  await expect(page.locator('#composeBody')).toHaveAttribute('placeholder', /^例：学生時代はずっとバスケ部/);
  // a tap anywhere on the bar (on ②) sets the heat there
  await page.locator('#composeNext').click();
  const bar = await page.locator('#composeMotivation').boundingBox();
  await page.mouse.click(bar.x + bar.width * 0.8, bar.y + bar.height / 2);
  const tapped = Number(await page.locator('#composeMotivation').inputValue());
  expect(Math.abs(tapped - 80)).toBeLessThanOrEqual(2);
  // later posts keep the old prompts and have no opening phrases
  await page.evaluate(async () => (await import('/static/js/router.js')).navigate('#/post'));
  await expect(page.locator('#composeStarters')).toBeHidden();
  await expect(page.locator('#composeExamples')).toBeHidden();
});

test('a post in three steps: the box has the focus, words past 60 are red, ← goes back a step', async ({ page }) => {
  await signInForFirstPost(page, 'steps');
  await page.evaluate(async () => (await import('/static/js/router.js')).navigate('#/post'));
  await expect(page.locator('#compose')).toHaveAttribute('data-step', '1');
  await expect(page.locator('#composeBody')).toBeFocused();
  await expect(page.locator('#bottomNav')).toBeHidden();
  await expect(page.locator('#composeBody')).toHaveAttribute('placeholder', '好きなこと、やってみたいことは？');
  // 61 characters: the last one is painted red, the counter says so, and ① cannot go on
  await page.locator('#composeBody').fill(`${'あ'.repeat(60)}い`);
  await expect(page.locator('#composeMirror mark')).toHaveText('い');
  await expect(page.locator('#composeCounterText')).toHaveText('61/60');
  await expect(page.locator('#composeNext')).toBeDisabled();
  await page.locator('#composeBody').fill('週末は川沿いを走っています');
  await expect(page.locator('#composeMirror mark')).toHaveCount(0);
  await page.locator('#composeNext').click();
  await expect(page.locator('#composeStep2')).toBeVisible();
  await expect(page.locator('#composeBody')).toBeHidden();
  await page.locator('#composeMotivation').fill('40');
  await page.locator('#composeNext2').click();
  await expect(page.locator('#composeSubmit')).toBeVisible();
  await expect(page.locator('#composeSubmit')).toHaveText('投稿する');
  // ← one step at a time, and what was written is still there
  await page.locator('#composeBack').click();
  await expect(page.locator('#compose')).toHaveAttribute('data-step', '2');
  await page.locator('#composeBack').click();
  await expect(page.locator('#compose')).toHaveAttribute('data-step', '1');
  await expect(page.locator('#composeBody')).toHaveValue('週末は川沿いを走っています');
  await page.locator('#composeBack').click();
  await expect(page.locator('#map')).toHaveClass(/active/);
});

test('the chosen prompt is recorded as the post prompt', async ({ page }) => {
  await signInForFirstPost(page, 'starter-prompt');
  await page.evaluate(async () => (await import('/static/js/router.js')).navigate('#/post?first=1'));
  await page.locator('#composeStarterList .extra-chip').nth(0).click();
  await page.keyboard.type('陸上部で長距離を走っていました');
  await page.locator('#composeNext').click();
  await page.locator('#composeMotivation').fill('60');
  await page.locator('#composeNext2').click();
  await page.locator('#composeSubmit').click();
  await expect(page.locator('#map')).toHaveClass(/active/, { timeout: 30000 });
  const prompt = await page.evaluate(async () => (await import('/static/js/state.js')).state.myPosts.at(-1)?.prompt);
  expect(prompt).toBe('past');
});

test('困ってること ticks 助けてほしい at ③, and leaves the tag alone once the person has touched it', async ({ page }) => {
  await signInForFirstPost(page, 'help-prompt');
  await page.evaluate(async () => (await import('/static/js/router.js')).navigate('#/post?first=1'));
  const help = page.locator('#composeStarterList .extra-chip[data-key="help"]');
  const tag = page.locator('#composeTags .check[data-tag="助けてほしい"]');
  await expect(help).toHaveText('困ってること');
  await help.click();
  await expect(page.locator('#composeBody')).toHaveAttribute('placeholder', /^例：家庭菜園のミニトマト/);
  await expect(tag).toHaveAttribute('aria-checked', 'true');
  // another prompt: the tick goes with 困ってること
  await page.locator('#composeStarterList .extra-chip[data-key="now"]').click();
  await expect(tag).toHaveAttribute('aria-checked', 'false');
  // back to 困ってること, then the person unticks it at ③: it stays unticked
  await help.click();
  await page.locator('#composeBody').fill('ミニトマトがうまく育ちません。コツを教えてください。');
  await page.locator('#composeNext').click();
  await page.locator('#composeMotivation').fill('50');
  await page.locator('#composeNext2').click();
  await expect(tag).toHaveAttribute('aria-checked', 'true');
  await tag.click();
  await expect(tag).toHaveAttribute('aria-checked', 'false');
  // ... and unchoosing 困ってること (back at ①) leaves the person's choice alone
  await page.locator('#composeBack').click();
  await page.locator('#composeBack').click();
  await help.click();
  await expect(tag).toHaveAttribute('aria-checked', 'false');
  // choosing it again ticks it again
  await help.click();
  await expect(tag).toHaveAttribute('aria-checked', 'true');
  await page.locator('#composeNext').click();
  await page.locator('#composeNext2').click();
  await page.locator('#composeSubmit').click();
  await expect(page.locator('#map')).toHaveClass(/active/, { timeout: 30000 });
  const saved = await page.evaluate(async () => {
    const post = (await import('/static/js/state.js')).state.myPosts.at(-1);
    return { prompt: post?.prompt, tags: post?.tags };
  });
  expect(saved).toEqual({ prompt: 'help', tags: ['助けてほしい'] });
});

test('first post opens already expanded when a draft with text comes back', async ({ page }) => {
  await signInForFirstPost(page, 'draft-open');
  const go = (hash) => page.evaluate(async (h) => (await import('/static/js/router.js')).navigate(h), hash);
  await go('#/post?first=1');
  await page.locator('#composeBody').fill('下書きに書いた文章は、戻ってきたときも残ります。');
  await go('#/map');
  await expect(page.locator('#map')).toHaveClass(/active/);
  await go('#/post?first=1');
  await expect(page.locator('#compose')).toHaveClass(/active/);
  await expect(page.locator('#composeBody')).toBeVisible();
  await expect(page.locator('#composeBody')).toHaveValue('下書きに書いた文章は、戻ってきたときも残ります。');
});

// 最初の投稿のあと：近くの投稿のカード。見本の人たちを、デモのコミュニティに置く。
async function seedNeighbours(page, rows) {
  // rows: [{ name, bodies }]. Each person signs in on their own token.
  for (const row of rows) {
    const email = `${row.name}-${Math.random().toString(36).slice(2)}@example.com`;
    const otp = await (await page.request.post('/api/local/auth/otp', { data: { email } })).json();
    const got = await (await page.request.post('/api/local/auth/verify', { data: { email, code: otp.code } })).json();
    const headers = { Authorization: `Bearer ${got.access_token}` };
    await page.request.put('/api/account/me', { data: { display_name: row.name, icon_id: '1' }, headers });
    await page.request.post('/api/local/invites/claim', { data: { code: 'demo-invite-code-local-0001' }, headers });
    const mine = await (await page.request.get('/api/local/communities/mine', { headers })).json();
    const communityId = mine.communities[0].id || mine.communities[0].community_id;
    for (const body of row.bodies) {
      await page.request.post('/api/posts', { data: { body, tags: [], motivation: 50, community_id: communityId }, headers });
    }
  }
}

async function writeFirstPost(page, body) {
  await page.evaluate(async () => (await import('/static/js/router.js')).navigate('#/post?first=1'));
  await page.locator('#composeBody').fill(body);
  await page.locator('#composeNext').click();
  await page.locator('#composeMotivation').fill('60');
  await page.locator('#composeNext2').click();
  await page.locator('#composeSubmit').click();
  await expect(page.locator('#map')).toHaveClass(/active/, { timeout: 30000 });
}

test('after the first post a card lists up to three nearby posts, one per person, never mine', async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 6);
  await seedNeighbours(page, [
    { name: `あき${tag}`, bodies: ['休日に公園を散歩しながら季節の花を撮影しています。', '週末は近所の公園でのんびり写真を撮っています。'] },
    { name: `いく${tag}`, bodies: ['休日は写真を撮りながら街を歩くのが好きです。'] },
    { name: `うた${tag}`, bodies: ['公園で花の写真を撮るのが趣味です。'] },
    { name: `えり${tag}`, bodies: ['最近、花の写真を撮りに公園へ出かけています。'] },
  ]);
  // The server outlives one viewport's run: earlier runs left people with the same words (and, with a fixed
  // name, the same name as mine). A name of this run's own tells "not mine" apart from "someone called that".
  const me = `nearby-${tag}`;
  await signInForFirstPost(page, me);
  await writeFirstPost(page, '休日に公園を散歩しながら季節の花を撮影しています。写真を楽しめる仲間と交流してみたいです。');
  const list = page.locator('#nearbyList');
  await expect(page.locator('#sheet')).toHaveClass(/on/, { timeout: 30000 });
  await expect(page.locator('#sheet .stack-title')).toHaveText('あなたの近くの投稿');
  await expect(page.locator('#sheet .nearby-lede')).toHaveText('近くにいる人ほど、似た話をしています');
  await expect(list.locator('.nearby-row')).toHaveCount(3);
  // One per person: three different accounts (names may repeat - other tests make people with fixed names),
  // and none of them is me.
  const authors = await list.locator('.nearby-row').evaluateAll((rows) => rows.map((row) => row.dataset.authorId));
  expect(new Set(authors).size).toBe(3);
  const myId = await page.evaluate(async () => (await import('/static/js/state.js')).state.account.id);
  expect(authors).not.toContain(myId);
  expect(await list.locator('.nearby-who').allInnerTexts()).not.toContain(me);
  await expect(list.locator('.nearby-row .avatar').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // タップすると、その投稿が地図の上で開く
  const firstId = await list.locator('.nearby-row').first().getAttribute('data-post-id');
  await list.locator('.nearby-row').first().click();
  await expect(page.locator('#sheet.on .post-card')).toHaveAttribute('data-post-id', firstId, { timeout: 15000 });
});

test('the nearby card says so when nobody is near, and 「地図を見る」 closes it', async ({ page }) => {
  await signInForFirstPost(page, 'nearby-none');
  await page.route('**/api/local/communities/*/map*', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ posts: [] }),
  }));
  await writeFirstPost(page, '誰もいない島に最初に降りてみたいなと思っています。ゆっくり進めます。');
  await expect(page.locator('#nearbyEmpty')).toHaveText('まだ近くに投稿がありません。仲間が投稿すると、ここに並びます。', { timeout: 30000 });
  await expect(page.locator('#nearbyList')).toHaveCount(0);
  await page.locator('#nearbyClose').click();
  await expect(page.locator('#sheet')).not.toHaveClass(/on/);
});

// The trial (reveal screen, banner) stays until after 10/30, but nothing on the first post leads to it now:
// call tryExample directly.
async function tryExampleOnce(page) {
  await page.evaluate(async () => {
    const compose = await import('/static/js/screens/compose.js');
    compose.tryExample('学生のころ吹奏楽部でトランペットを吹いていました。');
  });
}

test('trial result lists the nearest named islands and offers the own-words post first', async ({ page }) => {
  await signInForFirstPost(page, 'reveal-near');
  await page.route('**/api/posts/preview', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ x: 10, y: 10, island: { cluster_id: 1, label: '近い島A' } }),
  }));
  await page.route('**/api/islands*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ islands: [
      { cluster_id: 1, label: '近い島A', people: 4, cx: 11, cy: 10 },
      { cluster_id: 2, label: '近い島B', people: 2, cx: 12, cy: 10 },
      { cluster_id: 3, label: '', people: 9, cx: 10, cy: 11 },
      { cluster_id: 4, label: '近い島C', people: 7, cx: 13, cy: 10 },
      { cluster_id: 5, label: '遠い島D', people: 1, cx: 900, cy: 900 },
    ] }),
  }));
  await tryExampleOnce(page);
  await expect(page.locator('#reveal')).toHaveClass(/active/, { timeout: 15000 });
  await expect(page.locator('.reveal-near-lede')).toHaveText('あなたの文に近い話をしている人は、このあたりにいます');
  const names = page.locator('.reveal-near-name');
  await expect(names).toHaveText(['近い島A', '近い島B', '近い島C']);
  await expect(page.locator('.reveal-near-people').first()).toHaveText('4人');
  await expect(page.locator('#revealWrite')).toHaveText('自分の言葉で投稿する');
  await expect(page.locator('#revealToMap')).toHaveText('地図を見る');
  await page.locator('#revealWrite').click();
  await expect(page.locator('#compose')).toHaveClass(/active/);
  expect(await page.evaluate(() => location.hash)).toBe('#/post');
});

test('trial map: banner, nearby label, one-time hint, weekly switch and island card wording', async ({ page }) => {
  await signInForFirstPost(page, 'trial-map');
  await page.route('**/api/posts/preview', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ x: 10, y: 10, island: { cluster_id: 1, label: '近い島A' } }),
  }));
  await page.route('**/api/islands*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ islands: [
      { cluster_id: 1, label: '近い島A', people: 4, cx: 11, cy: 10 },
      { cluster_id: 2, label: '近い島B', people: 2, cx: 40, cy: 20 },
      { cluster_id: 3, label: '近い島C', people: 7, cx: 25, cy: 45 },
    ] }),
  }));
  const tryOnce = async () => {
    await tryExampleOnce(page);
    await expect(page.locator('#reveal')).toHaveClass(/active/, { timeout: 15000 });
    await page.locator('#revealToMap').click();
    await expect(page.locator('#map')).toHaveClass(/active/);
  };
  await tryOnce();
  await expect(page.locator('#trialBanner')).toContainText('ここがあなたの島になる場所です。まわりの島をタップして覗いてみよう');
  await expect(page.locator('#nearIslands .near-label')).toHaveText('まわりの島');
  await expect(page.locator('#trialHint')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#trialHint')).toHaveText('島をタップ');
  // Shown for real, so it counts as seen.
  expect(await page.evaluate(() => localStorage.getItem('islands.trialHint'))).toBe('1');

  // With my own post on an island, the label says so.
  await page.evaluate(async () => {
    const { state } = await import('/static/js/state.js');
    const extras = await import('/static/js/screens/map-extras.js');
    state.myPosts = [{ id: 'mine-1' }];
    state.islands = state.islands.map((island, i) => (i === 0 ? { ...island, post_ids: ['mine-1'] } : island));
    extras.refreshNearIslands();
  });
  await expect(page.locator('#nearIslands .near-label')).toHaveText('あなたに近い島');

  // The weekly switch is gone (new islands glow by themselves instead).
  await expect(page.locator('#busyToggle')).toHaveCount(0);
  await expect(page.locator('#busyNote')).toHaveCount(0);

  // A name chip opens the island card, worded "島をのぞく".
  await page.locator('#nearIslands .near-chip').first().click();
  await expect(page.locator('#islandCard')).toBeVisible();
  await expect(page.locator('#islandCard')).toContainText('島をのぞく');
  await expect(page.locator('#trialHint')).toBeHidden();

  // Second tryout: the hint stays away.
  await tryOnce();
  await expect(page.locator('#trialHint')).toBeHidden();
});

test('trial hint still works when localStorage refuses', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('denied'); };
    Storage.prototype.setItem = () => { throw new Error('denied'); };
  });
  await signInForFirstPost(page, 'trial-nostore');
  await page.route('**/api/posts/preview', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ x: 10, y: 10, island: { cluster_id: 1, label: '近い島A' } }),
  }));
  await page.route('**/api/islands*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ islands: [
      { cluster_id: 1, label: '近い島A', people: 4, cx: 11, cy: 10 },
      { cluster_id: 2, label: '近い島B', people: 2, cx: 40, cy: 20 },
    ] }),
  }));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await tryExampleOnce(page);
  await expect(page.locator('#reveal')).toHaveClass(/active/, { timeout: 15000 });
  await page.locator('#revealToMap').click();
  await expect(page.locator('#map')).toHaveClass(/active/);
  await expect(page.locator('#trialBanner')).toBeVisible();
  expect(errors.filter((message) => message !== 'denied')).toEqual([]);
});
