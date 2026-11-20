const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { start, tmpDir, stateFile, DAY } = require('../support/server');
const { monthAfter } = require('../../lib/meetings');

test('calendar-month expiry clamps month ends', () => {
  expect(new Date(monthAfter(Date.UTC(2026, 0, 31, 12))).toISOString()).toBe('2026-02-28T12:00:00.000Z');
  expect(new Date(monthAfter(Date.UTC(2028, 0, 31))).toISOString()).toBe('2028-02-29T00:00:00.000Z');
});

test('meeting secrets, guards, handover and saved activities survive restart and SSE reconnect', async ({ page }) => {
  const dir = tmpDir(); let s = await start(dir);
  try {
    const made = (await s.call('/meeting-room/api/rooms', { title: 'Persistent meeting' })).data;
    const api = '/meeting-room/api/rooms/' + made.id;
    // A visitor arriving before the creator cannot seize facilitator status.
    const guest = (await s.call(api + '/join', { name: 'Guest' })).data;
    const host = (await s.call(api + '/join', { name: 'Host', ownerToken: made.ownerToken })).data;
    const post = (action, data = {}, seat = host) => s.call(api + '/' + action, { ...data, secret: seat.secret });
    expect((await post('activity', { type: 'poker', title: 'Story' }, guest)).status).toBe(403);
    expect((await s.call(api + '/activity', { type: 'poker' })).status).toBe(401);
    expect((await post('activity', { type: '__proto__' })).status).toBe(400);
    expect((await post('activity', { type: 'poll', title: 'Q', options: ['A','A'] })).status).toBe(400);
    await post('activity', { type: 'poker', title: 'Story' });
    let state = (await s.call(api)).data, poker = state.activeId;
    await post('respond', { activityId: poker, value: '13' }, guest);
    state = (await s.call(api)).data;
    expect(state.sessions[0].activities[0]).toMatchObject({ results: null, responseIds: [guest.id] });
    await post('activity', { type: 'poll', title: 'Q', options: ['A','B'] });
    const poll = (await s.call(api)).data.activeId;
    expect((await post('respond', { activityId: poker, value: '8' })).status).toBe(409);
    await post('respond', { activityId: poll, value: 'o0' }, guest);
    expect((await post('respond', { activityId: poll, value: 'o1' }, guest)).status).toBe(409);
    await post('close', { activityId: poll });
    await post('switch', { activityId: poker });
    await post('close', { activityId: poker });
    await page.goto(s.base + '/meeting-room/' + made.id);
    await page.evaluate(api => {
      window.meetingEvents = [];
      window.meetingStream = new EventSource(api + '/events');
      window.meetingStream.onmessage = e => window.meetingEvents.push(JSON.parse(e.data));
    }, api);
    await expect.poll(() => page.evaluate(() => window.meetingEvents.length)).toBeGreaterThan(0);
    const port = s.port; await s.stop();
    const raw = fs.readFileSync(stateFile(dir), 'utf8');
    for (const token of [made.ownerToken, host.secret, guest.secret]) expect(raw).not.toContain(token);
    s = await start(dir, port);
    await post('handover', { memberId: guest.id });
    await expect.poll(() => page.evaluate(() => window.meetingEvents.at(-1)?.hostId)).toBe(guest.id);
    state = (await s.call(api)).data;
    expect(state.sessions[0].activities[0].results.median).toBe(13);
    expect(state.sessions[0].activities[1].results[0].count).toBe(1);
    expect((await post('end')).status).toBe(403);
    expect((await post('end', {}, guest)).status).toBe(200);
    expect((await post('session', {}, guest)).status).toBe(200);
    expect((await s.call(api)).data.sessions).toHaveLength(2);
    await page.evaluate(() => window.meetingStream.close());
  } finally { await s.stop(); }
});

test('public reads do not renew rooms; joins renew; expired links cannot be revived', async () => {
  const dir = tmpDir(); let s = await start(dir);
  const made = (await s.call('/meeting-room/api/rooms', { title: 'Expiry' })).data;
  const api = '/meeting-room/api/rooms/' + made.id;
  await s.stop();
  const data = JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));
  data.meetingRooms[0].usedAt = Date.now() - 20 * DAY;
  fs.writeFileSync(stateFile(dir), JSON.stringify(data));
  s = await start(dir);
  try {
    const before = (await s.call(api)).data;
    expect((await s.call(api)).data.expiresAt).toBe(before.expiresAt);
    await s.call(api + '/join', { name: 'Fresh use', ownerToken: made.ownerToken });
    expect((await s.call(api)).data.expiresAt).toBeGreaterThan(before.expiresAt + 19 * DAY);
  } finally { await s.stop(); }
  const expired = JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));
  expired.meetingRooms[0].usedAt = Date.now() - 40 * DAY;
  fs.writeFileSync(stateFile(dir), JSON.stringify(expired));
  s = await start(dir);
  try {
    expect((await s.call(api)).status).toBe(404);
    expect((await s.call(api + '/join', { name: 'Late' })).status).toBe(404);
  } finally { await s.stop(); }
});
