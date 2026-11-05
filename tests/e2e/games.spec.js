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
  await expect(guest.locator('#status')).toContainText('First to 5');
  await guest.keyboard.down('ArrowLeft');
  await guest.waitForTimeout(300);
  await guest.keyboard.up('ArrowLeft');
  await expect.poll(async () => guest.evaluate(() => game?.trails.length || 0), { timeout: 10000 }).toBeGreaterThan(10);
  await expect.poll(async () => host.evaluate(() => game?.trails.length || 0)).toBeGreaterThan(10);
  await hostContext.close(); await guestContext.close();
});
