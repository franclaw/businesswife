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

test('F toggles a much larger fullscreen arena with no desktop steering buttons', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'Fullscreen support varies on mobile browsers.');
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto('/games'); await page.locator('#name').fill('Fullscreen'); await page.locator('#create').click();
  await expect(page.locator('#room')).toBeVisible();
  const room = await page.evaluate(() => game.id);
  for (let i = 2; i <= 10; i++) expect((await request.post(`/games/api/rooms/${room}/join`, { data: { name: `Player ${i}` } })).ok()).toBeTruthy();
  await expect(page.locator('#count')).toHaveText('10 / 10');
  const windowed = await page.locator('#arena').boundingBox();
  expect(await page.evaluate(() => [game.field.width, game.field.height, canvas.width, canvas.height])).toEqual([1600, 1000, 1600, 1000]);
  await expect(page.locator('#fullscreen')).toHaveClass(/fullscreen-nudge/);
  await expect(page.locator('#fullscreen')).toHaveCSS('animation-name', 'fullscreen-invite');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('#fullscreen')).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.keyboard.press('f');
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBeTruthy();
  await expect(page.locator('.controls')).toBeHidden();
  await expect(page.locator('#fullscreen')).not.toHaveClass(/fullscreen-nudge/);
  const fullscreen = await page.locator('#arena').boundingBox();
  expect(fullscreen.width).toBeGreaterThan(windowed.width * 1.2);
  expect(fullscreen.height).toBeGreaterThan(982 * .9);
  expect(fullscreen.x).toBeGreaterThanOrEqual(0); expect(fullscreen.y).toBeGreaterThanOrEqual(0);
  expect(fullscreen.x + fullscreen.width).toBeLessThanOrEqual(1512);
  expect(fullscreen.y + fullscreen.height).toBeLessThanOrEqual(982);
  await page.locator('#fullscreen-start').click();
  await expect(page.locator('#overlay strong')).toHaveText(/[123]/);
  await page.keyboard.press('f');
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBeFalsy();
  await expect(page.locator('#fullscreen')).toHaveClass(/fullscreen-nudge/);
  await expect(page.locator('#overlay')).toBeHidden({ timeout: 6000 });
  await expect(page.locator('#fullscreen')).not.toHaveClass(/fullscreen-nudge/);
  await expect(page.locator('.controls')).toBeVisible();
});

test('F never interrupts text entry or browser modifier shortcuts', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'Desktop keyboard shortcut.');
  await page.goto('/games'); await page.locator('#name').fill('Focus'); await page.keyboard.press('f');
  await expect(page.locator('#name')).toHaveValue('Focusf');
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBeFalsy();
  await page.locator('#create').click(); await expect(page.locator('#room')).toBeVisible();
  await page.evaluate(() => { const input = document.createElement('input'); input.id = 'chat-draft'; document.querySelector('#play-stage').append(input); input.focus(); });
  await page.keyboard.press('f'); await expect(page.locator('#chat-draft')).toHaveValue('f');
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBeFalsy();
  await page.locator('#chat-draft').evaluate(el => el.remove());
  const prevented = await page.evaluate(() => { const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(event); return event.defaultPrevented; });
  expect(prevented).toBeFalsy();
});

test('each device sees its own identity before moving and a marker at its spawn', async ({ browser, baseURL }, testInfo) => {
  const use = testInfo.project.use;
  const device = { viewport: use.viewport, hasTouch: use.hasTouch, isMobile: use.isMobile, deviceScaleFactor: use.deviceScaleFactor };
  const a = await browser.newContext(device);
  const b = await browser.newContext(device);
  try {
    const host = await a.newPage(), guest = await b.newPage();
    await host.goto(baseURL + '/games'); await host.locator('#name').fill('Host'); await host.locator('#create').click();
    await expect(host.locator('#your-card')).toContainText('#1 · Host — YOU');
    await guest.goto(host.url()); await guest.locator('#name').fill('Guest'); await guest.locator('#create').click();
    await expect(guest.locator('#your-card')).toContainText('#2 · Guest — YOU');
    await expect(host.locator('#your-card')).not.toContainText('Guest');
    await expect(guest.locator('#players li.is-you')).toContainText('Guest (you)');
    await expect(host.locator('#players li.is-you')).toContainText('Host (you)');
    const color = await guest.evaluate(() => game.players.find(p => p.id === me.id).color);
    expect(await guest.locator('#your-player').evaluate(el => el.style.getPropertyValue('--player-color'))).toBe(color);
    if (testInfo.project.name === 'desktop') { await guest.keyboard.press('f'); await expect.poll(() => guest.evaluate(() => !!document.fullscreenElement)).toBeTruthy(); }
    await expect(guest.locator('#spawn-direction')).toBeVisible();
    const spawn = await guest.evaluate(() => game.players.find(p => p.id === me.id).spawn);
    const angle = await guest.locator('#spawn-direction').evaluate(el => parseFloat(el.style.transform.slice(7)));
    expect(angle).toBeCloseTo(-spawn.yaw * 180 / Math.PI);
    await host.locator('#start').click();
    await expect.poll(() => guest.evaluate(() => game.countdown)).toBeTruthy();
    const actual = await guest.evaluate(() => { const p = game.players.find(p => p.id === me.id); return { x: p.x, y: p.y, yaw: p.yaw }; });
    expect(actual.x).toBeCloseTo(spawn.x, 0); expect(actual.y).toBeCloseTo(spawn.y, 0); expect(actual.yaw).toBeCloseTo(spawn.yaw, 3);
    await expect(guest.locator('#spawn-label')).toBeVisible();
    await expect(guest.locator('#spawn-label')).toHaveText('YOU · #2');
    await expect(guest.locator('#your-card')).toContainText('Guest — YOU');
    const position = await guest.evaluate(() => { const p = game.players.find(p => p.id === me.id), marker = document.querySelector('#spawn-marker'); return { left: parseFloat(marker.style.left), top: parseFloat(marker.style.top), x: p.x / game.field.width * 100, y: p.y / game.field.height * 100, overflow: document.documentElement.scrollWidth > innerWidth }; });
    expect(position.left).toBeCloseTo(position.x); expect(position.top).toBeCloseTo(position.y); expect(position.overflow).toBeFalsy();
    await expect(guest.locator('#spawn-marker')).toBeHidden({ timeout: 6000 });
    await expect(guest.locator('#your-card')).toBeHidden();
    await expect(guest.locator('#your-player')).toBeVisible();
  } finally { await a.close(); await b.close(); }
});

test('room totals accumulate across rematches and survive a reconnect without double credit', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'Server score-series behavior runs once; phone identity is covered separately.');
  test.setTimeout(75000);
  await page.goto('/games'); await page.locator('#name').fill('Host'); await page.locator('#create').click();
  await expect(page.locator('#room')).toBeVisible();
  const auth = await page.evaluate(() => ({ id: game.id, playerId: me.id }));
  const path = `/games/api/rooms/${auth.id}`;
  expect((await request.post(path + '/join', { data: { name: 'Guest' } })).ok()).toBeTruthy();
  const get = async () => (await request.get(path)).json();
  await page.locator('#start').click();
  await expect.poll(async () => (await get()).phase, { timeout: 25000 }).toBe('over');
  const first = await get();
  expect(first.players.reduce((sum, p) => sum + p.totalScore, 0)).toBeGreaterThan(0);
  for (const p of first.players) { expect(p.totalScore).toBe(p.score); expect(p.roundsPlayed).toBe(1); }
  await expect(page.locator('#start')).toContainText('Play again');
  await page.locator('#start').click();
  const begun = await get();
  for (const p of begun.players) { expect(p.totalScore).toBe(first.players.find(old => old.id === p.id).totalScore); expect(p.score).toBe(0); }
  await page.reload(); await expect(page.locator('#room')).toBeVisible();
  expect(await page.evaluate(() => me.id)).toBe(auth.playerId);
  await expect.poll(async () => (await get()).phase, { timeout: 25000 }).toBe('over');
  const second = await get();
  for (const p of second.players) {
    expect(p.totalScore).toBe(first.players.find(old => old.id === p.id).totalScore + p.score);
    expect(p.roundsPlayed).toBe(2);
    await expect(page.locator(`li[data-player-id="${p.id}"] .player-score`)).toHaveText(`${p.totalScore} pts`);
    await expect(page.locator(`li[data-player-id="${p.id}"] .player-meta`)).toContainText(`+${p.score} pts this round`);
  }
  await page.waitForTimeout(2000);
  const stable = await get();
  expect(stable.players.map(p => p.totalScore)).toEqual(second.players.map(p => p.totalScore));
});

test('eraser legend is available only in solo and two-player rooms', async ({ page, request }) => {
  await page.goto('/games'); await page.locator('#name').fill('Host'); await page.locator('#create').click();
  await expect(page.locator('#your-player')).toBeVisible();
  const room = new URL(page.url()).pathname.split('/').pop();
  const endpoint = `/games/api/rooms/${room}`;
  await expect(page.locator('#eraser-legend')).toBeVisible();
  const second = await request.post(endpoint + '/join', { data: { name: 'Second' } });
  expect(second.ok()).toBeTruthy();
  await expect(page.locator('#count')).toHaveText('2 / 10');
  await expect(page.locator('#eraser-legend')).toBeVisible();
  const third = await request.post(endpoint + '/join', { data: { name: 'Third' } });
  expect(third.ok()).toBeTruthy();
  await expect(page.locator('#count')).toHaveText('3 / 10');
  await expect(page.locator('#eraser-legend')).toBeHidden();
  const seat = await third.json();
  const leave = await request.post(endpoint + '/leave', { data: { token: seat.token } });
  expect(leave.ok()).toBeTruthy();
  await expect(page.locator('#count')).toHaveText('2 / 10');
  await expect(page.locator('#eraser-legend')).toBeVisible();
});

test('delayed steering, burst snapshots and a crash never teleport a rendered snake', async ({ page }) => {
  await page.goto('/games'); await page.locator('#name').fill('Continuity'); await page.locator('#create').click();
  await expect(page.locator('#your-player')).toBeVisible();
  const result = await page.evaluate(async () => {
    // Drive the real renderer with a known authoritative trajectory. Arrival
    // jitter and the 900ms input acknowledgement are independent of frame rate.
    source.close();
    const template = structuredClone(game), id = me.id;
    const remote = { ...template.players[0], id: 'remote', slot: 1, name: 'Remote', color: '#ff737e' };
    template.players.push(remote); template.solo = false; template.generation++;
    template.phase = 'playing'; template.countdown = null; template.items = []; template.tick = 180;
    const path = t => {
      const angle = Math.max(0, t - .9) * 2.85;
      return t <= .9 ? { x: 800, y: 700 - 108 * t, yaw: 0 } : { x: 800 + 108 / 2.85 * (Math.cos(angle) - 1), y: 700 - 108 * .9 - 108 / 2.85 * Math.sin(angle), yaw: angle };
    };
    const history = [];
    let cursor = 0;
    const snapshot = (n, full = false, dead = false) => {
      const time = n / 20, g = structuredClone(template);
      g.tick = 180 + n * 3; g.elapsed = time; g.full = full; g.phase = dead ? 'over' : 'playing';
      g.players[0] = { ...g.players[0], ...path(time), alive: !dead, turn: time < .9 ? 0 : -1, inputSeq: time < .9 ? 0 : 50 };
      g.players[1] = { ...remote, x: 1000, y: 700 - 108 * time, yaw: 0, alive: true, turn: 0 };
      if (n) {
        for (let tick = g.tick - 2; tick <= g.tick; tick++) {
          const t = (tick - 180) / 60, p = path(t);
          history.push([0, p.x, p.y], [1, 1000, 700 - 108 * t]);
        }
      }
      g.trailFrom = full ? 0 : cursor; g.trailTo = history.length;
      g.trails = full ? [...history] : history.slice(cursor); cursor = history.length;
      receive(g);
    };
    snapshot(0, true); held = -1; inputSeq = 50; rtt = 900;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const samples = [];
    let running = true;
    const frame = now => {
      samples.push({ at: now, own: { ...rendered.get(id) }, remote: { ...rendered.get('remote') } });
      if (running) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const delays = [50, 25, 75, 150, 0, 0];
    for (let n = 1; n <= 36; n++) {
      await new Promise(resolve => setTimeout(resolve, delays[(n - 1) % delays.length]));
      snapshot(n, n === 27, n === 36); // full same-round reconnect, then collision
    }
    const pixel = ink.getImageData(1000, Math.floor(700 - 108 * 1.8), 1, 1).data;
    const latestHazardVisible = pixel[0] === 255 && pixel[1] === 115 && pixel[2] === 126;
    await new Promise(resolve => setTimeout(resolve, 650)); running = false;
    const speeds = samples.slice(1).flatMap((p, i) => ['own', 'remote'].map(key => Math.hypot(p[key].x - samples[i][key].x, p[key].y - samples[i][key].y) / Math.min(.04, (p.at - samples[i].at) / 1000)));
    const actual = path(1.8), visible = rendered.get(id);
    return { maxSpeed: Math.max(...speeds), crashError: Math.hypot(actual.x - visible.x, actual.y - visible.y), samples: samples.length, latestHazardVisible };
  });
  expect(result.samples).toBeGreaterThan(20);
  expect(result.maxSpeed).toBeLessThan(108 * 1.36);
  expect(result.crashError).toBeLessThan(1);
  expect(result.latestHazardVisible).toBeTruthy();
  console.log('900ms acknowledgement + burst/reconnect/death continuity:', result);
});
