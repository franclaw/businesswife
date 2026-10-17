const { test, expect } = require('@playwright/test');

// An intentionally flat blue upload makes an unframed result unambiguous:
// the border must add gold/red pixels while the middle stays blue.
async function upload(page, input, width = 480, height = 480) {
  const data = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#2866b5'; ctx.fillRect(0, 0, width, height);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { width, height });
  await input.setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
}
async function assertFramed(page, src) {
  expect(src).toMatch(/^data:image\/jpeg;base64,/);
  expect(src.length).toBeLessThanOrEqual(19000);
  const pixels = await page.evaluate(async (url) => {
    const image = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const pixel = (x, y) => [...ctx.getImageData(Math.floor(x * image.width), Math.floor(y * image.height), 1, 1).data];
    const out = { width: image.width, height: image.height, center: pixel(.5, .5), border: pixel(.5, .03) }; image.close(); return out;
  }, src);
  expect(pixels.width / pixels.height).toBeCloseTo(2 / 3, 2);
  expect(pixels.center[2]).toBeGreaterThan(pixels.center[0] + 50);
  expect(pixels.border[0]).toBeGreaterThan(pixels.border[2] + 30);
}
async function openPoker(page) {
  await page.goto('/planning-poker'); await page.getByTestId('create-btn').click();
  await expect(page.getByTestId('join-screen')).toBeVisible();
  await page.getByTestId('custom-wife').click();
  await page.getByTestId('custom-name').fill('Framed upload');
}

test('uploaded portrait is framed in preview, poker seat, saved card and later visits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPoker(page); await upload(page, page.getByTestId('custom-file'));
  const preview = page.getByTestId('custom-preview').locator('img');
  await expect(preview).toBeVisible();
  const src = await preview.getAttribute('src'); await assertFramed(page, src);
  await page.getByTestId('join-btn').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.locator('.player.me img.pic')).toHaveAttribute('src', src);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sbw_custom_wives')));
  expect(stored[0].icon).toBe(src);
  await page.goto('/planning-poker'); await page.getByTestId('create-btn').click();
  const saved = page.getByTestId('saved-pick'); await expect(saved).toHaveCount(1);
  await expect(saved.locator('img')).toHaveAttribute('src', src);
  await saved.click(); await page.getByTestId('join-btn').click(); await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.locator('.player.me img.pic')).toHaveAttribute('src', src);
});

test('poll uses the same framed upload for identity and vote portrait', async ({ page, request }) => {
  const r = await (await request.post('/poll/api/polls', { data: { question: 'Framed poll', options: ['Yes', 'No'] } })).json();
  await page.goto('/poll/' + r.id);
  const picker = page.getByTestId('identity-picker');
  await picker.getByTestId('custom-wife').click(); await picker.getByTestId('custom-name').fill('Framed voter');
  await upload(page, picker.getByTestId('custom-file'), 800, 400);
  const preview = picker.getByTestId('custom-preview').locator('img'); await expect(preview).toBeVisible();
  const src = await preview.getAttribute('src'); await assertFramed(page, src);
  await page.getByTestId('identity-add-btn').click();
  await expect(page.getByTestId('identity-overlay')).toBeHidden();
  await page.getByTestId('option').first().click();
  await expect.poll(async () => {
    const state = await (await request.get('/poll/api/polls/' + r.id)).json();
    return JSON.stringify(state).includes(src);
  }).toBe(true);
});

test('missing frame fails clearly and does not replace the chosen portrait', async ({ page }) => {
  await page.route('**/img/portrait-frame-v1.png', (route) => route.fulfill({ status: 503, body: '' }));
  await openPoker(page); await page.getByTestId('avatar-pick').first().click();
  const original = await page.getByTestId('custom-preview').locator('img').getAttribute('src');
  await upload(page, page.getByTestId('custom-file'));
  await expect(page.getByTestId('custom-error')).toContainText('Could not load the portrait frame');
  await expect(page.getByTestId('custom-preview').locator('img')).toHaveAttribute('src', original);
  await expect(page.getByTestId('join-btn')).toBeEnabled();
  await page.unroute('**/img/portrait-frame-v1.png');
  await upload(page, page.getByTestId('custom-file'));
  await expect(page.getByTestId('custom-error')).toBeEmpty();
  const preview = page.getByTestId('custom-preview').locator('img');
  await expect(preview).not.toHaveAttribute('src', original);
  await assertFramed(page, await preview.getAttribute('src'));
});

test('installed app can frame a new upload offline using its precached overlay', async ({ page, context }) => {
  await openPoker(page);
  // The landing URL lacks the worker scope's trailing slash. Navigate the
  // created room URL so this document is actually under /planning-poker/.
  await page.reload();
  await expect(page.getByTestId('join-screen')).toBeVisible();
  await page.getByTestId('custom-wife').click();
  await page.getByTestId('custom-name').fill('Offline upload');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await upload(page, page.getByTestId('custom-file'), 300, 600);
  const preview = page.getByTestId('custom-preview').locator('img');
  await expect(preview).toBeVisible(); await assertFramed(page, await preview.getAttribute('src'));
  await expect(page.getByTestId('custom-error')).toBeEmpty();
});
