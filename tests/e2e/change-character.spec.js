const { test, expect } = require('@playwright/test');
async function custom(page, name) {
  await page.getByTestId('custom-wife').click();
  await page.getByTestId('custom-name').fill(name);
}
async function firstIsCustom(page) {
  expect(await page.locator('bw-wife-picker bw-card').first().getAttribute('data-testid')).toBe('custom-wife');
}

test('poker character changes preserve seat, host and revealed vote, and can be cancelled', async ({ page, request }) => {
  await page.goto('/planning-poker');
  await page.getByTestId('create-btn').click();
  await firstIsCustom(page);
  await page.getByTestId('pick').first().click();
  await page.getByTestId('join-btn').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  const id = page.url().split('/').at(-1), endpoint = '/planning-poker/api/rooms/' + id;
  const seat = await page.evaluate(id => JSON.parse(localStorage.getItem('sbw_seat_' + id)), id);
  await request.post(endpoint + '/vote', { data: { secret: seat.secret, value: '8' } });
  await request.post(endpoint + '/reveal', { data: { secret: seat.secret } });
  await page.getByRole('button', { name: 'Change character', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await page.getByRole('button', { name: 'Change character', exact: true }).click();
  await custom(page, 'New poker character');
  await page.getByRole('button', { name: 'Save character', exact: true }).click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  let data = await (await request.get(endpoint + '/state')).json();
  expect(data.players).toHaveLength(1);
  expect(data.players[0]).toMatchObject({ id: seat.playerId, name: 'New poker character', vote: '8', isHost: true });
  await page.reload();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.getByTestId('boardroom')).toContainText('New poker character');
});

test('poll character remains editable after voting and closing without changing the final ballot', async ({ page, request }) => {
  await page.goto('/poll');
  await page.getByTestId('question-input').fill('Pick one');
  await page.getByTestId('option-input').nth(0).fill('A');
  await page.getByTestId('option-input').nth(1).fill('B');
  await page.getByTestId('create-btn').click();
  await firstIsCustom(page);
  await page.getByTestId('pick').first().click();
  await page.getByTestId('option').first().click();
  await expect(page.getByTestId('tally')).toContainText('your vote is final');
  await page.getByTestId('close-btn').click();
  await page.getByTestId('you-chip').click();
  await custom(page, 'New poll character');
  await page.getByTestId('identity-add-btn').click();
  await expect(page.getByTestId('identity-overlay')).toBeHidden();
  await expect(page.getByTestId('you-chip')).toContainText('New poll character');
  const endpoint = '/poll/api/polls/' + page.url().split('/').at(-1);
  const data = await (await request.get(endpoint)).json();
  expect(data).toMatchObject({ closed: true, totalVotes: 1 });
  expect(data.options[0]).toMatchObject({ count: 1 });
  expect(data.voters[0].name).toBe('New poll character');
  await page.reload();
  await expect(page.getByTestId('you-chip')).toContainText('New poll character');
  await expect(page.getByTestId('option').first()).toHaveClass(/mine/);
});

test('meeting room character changes keep identity across activities and reach other participants live', async ({ page, browser, request }) => {
  await page.goto('/meeting-room');
  await page.getByLabel('Room name').fill('Character changes');
  await page.getByRole('button', { name: 'Create meeting room', exact: true }).click();
  await firstIsCustom(page);
  await page.getByTestId('pick').first().click();
  await page.getByRole('button', { name: 'Join meeting', exact: true }).click();
  await page.getByLabel('Story or question').fill('Story');
  await page.getByRole('button', { name: 'Start activity', exact: true }).click();
  await page.locator('#activity').getByRole('button', { name: '5', exact: true }).click();
  const endpoint = '/meeting-room/api/rooms/' + page.url().split('/').at(-1);
  const before = await (await request.get(endpoint)).json();
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto(page.url());
    await other.getByTestId('pick').first().click();
    await other.getByRole('button', { name: 'Join meeting', exact: true }).click();
    await page.getByRole('button', { name: 'Change character', exact: true }).click();
    await custom(page, 'New meeting character');
    await page.getByRole('button', { name: 'Save character', exact: true }).click();
    await expect(page.locator('#identity')).toBeHidden();
    await expect(other.locator('#members')).toContainText('New meeting character');
    await page.getByRole('button', { name: 'Reveal cards', exact: true }).click();
    const after = await (await request.get(endpoint)).json();
    expect(after.hostId).toBe(before.hostId);
    expect(after.sessions[0].activities[0].results.votes).toEqual([{ name: 'New meeting character', vote: '5' }]);
    await page.reload();
    await expect(page.locator('#members')).toContainText('New meeting character');
  } finally { await otherContext.close(); }
});

test('each new poll asks for a character; returning to that poll restores only its own choice', async ({ page, request }) => {
  const make = async title => (await (await request.post('/poll/api/polls', { data: { question: title, options: ['A', 'B'] } })).json()).id;
  const first = await make('First poll'), second = await make('Second poll');
  // Global selection from older builds must not bypass a new room's join step.
  await page.goto('/poll');
  await page.evaluate(() => localStorage.setItem('bw_poll_identity', JSON.stringify({ name: 'Legacy choice', icon: '💼' })));
  await page.goto('/poll/' + first);
  await expect(page.getByTestId('identity-overlay')).toBeVisible();
  await custom(page, 'First poll character');
  await page.getByTestId('identity-add-btn').click();
  await expect(page.getByTestId('you-chip')).toContainText('First poll character');
  await page.getByTestId('option').first().click();
  await page.goto('/poll/' + second);
  await expect(page.getByTestId('identity-overlay')).toBeVisible();
  await expect(page.getByTestId('option').first()).toBeDisabled();
  await expect(page.getByTestId('saved-pick').filter({ hasText: 'First poll character' })).toBeVisible();
  await page.getByTestId('pick').first().click();
  await expect(page.getByTestId('identity-overlay')).toBeHidden();
  await expect(page.getByTestId('you-chip')).toBeVisible();
  await expect(page.getByTestId('you-chip')).not.toContainText('First poll character');
  await page.goto('/poll/' + first);
  await expect(page.getByTestId('identity-overlay')).toBeHidden();
  await expect(page.getByTestId('you-chip')).toContainText('First poll character');
  await expect(page.getByTestId('option').first()).toHaveClass(/mine/);
  await page.goto('/poll/' + second);
  await expect(page.getByTestId('identity-overlay')).toBeHidden();
  await expect(page.getByTestId('you-chip')).not.toContainText('First poll character');
});

test('poker creator becomes host even when a guest takes a seat first', async ({ page, browser }) => {
  await page.goto('/planning-poker');
  await page.getByTestId('create-btn').click();
  await expect(page.getByTestId('join-screen')).toBeVisible();
  const context = await browser.newContext();
  try {
    const guest = await context.newPage();
    await guest.goto(page.url());
    await guest.getByTestId('pick').first().click();
    await guest.getByTestId('join-btn').click();
    await expect(guest.getByTestId('game-screen')).toBeVisible();
    await expect(guest.getByTestId('host-bar')).toBeHidden();
    await expect(page.getByTestId('pick-taken')).toHaveCount(1);
    await page.getByTestId('pick').first().click();
    await page.getByTestId('join-btn').click();
    await expect(page.getByTestId('host-bar')).toBeVisible();
    await expect(guest.getByTestId('host-bar')).toBeHidden();
    await page.reload();
    await expect(page.getByTestId('host-bar')).toBeVisible();
  } finally { await context.close(); }
});
