// Pomodoro: an end-timestamp timer, the countdown in the tab title, and opt-in
// notifications. Time is driven by Playwright's fake clock and the
// Notification API is replaced by a recorder, so nothing here waits for real
// minutes or depends on the browser's permission UI.
const { test, expect } = require('@playwright/test');

function fakeNotifications(options = {}) {
  return [({ permission, answer, supported }) => {
    window.__notes = [];
    window.__asks = 0;
    let current = permission;
    if (!supported) { delete window.Notification; } else {
      window.Notification = class {
        constructor(title, opts) { window.__notes.push({ via: 'page', title, body: opts && opts.body }); }
        static get permission() { return current; }
        static async requestPermission() { window.__asks++; current = answer; return current; }
      };
    }
    if (window.ServiceWorkerRegistration) {
      ServiceWorkerRegistration.prototype.showNotification = async function (title, opts) {
        window.__notes.push({ via: 'sw', title, body: opts && opts.body });
      };
    }
    // Let the test put the tab "in the background".
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__vis || 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => (window.__vis || 'visible') !== 'visible' });
  }, { permission: 'default', answer: 'granted', supported: true, ...options }];
}

async function setHidden(page, hidden) {
  await page.evaluate((h) => { window.__vis = h ? 'hidden' : 'visible'; document.dispatchEvent(new Event('visibilitychange')); }, hidden);
}

test.describe('Pomodoro', () => {
  test('shows the countdown in the tab title and never asks on load', async ({ page }) => {
    await page.clock.install();
    await page.addInitScript(...fakeNotifications());
    await page.goto('/pomodoro/');
    await expect(page).toHaveTitle('Pomodoro — Business Wife');
    await expect(page.getByTestId('notify-ask')).toBeHidden();
    expect(await page.evaluate(() => window.__asks)).toBe(0);

    await page.getByRole('button', { name: 'Start' }).click();
    await page.clock.runFor(61_000);
    await expect(page).toHaveTitle(/^23:59 · Focus — Pomodoro$/);
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page).toHaveTitle(/^Paused 23:59 — Pomodoro$/);
  });

  test('the first start offers a calm opt-in; a background tab gets the notification', async ({ page }) => {
    await page.clock.install();
    await page.addInitScript(...fakeNotifications({ permission: 'default', answer: 'granted' }));
    await page.goto('/pomodoro/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByTestId('notify-ask')).toBeVisible();
    await page.getByTestId('notify-yes').click();
    await expect(page.getByTestId('bell')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.__asks)).toBe(1);

    await setHidden(page, true);
    await page.clock.fastForward(25 * 60_000 + 1_000);
    await expect.poll(() => page.evaluate(() => window.__notes)).toEqual([
      { via: 'sw', title: 'Focus block closed.', body: "Take 5 minutes. Start the break when you're ready." },
    ]);
    await expect(page).toHaveTitle('✓ Focus block closed. — Pomodoro');
    await setHidden(page, false);
    await expect(page).toHaveTitle('Pomodoro — Business Wife');
    await expect(page.getByTestId('digits')).toHaveText('05:00');

    // The break ends too, and the bell turns it all off again.
    await page.getByRole('button', { name: 'Start' }).click();
    await setHidden(page, true);
    await page.clock.fastForward(5 * 60_000 + 1_000);
    await expect.poll(() => page.evaluate(() => window.__notes.length)).toBe(2);
    expect((await page.evaluate(() => window.__notes))[1].title).toBe("Break's over.");
    await setHidden(page, false);
    await page.getByTestId('bell').click();
    await expect(page.getByTestId('bell')).toHaveAttribute('aria-pressed', 'false');
  });

  test('a visible tab only chimes; no system notification', async ({ page }) => {
    await page.clock.install();
    await page.addInitScript(...fakeNotifications({ permission: 'granted' }));
    await page.goto('/pomodoro/');
    await page.getByRole('button', { name: '15 / 3' }).click();
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByTestId('notify-ask')).toBeHidden(); // already granted: nothing to ask
    await page.clock.fastForward(15 * 60_000 + 1_000);
    await expect(page.getByTestId('digits')).toHaveText('03:00');
    expect(await page.evaluate(() => window.__notes)).toEqual([]);
  });

  test('denied or unsupported falls back to chime and tab title', async ({ page }) => {
    await page.clock.install();
    await page.addInitScript(...fakeNotifications({ permission: 'denied' }));
    await page.goto('/pomodoro/');
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByTestId('notify-ask')).toBeHidden();
    await page.getByTestId('bell').click();
    await expect(page.getByTestId('notify-note')).toContainText('blocked');
    await setHidden(page, true);
    await page.clock.fastForward(25 * 60_000 + 1_000);
    await expect(page).toHaveTitle('✓ Focus block closed. — Pomodoro');
    expect(await page.evaluate(() => window.__notes)).toEqual([]);
    expect(await page.evaluate(() => window.__asks)).toBe(0);
  });

  test('without the Notification API the bell explains the fallback', async ({ page }) => {
    await page.addInitScript(...fakeNotifications({ supported: false }));
    await page.goto('/pomodoro/');
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByTestId('notify-ask')).toBeHidden();
    await page.getByTestId('bell').click();
    await expect(page.getByTestId('notify-note')).toContainText("can't notify");
  });

  test('a block that ended while the page was closed moves on quietly', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('bw_pomodoro_v1', JSON.stringify({
        focusMin: 25, breakMin: 5, mode: 'focus', remainingMs: 1000, running: true, endsAt: Date.now() - 60_000, sessions: 2,
      }));
    });
    await page.goto('/pomodoro/');
    await expect(page.locator('#modeLabel')).toHaveText('Break');
    await expect(page.locator('#sessionCount')).toHaveText('3');
    await expect(page.getByTestId('digits')).toHaveText('05:00');
  });

  test('moves installed clients off the old cache-first worker', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      const old = await caches.open('bw-pomodoro-v1');
      await old.put('/pomodoro/index.html', new Response('stale shell from the old worker'));
    });
    await page.goto('/pomodoro/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => page.evaluate(() => caches.keys())).toEqual(expect.arrayContaining(['bw-pomodoro-v2']));
    await expect.poll(() => page.evaluate(() => caches.keys())).not.toContain('bw-pomodoro-v1');
    // Pages are network-first now: a reload shows the live page, not the stale copy.
    await page.reload();
    await expect(page.getByTestId('digits')).toBeVisible();
  });
});
