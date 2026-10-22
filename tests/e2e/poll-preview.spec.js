const { test, expect } = require('@playwright/test');

test('a crawler without JavaScript sees the poll question in link-preview metadata', async ({ browser, request, baseURL }) => {
  const question = 'Lunch: "R&D" <team> & café? $&';
  const { id, ownerToken } = await (await request.post('/poll/api/polls', { data: { question, options: ['A', 'B'] } })).json();
  const ctx = await browser.newContext({ javaScriptEnabled: false, userAgent: 'TelegramBot (like TwitterBot)' });
  try {
    const page = await ctx.newPage();
    const response = await page.goto(baseURL + '/poll/' + id + '/?tracking=not-in-preview');
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');
    await expect(page).toHaveTitle(question + ' — Poll · Business Wife');
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', question);
    await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute('content', question);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://businesswife.nl/poll/' + id);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://businesswife.nl/poll/' + id);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://businesswife.nl/poll/icons/icon-512.png');
    const html = await response.text();
    expect(html).not.toContain(ownerToken);
    expect(html).toContain('&lt;team&gt;');
    expect(html).toContain('&quot;R&amp;D&quot;');
    expect(html).not.toContain('not-in-preview');
    const head = await request.head('/poll/' + id);
    expect(head.status()).toBe(200);
    expect(head.headers()['content-type']).toContain('text/html');
    expect(await head.text()).toBe('');
  } finally { await ctx.close(); }
});

test('poll previews stay separate, work when closed, and leave lobby/missing polls generic', async ({ page, request }) => {
  const create = async (question) => (await (await request.post('/poll/api/polls', { data: { question, options: ['A', 'B'] } })).json());
  const a = await create('Workshop on Thursday?');
  const b = await create('Coffee on Friday?');
  await request.post(`/poll/api/polls/${a.id}/close`, { data: { ownerToken: a.ownerToken } });
  await page.goto('/poll/' + a.id);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'Workshop on Thursday?');
  await expect(page).toHaveTitle('Workshop on Thursday? — Poll · Business Wife');
  await page.goto('/poll/' + b.id);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'Coffee on Friday?');
  for (const path of ['/poll', '/poll/zz99zz']) {
    const html = await (await request.get(path)).text();
    expect(html).toContain('<title>Poll — Business Wife</title>');
    expect(html).not.toContain('Workshop on Thursday?');
    expect(html).not.toContain('property="og:title"');
  }
});
