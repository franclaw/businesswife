const { test, expect } = require('@playwright/test');

const POKER = '/planning-poker';

async function createRoom(page) {
  await page.goto(POKER);
  await expect(page.getByTestId('lobby-screen')).toBeVisible();
  await page.getByTestId('create-btn').click();
  await expect(page.getByTestId('join-screen')).toBeVisible();
  await expect(page).toHaveURL(/\/planning-poker\/r\/[a-z0-9]{6}/);
  await expect(page.getByTestId('share-url')).toHaveValue(/\/planning-poker\/r\/[a-z0-9]{6}/);
  return page.url();
}

async function pickWife(page, firstName) {
  await expect(page.getByTestId('join-screen')).toBeVisible();
  await page.locator('[data-testid="pick"][data-first="' + firstName + '"]').click();
  await expect(page.getByTestId('join-btn')).toBeEnabled();
  await page.getByTestId('join-btn').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.getByTestId('boardroom')).toContainText(firstName);
}

async function leave(page) {
  const link = page.getByTestId('leave-link');
  if (await link.isVisible().catch(() => false)) await link.click();
}

test.describe('Hub', () => {
  test('homepage lists sub-apps', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Business Wife/);
    await expect(page.getByRole('link', { name: /Planning Poker/i })).toHaveAttribute('href', '/planning-poker');
    await expect(page.getByRole('link', { name: /Pomodoro/i })).toHaveAttribute('href', '/pomodoro');
  });
});

test.describe('Planning Poker — rooms', () => {
  test('poker lobby is create/join, not a single boardroom', async ({ page }) => {
    await page.goto(POKER);
    await expect(page).toHaveTitle(/Business Wife Edition/);
    await expect(page.getByTestId('lobby-screen')).toBeVisible();
    await expect(page.getByTestId('create-btn')).toBeVisible();
    await expect(page.getByTestId('join-screen')).toBeHidden();
    await expect(page.getByTestId('game-screen')).toBeHidden();
    await expect(page.getByTestId('lobby-fan').locator('img.fan-card')).toHaveCount(8);
    await expect(page.locator('footer')).toContainText('Inspired by the great H S');
    await expect(page.locator('h1')).not.toContainText('💋');
  });

  test('create room gets a shareable /planning-poker/r/:id URL and portraits', async ({ page }) => {
    await createRoom(page);
    await expect(page.locator('[data-testid="pick"]')).toHaveCount(16);
    await expect.poll(async () =>
      page.locator('#nameGrid img.pic').evaluateAll((imgs) =>
        imgs.filter((img) => img.complete && img.naturalWidth > 0).length
      )
    ).toBe(16);
  });

  test('legacy /r/:id redirects to planning-poker path', async ({ page }) => {
    await page.goto('/r/abc234');
    await expect(page).toHaveURL(/\/planning-poker\/r\/abc234/);
  });

  test('join via shared URL, vote, reveal, next round', async ({ browser }) => {
    const host = await browser.newPage();
    const roomUrl = await createRoom(host);
    await pickWife(host, 'Coco');

    const guest = await browser.newPage();
    await guest.goto(roomUrl);
    await pickWife(guest, 'Betty');
    await expect(host.getByTestId('boardroom')).toContainText('Betty');

    const phase = await host.locator('#phaseBadge').textContent();
    if ((phase || '').includes('revealed')) await host.getByTestId('next-btn').click();
    await host.locator('[data-testid="card"][data-v="8"]').click();
    await expect(host.locator('.player.me .vote')).toHaveText('🔒');

    await host.getByTestId('reveal-btn').click();
    await expect(host.locator('.player.me .vote')).toHaveText('8');
    await expect(guest.getByTestId('boardroom')).toContainText('8');

    await host.getByTestId('next-btn').click();
    await expect(host.locator('.player.me .vote')).toHaveText('—');

    await leave(host);
    await leave(guest);
  });

  test('taken wives move to a separate section and cannot be picked', async ({ browser }) => {
    const host = await browser.newPage();
    const roomUrl = await createRoom(host);
    await pickWife(host, 'Coco');

    const guest = await browser.newPage();
    await guest.goto(roomUrl);
    await expect(guest.getByTestId('taken-wrap')).toBeVisible();
    await expect(guest.locator('[data-testid="pick-taken"][data-first="Coco"]')).toHaveCount(1);
    await expect(guest.locator('[data-testid="pick"][data-first="Coco"]')).toHaveCount(0);

    await guest.locator('[data-testid="pick-taken"][data-first="Coco"]').click({ force: true });
    await expect(guest.getByTestId('join-btn')).toBeDisabled();

    await pickWife(guest, 'Betty');
    await expect(host.getByTestId('boardroom')).toContainText('Betty');
    const third = await browser.newPage();
    await third.goto(roomUrl);
    await expect(third.locator('[data-testid="pick-taken"]')).toHaveCount(2);
    await leave(host);
    await leave(guest);
  });

  test('rename: Jaqueline (Trekhaak services) replaces Dominique', async ({ page }) => {
    await createRoom(page);
    await expect(page.locator('[data-testid="pick"][data-first="Jaqueline"]')).toContainText('Trekhaak services');
    await expect(page.getByRole('button', { name: /Dominique/ })).toHaveCount(0);
  });

  test('observer joins, watches, and cannot vote', async ({ browser }) => {
    const host = await browser.newPage();
    const roomUrl = await createRoom(host);
    await pickWife(host, 'Coco');

    const obs = await browser.newPage();
    await obs.goto(roomUrl);
    await obs.getByTestId('observer-name').fill('Sam');
    await obs.getByTestId('observer-btn').click();
    await expect(obs.getByTestId('game-screen')).toBeVisible();
    await expect(obs.getByTestId('cards')).toBeHidden();
    await expect(obs.getByTestId('boardroom')).toContainText('Sam');
    await expect(host.getByTestId('boardroom')).toContainText('Sam');

    const rejected = await obs.evaluate(async () => {
      const m = location.pathname.match(/\/planning-poker\/r\/([a-z0-9]{6})/);
      const roomId = m[1];
      const id = localStorage.getItem('sbw_id_' + roomId);
      const r = await fetch(location.origin + '/planning-poker/api/rooms/' + roomId + '/vote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, value: '5' }),
      });
      return r.status;
    });
    expect(rejected).toBe(403);

    await host.locator('[data-testid="card"][data-v="8"]').click();
    await expect(host.locator('.player.me .vote')).toHaveText('🔒');
    await host.getByTestId('reveal-btn').click();
    await expect(obs.getByTestId('boardroom')).toContainText('8');

    await leave(host);
    await leave(obs);
  });

  test('two rooms stay isolated', async ({ browser }) => {
    const a = await browser.newPage();
    const b = await browser.newPage();
    await createRoom(a);
    await pickWife(a, 'Vivienne');
    await createRoom(b);
    await pickWife(b, 'Margot');
    await expect(a.getByTestId('boardroom')).not.toContainText('Margot');
    await expect(b.getByTestId('boardroom')).not.toContainText('Vivienne');
    expect(new URL(a.url()).pathname).not.toBe(new URL(b.url()).pathname);
    await leave(a);
    await leave(b);
  });

  test('leave returns to poker lobby not hub', async ({ page }) => {
    await createRoom(page);
    await pickWife(page, 'Coco');
    await leave(page);
    await expect(page).toHaveURL(/\/planning-poker\/?$/);
    await expect(page.getByTestId('lobby-screen')).toBeVisible();
  });
});

test.describe('Pomodoro PWA', () => {
  test('timer page and manifest exist', async ({ page, request }) => {
    await page.goto('/pomodoro');
    await expect(page.locator('#digits')).toBeVisible();
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/pomodoro/manifest.webmanifest');
    const man = await request.get('/pomodoro/manifest.webmanifest');
    expect(man.ok()).toBeTruthy();
    const body = await man.json();
    expect(body.start_url).toMatch(/\/pomodoro/);
    expect(body.display).toBe('standalone');
    const sw = await request.get('/pomodoro/sw.js');
    expect(sw.ok()).toBeTruthy();
    expect(await sw.text()).toMatch(/CACHE/);
  });
});

test.describe('Poker PWA', () => {
  test('manifest and service worker are served', async ({ request }) => {
    const man = await request.get('/planning-poker/manifest.webmanifest');
    expect(man.ok()).toBeTruthy();
    const body = await man.json();
    expect(body.start_url).toMatch(/\/planning-poker/);
    expect(body.scope).toMatch(/\/planning-poker/);
    expect(body.display).toBe('standalone');
    const sw = await request.get('/planning-poker/sw.js');
    expect(sw.ok()).toBeTruthy();
  });
});
