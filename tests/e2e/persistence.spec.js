// Polls and date picks survive a restart. These specs start their own server
// on a spare port with a throwaway data directory, so they never touch
// BASE_URL (and never the live site).
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', '..', 'server.js');
const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');
const iso = (offset) => {
  const d = new Date(Date.now() + offset * DAY);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

let nextPort = 7300 + Math.floor(Math.random() * 500);

async function start(dataDir) {
  const port = nextPort++;
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start: ' + log)), 10_000);
    const onData = (chunk) => {
      log += chunk;
      if (log.includes('business wife hub on')) { clearTimeout(timer); resolve(); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', () => reject(new Error('server exited: ' + log)));
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, body) => {
    const res = await fetch(base + p, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
  const stop = (signal = 'SIGTERM') => new Promise((resolve) => {
    proc.removeAllListeners('exit');
    proc.on('exit', resolve);
    proc.kill(signal);
  });
  return { base, call, stop, log: () => log };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bw-data-'));
const stateFile = (dir) => path.join(dir, 'state.json');

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
    const poll = (await s.call('/poll/api/polls', { question: 'Lunch?', options: ['Yes', 'No'], creatorId: voter })).data.id;
    await s.call(`/poll/api/polls/${poll}/vote`, { voterId: voter, optionId: 'o1' });
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
    expect((await s.call(`/poll/api/polls/${poll}/close`, { voterId: 'someone-else-1234' })).status).toBe(403);
    expect((await s.call(`/poll/api/polls/${poll}/close`, { voterId: voter })).status).toBe(200);
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
});
