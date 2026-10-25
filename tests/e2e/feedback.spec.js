const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { start, tmpDir, stateFile } = require('../support/server');

async function create(request, votes = 3) {
  const res = await request.post('/feedback/api/sessions', { data: { title: 'Project evaluation', categories: ['Wins', 'Challenges', 'Learning'], votesPerParticipant: votes } });
  expect(res.ok()).toBeTruthy();
  const made = await res.json();
  return { ...made, api: `/feedback/api/sessions/${made.id}` };
}
const post = (request, room, sub, data) => request.post(room.api + sub, { data });
const move = async (request, room, state) => expect((await post(request, room, '/state', { facilitatorToken: room.facilitatorToken, state })).ok()).toBeTruthy();
const get = async (request, room, participantId, facilitatorToken) => (await request.get(room.api, { params: { participantId }, headers: facilitatorToken ? { 'X-Facilitator-Token': facilitatorToken } : {} })).json();
const add = async (request, room, participantId, text, categoryId = 'c1') => {
  const res = await post(request, room, '/items', { participantId, categoryId, text });
  expect(res.ok()).toBeTruthy(); return (await res.json()).item.id;
};

// Inspect the bytes actually delivered, not just what the UI chooses to draw.
async function eventState(url) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5000);
  try {
    const res = await fetch(url, { signal: abort.signal });
    const reader = res.body.getReader(); let text = '';
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    return JSON.parse(text.split('\n').find((line) => line.startsWith('data: ')).slice(6));
  } finally { clearTimeout(timer); abort.abort(); }
}

test('blind HTTP and SSE, hidden totals, facilitator-only state changes and edits', async ({ request, baseURL }) => {
  const r = await create(request), alice = 'alice-device-123', bob = 'bob-device-123';
  const itemId = await add(request, r, alice, 'Private thought');
  await add(request, r, bob, 'Another private thought');
  for (const s of [await get(request, r, bob), await eventState(baseURL + r.api + '/events?participantId=' + bob)]) {
    expect(s.items.map((i) => i.text)).toEqual(['Another private thought']);
    expect(JSON.stringify(s)).not.toContain('Private thought');
    expect(s.items[0]).not.toHaveProperty('author');
    expect(s).not.toHaveProperty('votes');
  }
  expect((await get(request, r, 'observer-123')).items).toEqual([]);
  expect((await request.get('/feedback/api/sessions')).status()).toBe(404);
  for (const state of ['revealed', 'results']) expect((await post(request, r, '/state', { state })).status()).toBe(403);
  expect((await post(request, r, '/items/update', { participantId: bob, itemId, text: 'Stolen' })).status()).toBe(403);
  await move(request, r, 'revealed');
  expect((await post(request, r, '/items', { participantId: alice, categoryId: 'c1', text: 'Late' })).status()).toBe(409);
  expect((await post(request, r, '/items/delete', { participantId: alice, itemId })).status()).toBe(409);
  await move(request, r, 'voting');
  await post(request, r, '/vote', { participantId: alice, itemId, add: true });
  for (const s of [await get(request, r, bob, r.facilitatorToken), await eventState(baseURL + r.api + '/events?participantId=' + bob)]) {
    expect(s.items).toHaveLength(2);
    expect(s.items[0]).not.toHaveProperty('votes');
    expect(s.myVotes).toEqual([]);
    expect(JSON.stringify(s)).not.toContain(alice);
  }
  await move(request, r, 'results');
  expect((await get(request, r, bob)).items.find((i) => i.id === itemId).votes).toBe(1);
});

test('vote budget, idempotence, merge originals, duplicate voters, and backward transitions', async ({ request }) => {
  const r = await create(request, 2), participantId = 'device-voter-123';
  const ids = [];
  for (const text of ['Alpha', 'Beta', 'Gamma']) ids.push(await add(request, r, participantId, text));
  const other = await add(request, r, participantId, 'Other category', 'c2');
  await move(request, r, 'revealed'); await move(request, r, 'voting');
  for (const itemId of ids.slice(0, 2)) expect((await post(request, r, '/vote', { participantId, itemId, add: true })).ok()).toBeTruthy();
  expect((await post(request, r, '/vote', { participantId, itemId: ids[0], add: true })).ok()).toBeTruthy();
  expect((await post(request, r, '/vote', { participantId, itemId: ids[2], add: true })).status()).toBe(409);
  expect((await post(request, r, '/merge', { facilitatorToken: r.facilitatorToken, targetId: ids[0], sourceIds: [other] })).status()).toBe(400);
  expect((await post(request, r, '/merge', { facilitatorToken: r.facilitatorToken, targetId: ids[0], sourceIds: [ids[1], ids[1]] })).ok()).toBeTruthy();
  let s = await get(request, r, participantId);
  expect(s.myVotes).toEqual([ids[0]]); expect(s.remainingVotes).toBe(1);
  expect(s.items[0].mergedFrom).toEqual(['Alpha', 'Beta']);
  await post(request, r, '/items/update', { facilitatorToken: r.facilitatorToken, itemId: ids[0], text: 'Combined' });
  await move(request, r, 'results');
  s = await get(request, r, participantId); expect(s.items[0].votes).toBe(1);
  expect(s.items[0].mergedFrom).toEqual(['Alpha', 'Beta']);
  await move(request, r, 'voting'); await move(request, r, 'revealed'); await move(request, r, 'collecting');
  s = await get(request, r, participantId); expect(s.myVotes).toEqual([ids[0]]); expect(s.items[0]).not.toHaveProperty('votes');
  await move(request, r, 'revealed'); await move(request, r, 'voting');
  await post(request, r, '/vote', { participantId, itemId: ids[0], add: false });
  expect((await get(request, r, participantId)).remainingVotes).toBe(2);
  await post(request, r, '/items/delete', { facilitatorToken: r.facilitatorToken, itemId: ids[0] });
  expect((await get(request, r, participantId)).items).toHaveLength(2);
});

test('mobile eight-person session: create, collect, merge, vote, abstain, export, reopen', async ({ page, browser, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/feedback');
  await page.getByLabel('Session title').fill('Release retrospective');
  for (let i = 1; i <= 3; i++) await page.getByLabel('Question ' + i, { exact: true }).fill(['Wins', 'Challenges', 'Learning'][i - 1]);
  await page.getByRole('button', { name: 'Remove question 4' }).click();
  await page.getByRole('button', { name: 'Create session', exact: true }).click();
  await expect(page).toHaveURL(/\/facilitator$/); // token kept on device, not on screen
  await expect(page.getByRole('heading', { name: 'Collecting', exact: true })).toBeVisible();
  await page.getByText('Share & facilitator link').click();
  const participantLink = await page.getByLabel('Participant link', { exact: true }).inputValue();
  await expect(page.locator('#qr canvas')).toHaveCount(1);
  const contexts = [];
  try {
    const people = [];
    for (let i = 0; i < 8; i++) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); contexts.push(context);
      const p = await context.newPage(); people.push(p); await p.goto(participantLink);
      await expect(p.getByRole('heading', { name: 'Collecting', exact: true })).toBeVisible();
      await p.locator('#draft-c1').fill('Person ' + i + ' feedback');
      await p.locator('[data-submit="c1"]').getByRole('button', { name: 'Add feedback' }).click();
      await expect(p.locator('.item')).toHaveCount(1);
      await expect(p.getByRole('button', { name: 'Reveal feedback' })).toHaveCount(0);
    }
    await expect(page.locator('.item')).toHaveCount(0);
    // Draft survives a live update, and own feedback can be edited/deleted.
    await people[0].locator('#draft-c2').fill('Unsaved draft');
    people[0].once('dialog', (d) => d.accept('Edited feedback'));
    await people[0].getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(people[0].locator('.item p').first()).toHaveText('Edited feedback');
    await expect(people[0].locator('#draft-c2')).toHaveValue('Unsaved draft');
    await page.getByRole('button', { name: 'Reveal feedback', exact: true }).click();
    await expect(people[0].locator('.item')).toHaveCount(8);
    await page.locator('[data-merge-item]').nth(0).check(); await page.locator('[data-merge-item]').nth(1).check();
    await page.getByRole('button', { name: 'Merge selected items' }).click();
    await expect(page.locator('.item')).toHaveCount(7);
    await expect(page.getByText('Original texts (2)')).toBeVisible();
    await page.getByRole('button', { name: 'Open voting', exact: true }).click();
    for (const p of people.slice(0, 7)) {
      await expect(p.getByRole('heading', { name: 'Voting', exact: true })).toBeVisible();
      await p.locator('[data-vote]').first().click();
      await expect(p.locator('#remaining')).toContainText('2 of 3');
    }
    // Eighth person abstains. Facilitator votes too.
    await page.locator('[data-vote]').first().click();
    await expect(page.locator('#remaining')).toContainText('2 of 3');
    await people[0].locator('[data-vote]').first().click();
    await expect(people[0].locator('#remaining')).toContainText('3 of 3');
    await people[0].locator('[data-vote]').nth(1).click();
    await expect(people[0].locator('#remaining')).toContainText('2 of 3');
    await expect(people[0].locator('.vote-total')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close voting & show results', exact: true }).click();
    await expect(people[7].getByRole('heading', { name: 'Results', exact: true })).toBeVisible();
    await expect(people[7].locator('.vote-total').first()).toContainText('7 votes');
    await expect(page.locator('#markdown')).toHaveValue(/## Overall ranking/);
    await expect(page.locator('#markdown')).toHaveValue(/Original: Edited feedback/);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
    await page.getByRole('button', { name: 'Copy Markdown', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('# Release retrospective');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Markdown' }).click();
    expect((await download).suggestedFilename()).toMatch(/feedback-.*\.md/);
    await page.getByLabel('Item order').selectOption('original');
    await page.reload(); await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reopen voting', exact: true }).click();
    await expect(people[7].getByRole('heading', { name: 'Voting', exact: true })).toBeVisible();
    await expect(people[7].locator('.vote-total')).toHaveCount(0);
    await page.goto('/feedback'); await page.getByRole('link', { name: 'Release retrospective' }).click();
    await expect(page.getByRole('button', { name: 'Close voting & show results' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await Promise.all(contexts.map((c) => c.close())); }
});

test('the facilitator token never travels in a URL', async ({ page, request }) => {
  const r = await create(request);
  const urls = [];
  page.on('request', (req) => urls.push(req.url()));
  await page.goto(`/feedback/${r.id}/facilitator#token=${encodeURIComponent(r.facilitatorToken)}`);
  await expect(page.locator('#connection')).toHaveText('Live · connected');
  await expect(page.getByRole('button', { name: 'Reveal feedback', exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/feedback/${r.id}/facilitator$`));
  // A live update keeps the facilitator controls even though the stream is anonymous.
  await page.locator('#draft-c1').fill('From the facilitator');
  await page.locator('[data-submit="c1"]').getByRole('button', { name: 'Add feedback' }).click();
  await expect(page.locator('.item')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Reveal feedback', exact: true })).toBeVisible();
  expect(urls.filter((u) => u.includes(r.facilitatorToken))).toEqual([]);
  // Reopening from history works without the fragment (token kept on this device).
  await page.goto(`/feedback/${r.id}/facilitator`);
  await expect(page.getByRole('button', { name: 'Reveal feedback', exact: true })).toBeVisible();
});

test('automatic SSE reconnection keeps drafts and catches up after offline', async ({ page, context, request }) => {
  const r = await create(request); await page.goto('/feedback/' + r.id);
  await expect(page.locator('#connection')).toHaveText('Live · connected');
  await page.locator('#draft-c1').fill('Draft while offline');
  await context.setOffline(true);
  await move(request, r, 'revealed');
  await context.setOffline(false);
  await expect(page.getByRole('heading', { name: 'Revealed', exact: true })).toBeVisible({ timeout: 20000 });
  await move(request, r, 'collecting');
  await expect(page.locator('#draft-c1')).toHaveValue('Draft while offline');
});

test('feedback persists through restart and live clients reconnect with hashed capabilities', async ({ browser }) => {
  const dir = tmpDir();
  let s, context;
  const api = (p = '') => '/feedback/api/sessions' + p;
  try {
    s = await start(dir);
    const r = (await s.call(api(), { title: 'Persistent feedback', categories: ['Wins'] })).data;
    const participantId = 'persistent-device-123';
    const item = (await s.call(api('/' + r.id + '/items'), { participantId, categoryId: 'c1', text: 'Keep this' })).data;
    for (const state of ['revealed', 'voting']) await s.call(api('/' + r.id + '/state'), { facilitatorToken: r.facilitatorToken, state });
    await s.call(api('/' + r.id + '/vote'), { participantId, itemId: item.item.id, add: true });
    await s.call(api('/' + r.id + '/state'), { facilitatorToken: r.facilitatorToken, state: 'results' });
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${s.base}/feedback/${r.id}`);
    await expect(page.locator('#connection')).toHaveText('Live · connected');
    const port = s.port;
    await s.stop();
    await expect(page.locator('#connection')).toContainText('reconnecting automatically');
    const raw = fs.readFileSync(stateFile(dir), 'utf8');
    expect(raw).not.toContain(r.facilitatorToken); expect(raw).not.toContain(participantId);
    s = await start(dir, port);
    const got = (await s.call(api('/' + r.id + '?participantId=' + participantId), undefined, { 'X-Facilitator-Token': r.facilitatorToken })).data;
    expect(got.state).toBe('results'); expect(got.facilitator).toBe(true); expect(got.items[0].votes).toBe(1); expect(got.myVotes).toEqual([item.item.id]);
    await s.call(api('/' + r.id + '/state'), { facilitatorToken: r.facilitatorToken, state: 'voting' });
    await expect(page.getByRole('heading', { name: 'Voting', exact: true })).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#connection')).toHaveText('Live · connected');
  } finally { if (context) await context.close(); if (s) await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
