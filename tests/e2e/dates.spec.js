const { test, expect } = require('@playwright/test');

const DATES = '/dates';
const API = '/dates/api/picks';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pad = (n) => String(n).padStart(2, '0');
const iso = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const ALL = ['morning', 'afternoon', 'evening'];

// Create through the UI. `days` is [[dayOffset, [blocks]]]; every proposed day
// starts with all three parts on, so the ones not wanted are switched off.
async function createPick(page, { title = 'Team dinner', days = [[0, ALL], [1, ALL], [2, ALL]] } = {}) {
  await page.goto(DATES);
  await expect(page.getByTestId('lobby')).toBeVisible();
  await page.getByTestId('create-title').fill(title);
  const form = page.getByTestId('create-dates');
  for (const [offset, blocks] of days) {
    await form.getByTestId('add-day').fill(iso(offset));
    await form.getByTestId('add-day-btn').click();
    const row = form.locator(`[data-testid="proposal"][data-date="${iso(offset)}"]`);
    for (const b of ALL.filter((x) => !blocks.includes(x))) await row.locator(`[data-block="${b}"]`).click();
  }
  await page.getByTestId('create-btn').click();
  await expect(page).toHaveURL(/\/dates\/[a-z0-9]{6}$/);
  await expect(page.getByTestId('board')).toBeVisible();
  const code = page.url().match(/\/dates\/([a-z0-9]{6})/)[1];
  const ownerUrl = await page.getByTestId('owner-url').inputValue();
  return { code, ownerUrl };
}

async function apiCreate(request, days = [[0, ALL], [1, ALL]]) {
  const res = await request.post(API, {
    data: { title: 'Board dinner', days: days.map(([o, blocks]) => ({ date: iso(o), blocks })) },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return { id: body.id, owner: body.ownerToken };
}

const cell = (page, offset, block) => page.locator(`[data-testid="cell"][data-key="${iso(offset)}|${block}"]`);
const count = async (page, offset, block) => (await cell(page, offset, block).locator('.n').textContent()).trim();

async function openAs(browser, url, name) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url);
  await expect(page.getByTestId('board')).toBeVisible();
  if (name) await page.getByTestId('name-input').fill(name);
  return { ctx, page };
}

test.describe('Hub', () => {
  test('homepage lists the Date Picker', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: /Date Picker/i })).toHaveAttribute('href', '/dates');
  });
});

test.describe('Date Picker — create', () => {
  test('create needs a title and at least one part of one date', async ({ page }) => {
    await page.goto(DATES);
    const btn = page.getByTestId('create-btn');
    await expect(btn).toBeDisabled();
    await page.getByTestId('create-title').fill('Team dinner');
    await expect(btn).toBeDisabled();
    const form = page.getByTestId('create-dates');
    await form.getByTestId('add-day').fill(iso(1));
    await form.getByTestId('add-day-btn').click();
    await expect(btn).toBeEnabled();
    // Switching every part of the only date off takes it off the table.
    const row = form.getByTestId('proposal');
    for (const b of ALL) await row.locator(`[data-block="${b}"]`).click();
    await expect(btn).toBeDisabled();
    await row.locator('[data-block="evening"]').click();
    await expect(row.locator('[data-block="evening"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(btn).toBeEnabled();
  });

  test('the next 7 days can go on the table in one tap, and come off again', async ({ page }) => {
    await page.goto(DATES);
    const form = page.getByTestId('create-dates');
    await form.getByTestId('add-week').click();
    await expect(form.getByTestId('proposal')).toHaveCount(7);
    await form.getByTestId('remove-day').first().click();
    await expect(form.getByTestId('proposal')).toHaveCount(6);
  });

  test('only the proposed parts of each date are offered', async ({ page }) => {
    await createPick(page, { days: [[1, ['evening']], [2, ['morning', 'afternoon']]] });
    await expect(page.getByTestId('cell')).toHaveCount(3);
    await expect(cell(page, 1, 'evening')).toBeVisible();
    await expect(cell(page, 1, 'morning')).toHaveCount(0);
    await expect(cell(page, 2, 'evening')).toHaveCount(0);
  });

  test('the creator link is shown once, loudly, and stays out of the address bar', async ({ page }) => {
    const { code, ownerUrl } = await createPick(page);
    await expect(page.getByTestId('owner-link-card')).toBeVisible();
    expect(ownerUrl).toMatch(new RegExp(`/dates/${code}/admin/[0-9a-f-]{36}$`));
    await expect(page).toHaveURL(new RegExp(`/dates/${code}$`));
    await page.getByTestId('owner-link-done').click();
    await expect(page.getByTestId('owner-link-card')).toBeHidden();
    await page.reload();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('owner-link-card')).toBeHidden();
    // Still the creator on this device.
    await expect(page.getByTestId('creator-panel')).toBeVisible();
  });

  test('an unknown code is reported, not followed', async ({ page }) => {
    await page.goto(DATES);
    await page.getByTestId('join-code').fill('zzzzzz');
    await page.getByTestId('join-btn').click();
    await expect(page.getByTestId('join-error')).toContainText(/no pick with that code/i);
    await expect(page).not.toHaveURL(/\/dates\/zzzzzz/);
  });

  test('a short code is refused before the network', async ({ page }) => {
    await page.goto(DATES);
    await page.getByTestId('join-code').fill('abc');
    await page.getByTestId('join-btn').click();
    await expect(page.getByTestId('join-error')).toContainText(/6 characters/i);
  });
});

test.describe('Date Picker — marking', () => {
  test('a name is required before a tap counts', async ({ page, request }) => {
    const { code } = await createPick(page);
    await cell(page, 0, 'evening').click();
    await expect(page.getByTestId('board-error')).toContainText(/name/i);
    await expect(page.getByTestId('name-input')).toBeFocused();
    const state = await (await request.get(`${API}/${code}`)).json();
    expect(state.totalPeople).toBe(0);
  });

  test('a tap marks, a second tap clears, and the name is remembered', async ({ page }) => {
    await createPick(page);
    await page.getByTestId('name-input').fill('Marc');
    await cell(page, 0, 'evening').click();
    await expect(cell(page, 0, 'evening')).toHaveClass(/mine/);
    await expect.poll(() => count(page, 0, 'evening')).toBe('1');
    await cell(page, 0, 'evening').click();
    await expect.poll(() => count(page, 0, 'evening')).toBe('');
    await expect(cell(page, 0, 'evening')).not.toHaveClass(/mine/);
    await cell(page, 1, 'morning').click();
    await expect.poll(() => count(page, 1, 'morning')).toBe('1');
    await page.reload();
    await expect(page.getByTestId('name-input')).toHaveValue('Marc');
    await expect(cell(page, 1, 'morning')).toHaveClass(/mine/);
  });

  test('anyone can fill in or correct anyone else’s answers, live', async ({ page, browser }) => {
    const { code } = await createPick(page, { title: 'Offsite' });
    await page.getByTestId('name-input').fill('Marc');

    const b = await openAs(browser, `${DATES}/${code}`, 'Sana');
    await cell(b.page, 1, 'afternoon').click();
    await expect.poll(() => count(page, 1, 'afternoon'), 'Sana should appear on Marc').toBe('1');
    await expect(page.getByTestId('people')).toContainText('Sana');

    // Marc corrects Sana's answer from his own phone.
    await page.getByTestId('person').filter({ hasText: 'Sana' }).click();
    await expect(page.getByTestId('name-input')).toHaveValue('Sana');
    await expect(cell(page, 1, 'afternoon')).toHaveClass(/mine/);
    await cell(page, 1, 'afternoon').click();
    await expect.poll(() => count(b.page, 1, 'afternoon')).toBe('');
    await b.ctx.close();
  });

  test('names match regardless of case and spacing', async ({ page, request }) => {
    const { code } = await createPick(page);
    await page.getByTestId('name-input').fill('Sana');
    await cell(page, 0, 'morning').click();
    await expect.poll(() => count(page, 0, 'morning')).toBe('1');
    await page.getByTestId('name-input').fill('  sana ');
    await expect(cell(page, 0, 'morning')).toHaveClass(/mine/);
    await cell(page, 0, 'evening').click();
    await expect.poll(() => count(page, 0, 'evening')).toBe('1');
    const state = await (await request.get(`${API}/${code}`)).json();
    expect(state.totalPeople).toBe(1);
  });

  test('the overlap goes gold and is named in plain words', async ({ page, browser }) => {
    const { code } = await createPick(page);
    await page.getByTestId('name-input').fill('Marc');
    await cell(page, 2, 'evening').click();
    await expect(page.locator('[data-testid="verdict"] .v')).toContainText(/evening/i);

    const b = await openAs(browser, `${DATES}/${code}`, 'Sana');
    await cell(b.page, 2, 'evening').click();
    await expect.poll(() => count(page, 2, 'evening')).toBe('2');
    await expect(cell(page, 2, 'evening')).toHaveClass(/\ball\b/);
    await expect(page.getByTestId('verdict')).toContainText(/everyone is free, 2 of 2/i);
    await b.ctx.close();
  });
});

test.describe('Date Picker — locked answers', () => {
  test('locking hands out an edit link and stops others typing over it', async ({ page, browser, request }) => {
    const { code } = await createPick(page);
    await page.getByTestId('name-input').fill('Marc');
    await cell(page, 0, 'evening').click();
    await expect(page.getByTestId('lock-btn')).toBeVisible();
    await page.getByTestId('lock-btn').click();
    await expect(page.getByTestId('person-link-card')).toBeVisible();
    const editUrl = await page.getByTestId('person-url').inputValue();
    expect(editUrl).toMatch(new RegExp(`/dates/${code}/[0-9a-f-]{36}$`));
    await expect(page.getByTestId('unlock-btn')).toBeVisible();

    // The link holder can still change their own answers.
    await cell(page, 1, 'evening').click();
    await expect.poll(() => count(page, 1, 'evening')).toBe('1');

    const b = await openAs(browser, `${DATES}/${code}`, 'marc');
    await expect(b.page.getByTestId('lock-notice')).toContainText(/Marc’s answers are locked\. Only their edit link can change them/);
    await cell(b.page, 0, 'morning').click();
    await expect.poll(() => count(page, 0, 'morning')).toBe('');
    await b.ctx.close();

    const res = await request.post(`${API}/${code}/mark`, { data: { name: 'Marc', date: iso(0), block: 'morning', on: true } });
    expect(res.status()).toBe(423);
  });

  test('an edit link opens on a fresh device as that person and can unlock', async ({ page, browser }) => {
    const { code } = await createPick(page);
    await page.getByTestId('name-input').fill('Marc');
    await cell(page, 0, 'evening').click();
    await page.getByTestId('lock-btn').click();
    await expect(page.getByTestId('person-url')).toHaveValue(/[0-9a-f-]{36}$/);
    const editUrl = await page.getByTestId('person-url').inputValue();

    const b = await openAs(browser, editUrl);
    await expect(b.page).toHaveURL(new RegExp(`/dates/${code}$`));
    await expect(b.page.getByTestId('name-input')).toHaveValue('Marc');
    await expect(b.page.getByTestId('lock-notice')).toBeHidden();
    await cell(b.page, 2, 'morning').click();
    await expect.poll(() => count(page, 2, 'morning')).toBe('1');
    await b.page.getByTestId('unlock-btn').click();
    await expect(b.page.getByTestId('lock-btn')).toBeVisible();
    await expect(page.getByTestId('person').filter({ hasText: 'Marc' })).not.toContainText('🔒');
    await b.ctx.close();
  });

  test('the creator can reopen a name somebody else locked', async ({ page, request }) => {
    const { code } = await createPick(page);
    await request.post(`${API}/${code}/mark`, { data: { name: 'Pim', date: iso(0), block: 'morning', on: true } });
    await request.post(`${API}/${code}/lock`, { data: { name: 'Pim' } });
    await expect(page.getByTestId('owner-unlock')).toBeVisible();
    await page.getByTestId('owner-unlock').click();
    await expect(page.getByTestId('owner-unlock')).toHaveCount(0);
    const res = await request.post(`${API}/${code}/mark`, { data: { name: 'Pim', date: iso(0), block: 'evening', on: true } });
    expect(res.status()).toBe(200);
  });
});

test.describe('Date Picker — creator', () => {
  test('only the creator link shows the creator panel', async ({ page, browser }) => {
    const { code, ownerUrl } = await createPick(page);
    const guest = await openAs(browser, `${DATES}/${code}`);
    await expect(guest.page.getByTestId('creator-panel')).toBeHidden();
    await guest.ctx.close();

    const phone = await openAs(browser, ownerUrl);
    await expect(phone.page.getByTestId('creator-panel')).toBeVisible();
    await expect(phone.page).toHaveURL(new RegExp(`/dates/${code}$`));
    await phone.ctx.close();
  });

  test('the creator sets the date, voting stops, and can reopen', async ({ page, request }) => {
    const { code } = await createPick(page);
    await page.getByTestId('name-input').fill('Marc');
    await cell(page, 1, 'evening').click();
    await expect.poll(() => count(page, 1, 'evening')).toBe('1');
    await expect(page.getByTestId('choose-slot')).toHaveValue(`${iso(1)}|evening`);
    await page.getByTestId('choose-btn').click();
    await expect(page.getByTestId('verdict')).toContainText(/the date is set/i);
    await expect(cell(page, 1, 'evening')).toHaveClass(/chosen/);
    await expect(cell(page, 0, 'morning')).toBeDisabled();
    await expect(page.getByTestId('lock-btn')).toBeHidden();

    const late = await request.post(`${API}/${code}/mark`, { data: { name: 'Late', date: iso(0), block: 'morning', on: true } });
    expect(late.status()).toBe(409);

    await page.getByTestId('reopen-btn').click();
    await expect(page.getByTestId('verdict')).toContainText(/best overlap/i);
    await cell(page, 0, 'morning').click();
    await expect.poll(() => count(page, 0, 'morning')).toBe('1');
  });

  test('the creator puts more dates on the table and everyone sees them', async ({ page, browser }) => {
    const { code } = await createPick(page, { days: [[0, ['evening']]] });
    const guest = await openAs(browser, `${DATES}/${code}`, 'Sana');
    await expect(guest.page.getByTestId('cell')).toHaveCount(1);

    await page.locator('#addMore summary').click();
    const more = page.getByTestId('more-dates');
    await more.getByTestId('add-day').fill(iso(3));
    await more.getByTestId('add-day-btn').click();
    await more.locator(`[data-date="${iso(3)}"] [data-block="morning"]`).click();
    await page.getByTestId('add-dates-btn').click();

    await expect(guest.page.getByTestId('cell')).toHaveCount(3);
    await expect(cell(guest.page, 3, 'afternoon')).toBeVisible();
    await expect(cell(guest.page, 3, 'morning')).toHaveCount(0);
    await guest.ctx.close();
  });
});

test.describe('Date Picker — mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a two-week grid scrolls inside itself, not the page', async ({ page }) => {
    const days = Array.from({ length: 14 }, (_, i) => [i, ALL]);
    await createPick(page, { days });
    await expect(page.getByTestId('cell')).toHaveCount(42);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('Date Picker — API', () => {
  test('credentials are distinct, never broadcast, and not interchangeable', async ({ request }) => {
    const { id, owner } = await apiCreate(request, [[1, ['evening']]]);
    expect(owner).toMatch(UUID);
    const state = await (await request.get(`${API}/${id}`)).text();
    expect(state).not.toContain(owner);

    const admin = await (await request.get(`${API}/${id}/who?token=${owner}`)).json();
    expect(admin.role).toBe('admin');

    await request.post(`${API}/${id}/mark`, { data: { name: 'Marc', date: iso(1), block: 'evening', on: true } });
    const locked = await (await request.post(`${API}/${id}/lock`, { data: { name: 'Marc' } })).json();
    const personKey = locked.token;
    expect(personKey).toMatch(UUID);
    expect(personKey).not.toBe(owner);
    expect(await (await request.get(`${API}/${id}`)).text()).not.toContain(personKey);

    const who = await (await request.get(`${API}/${id}/who?token=${personKey}`)).json();
    expect(who).toEqual({ role: 'person', name: 'Marc', locked: true });
    expect((await request.get(`${API}/${id}/who?token=nope`)).status()).toBe(403);

    const personChoose = await request.post(`${API}/${id}/choose`, { data: { ownerToken: personKey, date: iso(1), block: 'evening' } });
    expect(personChoose.status()).toBe(403);
    const personAdd = await request.post(`${API}/${id}/dates`, { data: { ownerToken: personKey, days: [{ date: iso(4), blocks: ['morning'] }] } });
    expect(personAdd.status()).toBe(403);
    const ownerAsPerson = await request.post(`${API}/${id}/mark`, { data: { name: 'Marc', date: iso(1), block: 'evening', on: false, token: owner } });
    expect(ownerAsPerson.status()).toBe(423);
    const noOwner = await request.post(`${API}/${id}/choose`, { data: { date: iso(1), block: 'evening' } });
    expect(noOwner.status()).toBe(403);
  });

  test('rejects bad picks and bad marks', async ({ request }) => {
    expect((await request.post(API, { data: { days: [{ date: iso(0), blocks: ALL }] } })).status()).toBe(400);
    expect((await request.post(API, { data: { title: 'X', days: [] } })).status()).toBe(400);
    expect((await request.post(API, { data: { title: 'X', days: [{ date: iso(0), blocks: [] }] } })).status()).toBe(400);
    expect((await request.post(API, { data: { title: 'X', days: [{ date: iso(-5), blocks: ALL }] } })).status()).toBe(400);

    const { id } = await apiCreate(request, [[0, ['evening']]]);
    const noName = await request.post(`${API}/${id}/mark`, { data: { name: '  ', date: iso(0), block: 'evening', on: true } });
    expect(noName.status()).toBe(400);
    const offTable = await request.post(`${API}/${id}/mark`, { data: { name: 'A', date: iso(0), block: 'morning', on: true } });
    expect(offTable.status()).toBe(400);
    const lockNothing = await request.post(`${API}/${id}/lock`, { data: { name: 'Nobody' } });
    expect(lockNothing.status()).toBe(400);
  });

  test('clearing every mark takes a name off the head count', async ({ request }) => {
    const { id } = await apiCreate(request, [[0, ALL]]);
    const mark = (name, on) => request.post(`${API}/${id}/mark`, { data: { name, date: iso(0), block: 'evening', on } });
    await mark('Ghost', false);
    expect((await (await request.get(`${API}/${id}`)).json()).totalPeople).toBe(0);
    await mark('Marc', true);
    await mark('Sana', true);
    expect((await (await request.get(`${API}/${id}`)).json()).totalPeople).toBe(2);
    await mark('Sana', false);
    const state = await (await request.get(`${API}/${id}`)).json();
    expect(state.totalPeople).toBe(1);
    expect(state.best).toEqual({ date: iso(0), block: 'evening', count: 1 });
  });

  test('page routes serve the app, including both kinds of link', async ({ request }) => {
    const { id, owner } = await apiCreate(request);
    for (const p of [`/dates/${id}`, `/dates/${id}/admin/${owner}`, `/dates/${id}/${owner}`]) {
      const res = await request.get(p);
      expect(res.status(), p).toBe(200);
    }
    expect((await request.get(`${API}/nosuch`)).status()).toBe(404);
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
