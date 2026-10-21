const { test, expect } = require('@playwright/test');

// Uploads are stored RAW (no baked frame) and the frame is painted over them
// in the frontend via .bw-framed. A flat blue upload makes that unambiguous:
// every pixel of a raw upload must stay blue — gold pixels may only come
// from the CSS overlay, never from the stored image.
async function upload(page, input, width = 480, height = 480) {
  const data = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#2866b5'; ctx.fillRect(0, 0, width, height);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { width, height });
  await input.setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
}
async function assertRawUpload(page, src) {
  expect(src).toMatch(/^data:image\/jpeg;base64,/);
  expect(src.length).toBeLessThanOrEqual(19000);
  const pixels = await page.evaluate(async (url) => {
    const image = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const pixel = (x, y) => [...ctx.getImageData(Math.floor(x * image.width), Math.floor(y * image.height), 1, 1).data];
    const out = {
      width: image.width, height: image.height,
      center: pixel(.5, .5), top: pixel(.5, .03), corner: pixel(.02, .02),
    }; image.close(); return out;
  }, src);
  // Cropped to a 2:3 portrait, and blue everywhere: no frame baked in.
  expect(pixels.width / pixels.height).toBeCloseTo(2 / 3, 2);
  for (const px of [pixels.center, pixels.top, pixels.corner]) {
    expect(px[2]).toBeGreaterThan(px[0] + 50);
  }
}
async function openPoker(page) {
  await page.goto('/planning-poker'); await page.getByTestId('create-btn').click();
  await expect(page.getByTestId('join-screen')).toBeVisible();
  await page.getByTestId('custom-wife').click();
  await page.getByTestId('custom-name').fill('Framed upload');
}

test('upload stores the raw photo and the frontend frames preview, seat and saved card', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPoker(page); await upload(page, page.getByTestId('custom-file'));
  const preview = page.getByTestId('custom-preview').locator('img');
  await expect(preview).toBeVisible();
  const src = await preview.getAttribute('src'); await assertRawUpload(page, src);
  // The frame must be an overlay element, not pixels inside the image.
  await expect(page.getByTestId('custom-preview').locator('.bw-framed img')).toHaveCount(1);
  await page.getByTestId('join-btn').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.locator('.player.me .bw-framed img.pic')).toHaveAttribute('src', src);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sbw_custom_wives')));
  await page.goto('/planning-poker'); await page.getByTestId('create-btn').click();
  const saved = page.getByTestId('saved-pick'); await expect(saved).toHaveCount(1);
  await expect(saved.locator('img')).toHaveAttribute('src', src);
  await expect(saved.locator('.bw-framed img')).toHaveCount(1);
  await saved.click(); await page.getByTestId('join-btn').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.locator('.player.me .bw-framed img.pic')).toHaveAttribute('src', src);
  expect(Array.isArray(stored)).toBe(true);
});

test('legacy saved uploads keep their baked frame and get no overlay', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/planning-poker');
  const legacy = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 60;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#8a2433'; ctx.fillRect(0, 0, 40, 60);
    ctx.fillStyle = '#2866b5'; ctx.fillRect(5, 5, 30, 50);  // old composite: frame border baked in
    return canvas.toDataURL('image/jpeg', 0.85);
  });
  await page.evaluate((icon) => localStorage.setItem('sbw_custom_wives', JSON.stringify([
    { name: 'Legacy Fran', icon, savedAt: Date.now(), subtitle: 'baked frame' },
  ])), legacy);
  await page.reload(); await page.getByTestId('create-btn').click();
  const saved = page.getByTestId('saved-pick'); await expect(saved).toHaveCount(1);
  await expect(saved.locator('img')).toHaveAttribute('src', legacy);
  await expect(saved.locator('.bw-framed')).toHaveCount(0);      // no double frame
  await saved.click(); await page.getByTestId('join-btn').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.locator('.player.me img.pic')).toHaveAttribute('src', legacy);
  await expect(page.locator('.player.me .bw-framed')).toHaveCount(0);
});

test('poll stores the raw upload and frames the chip, the vote state and voter cells', async ({ page, request }) => {
  const r = await (await request.post('/poll/api/polls', { data: { question: 'Framed poll', options: ['Yes', 'No'] } })).json();
  await page.goto('/poll/' + r.id);
  const picker = page.getByTestId('identity-picker');
  await picker.getByTestId('custom-wife').click(); await picker.getByTestId('custom-name').fill('Framed voter');
  await upload(page, picker.getByTestId('custom-file'), 800, 400);
  const preview = picker.getByTestId('custom-preview').locator('img'); await expect(preview).toBeVisible();
  const src = await preview.getAttribute('src'); await assertRawUpload(page, src);
  await picker.getByTestId('custom-preview').locator('.bw-framed img').waitFor();
  await page.getByTestId('identity-add-btn').click();
  await expect(page.getByTestId('identity-overlay')).toBeHidden();
  await expect(page.getByTestId('you-chip').locator('.bw-framed img')).toHaveCount(1);
  await page.getByTestId('option').first().click();
  await expect.poll(async () => {
    const state = await (await request.get('/poll/api/polls/' + r.id)).json();
    const voter = state.voters && state.voters[0];
    return voter && voter.icon === src && voter.raw === true;
  }).toBe(true);
  await expect(page.getByTestId('option-voters').locator('.bw-framed img')).toHaveCount(1);
});

test('a raw server vote without the raw flag renders unframed, with the flag framed', async ({ page, request }) => {
  const r = await (await request.post('/poll/api/polls', { data: { question: 'Flagged voters', options: ['Yes', 'No'] } })).json();
  const legacy = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAcACgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiig//2Q==';
  const poll = await (await request.get('/poll/api/polls/' + r.id)).json();
  const optionId = poll.options[0].id;
  await request.post('/poll/api/polls/' + r.id + '/vote', { data: { voterId: 'legacy-voter', optionId, name: 'Old Fran', icon: legacy } });
  await request.post('/poll/api/polls/' + r.id + '/vote', { data: { voterId: 'raw-voter', optionId, name: 'New Fran', icon: legacy, raw: true } });
  const state = await (await request.get('/poll/api/polls/' + r.id)).json();
  const old = state.voters.find((v) => v.name === 'Old Fran');
  const fresh = state.voters.find((v) => v.name === 'New Fran');
  expect(old.raw).toBeFalsy();
  expect(fresh.raw).toBe(true);
  await request.post('/poll/api/polls/' + r.id + '/close', { data: { ownerToken: r.ownerToken } });
  await page.goto('/poll/' + r.id);
  await expect(page.getByTestId('option-voters').locator('.bw-framed')).toHaveCount(1); // only the flagged voter
});

test('installed app renders a new upload with its overlay offline', async ({ page, context }) => {
  await openPoker(page);
  await page.reload();
  await expect(page.getByTestId('join-screen')).toBeVisible();
  await page.getByTestId('custom-wife').click();
  await page.getByTestId('custom-name').fill('Offline upload');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await upload(page, page.getByTestId('custom-file'), 300, 600);
  const preview = page.getByTestId('custom-preview').locator('img');
  await expect(preview).toBeVisible(); await assertRawUpload(page, await preview.getAttribute('src'));
  await expect(page.getByTestId('custom-preview').locator('.bw-framed img')).toHaveCount(1);
  await expect(page.getByTestId('custom-error')).toBeEmpty();
  // The frame asset must come from the precache, not the network.
  const cached = await page.evaluate(() => caches.match('/img/portrait-frame-v1.png').then((r) => !!r));
  expect(cached).toBe(true);
});
