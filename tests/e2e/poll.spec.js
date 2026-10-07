const { test, expect } = require('@playwright/test');

const POLL = '/poll';
const CODE_RE = /\/poll\/([a-z0-9]{6})/;

function unique(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 7);
}

async function createPoll(page, question, options) {
  await page.goto(POLL);
  await expect(page.getByTestId('lobby-screen')).toBeVisible();
  await page.getByTestId('question-input').fill(question);
  const inputs = page.getByTestId('option-input');
  await inputs.nth(0).fill(options[0]);
  await inputs.nth(1).fill(options[1]);
  for (let i = 2; i < options.length; i++) {
    await page.getByTestId('add-option-btn').click();
    await inputs.nth(i).fill(options[i]);
  }
  await page.getByTestId('create-btn').click();
  await expect(page).toHaveURL(new RegExp(CODE_RE.source));
  await expect(page.getByTestId('poll-screen')).toBeVisible();
  await expect(page.getByTestId('share-url')).toHaveValue(CODE_RE);
  return page.url();
}

test.describe('Hub', () => {
  test('homepage lists the Poll app', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: /Poll/i })).toHaveAttribute('href', '/poll');
  });
});

test.describe('Poll — lobby', () => {
  test('create needs a question and two options', async ({ page }) => {
    await page.goto(POLL);
    await expect(page.getByTestId('lobby-screen')).toBeVisible();
    await page.getByTestId('create-btn').click();
    await expect(page.getByTestId('create-error')).toContainText(/question/i);

    await page.getByTestId('question-input').fill('Tacos or pizza?');
    await page.getByTestId('create-btn').click();
    await expect(page.getByTestId('create-error')).toContainText(/2 options/i);
    await expect(page).not.toHaveURL(CODE_RE);
  });

  test('option list caps at eight', async ({ page }) => {
    await page.goto(POLL);
    const add = page.getByTestId('add-option-btn');
    for (let i = 0; i < 6; i++) await add.click();
    await expect(page.getByTestId('option-input')).toHaveCount(8);
    await expect(add).toBeDisabled();
    await expect(add).toContainText(/8 options max/i);
  });

  test('joining an unknown code reports it', async ({ page }) => {
    await page.goto(POLL);
    await page.getByTestId('join-code').fill('zz99zz');
    await page.getByTestId('join-btn').click();
    await expect(page.getByTestId('join-error')).toContainText(/not found/i);
    await expect(page.getByTestId('lobby-screen')).toBeVisible();
  });
});

test.describe('Poll — voting', () => {
  test('creator can open a poll and sees the share link', async ({ page }) => {
    const url = await createPoll(page, 'Where is the offsite?', ['Coast', 'Ardennes']);
    expect(url).toMatch(CODE_RE);
    await expect(page.getByTestId('poll-question')).toHaveText('Where is the offsite?');
    await expect(page.getByTestId('option')).toHaveCount(2);
    await expect(page.getByTestId('tally')).toContainText(/vote to see the split/i);
    await expect(page.getByTestId('close-btn')).toBeVisible();
  });

  test('results stay hidden until you vote', async ({ page }) => {
    const url = await createPoll(page, 'Ship on Friday?', ['Yes', 'No']);
    await expect(page.getByTestId('option-count').first()).toHaveText('');
    await page.getByTestId('option').filter({ hasText: 'Yes' }).first().click();
    await expect(page.getByTestId('option-count').first()).toContainText('1');
    await expect(page.getByTestId('tally')).toContainText(/^1 vote\b/);
  });

  test('votes from a second device arrive live', async ({ page, context }) => {
    const url = await createPoll(page, 'Pick a date', ['March', 'April', 'May']);
    await page.getByTestId('option').filter({ hasText: 'March' }).first().click();
    const other = await context.newPage();
    await other.goto(url);
    await expect(other.getByTestId('poll-question')).toHaveText('Pick a date');
    await other.getByTestId('option').filter({ hasText: 'April' }).first().click();
    await expect(other.getByTestId('option').filter({ hasText: 'April' }).first()).toHaveClass(/mine/);

    // creator sees the tally move without reloading
    await expect(page.getByTestId('tally')).toContainText(/^2 votes/);
    const april = page.getByTestId('option').filter({ hasText: 'April' }).first();
    await expect(april.getByTestId('option-count')).toContainText('1');
    await other.close();
  });

  test('one vote per voter, but changeable while open', async ({ page }) => {
    const url = await createPoll(page, 'Change my mind', ['Tabs', 'Spaces']);
    await page.getByTestId('option').filter({ hasText: 'Tabs' }).first().click();
    await expect(page.getByTestId('tally')).toContainText(/^1 vote\b/);
    // switching sides does not add a second vote
    await page.getByTestId('option').filter({ hasText: 'Spaces' }).first().click();
    await expect(page.getByTestId('tally')).toContainText(/^1 vote\b/);
    await expect(page.getByTestId('option').filter({ hasText: 'Spaces' }).first()).toHaveClass(/mine/);
    await expect(page.getByTestId('option').filter({ hasText: 'Tabs' }).first()).not.toHaveClass(/mine/);
    // and the choice survives a reload
    await page.goto(url);
    await expect(page.getByTestId('option').filter({ hasText: 'Spaces' }).first()).toHaveClass(/mine/);
    await expect(page.getByTestId('tally')).toContainText(/^1 vote\b/);
  });
});

test.describe('Poll — closing', () => {
  test('creator closes the poll and voting locks', async ({ page, context }) => {
    const url = await createPoll(page, 'Final question', ['Left', 'Right']);
    const other = await context.newPage();
    await other.goto(url);
    await other.getByTestId('option').filter({ hasText: 'Left' }).first().click();

    await page.getByTestId('close-btn').click();
    await expect(page.getByTestId('closed-banner')).toBeVisible();
    await expect(page.getByTestId('close-btn')).toBeHidden();
    await expect(page.getByTestId('option').first()).toBeDisabled();

    // voter gets the closed state live
    await expect(other.getByTestId('closed-banner')).toBeVisible();
    await expect(other.getByTestId('option').first()).toBeDisabled();
    await expect(other.getByTestId('tally')).toContainText(/^1 vote\b/);
    await other.close();
  });

  test('a closed poll rejects late votes', async ({ request }) => {
    const created = await request.post('/poll/api/polls', {
      data: { question: 'API poll', options: ['A', 'B'] },
    });
    expect(created.ok()).toBeTruthy();
    const { id } = await created.json();
    const voter = 'apivoter' + Math.random().toString(36).slice(2, 10);

    const vote = await request.post(`/poll/api/polls/${id}/vote`, {
      data: { voterId: voter, optionId: 'o1' },
    });
    expect(vote.ok()).toBeTruthy();

    const state = await (await request.get(`/poll/api/polls/${id}`)).json();
    expect(state.totalVotes).toBe(1);
    expect(state.options.find(o => o.id === 'o1').count).toBe(1);

    const bad = await request.post(`/poll/api/polls/${id}/vote`, {
      data: { voterId: voter, optionId: 'nope' },
    });
    expect(bad.status()).toBe(400);
  });
});
