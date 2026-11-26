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

// Ten independent browser contexts, not ten tabs sharing a seat credential.
test('ten players get unique seats, live updates, pickups and a bounded game stream', async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'Ten-browser load scenario; mobile controls are exercised separately.');
  test.setTimeout(60000);
  const contexts = [], pages = [];
  try {
    for (let i = 0; i < 10; i++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 960 } }); contexts.push(context);
      const page = await context.newPage(); pages.push(page);
      await page.goto(i === 0 ? baseURL + '/games' : pages[0].url());
      await page.locator('#name').fill('Player ' + (i + 1));
      await page.locator('#create').click();
      await expect(page.locator('#room')).toBeVisible();
    }
    await expect(pages[0].locator('#count')).toHaveText('10 / 10');
    await expect(pages[9].locator('#players li')).toHaveCount(10);
    const roster = await pages[0].evaluate(() => game.players);
    expect(new Set(roster.map(p => p.color)).size).toBe(10);
    expect(new Set(roster.map(p => p.slot)).size).toBe(10);
    expect(roster.every(p => !('token' in p))).toBeTruthy();
    const full = await pages[0].request.post('/games/api/rooms/' + new URL(pages[0].url()).pathname.split('/').pop() + '/join', { data: { name: 'Eleventh' } });
    expect(full.status()).toBe(409);
    await pages[0].locator('#start').click();
    await expect(pages[9].locator('#overlay')).toBeHidden({ timeout: 6000 });
    await pages[0].evaluate(() => {
      window.wire = []; const previous = source.onmessage;
      source.onmessage = event => { window.wire.push(event.data.length); previous(event); };
    });
    const sample = await pages[0].evaluate(() => new Promise(resolve => {
      const times = []; let last = performance.now(), end = last + 1400;
      const frame = now => { times.push(now - last); last = now; if (now < end) requestAnimationFrame(frame); else resolve({ times, wire: window.wire, items: game.items, pickupSeen: !!game.pickupNotice, count: game.players.length }); };
      requestAnimationFrame(frame);
    }));
    expect(sample.count).toBe(10); expect(sample.items.length > 0 || sample.pickupSeen).toBeTruthy();
    expect(sample.wire.length).toBeGreaterThan(5);
    expect(Math.max(...sample.wire)).toBeLessThan(16000);
    const frames = sample.times.sort((a, b) => a - b);
    console.log('10-client sample:', JSON.stringify({ medianFrameMs: frames[Math.floor(frames.length / 2)], p95FrameMs: frames[Math.floor(frames.length * .95)], averageUpdateBytes: Math.round(sample.wire.reduce((a, b) => a + b, 0) / sample.wire.length) }));
    // A fresh snapshot after reconnect must rebuild the same trail, not append it twice.
    await pages[9].evaluate(() => connect());
    await expect.poll(() => pages[9].evaluate(() => connected && game.players.length === 10)).toBeTruthy();
    await expect(pages[9].locator('#count')).toHaveText('10 / 10');
  } finally { for (const context of contexts) await context.close(); }
});

test('steering reacts before delayed network acknowledgement and opposing keys release cleanly', async ({ page }) => {
  await page.goto('/games'); await page.locator('#name').fill('Responsive'); await page.locator('#create').click();
  await page.locator('#start').click(); await expect(page.locator('#overlay')).toBeHidden({ timeout: 6000 });
  await page.route('**/games/api/rooms/*/turn', async route => { await new Promise(resolve => setTimeout(resolve, 500)); await route.continue().catch(() => {}); });
  const sample = await page.evaluate(async () => {
    const start = performance.now(), yaw = rendered.get(me.id).yaw;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 120));
    const result = { elapsed: performance.now() - start, yawChange: normalize(rendered.get(me.id).yaw - yaw), serverTurn: game.players.find(p => p.id === me.id).turn };
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    result.both = held;
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', cancelable: true })); result.right = held;
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', cancelable: true })); result.released = held;
    return result;
  });
  expect(sample.yawChange).toBeGreaterThan(.08); expect(sample.serverTurn).toBe(0);
  expect(sample.both).toBe(0); expect(sample.right).toBe(1); expect(sample.released).toBe(0);
  await expect(page.locator('#left')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#right')).toHaveAttribute('aria-pressed', 'false');
  console.log('Input under 500ms simulated delay:', JSON.stringify(sample));
});

test('out-of-order and previous-round input cannot overwrite current steering', async ({ page, request }) => {
  await page.goto('/games'); await page.locator('#name').fill('Sequence'); await page.locator('#create').click();
  await expect(page.locator('#room')).toBeVisible();
  await page.locator('#start').click();
  await expect(page.locator('#overlay')).toBeHidden({ timeout: 6000 });
  const auth = await page.evaluate(() => ({ token: me.token, generation: game.generation, id: game.id }));
  const path = `/games/api/rooms/${auth.id}/turn`;
  await request.post(path, { data: { token: auth.token, turn: 1, seq: 100, generation: auth.generation } });
  await request.post(path, { data: { token: auth.token, turn: -1, seq: 99, generation: auth.generation } });
  const stale = await request.post(path, { data: { token: auth.token, turn: -1, seq: 101, generation: auth.generation - 1 } });
  expect((await stale.json()).seq).toBe(100);
  const state = await (await request.get(`/games/api/rooms/${auth.id}`)).json();
  expect(state.players[0].turn).toBe(1); expect(state.players[0].inputSeq).toBe(100);
});

for (const size of [{width:1440,height:900},{width:1512,height:982}]) test(`laptop room fits ${size.width}×${size.height} without page scrolling`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'Desktop viewport layout.');
  await page.setViewportSize(size); await page.goto('/games'); await page.locator('#name').fill('Laptop'); await page.locator('#create').click();
  await expect(page.locator('#room')).toBeVisible();
  const layout = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
    arena: document.querySelector('#arena').getBoundingClientRect().toJSON(),
    stage: document.querySelector('#play-stage').getBoundingClientRect().toJSON(),
  }));
  expect(layout.width).toBeLessThanOrEqual(size.width);
  expect(layout.height).toBeLessThanOrEqual(size.height);
  expect(layout.stage.bottom).toBeLessThan(size.height);
  expect(layout.arena.width).toBeGreaterThan(size.width === 1512 ? 1050 : 930);
  expect(layout.arena.height).toBeGreaterThan(620);
});

test('touch steering supports two fingers and releases without a stuck turn', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'Real touch input in the phone context.');
  await page.goto('/games'); await page.locator('#name').fill('Touch'); await page.locator('#create').click();
  await page.locator('#start').click(); await expect(page.locator('#overlay')).toBeHidden({ timeout: 6000 });
  const left = await page.locator('#left').boundingBox(), right = await page.locator('#right').boundingBox();
  const a = { x: Math.round(left.x + left.width / 2), y: Math.round(left.y + left.height / 2), id: 1 };
  const b = { x: Math.round(right.x + right.width / 2), y: Math.round(right.y + right.height / 2), id: 2 };
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [a] });
  await expect(page.locator('#left')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => held)).toBe(-1);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [a, b] });
  expect(await page.evaluate(() => held)).toBe(0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [a] });
  expect(await page.evaluate(() => held)).toBe(1);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect(await page.evaluate(() => held)).toBe(0);
  await expect(page.locator('#right')).toHaveAttribute('aria-pressed', 'false');
});

test('fullscreen keeps the complete arena and controls inside the display', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'Fullscreen support varies on mobile browsers.');
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto('/games'); await page.locator('#name').fill('Fullscreen'); await page.locator('#create').click();
  await page.getByRole('button', {name:'Enter fullscreen'}).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBeTruthy();
  const bottom = await page.locator('#right').evaluate(el => el.getBoundingClientRect().bottom);
  expect(bottom).toBeLessThanOrEqual(982);
  await page.getByRole('button', {name:'Exit fullscreen'}).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBeFalsy();
});
