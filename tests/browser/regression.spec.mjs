import { test, expect } from '@playwright/test';

test('landing, anonymous guard and navigation fit each viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#welcome')).toHaveClass(/active/);
  await page.goto('/#/map');
  await expect(page.locator('#map')).toHaveClass(/active/);
  await expect(page.locator('#bottomNav')).toBeVisible();
  const nav = await page.locator('#bottomNav').boundingBox();
  expect(nav.height).toBe(64);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('[data-route="#/post"]').click();
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
    await navigate('#/setup');
  });
  await page.locator('#setupName').fill('ガイド確認');
  await page.locator('#setupSave').click();
  await expect(page.locator('#guidance')).toHaveClass(/active/);
  await expect(page.locator('#guidanceTrack > .slide').nth(0)).toBeVisible();
  await page.locator('#guidanceNext').click();
  await page.goto('/');
  await expect(page.locator('#guidance')).toHaveClass(/active/);
  await expect(page.locator('#guidanceTrack > .slide').nth(1)).toBeVisible();
  const slides = await page.locator('#guidanceTrack > *').count();
  for (let i = 1; i < slides; i++) await page.locator('#guidanceNext').click();
  await expect(page.locator('#compose')).toHaveClass(/active/);
  await expect(page.locator('#composeLede')).toHaveText('ためしに１つ\n投稿してみましょう。');
  await expect(page.locator('#bottomNav')).toBeHidden();
  // 最初は例文だけ。「自分の言葉で書く」で入力欄が開く。
  await expect(page.locator('#composeBody')).toBeHidden();
  await page.locator('#composeOwnBtn').click();
  await expect(page.locator('#composeBody')).toBeVisible();
  await expect(page.locator('#firstPostFooter #composeSubmit')).toBeVisible();
});

test('reference registration saves profile and completes the first post', async ({ page }) => {
  await page.goto('/');
  await page.locator('#welcomeRegister').click();
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
  await expect(page.locator('#guidance h2').first()).toContainText('あなたが書いたひとことで');
  const pages = await page.locator('#guidanceTrack > .slide').count();
  for (let i = 0; i < pages; i++) await page.locator('#guidanceNext').click();
  await page.locator('#composeOwnBtn').click();
  await page.locator('#composeBody').fill('休日に公園を散歩しながら季節の花を撮影しています。写真を楽しめる仲間と交流してみたいです。');
  // スライダーを一度動かすまで投稿できない。
  await expect(page.locator('#composeSubmit')).toBeDisabled();
  await page.locator('#composeMotivation').fill('70');
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
    state.account = (await api.put('/api/account/me', { display_name: '比較用', icon_id: '1' })).account;
    return (await api.post('/api/posts', { body: '週末はソロキャンプに出かけて、焚き火を眺めながら静かに過ごすのが好きです。', motivation: 50 })).id;
  });
  await page.locator('[data-route="#/post"]').click();
  await expect(page.locator('#compose')).toHaveClass(/active/);
  await page.locator('#composeBody').fill('画面を移動してもこの下書きを保持します。');
  await page.locator('[data-route="#/map"]').click();
  await page.locator('[data-route="#/post"]').click();
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
  await page.goto('/');
  await page.locator('#welcomeRegister').click();
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
  await page.locator('#composeOwnBtn').click();
  await page.locator('#composeBody').fill('休日に公園を散歩しながら季節の花を撮影しています。写真を楽しめる仲間と交流してみたいです。');
  await page.locator('#composeMotivation').fill('70');
  // A 1x1 PNG is enough: the viewer does not care what the picture is.
  await page.locator('#composeImageInput').setInputFiles({
    name: 'dot.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  });
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
    await navigate('#/setup');
  });
  await page.locator('#setupName').fill('スキップ確認');
  await page.locator('#setupSave').click();
  await expect(page.locator('#guidance')).toHaveClass(/active/);
  const slides = await page.locator('#guidanceTrack > *').count();
  for (let i = 1; i < slides; i++) await page.locator('#guidanceNext').click();
  await expect(page.locator('#guidanceNext')).toHaveText('ひとこと書いてみる');
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
    state.account = (await api.put('/api/account/me', { display_name: name, icon_id: '1' })).account;
  }, label);
}

test('first post shows only the examples until "自分の言葉で書く" opens the form and focuses the body', async ({ page }) => {
  await signInForFirstPost(page, 'two-step');
  await page.evaluate(async () => (await import('/static/js/router.js')).navigate('#/post?first=1'));
  await expect(page.locator('#compose')).toHaveClass(/active/);
  await expect(page.locator('#composeOwnBtn')).toBeVisible();
  await expect(page.locator('#composeExampleList .example').first()).toBeVisible();
  for (const id of ['#composeBody', '#composeMotivation', '#composeSubmit']) {
    await expect(page.locator(id)).toBeHidden();
  }
  await page.locator('#composeOwnBtn').click();
  await expect(page.locator('#composeBody')).toBeVisible();
  await expect(page.locator('#composeBody')).toBeFocused();
  await expect(page.locator('#composeOwnBtn')).toBeHidden();
  await expect(page.locator('#firstPostFooter #composeSubmit')).toBeVisible();
});

test('first post opens already expanded when a draft with text comes back', async ({ page }) => {
  await signInForFirstPost(page, 'draft-open');
  const go = (hash) => page.evaluate(async (h) => (await import('/static/js/router.js')).navigate(h), hash);
  await go('#/post?first=1');
  await page.locator('#composeOwnBtn').click();
  await page.locator('#composeBody').fill('下書きに書いた文章は、戻ってきたときも残ります。');
  await go('#/map');
  await expect(page.locator('#map')).toHaveClass(/active/);
  await go('#/post?first=1');
  await expect(page.locator('#compose')).toHaveClass(/active/);
  await expect(page.locator('#composeBody')).toBeVisible();
  await expect(page.locator('#composeBody')).toHaveValue('下書きに書いた文章は、戻ってきたときも残ります。');
  await expect(page.locator('#composeOwnBtn')).toBeHidden();
});

test('trial result lists the nearest named islands and offers the own-words post first', async ({ page }) => {
  await signInForFirstPost(page, 'reveal-near');
  await page.route('**/api/posts/preview', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ x: 10, y: 10, island: { cluster_id: 1, label: '近い島A' } }),
  }));
  await page.route('**/api/islands', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ islands: [
      { cluster_id: 1, label: '近い島A', people: 4, cx: 11, cy: 10 },
      { cluster_id: 2, label: '近い島B', people: 2, cx: 12, cy: 10 },
      { cluster_id: 3, label: '', people: 9, cx: 10, cy: 11 },
      { cluster_id: 4, label: '近い島C', people: 7, cx: 13, cy: 10 },
      { cluster_id: 5, label: '遠い島D', people: 1, cx: 900, cy: 900 },
    ] }),
  }));
  await page.evaluate(async () => (await import('/static/js/router.js')).navigate('#/post?first=1'));
  await page.locator('#composeExampleList .example').first().click();
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
  await page.route('**/api/islands', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ islands: [
      { cluster_id: 1, label: '近い島A', people: 4, cx: 11, cy: 10 },
      { cluster_id: 2, label: '近い島B', people: 2, cx: 40, cy: 20 },
      { cluster_id: 3, label: '近い島C', people: 7, cx: 25, cy: 45 },
    ] }),
  }));
  const tryOnce = async () => {
    await page.evaluate(async () => (await import('/static/js/router.js')).navigate('#/post?first=1'));
    await page.locator('#composeExampleList .example').first().click();
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

  // The weekly switch and its one-line note.
  await expect(page.locator('#busyToggle')).toContainText('今週の反応');
  await expect(page.locator('#busyNote')).toBeHidden();
  await page.locator('#busyToggle').click();
  await expect(page.locator('#busyNote')).toBeVisible();
  await page.locator('#busyToggle').click();
  await expect(page.locator('#busyNote')).toBeHidden();

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
  await page.route('**/api/islands', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ islands: [
      { cluster_id: 1, label: '近い島A', people: 4, cx: 11, cy: 10 },
      { cluster_id: 2, label: '近い島B', people: 2, cx: 40, cy: 20 },
    ] }),
  }));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(async () => (await import('/static/js/router.js')).navigate('#/post?first=1'));
  await page.locator('#composeExampleList .example').first().click();
  await expect(page.locator('#reveal')).toHaveClass(/active/, { timeout: 15000 });
  await page.locator('#revealToMap').click();
  await expect(page.locator('#map')).toHaveClass(/active/);
  await expect(page.locator('#trialBanner')).toBeVisible();
  expect(errors.filter((message) => message !== 'denied')).toEqual([]);
});
