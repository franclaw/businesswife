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
  const link = page.locator('[data-testid="leave-link"]:visible').first();
  if (await link.count() && await link.isVisible().catch(() => false)) await link.click();
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
    await expect(page.locator('.room-code-label')).toBeVisible();
    await expect(page.locator('.room-code-label')).toHaveText(/room code/i);
    await expect(page.locator('.lobby-switch')).toHaveCount(0);
    await expect(page.locator('footer')).not.toContainText(/Bold|Calm|Mix/);
    const fanW = await page.getByTestId('lobby-fan').evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--fan-w')));
    expect(fanW).toBeGreaterThan(100);
    await expect(page.locator('footer')).toContainText('Inspired by the great H S');
    await expect(page.locator('h1')).not.toContainText('💋');
  });


  test('old lobby query params still show the mix home screen', async ({ page }) => {
    for (const q of ['?lobby=bold', '?lobby=calm', '?lobby=mix']) {
      await page.goto(POKER + q);
      await expect(page.getByTestId('lobby-screen')).toBeVisible();
      await expect(page.getByTestId('create-btn')).toHaveText(/Create a boardroom/);
      await expect(page.locator('.room-code-label')).toBeVisible();
      await expect(page.locator('.lobby-switch')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('Bold');
      const fanW = await page.getByTestId('lobby-fan').evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--fan-w')));
      expect(fanW).toBeGreaterThan(100);
    }
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

  test('legacy /r/:id redirects to planning-poker path', async ({ page, request }) => {
    const res = await request.get('/r/abc234', { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()['location']).toMatch(/\/planning-poker\/r\/abc234/);
    // Missing room clears session and shows lobby (rejoin feature)
    await page.goto('/planning-poker/r/abc234');
    await expect(page.getByTestId('lobby-screen')).toBeVisible();
    await expect(page.getByTestId('lobby-err')).toContainText(/gone|boardroom/i);
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

  test('reveal all shows Revealing feedback and hides after reveal', async ({ page }) => {
    await createRoom(page);
    await pickWife(page, 'Coco');
    await page.locator('#question').fill('Keep on reveal');
    await page.locator('#question').blur();
    await expect.poll(async () => page.locator('#question').inputValue()).toBe('Keep on reveal');
    await page.locator('[data-testid="card"][data-v="5"]').click();
    await expect(page.locator('.player.me .vote')).toHaveText('🔒');

    const reveal = page.getByTestId('reveal-btn');
    await reveal.click();
    await expect(page.locator('#phaseBadge')).toHaveText('revealed');
    await expect(page.locator('.player.me .vote')).toHaveText('5');
    await expect(reveal).toBeHidden();
    // Reveal must not clear the question (unlike next round)
    await expect(page.locator('#question')).toHaveValue('Keep on reveal');
  });

  test('next round clears question and shows Starting feedback', async ({ page }) => {
    await createRoom(page);
    await pickWife(page, 'Coco');
    await page.locator('#question').fill('Estimate the launch');
    await page.locator('#question').blur();
    await expect.poll(async () => page.locator('#question').inputValue()).toBe('Estimate the launch');

    await page.locator('[data-testid="card"][data-v="5"]').click();
    await page.getByTestId('reveal-btn').click();
    await expect(page.locator('#phaseBadge')).toHaveText('revealed');

    const next = page.getByTestId('next-btn');
    await next.click();
    await expect(page.locator('#question')).toHaveValue('');
    await expect.poll(async () => page.locator('#round').textContent()).toBe('2');
    await expect(page.locator('.player.me .vote')).toHaveText('—');
  });

  test('custom wife joins with name and stock portrait', async ({ page }) => {
    await createRoom(page);
    await expect(page.getByTestId('custom-wife')).toBeVisible();
    await page.getByTestId('custom-wife').locator('summary').click();
    await page.getByTestId('custom-name').fill('Nova');
    await page.locator('[data-testid="avatar-pick"]').first().click();
    await expect(page.getByTestId('join-btn')).toBeEnabled();
    await page.getByTestId('join-btn').click();
    await expect(page.getByTestId('game-screen')).toBeVisible();
    await expect(page.getByTestId('boardroom')).toContainText('Nova');
  });

  test('selecting a wife card auto-fills name and portrait (#5)', async ({ page }) => {
    await createRoom(page);
    await page.locator('[data-testid="pick"][data-first="Coco"]').click();
    await expect(page.getByTestId('custom-name')).toHaveValue('Coco');
    await expect(page.locator('[data-testid="pick"][data-first="Coco"].sel')).toHaveCount(1);
    await expect(page.getByTestId('join-btn')).toBeEnabled();
    // Custom panel stays collapsed for gallery picks
    await expect(page.getByTestId('custom-wife')).not.toHaveAttribute('open');

    // Selecting another card updates name
    await page.locator('[data-testid="pick"][data-first="Betty"]').click();
    await expect(page.getByTestId('custom-name')).toHaveValue('Betty');
    await expect(page.locator('[data-testid="pick"][data-first="Betty"].sel')).toHaveCount(1);

    // Open Add your own to edit name after pick — detaches roster selection
    await page.getByTestId('custom-wife').locator('summary').click();
    await expect(page.locator('[data-testid="avatar-pick"].sel')).toHaveCount(1);
    await expect(page.getByTestId('custom-preview').locator('img')).toHaveAttribute('src', /secretary/);
    await page.getByTestId('custom-name').fill('Nova');
    await expect(page.locator('[data-testid="pick"].sel')).toHaveCount(0);
    await expect(page.locator('[data-testid="avatar-pick"].sel')).toHaveCount(1);
    await page.getByTestId('join-btn').click();
    await expect(page.getByTestId('game-screen')).toBeVisible();
    await expect(page.getByTestId('boardroom')).toContainText('Nova');
  });
});


test.describe('Planning Poker — features 1–9', () => {
  test('rejoin restores seat after reload without lobby', async ({ page }) => {
    await createRoom(page);
    await pickWife(page, 'Coco');
    await expect(page.getByTestId('host-badge')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('game-screen')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('boardroom')).toContainText('Coco');
    await expect(page.getByTestId('join-screen')).toBeHidden();
    await leave(page);
  });

  test('host can lock joining and kick a player', async ({ browser }) => {
    const host = await browser.newPage();
    const roomUrl = await createRoom(host);
    await pickWife(host, 'Coco');
    await expect(host.getByTestId('host-bar')).toBeVisible();
    await host.getByTestId('host-menu-btn').click();
    await expect(host.getByTestId('host-menu')).toBeVisible();
    await host.getByTestId('lock-toggle').check();
    await expect.poll(async () => {
      const r = await host.evaluate(async () => {
        const m = location.pathname.match(/\/planning-poker\/r\/([a-z0-9]{6})/);
        const res = await fetch(location.origin + '/planning-poker/api/rooms/' + m[1] + '/state');
        return (await res.json()).locked;
      });
      return r;
    }).toBe(true);

    const guest = await browser.newPage();
    await guest.goto(roomUrl);
    await guest.locator('[data-testid="pick"][data-first="Betty"]').click();
    await guest.getByTestId('join-btn').click();
    await expect(guest.getByTestId('join-err')).toContainText(/locked/i);

    // Re-open host menu if closed
    if (!(await host.getByTestId('host-menu').isVisible())) {
      await host.getByTestId('host-menu-btn').click();
    }
    await host.getByTestId('lock-toggle').uncheck();
    await guest.getByTestId('join-btn').click();
    await expect(guest.getByTestId('game-screen')).toBeVisible();

    await host.locator('[data-testid="seat-menu-btn"]').click();
    await host.locator('[data-testid="kick-btn"]').click();
    await expect(host.getByTestId('boardroom')).not.toContainText('Betty');
    await expect.poll(async () => guest.getByTestId('join-screen').isVisible()).toBeTruthy();

    await leave(host);
    await guest.close();
  });

  test('vote summary shows after reveal; history after next', async ({ page }) => {
    await createRoom(page);
    await pickWife(page, 'Coco');
    await page.locator('#question').fill('Ship the deck');
    await page.locator('#question').blur();
    await page.locator('[data-testid="card"][data-v="8"]').click();
    await page.getByTestId('reveal-btn').click();
    await expect(page.getByTestId('vote-summary')).toBeVisible();
    await expect(page.getByTestId('summary-mode')).toHaveText('8');
    await expect(page.getByTestId('vote-summary')).toContainText(/Avg/i);
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('history-list').locator('[data-testid="history-item"]')).toHaveCount(1);
    await expect(page.getByTestId('history-list')).toContainText('Ship the deck');
    await leave(page);
  });

  test('share card shows large room code', async ({ page }) => {
    await createRoom(page);
    await expect(page.getByTestId('room-code-big')).toBeVisible();
    await expect(page.locator('#roomCodeBig')).toHaveText(/^[a-z0-9]{6}$/);
    await expect(page.getByTestId('share-btn')).toBeVisible();
    await expect(page.getByTestId('copy-btn')).toBeVisible();
    // Long URL stays in DOM for clipboard but is not a permanent invite field
    await expect(page.getByTestId('share-url')).toBeHidden();
  });

  test('observer badge is clear and vote deck stays hidden', async ({ browser }) => {
    const host = await browser.newPage();
    const roomUrl = await createRoom(host);
    await pickWife(host, 'Coco');
    const obs = await browser.newPage();
    await obs.goto(roomUrl);
    await obs.getByTestId('observer-name').fill('Sam');
    await obs.getByTestId('observer-btn').click();
    await expect(obs.getByTestId('observer-badge')).toBeVisible();
    await expect(obs.getByTestId('observer-badge')).toHaveText(/OBSERVER/i);
    await expect(obs.getByTestId('cards')).toBeHidden();
    await expect(obs.locator('#playCard')).toBeHidden();
    await leave(host);
    await leave(obs);
  });

  test('sound toggle persists preference', async ({ page }) => {
    await createRoom(page);
    await pickWife(page, 'Coco');
    await page.getByTestId('host-menu-btn').click();
    const toggle = page.getByTestId('sound-toggle');
    await expect(toggle).toBeVisible();
    const initial = await toggle.isChecked();
    await toggle.click();
    await expect(toggle).toBeChecked({ checked: !initial });
    await page.reload();
    await expect(page.getByTestId('game-screen')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('host-menu-btn').click();
    await expect(page.getByTestId('sound-toggle')).toBeChecked({ checked: !initial });
    await leave(page);
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
