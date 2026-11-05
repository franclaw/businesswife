const { test, expect } = require('@playwright/test');

test('two independent players join and play a curve match', async ({ browser, baseURL }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const base = baseURL;
  await host.goto(base + '/games');
  await host.locator('#name').fill('Host');
  await host.getByRole('button', {name: /create a room/i}).click();
  await expect(host).toHaveURL(/\/games\/[a-f0-9]{8}$/);
  await expect(host.locator('#players')).toContainText('Host (you)');
  await guest.goto(host.url());
  await guest.locator('#name').fill('Guest');
  await guest.getByRole('button', {name: /join room/i}).click();
  await expect(host.locator('#players')).toContainText('Guest');
  await expect(guest.locator('#players')).toContainText('Host');
  await host.getByRole('button', {name: /start game/i}).click();
  await expect(guest.locator('#status')).toContainText('Last curve standing');
  await guest.keyboard.down('ArrowLeft');
  await guest.waitForTimeout(300);
  await guest.keyboard.up('ArrowLeft');
  await expect.poll(async () => guest.evaluate(() => game?.trails.length || 0), { timeout: 10000 }).toBeGreaterThan(10);
  await expect.poll(async () => host.evaluate(() => game?.trails.length || 0)).toBeGreaterThan(10);
  await expect(host.locator('#overlay')).toBeVisible({ timeout: 20000 });
  await expect(host.locator('#status')).toHaveText('Final scores shown above.');
  await expect(host.locator('#players')).toContainText('pts');
  const ended = await host.locator('#overlay strong').textContent();
  await host.waitForTimeout(2200);
  await expect(host.locator('#overlay strong')).toHaveText(ended);
  await hostContext.close(); await guestContext.close();
});


test('solo countdown ends in a stable result with a visible survival score', async ({ page }) => {
  await page.goto('/games');
  await page.locator('#name').fill('Solo');
  await page.locator('#create').click();
  await expect(page.locator('#players')).toContainText('Solo');
  await page.locator('#start').click();
  await expect(page.locator('#overlay strong')).toHaveText(/[123]/);
  await expect(page.locator('#overlay')).toBeHidden({ timeout: 5000 });
  await expect(page.locator('#overlay strong')).toHaveText('RUN COMPLETE', { timeout: 20000 });
  await expect(page.locator('#players')).toContainText(/\d+ sec/);
  await expect(page.locator('#start')).toContainText('Play again');
  await page.waitForTimeout(2500);
  await expect(page.locator('#overlay strong')).toHaveText('RUN COMPLETE');
});
