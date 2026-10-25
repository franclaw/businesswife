// Server safety rails: the per-IP create limit, feedback expiry, and no 500s
// for hostile input. Each spec runs its own private server.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { start, tmpDir, stateFile, DAY } = require('../support/server');

test.describe('Server rails', () => {
  test('create endpoints are rate limited per client, across apps', async () => {
    const s = await start(tmpDir(), undefined, { BW_RATE_LIMIT: '4' });
    const from = (ip) => ({ 'X-Forwarded-For': ip });
    const creates = [
      ['/planning-poker/api/rooms', {}],
      ['/poll/api/polls', { question: 'Q?', options: ['A', 'B'] }],
      ['/feedback/api/sessions', { title: 'Retro', categories: ['Well?'] }],
      ['/api/rooms', {}],
    ];
    for (const [p, body] of creates) expect((await s.call(p, body, from('203.0.113.7'))).status, p).toBe(200);
    const res = await fetch(s.base + '/dates/api/picks', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...from('203.0.113.7') }, body: '{}',
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await res.json()).error).toMatch(/Too many/);
    // Another client is unaffected, and so is everything that is not a create.
    expect((await s.call('/planning-poker/api/rooms', {}, from('198.51.100.2'))).status).toBe(200);
    const { id } = (await s.call('/poll/api/polls', { question: 'Q?', options: ['A', 'B'] }, from('198.51.100.2'))).data;
    for (let i = 0; i < 6; i++) {
      expect((await s.call(`/poll/api/polls/${id}/vote`, { voterId: 'ratelimit-voter-' + i, optionId: 'o1' }, from('203.0.113.7'))).status).toBe(200);
    }
    await s.stop();
  });

  test('feedback sessions expire after 60 idle days', async () => {
    const dir = tmpDir();
    const t = Date.now();
    const session = (id, idleDays) => ({ id, title: id, description: '', categories: [{ id: 'c1', label: 'Q' }], votesPerParticipant: 3, state: 'collecting', items: [], votes: [], facilitatorHash: null, createdAt: t - idleDays * DAY, updatedAt: t - idleDays * DAY });
    fs.writeFileSync(stateFile(dir), JSON.stringify({ version: 1, feedback: [session('fb0061', 61), session('fb0059', 59)] }));
    const s = await start(dir);
    expect((await s.call('/feedback/api/sessions/fb0061')).status).toBe(404);
    expect((await s.call('/feedback/api/sessions/fb0059')).status).toBe(200);
    await s.stop();
  });

  test('hostile bodies get 4xx answers, never a 500', async () => {
    const s = await start(tmpDir());
    const room = (await s.call('/planning-poker/api/rooms', {})).data.id;
    const poll = (await s.call('/poll/api/polls', { question: 'Q?', options: ['A', 'B'] })).data.id;
    const pick = (await s.call('/dates/api/picks', { title: 'T', days: [{ date: new Date(Date.now() + DAY).toISOString().slice(0, 10), blocks: ['evening'] }] })).data.id;
    const fb = (await s.call('/feedback/api/sessions', { title: 'T', categories: ['Q'] })).data.id;
    const paths = [
      '/planning-poker/api/rooms', `/planning-poker/api/rooms/${room}/join`, `/planning-poker/api/rooms/${room}/vote`,
      `/planning-poker/api/rooms/${room}/question`, `/planning-poker/api/rooms/${room}/kick`,
      '/poll/api/polls', `/poll/api/polls/${poll}/vote`, `/poll/api/polls/${poll}/identity`, `/poll/api/polls/${poll}/close`,
      '/dates/api/picks', `/dates/api/picks/${pick}/mark`, `/dates/api/picks/${pick}/none`, `/dates/api/picks/${pick}/lock`,
      `/dates/api/picks/${pick}/unlock`, `/dates/api/picks/${pick}/choose`, `/dates/api/picks/${pick}/dates`,
      '/feedback/api/sessions', `/feedback/api/sessions/${fb}/items`, `/feedback/api/sessions/${fb}/vote`,
      `/feedback/api/sessions/${fb}/merge`, `/feedback/api/sessions/${fb}/state`, `/feedback/api/sessions/${fb}/items/update`,
    ];
    const weird = [null, 0, [], 'x', { '__proto__': { a: 1 } }];
    const bodies = [
      '', 'not json', '[]', '"str"', '123',
      ...['name', 'icon', 'value', 'question', 'options', 'voterId', 'optionId', 'title', 'days', 'date', 'block', 'categories', 'itemId', 'text', 'state', 'sourceIds', 'targetId', 'participantId', 'secret', 'token', 'ownerToken', 'subtitle']
        .flatMap((k) => weird.map((v) => JSON.stringify({ [k]: v, secret: 1, participantId: 'fuzzparticipant1', voterId: 'fuzzvoter-12345' }))),
    ];
    for (const p of paths) {
      for (const body of bodies) {
        const res = await fetch(s.base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        expect(res.status, `${p} ${body}`).toBeLessThan(500);
      }
    }
    expect(s.log()).not.toMatch(/failed:/);
    await s.stop();
  });
});
