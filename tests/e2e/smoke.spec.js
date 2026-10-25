// @live smoke: read-only checks that are safe against production (no data is
// created). Runs locally with the rest of the suite and live with
// `npm run test:e2e:live`.
const { test, expect } = require('@playwright/test');

const APPS = [
  { path: '/', title: 'Business Wife', hub: true },
  { path: '/planning-poker/', title: 'Planning Poker — Business Wife', kicker: 'Estimate' },
  { path: '/pomodoro/', title: 'Pomodoro — Business Wife', kicker: 'Focus' },
  { path: '/poll/', title: 'Poll — Business Wife', kicker: 'Decide' },
  { path: '/dates/', title: 'Date Picker — Business Wife', kicker: 'Schedule' },
  { path: '/feedback/', title: 'Feedback — Business Wife', kicker: 'Reflect' },
];

test.describe('Smoke @live', () => {
  for (const app of APPS) {
    test(`${app.path} renders with the shared theme and header`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      const res = await page.goto(app.path);
      expect(res.status()).toBe(200);
      await expect(page).toHaveTitle(app.title);
      await expect(page.locator('link[href="/components/theme.css"]')).toHaveCount(1);
      if (!app.hub) {
        await expect(page.locator('.bw-head .bw-brand')).toHaveAttribute('href', '/');
        await expect(page.locator('.bw-head .bw-kicker')).toContainText(app.kicker);
      }
      const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
      expect(bg).toBe('#c43d6e');
      expect(errors).toEqual([]);
    });
  }

  test('the hub links every app', async ({ page }) => {
    await page.goto('/');
    for (const href of ['/planning-poker', '/pomodoro', '/poll', '/dates', '/feedback']) {
      await expect(page.locator(`a.app[href="${href}"]`)).toHaveCount(1);
    }
  });

  test('hub → every app → back to the hub', async ({ page }) => {
    for (const app of APPS.filter((a) => !a.hub)) {
      await page.goto('/');
      await page.locator(`a.app[href="${app.path.slice(0, -1)}"]`).click();
      await expect(page).toHaveTitle(app.title);
      await page.locator('.bw-head .bw-brand').click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator('a.app')).toHaveCount(5);
    }
  });

  test('every app worker is the shared network-first core', async ({ request }) => {
    for (const app of ['planning-poker', 'pomodoro', 'poll', 'dates']) {
      const res = await request.get(`/${app}/sw.js`);
      expect(res.ok()).toBeTruthy();
      expect(await res.text()).toContain('importScripts("/components/sw-core.js")');
    }
    expect((await request.get('/components/theme.css')).ok()).toBeTruthy();
  });

  test('unknown sessions are clean 404s', async ({ request }) => {
    for (const p of ['/planning-poker/api/rooms/zz99zz', '/poll/api/polls/zz99zz', '/dates/api/picks/zz99zz', '/feedback/api/sessions/zz99zz']) {
      const res = await request.get(p);
      expect(res.status(), p).toBe(404);
      expect((await res.json()).error).toBeTruthy();
    }
  });
});
