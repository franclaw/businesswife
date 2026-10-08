const { test, expect } = require('@playwright/test');

const DATES = '/dates';
const iso = (offset) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

// The app keeps one identity per browser profile, so a second "device" needs a
// second context. Marks are keyed by pick id, so a fresh context starts clean.
async function createPick(page, title = 'Team dinner') {
  await page.goto(DATES);
  await expect(page.getByTestId('lobby')).toBeVisible();
  await page.getByTestId('name-input').fill('Marc');
  await page.getByTestId('create-title').fill(title);
  await expect(page.getByTestId('create-btn')).toBeEnabled();
  await page.getByTestId('create-btn').click();
  await expect(page).toHaveURL(/\/dates\/[a-z0-9]{6}/);
  await expect(page.getByTestId('board')).toBeVisible();
  return page.url().match(/\/dates\/([a-z0-9]{6})/)[1];
}

async function tapCell(page, dayOffset, block) {
  const key = `${iso(dayOffset)}|${block}`;
  await page.locator(`[data-testid="cell"][data-key="${key}"]`).click();
}

async function cellCount(page, dayOffset, block) {
  const key = `${iso(dayOffset)}|${block}`;
  return (await page.locator(`[data-testid="cell"][data-key="${key}"] .n`).textContent()).trim();
}

test.describe('Hub', () => {
  test('homepage lists the Date Picker', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: /Date Picker/i })).toHaveAttribute('href', '/dates');
  });
});

test.describe('Date Picker — lobby', () => {
  test('create needs a name and a title', async ({ page }) => {
    await page.goto(DATES);
    await expect(page.getByTestId('create-btn')).toBeDisabled();
    await page.getByTestId('name-input').fill('Marc');
    await expect(page.getByTestId('create-btn')).toBeDisabled();
    await page.getByTestId('create-title').fill('Team dinner');
    await expect(page.getByTestId('create-btn')).toBeEnabled();
  });

  test('an unknown code is reported, not followed', async ({ page }) => {
    await page.goto(DATES);
    await page.getByTestId('name-input').fill('Marc');
    await page.getByTestId('join-code').fill('zzzzzz');
    await page.getByTestId('join-btn').click();
    await expect(page.getByTestId('join-error')).toContainText(/no pick with that code/i);
    await expect(page).not.toHaveURL(/\/dates\/zzzzzz/);
  });

  test('a join without a name is refused before the network', async ({ page }) => {
    await page.goto(DATES);
    await page.getByTestId('join-code').fill('abc123');
    await page.getByTestId('join-btn').click();
    await expect(page.getByTestId('join-error')).toContainText(/name/i);
  });
});

test.describe('Date Picker — marking', () => {
  test('a tap marks the block and counts me', async ({ page }) => {
    await createPick(page);
    await tapCell(page, 0, 'evening');
    await expect(page.locator(`[data-testid="cell"][data-key="${iso(0)}|evening"]`)).toHaveClass(/mine/);
    await expect.poll(() => cellCount(page, 0, 'evening')).toBe('1');
  });

  test('a second tap clears it', async ({ page }) => {
    await createPick(page);
    await tapCell(page, 0, 'evening');
    await expect.poll(() => cellCount(page, 0, 'evening')).toBe('1');
    await tapCell(page, 0, 'evening');
    await expect.poll(() => cellCount(page, 0, 'evening')).toBe('');
    await expect(page.locator(`[data-testid="cell"][data-key="${iso(0)}|evening"]`)).not.toHaveClass(/mine/);
  });

  test('my marks survive a reload', async ({ page }) => {
    await createPick(page);
    await tapCell(page, 0, 'evening');
    await tapCell(page, 2, 'morning');
    await expect.poll(() => cellCount(page, 0, 'evening')).toBe('1');
    await page.reload();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.locator(`[data-testid="cell"][data-key="${iso(0)}|evening"]`)).toHaveClass(/mine/);
    await expect(page.locator(`[data-testid="cell"][data-key="${iso(2)}|morning"]`)).toHaveClass(/mine/);
    await expect.poll(() => cellCount(page, 0, 'evening')).toBe('1');
  });

  test('the overlap from another device arrives live', async ({ browser }) => {
    const a = await browser.newContext();
    const pa = await a.newPage();
    const code = await createPick(pa, 'Offsite');

    const b = await browser.newContext();
    const pb = await b.newPage();
    await pb.goto(`${DATES}/${code}`);
    await expect(pb.getByTestId('board')).toBeVisible();
    // A stranger needs a name before their taps mean anything.
    await pb.evaluate(() => localStorage.setItem('bw_date_name', 'Sana'));
    await pb.reload();
    await expect(pb.getByTestId('board')).toBeVisible();

    await tapCell(pb, 1, 'afternoon');
    await expect.poll(() => cellCount(pa, 1, 'afternoon'), 'Sana should appear on Marc').toBe('1');
    await expect(pa.getByTestId('participants')).toContainText('S');

    // and the overlap grows when both mark the same block
    await tapCell(pa, 1, 'afternoon');
    await expect.poll(() => cellCount(pa, 1, 'afternoon')).toBe('2');
    await expect(pa.getByTestId('verdict')).toContainText(/everyone is free/i);

    await a.close();
    await b.close();
  });

  test('best overlap follows the crowd, not my own pick', async ({ page }) => {
    await createPick(page);
    await tapCell(page, 3, 'morning');
    // Assert the value, not the header: "Best overlap" is static text and is
    // true before any mark lands, which made the old assertion a race.
    await expect(page.locator('[data-testid="verdict"] .v')).toContainText(/morning/i);
  });
});

test.describe('Date Picker — locking', () => {
  test('the creator locks the best overlap and voting stops', async ({ page, request }) => {
    const code = await createPick(page);
    await tapCell(page, 0, 'evening');
    await expect.poll(() => cellCount(page, 0, 'evening')).toBe('1');

    await expect(page.getByTestId('lock-btn')).toBeEnabled();
    await page.getByTestId('lock-btn').click();
    await expect(page.getByTestId('verdict')).toContainText(/locked in/i);
    await expect(page.locator('[data-testid="cell"]').first()).toBeDisabled();

    // A late mark is refused by the server, not merely hidden. Uses the request
    // fixture so the relative URL resolves against baseURL.
    const res = await request.post(`/dates/api/picks/${code}/mark`, {
      data: { voterId: 'latevoter1234', name: 'Late', date: iso(1), block: 'morning', on: true },
    });
    expect(res.status()).toBe(409);
  });

  test('reopening lets voting resume', async ({ page }) => {
    await createPick(page);
    await tapCell(page, 0, 'evening');
    await page.getByTestId('lock-btn').click();
    await expect(page.getByTestId('verdict')).toContainText(/locked in/i);
    await page.getByTestId('unlock-btn').click();
    await expect(page.getByTestId('verdict')).toContainText(/best overlap/i);
    await tapCell(page, 1, 'morning');
    await expect.poll(() => cellCount(page, 1, 'morning')).toBe('1');
  });

  test('a stranger cannot lock someone else’s pick', async ({ request }) => {
    const created = await request.post('/dates/api/picks', {
      data: { title: 'Someone else’s', days: [iso(0), iso(1)], creatorId: 'creator-aaaaaaaa' },
    });
    const { id } = await created.json();
    const res = await request.post(`/dates/api/picks/${id}/lock`, {
      data: { voterId: 'notthecreator', date: iso(0), block: 'morning' },
    });
    expect(res.status()).toBe(403);
  });
});

test.describe('Date Picker — API', () => {
  test('rejects an empty title and an empty window', async ({ request }) => {
    const noTitle = await request.post('/dates/api/picks', { data: { days: [iso(0)] } });
    expect(noTitle.status()).toBe(400);
    const noDays = await request.post('/dates/api/picks', { data: { title: 'X', days: [] } });
    expect(noDays.status()).toBe(400);
  });

  test('rejects a day outside the window', async ({ request }) => {
    const created = await request.post('/dates/api/picks', {
      data: { title: 'Tight', days: [iso(0)], creatorId: 'creator-aaaaaaaa' },
    });
    const { id } = await created.json();
    const bad = await request.post(`/dates/api/picks/${id}/mark`, {
      data: { voterId: 'voter-aaaaaaaa', name: 'A', date: iso(9), block: 'morning', on: true },
    });
    expect(bad.status()).toBe(400);
  });
});

test.describe('Date Picker PWA', () => {
  test('manifest and service worker are served', async ({ request }) => {
    const man = await request.get('/dates/manifest.webmanifest');
    expect(man.ok()).toBeTruthy();
    const body = await man.json();
    expect(body.start_url).toMatch(/\/dates/);
    expect(body.scope).toMatch(/\/dates/);
    expect(body.display).toBe('standalone');
    const sw = await request.get('/dates/sw.js');
    expect(sw.ok()).toBeTruthy();
  });

  test('icons are real PNGs at both sizes', async ({ request }) => {
    for (const size of [192, 512]) {
      const res = await request.get(`/dates/icons/icon-${size}.png`);
      expect(res.ok()).toBeTruthy();
      const buf = await res.body();
      expect(buf.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(buf.readUInt32BE(16)).toBe(size);
    }
  });
});
