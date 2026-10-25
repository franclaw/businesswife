const { test, expect } = require('@playwright/test');

for (const width of [390, 1280]) {
  test(`boardroom title follows creation, joining, sharing and later rounds at ${width}px`, async ({ page, browser }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(() => Object.defineProperty(navigator, 'share', { value: async (data) => { window.lastShare = data; } }));
    await page.goto('/planning-poker');
    await page.getByTestId('boardroom-title-input').fill('  Sprint 24   planning  ');
    await page.getByTestId('boardroom-title-input').press('Enter');
    await expect(page.getByTestId('join-screen')).toBeVisible();
    await expect(page.getByTestId('room-title')).toHaveText('Sprint 24 planning');
    await expect(page).toHaveTitle('Sprint 24 planning — Planning Poker · Business Wife');
    const url = page.url();
    await page.getByTestId('share-btn').click();
    expect(await page.evaluate(() => window.lastShare)).toEqual({ title: 'Sprint 24 planning', text: 'Join Sprint 24 planning', url });
    await page.getByTestId('pick').first().click();
    await page.getByTestId('join-btn').click();
    await expect(page.getByTestId('game-screen')).toBeVisible();
    await page.getByTestId('question').fill('Estimate this story');
    await page.getByTestId('question').blur();
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('room-title')).toHaveText('Sprint 24 planning');
    await page.reload();
    await expect(page.getByTestId('game-screen')).toBeVisible();
    await expect(page.getByTestId('room-title')).toHaveText('Sprint 24 planning');
    const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
    try {
      const other = await ctx.newPage();
      await other.goto(url);
      await expect(other.getByTestId('join-screen')).toBeVisible();
      await expect(other.getByTestId('room-title')).toHaveText('Sprint 24 planning');
      const bounds = await other.getByTestId('room-title').evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, viewport: innerWidth }; });
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
    } finally { await ctx.close(); }
  });
}

test('poker preview is server-rendered, escaped, canonical, separate from poll metadata and excludes seats', async ({ browser, request, baseURL }) => {
  const title = 'Sprint "R&D" <team> & café? $&';
  const { id } = await (await request.post('/planning-poker/api/rooms', { data: { title } })).json();
  const joined = await (await request.post(`/planning-poker/api/rooms/${id}/join`, { data: { name: 'Private participant', icon: '💼' } })).json();
  const ctx = await browser.newContext({ javaScriptEnabled: false, userAgent: 'TelegramBot (like TwitterBot)' });
  try {
    const page = await ctx.newPage();
    const response = await page.goto(baseURL + `/planning-poker/r/${id}/?private=tracking`);
    expect(response.headers()['cache-control']).toBe('no-store');
    await expect(page).toHaveTitle(title + ' — Planning Poker · Business Wife');
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', title);
    await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute('content', title);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', `https://businesswife.nl/planning-poker/r/${id}`);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://businesswife.nl/planning-poker/icons/icon-512.png');
    const html = await response.text();
    for (const secret of [joined.secret, joined.id, 'Private participant', 'tracking']) expect(html).not.toContain(secret);
    expect(html).toContain('&lt;team&gt;');
    expect(html).toContain('&quot;R&amp;D&quot;');
    const legacy = await request.get('/r/' + id);
    expect(await legacy.text()).toContain('property="og:title"');
  } finally { await ctx.close(); }
});

test('empty/legacy creation gets a named boardroom; titles are bounded and unknown links stay generic', async ({ request }) => {
  for (const data of [undefined, { title: '   ' }]) {
    const res = await request.post('/planning-poker/api/rooms', data ? { data } : {});
    expect(res.ok()).toBe(true);
    const { id } = await res.json();
    const state = await (await request.get(`/planning-poker/api/rooms/${id}/state`)).json();
    expect(state.title).toMatch(/^Refinement \d{4}-\d{2}-\d{2}$/);
  }
  expect((await request.post('/planning-poker/api/rooms', { data: { title: { bad: true } } })).status()).toBe(400);
  const { id } = await (await request.post('/planning-poker/api/rooms', { data: { title: 'x'.repeat(140) } })).json();
  expect((await (await request.get(`/planning-poker/api/rooms/${id}/state`)).json()).title).toHaveLength(120);
  for (const path of ['/planning-poker', '/planning-poker/r/zz99zz']) {
    const html = await (await request.get(path)).text();
    expect(html).toContain('<title>Planning Poker — Business Wife</title>');
    expect(html).not.toContain('property="og:title"');
  }
});
