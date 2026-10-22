const { test, expect } = require('@playwright/test');

const POLL = '/poll';
const CODE_RE = /\/poll\/([a-z0-9]{6})/;

function unique(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 7);
}

async function pickIdentity(page) {
  const overlay = page.getByTestId('identity-overlay');
  // A shared device identity may be taken by another participant in this poll.
  await expect.poll(async () => await overlay.isVisible() || await page.getByTestId('option').first().isEnabled()).toBe(true);
  if (await overlay.isVisible()) {
    await page.getByTestId('identity-picker').getByTestId('pick').first().click();
    await expect(overlay).toBeHidden();
  }
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
  await pickIdentity(page);
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
    await pickIdentity(other);
    await other.getByTestId('option').filter({ hasText: 'April' }).first().click();
    await expect(other.getByTestId('option').filter({ hasText: 'April' }).first()).toHaveClass(/mine/);

    // creator sees the tally move without reloading
    await expect(page.getByTestId('tally')).toContainText(/^2 votes/);
    const april = page.getByTestId('option').filter({ hasText: 'April' }).first();
    await expect(april.getByTestId('option-count')).toContainText('1');
    await other.close();
  });

  test('seeing results locks the choice, including after reload and direct API changes', async ({ page, request }) => {
    const url = await createPoll(page, 'Final answer', ['Tabs', 'Spaces']);
    const tabs = page.getByTestId('option').filter({ hasText: 'Tabs' }).first();
    const spaces = page.getByTestId('option').filter({ hasText: 'Spaces' }).first();
    await tabs.click();
    await expect(page.getByTestId('tally')).toContainText('your vote is final');
    await expect(tabs).toHaveClass(/mine/);
    await expect(spaces).toBeDisabled();
    await expect(page.getByTestId('you-chip')).toBeDisabled();
    const voterId = await page.evaluate(() => sessionStorage.getItem('bw_poll_voter'));
    const id = url.match(CODE_RE)[1];
    const change = await request.post(`/poll/api/polls/${id}/vote`, { data: { voterId, optionId: 'o2' } });
    expect(change.status()).toBe(409);
    await page.goto(url);
    await expect(tabs).toHaveClass(/mine/);
    await expect(spaces).toBeDisabled();
    await expect(page.getByTestId('tally')).toContainText(/^1 vote\b/);
    // Even a stale client that lost its local choice cannot switch sides.
    await page.evaluate((id) => sessionStorage.removeItem('bw_poll_vote_' + id), id);
    await page.reload();
    await expect(tabs).toHaveClass(/mine/);
    await expect(spaces).toBeDisabled();
    await expect(page.getByTestId('tally')).toContainText('your vote is final');
  });
});

test.describe('Poll — identity', () => {
  test('the picker gates the poll and the chip shows the choice', async ({ page }) => {
    await createPoll(page, 'Lunch?', ['Croissant', 'Sandwich']);
    await expect(page.getByTestId('you-chip')).toContainText('Vivienne');
    await page.getByTestId('option').filter({ hasText: 'Croissant' }).first().click();
    await expect(page.getByTestId('option-voters').first()).toBeVisible();
    await expect(page.getByTestId('tally')).toContainText('Vivienne have voted');
  });

  test('identity is remembered on this device', async ({ page }) => {
    const url = await createPoll(page, 'Reload check', ['A', 'B']);
    await page.goto(url);
    await expect(page.getByTestId('identity-overlay')).toBeHidden();
    await expect(page.getByTestId('you-chip')).toContainText('Vivienne');
  });

  test('add your own saves a custom wife', async ({ page }) => {
    await createPoll(page, 'Custom check', ['A', 'B']);
    await page.getByTestId('you-chip').click();
    await page.getByTestId('custom-wife').click();
    await page.getByTestId('custom-name').fill('Francine');
    await page.getByTestId('identity-add-btn').click();
    await expect(page.getByTestId('identity-overlay')).toBeHidden();
    await expect(page.getByTestId('you-chip')).toContainText('Francine');
    // she is offered again next visit
    await page.getByTestId('you-chip').click();
    await expect(page.getByTestId('saved-pick').first()).toContainText('Francine');
  });
});

test.describe('Poll — closing', () => {
  test('creator closes the poll and voting locks', async ({ page, context }) => {
    const url = await createPoll(page, 'Final question', ['Left', 'Right']);
    const other = await context.newPage();
    await other.goto(url);
    await pickIdentity(other);
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

test.describe('Poll — ownership and limits', () => {
  const API = '/poll/api/polls';
  const voter = () => 'v' + Math.random().toString(36).slice(2, 12);

  async function make(request) {
    const res = await request.post(API, { data: { question: 'Owned?', options: ['A', 'B'] } });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ownerToken).toBeTruthy();
    return body;
  }

  test('only the owner token closes a poll; voting first does not make you owner', async ({ request }) => {
    const { id, ownerToken } = await make(request);
    const v = voter();
    expect((await request.post(`${API}/${id}/vote`, { data: { voterId: v, optionId: 'o1' } })).ok()).toBeTruthy();
    expect((await request.post(`${API}/${id}/close`, { data: { voterId: v } })).status()).toBe(403);
    expect((await request.post(`${API}/${id}/close`, { data: { ownerToken: v } })).status()).toBe(403);
    expect((await request.post(`${API}/${id}/close`, { data: {} })).status()).toBe(403);
    expect((await request.post(`${API}/${id}/close`, { data: { ownerToken } })).ok()).toBeTruthy();
    expect((await (await request.get(`${API}/${id}`)).json()).closed).toBe(true);
  });

  test('state never shows the owner token', async ({ request }) => {
    const { id, ownerToken } = await make(request);
    expect(await (await request.get(`${API}/${id}`)).text()).not.toContain(ownerToken);
  });

  test('a poll takes at most 64 voters; existing ballots stay final', async ({ request }) => {
    const { id } = await make(request);
    const first = voter();
    await request.post(`${API}/${id}/vote`, { data: { voterId: first, optionId: 'o1' } });
    for (let i = 1; i < 64; i++) {
      expect((await request.post(`${API}/${id}/vote`, { data: { voterId: voter(), optionId: 'o1' } })).ok()).toBeTruthy();
    }
    expect((await request.post(`${API}/${id}/vote`, { data: { voterId: voter(), optionId: 'o2' } })).status()).toBe(409);
    expect((await request.post(`${API}/${id}/vote`, { data: { voterId: first, optionId: 'o2' } })).status()).toBe(409);
    expect((await request.post(`${API}/${id}/vote`, { data: { voterId: first, optionId: 'o1' } })).ok()).toBeTruthy();
    expect((await (await request.get(`${API}/${id}`)).json()).totalVotes).toBe(64);
  });

  test('vote pictures: portraits and small uploads only', async ({ request }) => {
    const { id } = await make(request);
    const vote = (icon) => request.post(`${API}/${id}/vote`, { data: { voterId: voter(), optionId: 'o1', name: voter(), icon } });
    expect((await vote('/img/hr.png')).ok()).toBeTruthy();
    expect((await vote('💼')).ok()).toBeTruthy();
    expect((await vote('data:image/png;base64,' + 'A'.repeat(1000))).ok()).toBeTruthy();
    expect((await vote('https://tracker.example/pixel.png')).status()).toBe(400);
    expect((await vote('data:image/png;base64,' + 'A'.repeat(30000))).status()).toBe(400);
    expect((await vote('/img/../../etc/passwd')).status()).toBe(400);
  });
});


test('concurrent ballots accept only the first, and retries cannot rewrite its wife', async ({ request }) => {
  const { id } = await (await request.post('/poll/api/polls', { data: { question: 'Race?', options: ['A', 'B'] } })).json();
  const endpoint = `/poll/api/polls/${id}/vote`;
  const votes = await Promise.all(['o1', 'o2'].map(optionId => request.post(endpoint, {
    data: { voterId: 'racing-voter', optionId, name: 'Original wife', icon: '/img/hr.png' },
  })));
  expect(votes.map(r => r.status()).sort()).toEqual([200, 409]);
  const before = await (await request.get(`/poll/api/polls/${id}`)).json();
  const optionId = before.options.find(o => o.count === 1).id;
  expect((await request.post(endpoint, { data: { voterId: 'racing-voter', optionId, name: 'Replacement' } })).status()).toBe(200);
  expect(await (await request.get(`/poll/api/polls/${id}`)).json()).toEqual(before);
});

test('a selected wife is taken live before voting, and another device must choose somebody else', async ({ page, browser }) => {
  const url = await createPoll(page, 'One wife per participant', ['A', 'B']);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto(url);
    await expect(other.getByTestId('identity-overlay')).toBeVisible();
    await expect(other.getByTestId('pick-taken')).toHaveCount(1);
    await expect(other.getByTestId('pick-taken')).toContainText('Vivienne');
    await other.getByTestId('pick-taken').click();
    await expect(other.getByTestId('identity-overlay')).toBeVisible();
    await other.getByTestId('pick').first().click();
    await expect(other.getByTestId('identity-overlay')).toBeHidden();
    await expect(other.getByTestId('you-chip')).not.toContainText('Vivienne');
    await page.getByTestId('you-chip').click();
    await expect(page.getByTestId('pick-taken')).toHaveCount(1);
    await expect(page.getByTestId('pick-taken')).not.toContainText('Vivienne');
    await page.getByTestId('pick').first().click();
    await page.getByTestId('option').first().click();
    await other.getByTestId('option').last().click();
    await expect(page.getByTestId('tally')).toContainText(/^2 votes/);
  } finally { await otherContext.close(); }
});

test('wife reservation races, direct votes, switching and per-poll scope are enforced by the server', async ({ request }) => {
  const make = async () => (await (await request.post('/poll/api/polls', { data: { question: 'Unique?', options: ['A', 'B'] } })).json()).id;
  const id = await make();
  const claim = (poll, voterId, name) => request.post(`/poll/api/polls/${poll}/identity`, { data: { voterId, name, icon: '/img/hr.png' } });
  const first = 'claim-first', second = 'claim-second';
  const responses = await Promise.all([claim(id, first, 'Nova'), claim(id, second, 'NOVA')]);
  expect(responses.map(r => r.status()).sort()).toEqual([200, 409]);
  const winner = responses[0].ok() ? first : second;
  const loser = winner === first ? second : first;
  expect((await request.post(`/poll/api/polls/${id}/vote`, { data: { voterId: loser, optionId: 'o1', name: 'nova' } })).status()).toBe(409);
  expect((await claim(id, winner, 'Another wife')).status()).toBe(200);
  expect((await claim(id, loser, 'Nova')).status()).toBe(200); // released old reservation
  expect((await claim(await make(), 'third-voter', 'Nova')).status()).toBe(200); // another poll
  await request.post(`/poll/api/polls/${id}/vote`, { data: { voterId: loser, optionId: 'o1', name: 'Spoofed wife' } });
  await claim(id, loser, 'Changed after voting');
  const state = await (await request.get(`/poll/api/polls/${id}`)).json();
  expect(state.voters[0].name.toLowerCase()).toBe('nova');
  expect(state.identities.map(i => i.name.toLowerCase()).sort()).toEqual(['another wife', 'nova']);
});
