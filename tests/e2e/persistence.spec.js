// Polls, date picks and poker rooms survive a restart. These specs start their own server
// on a spare port with a throwaway data directory, so they never touch
// BASE_URL (and never the live site).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { start, tmpDir, stateFile, iso, DAY } = require('../support/server');

test.describe('Persistence', () => {
  test('date picks and polls survive a restart, links included', async () => {
    const dir = tmpDir();
    let s = await start(dir);
    const created = await s.call('/dates/api/picks', { title: 'Launch dinner', days: [{ date: iso(2), blocks: ['evening'] }] });
    const { id, ownerToken } = created.data;
    await s.call(`/dates/api/picks/${id}/mark`, { name: 'Marc', date: iso(2), block: 'evening', on: true });
    await s.call(`/dates/api/picks/${id}/none`, { name: 'Joost', on: true });
    const lock = await s.call(`/dates/api/picks/${id}/lock`, { name: 'Marc' });
    const personKey = lock.data.token;
    const voter = 'voter-persist-1234';
    const pollMade = (await s.call('/poll/api/polls', { question: 'Lunch?', options: ['Yes', 'No'] })).data;
    const poll = pollMade.id;
    await s.call(`/poll/api/polls/${poll}/identity`, { voterId: 'unvoted-persist-voter', name: 'Reserved before voting' });
    await s.call(`/poll/api/polls/${poll}/vote`, { voterId: voter, optionId: 'o1', name: 'Persisted wife' });
    await s.stop();

    // Only hashes of the secrets are on disk.
    const raw = fs.readFileSync(stateFile(dir), 'utf8');
    expect(raw).toContain('Launch dinner');
    for (const secret of [ownerToken, personKey, voter]) expect(raw).not.toContain(secret);
    expect(fs.statSync(stateFile(dir)).mode & 0o077).toBe(0);

    s = await start(dir);
    const state = (await s.call(`/dates/api/picks/${id}`)).data;
    expect(state.title).toBe('Launch dinner');
    expect(state.totalPeople).toBe(2);
    expect(state.people.find((p) => p.name === 'Marc')).toMatchObject({ locked: true, count: 1 });
    expect(state.people.find((p) => p.name === 'Joost')).toMatchObject({ none: true });
    expect((await s.call(`/dates/api/picks/${id}/who?token=${ownerToken}`)).data.role).toBe('admin');
    expect((await s.call(`/dates/api/picks/${id}/who?token=${personKey}`)).data).toMatchObject({ role: 'person', name: 'Marc' });
    expect((await s.call(`/dates/api/picks/${id}/mark`, { name: 'Marc', date: iso(2), block: 'evening', on: false })).status).toBe(423);

    expect((await s.call(`/poll/api/polls/${poll}`)).data.totalVotes).toBe(1);
    expect((await s.call(`/poll/api/polls/${poll}/vote`, { voterId: voter, optionId: 'o2' })).status).toBe(409);
    expect((await s.call(`/poll/api/polls/${poll}`)).data.options[0].count).toBe(1);
    expect((await s.call(`/poll/api/polls/${poll}/identity`, { voterId: 'other-persist-voter', name: 'Persisted wife' })).status).toBe(409);
    expect((await s.call(`/poll/api/polls/${poll}/identity`, { voterId: 'other-persist-voter', name: 'Reserved before voting' })).status).toBe(409);
    expect((await s.call(`/poll/api/polls/${poll}/close`, { ownerToken: 'someone-else-1234' })).status).toBe(403);
    expect((await s.call(`/poll/api/polls/${poll}/close`, { ownerToken: pollMade.ownerToken })).status).toBe(200);
    await s.stop();
  });

  test('a change is on disk within seconds, even after a hard kill', async () => {
    const dir = tmpDir();
    let s = await start(dir);
    const { id } = (await s.call('/dates/api/picks', { title: 'Crash test', days: [{ date: iso(1), blocks: ['morning'] }] })).data;
    await expect.poll(() => fs.existsSync(stateFile(dir)) && fs.readFileSync(stateFile(dir), 'utf8').includes(id), { timeout: 5_000 }).toBe(true);
    await s.stop('SIGKILL');
    s = await start(dir);
    expect((await s.call(`/dates/api/picks/${id}`)).status).toBe(200);
    // No temp files are left behind.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    await s.stop();
  });

  test('expired picks and polls are not brought back', async () => {
    const dir = tmpDir();
    const t = Date.now();
    const pick = (id, updatedAgo, chosen) => ({
      id, title: id, slots: [{ date: iso(-20), block: 'evening' }, { date: iso(-10), block: 'evening' }],
      people: [], ownerHash: null, closed: !!chosen, chosen: chosen || null,
      createdAt: t - 70 * DAY, updatedAt: t - updatedAgo * DAY,
    });
    fs.writeFileSync(stateFile(dir), JSON.stringify({
      version: 1,
      dates: [
        pick('idle61', 61),                              // 60 days idle: gone
        pick('idle59', 59),                              // still inside 60 days
        pick('setold', 15, `${iso(-20)}|evening`),       // set date 20 days ago: gone
        pick('setnew', 15, `${iso(-10)}|evening`),       // set date 10 days ago: kept
      ],
      polls: [
        { id: 'poll61', question: 'Q', options: [{ id: 'o1', label: 'A' }], votes: [], closed: false, createdAt: t - 61 * DAY, updatedAt: t - 61 * DAY },
        { id: 'poll01', question: 'Q', options: [{ id: 'o1', label: 'A' }], votes: [], closed: false, createdAt: t - DAY, updatedAt: t - DAY },
      ],
    }));
    const s = await start(dir);
    const status = async (p) => (await s.call(p)).status;
    expect(await status('/dates/api/picks/idle61')).toBe(404);
    expect(await status('/dates/api/picks/idle59')).toBe(200);
    expect(await status('/dates/api/picks/setold')).toBe(404);
    expect(await status('/dates/api/picks/setnew')).toBe(200);
    expect(await status('/poll/api/polls/poll61')).toBe(404);
    expect(await status('/poll/api/polls/poll01')).toBe(200);

    // The lifetime is reported: 60 days after the last change, or two weeks after the set date.
    const idle = (await s.call('/dates/api/picks/idle59')).data;
    expect(Math.round((Date.parse(idle.expiresAt) - t) / DAY)).toBe(1);
    const set = (await s.call('/dates/api/picks/setnew')).data;
    expect(set.expiresAt.slice(0, 10)).toBe(iso(4));
    await s.stop();
  });

  test('a fresh pick reports 60 days, and the data file is never served', async () => {
    const dir = tmpDir();
    const s = await start(dir);
    const { id } = (await s.call('/dates/api/picks', { title: 'Lifetime', days: [{ date: iso(1), blocks: ['evening'] }] })).data;
    const state = (await s.call(`/dates/api/picks/${id}`)).data;
    expect(Math.round((Date.parse(state.expiresAt) - Date.now()) / DAY)).toBe(60);
    for (const p of ['/data/state.json', '/state.json', '/dates/../data/state.json', '/dates/icons/../../data/state.json']) {
      const res = await fetch(s.base + p);
      expect(res.status, p).not.toBe(200);
    }
    await s.stop();
  });

  test('an unreadable data file is set aside, not fatal', async () => {
    const dir = tmpDir();
    fs.writeFileSync(stateFile(dir), '{ not json');
    const s = await start(dir);
    expect((await s.call('/dates/api/picks/abcdef')).status).toBe(404);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
    await s.stop();
  });

  test('poker rooms survive a restart: round, story, votes, history and seats', async () => {
    const dir = tmpDir();
    let s = await start(dir);
    const API = '/planning-poker/api/rooms';
    const { id } = (await s.call(API, { title: 'Sprint 42 refinement' })).data;
    const host = (await s.call(`${API}/${id}/join`, { name: 'The Executive', icon: '💼' })).data;
    const guest = (await s.call(`${API}/${id}/join`, { name: 'The Closer', icon: '👠' })).data;
    const as = (seat) => ({ 'X-Seat-Secret': seat.secret });
    await s.call(`${API}/${id}/question`, { question: 'PROJ-1 Login' }, as(host));
    await s.call(`${API}/${id}/vote`, { value: '5' }, as(host));
    await s.call(`${API}/${id}/vote`, { value: '8' }, as(guest));
    await s.call(`${API}/${id}/reveal`, {}, as(guest));
    await s.call(`${API}/${id}/next`, {}, as(host));
    await s.call(`${API}/${id}/question`, { question: 'PROJ-2 Export' }, as(host));
    await s.call(`${API}/${id}/vote`, { value: '3' }, as(guest));
    await s.stop();

    const raw = fs.readFileSync(stateFile(dir), 'utf8');
    expect(raw).toContain('Sprint 42 refinement');
    for (const secret of [host.secret, guest.secret]) expect(raw).not.toContain(secret);

    s = await start(dir);
    const state = (await s.call(`${API}/${id}/state`)).data;
    expect(state).toMatchObject({ title: 'Sprint 42 refinement', round: 2, phase: 'voting', question: 'PROJ-2 Export', hostId: host.id });
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ question: 'PROJ-1 Login', summary: { median: 6.5, count: 2 } });
    expect(state.players.map((p) => [p.name, p.hasVoted, p.vote])).toEqual(expect.arrayContaining([
      ['The Executive', false, null], ['The Closer', true, '🔒'],
    ]));
    // The old seat secrets still work: no rejoin needed after a deploy.
    expect((await s.call(`${API}/${id}/vote`, { value: '5' }, as(host))).status).toBe(200);
    expect((await s.call(`${API}/${id}/reveal`, {}, as(host))).data.summary.median).toBe(4);
    expect((await s.call(`${API}/${id}/vote`, { value: '5' }, { 'X-Seat-Secret': 'not-a-seat-secret' })).status).toBe(401);
    await s.stop();
  });

  test('stored data-URL pictures move to /img/u links on load; unused ones are swept', async () => {
    const dir = tmpDir();
    const t = Date.now();
    const pic = 'data:image/png;base64,' + Buffer.from('legacy upload bytes').toString('base64');
    const player = { id: 'p1', secretHash: 'x'.repeat(64), name: 'Nova', icon: pic, raw: true, role: 'player', subtitle: '', vote: null, revealed: false };
    fs.writeFileSync(stateFile(dir), JSON.stringify({ version: 1, rooms: [{ id: 'pic001', title: 'Pictures', round: 1, phase: 'lobby', question: '', hostId: 'p1', locked: false, history: [], players: [player], updatedAt: t }] }));
    const s = await start(dir);
    const state = (await s.call('/planning-poker/api/rooms/pic001/state')).data;
    const icon = state.players[0].icon;
    expect(icon).toMatch(/^\/img\/u\/[a-f0-9]{32}\.png$/);
    expect(state.players[0].raw).toBe(true);
    const res = await fetch(s.base + icon);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('legacy upload bytes');
    await s.stop();

    // The sweep keeps what is referenced and deletes the rest (after a grace period).
    const { createUploads } = require('../../lib/icons');
    const uploads = createUploads(dir);
    const orphan = uploads.intake('data:image/png;base64,' + Buffer.from('orphan').toString('base64'));
    // Do not depend on the filesystem timestamp ticking between intake and sweep.
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(path.join(dir, 'uploads', orphan.split('/').pop()), old, old);
    expect(uploads.sweep(new Set([icon]), 0)).toBe(1);
    expect(fs.existsSync(path.join(dir, 'uploads', icon.split('/').pop()))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'uploads', orphan.split('/').pop()))).toBe(false);
    // A link whose picture is gone falls back to a neutral emoji instead of a broken image.
    expect(uploads.intake(orphan)).toBe('👤');
  });

  test('a poker rejoin cannot rename a seat onto another seat', async () => {
    const s = await start(tmpDir());
    const API = '/planning-poker/api/rooms';
    const { id } = (await s.call(API, { title: 'Names' })).data;
    await s.call(`${API}/${id}/join`, { name: 'Coco', icon: '👠' });
    const margot = (await s.call(`${API}/${id}/join`, { name: 'Margot', icon: '📊' })).data;
    const again = await s.call(`${API}/${id}/join`, { name: 'coco', icon: '📊' }, { 'X-Seat-Secret': margot.secret });
    expect(again.status).toBe(200);
    expect((await s.call(`${API}/${id}/state`)).data.players.map((p) => p.name).sort()).toEqual(['Coco', 'Margot']);
    // A free name is still taken over on rejoin.
    await s.call(`${API}/${id}/join`, { name: 'Margot B', icon: '📊' }, { 'X-Seat-Secret': margot.secret });
    expect((await s.call(`${API}/${id}/state`)).data.players.map((p) => p.name).sort()).toEqual(['Coco', 'Margot B']);
    await s.stop();
  });

  test('poker rooms expire after a day without activity', async () => {
    const dir = tmpDir();
    const t = Date.now();
    const room = (id, idleHours) => ({ id, title: id, round: 1, phase: 'lobby', question: '', hostId: null, locked: false, history: [], players: [], updatedAt: t - idleHours * 3_600_000 });
    fs.writeFileSync(stateFile(dir), JSON.stringify({ version: 1, rooms: [room('room25', 25), room('room23', 23)] }));
    const s = await start(dir);
    expect((await s.call('/planning-poker/api/rooms/room25')).status).toBe(404);
    expect((await s.call('/planning-poker/api/rooms/room23')).data).toMatchObject({ exists: true, title: 'room23' });
    await s.stop();
  });

  test('an open boardroom keeps working through a server restart', async ({ page }) => {
    const dir = tmpDir();
    let s = await start(dir);
    await page.goto(s.base + '/planning-poker');
    await page.getByTestId('create-btn').click();
    await page.locator('[data-testid="pick"][data-first="Charlotte"]').click();
    await page.getByTestId('join-btn').click();
    await expect(page.getByTestId('game-screen')).toBeVisible();
    await page.getByTestId('question').fill('Survives a deploy');
    await page.getByTestId('question').blur();
    const id = page.url().split('/').pop();
    await expect.poll(async () => (await s.call(`/planning-poker/api/rooms/${id}/state`)).data.question).toBe('Survives a deploy');
    await s.stop();
    s = await start(dir, s.port);
    // The page reconnects on its own and its seat is still valid.
    await page.getByTestId('card').filter({ hasText: /^5$/ }).click();
    await expect(page.getByTestId('hand')).toHaveClass(/compact/);
    await expect.poll(async () => (await s.call(`/planning-poker/api/rooms/${id}/state`)).data.players[0].hasVoted).toBe(true);
    await expect(page.getByTestId('question')).toHaveValue('Survives a deploy');
    await s.stop();
  });
});
