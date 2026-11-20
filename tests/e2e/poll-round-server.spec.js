const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { start, tmpDir, stateFile } = require('../support/server');

test('poll rounds require owner and current round, reject stale ballots/close, and survive restart', async () => {
  const dir = tmpDir(); let s = await start(dir);
  try {
    const made = (await s.call('/poll/api/polls', { question: 'Original', options: ['Yes', 'No'] })).data;
    const api = '/poll/api/polls/' + made.id;
    const voterId = 'round-test-voter';
    await s.call(api + '/vote', { voterId, optionId: 'o1', name: 'Participant' });
    const draft = { ownerToken: made.ownerToken, round: 1, question: 'Next', options: ['Later', 'Now'] };
    expect((await s.call(api + '/round', { ...draft, ownerToken: 'wrong' })).status).toBe(403);
    expect((await s.call(api + '/round', { ...draft, question: '' })).status).toBe(400);
    expect((await s.call(api)).data).toMatchObject({ round: 1, totalVotes: 1 });
    const outcomes = await Promise.all([s.call(api + '/round', draft), s.call(api + '/round', draft)]);
    expect(outcomes.map(x => x.status).sort()).toEqual([200, 409]);
    let state = (await s.call(api)).data;
    expect(state).toMatchObject({ round: 2, totalVotes: 0, closed: false, question: 'Next' });
    expect(state.history).toHaveLength(1);
    expect(state.history[0].options[0].count).toBe(1);
    expect(state.identities[0].name).toBe('Participant');
    for (const body of [{ voterId, optionId: 'o1' }, { voterId, optionId: 'o1', round: 1 }]) expect((await s.call(api + '/vote', body)).status).toBe(409);
    expect((await s.call(api + '/close', { ownerToken: made.ownerToken, round: 1 })).status).toBe(409);
    expect((await s.call(api + '/vote', { voterId, optionId: 'o2', round: 2 })).status).toBe(200);
    expect((await s.call(api + '/vote', { voterId, optionId: 'o1', round: 2 })).status).toBe(409);
    await s.stop(); s = await start(dir);
    state = (await s.call(api)).data;
    expect(state).toMatchObject({ round: 2, totalVotes: 1, question: 'Next' });
    expect(state.options[1].count).toBe(1);
    expect(state.history[0]).toMatchObject({ question: 'Original', totalVotes: 1 });
    expect((await s.call(api + '/identity', { voterId, restore: true })).data).toMatchObject({ round: 2, optionId: 'o2' });
    expect(fs.readFileSync(stateFile(dir), 'utf8')).not.toContain(made.ownerToken);
    expect((await s.call(api + '/close', { ownerToken: made.ownerToken, round: 2 })).status).toBe(200);
    expect((await s.call(api + '/round', { ...draft, round: 2 })).status).toBe(200);
    expect((await s.call(api)).data.history).toHaveLength(2);
  } finally { await s.stop(); }
});
