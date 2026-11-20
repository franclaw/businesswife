const { test, expect } = require('@playwright/test');
const { start, tmpDir } = require('../support/server');

test('authenticated character updates reject conflicts and persist without duplicating votes', async () => {
  const dir = tmpDir(); let server = await start(dir);
  try {
    for (const app of ['planning-poker', 'meeting-room', 'poll']) {
      const prefix = app === 'poll' ? '/poll/api/polls' : `/${app}/api/rooms`;
      const made = (await server.call(prefix, { title: 'Characters', question: 'Q', options: ['A', 'B'] })).data;
      const endpoint = prefix + '/' + made.id;
      const seat = app === 'poll' ? { secret: 'character-voter-1' } : (await server.call(endpoint + '/join', { name: 'Original', icon: '/img/hr.png', ownerToken: made.ownerToken })).data;
      const data = body => app === 'poll' ? { voterId: seat.secret, ...body } : { secret: seat.secret, ...body };
      await server.call(endpoint + (app === 'poll' ? '/identity' : '/join'), app === 'poll' ? { voterId: 'character-voter-2', name: 'Taken' } : { name: 'Taken', icon: '/img/legal.png' });
      if (app === 'planning-poker') await server.call(endpoint + '/vote', data({ value: '8' }));
      if (app === 'poll') await server.call(endpoint + '/vote', data({ optionId: 'o1', name: 'Original' }));
      if (app === 'meeting-room') {
        await server.call(endpoint + '/activity', data({ type: 'poker', title: 'Story' }));
        const activityId = (await server.call(endpoint)).data.activeId;
        await server.call(endpoint + '/respond', data({ activityId, value: '8' }));
      }
      if (app !== 'poll') expect((await server.call(endpoint + '/identity', { name: 'Imposter', icon: '/img/hr.png' })).status).toBe(401);
      expect((await server.call(endpoint + '/identity', data({ name: 'Taken', icon: '/img/hr.png' }))).status).toBe(409);
      expect((await server.call(endpoint + '/identity', data({ name: 'Changed', icon: 'https://invalid.example/x' }))).status).toBe(400);
      expect((await server.call(endpoint + '/identity', data({ name: 'Changed', icon: '/img/cfo.png' }))).status).toBe(200);
      if (app === 'poll') {
        const restored = await server.call(endpoint + '/identity', data({ name: 'Original', restore: true }));
        expect(restored.data).toMatchObject({ identity: { name: 'Changed' }, optionId: 'o1' });
        expect((await server.call(endpoint + '/vote', data({ optionId: 'o2' }))).status).toBe(409);
      }
      await server.stop(); server = await start(dir);
      const state = (await server.call(endpoint + (app === 'planning-poker' ? '/state' : ''))).data;
      if (app === 'poll') {
        expect(state).toMatchObject({ totalVotes: 1, voters: [{ name: 'Changed', icon: '/img/cfo.png' }] });
        expect(state.options[0].count).toBe(1);
      } else if (app === 'planning-poker') {
        expect(state.players.find(p => p.id === seat.id)).toMatchObject({ name: 'Changed', hasVoted: true, isHost: true });
      } else {
        expect(state.members.find(p => p.id === seat.id).name).toBe('Changed');
        expect(state.hostId).toBe(seat.id);
        expect(state.sessions[0].activities[0].responseIds).toEqual([seat.id]);
      }
    }
  } finally { await server.stop(); }
});

test('poker creator, not first joiner, owns host authority across restart and rejoining a locked room', async () => {
  const dir = tmpDir(); let server = await start(dir);
  try {
    const made = (await server.call('/planning-poker/api/rooms', { title: 'Creator host' })).data;
    const api = '/planning-poker/api/rooms/' + made.id;
    const guest = (await server.call(api + '/join', { name: 'First visitor', icon: '💼' })).data;
    let state = (await server.call(api + '/state')).data;
    expect(state.hostId).toBeNull();
    expect(state.players[0].isHost).toBe(false);
    expect((await server.call(api + '/lock', { secret: guest.secret, locked: true })).status).toBe(403);
    await server.stop(); server = await start(dir);
    const host = (await server.call(api + '/join', { name: 'Creator', icon: '👑', ownerToken: made.ownerToken })).data;
    state = (await server.call(api + '/state')).data;
    expect(state.hostId).toBe(host.id);
    const text = JSON.stringify(state);
    expect(text).not.toContain(made.ownerToken);
    expect(text).not.toContain('ownerHash');
    expect((await server.call(api + '/join', { secret: guest.secret, ownerToken: 'wrong-token' })).status).toBe(200);
    expect((await server.call(api + '/state')).data.hostId).toBe(host.id);
    await server.call(api + '/lock', { secret: host.secret, locked: true });
    await server.call(api + '/leave', { secret: host.secret });
    expect((await server.call(api + '/state')).data.hostId).toBeNull();
    expect((await server.call(api + '/join', { name: 'Visitor2', icon: '💼' })).status).toBe(403);
    const rejoined = await server.call(api + '/join', { name: 'Creator again', icon: '👑', ownerToken: made.ownerToken });
    expect(rejoined.status).toBe(200);
    await server.stop(); server = await start(dir);
    expect((await server.call(api + '/state')).data.hostId).toBe(rejoined.data.id);
    const fs = require('fs');
    expect(fs.readFileSync(require('../support/server').stateFile(dir), 'utf8')).not.toContain(made.ownerToken);
  } finally { await server.stop(); }
});
