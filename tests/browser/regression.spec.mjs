import { test, expect } from '@playwright/test';

test('landing, anonymous guard and navigation fit each viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#intro')).toHaveClass(/active/);
  const slides = await page.locator('#slideTrack > .slide').count();
  for (let i = 0; i < slides; i++) await page.locator('#introNext').click();
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
  await expect(page.locator('#intro')).toHaveClass(/active/);
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
  await page.reload();
  await expect(page.locator('#guidance')).toHaveClass(/active/);
  const slides = await page.locator('#guidanceTrack > *').count();
  for (let i = 0; i < slides; i++) await page.locator('#guidanceNext').click();
  await expect(page.locator('#compose')).toHaveClass(/active/);
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
  await expect(page.locator('#sheet')).toHaveAttribute('aria-modal', String(mobile));
  if (mobile) {
    await page.locator('#sheetGrip').click();
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
