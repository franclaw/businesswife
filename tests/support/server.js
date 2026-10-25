// Start a private server for specs that need their own data directory or a
// restart: a spare port, a throwaway DATA_DIR, never the shared e2e server
// and never the live site.
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

async function start(dataDir, port = nextPort++, env = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, BW_RATE_LIMIT: '1000', ...env, PORT: String(port), DATA_DIR: dataDir },
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
  const call = async (p, body, headers = {}) => {
    const res = await fetch(base + p, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
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
  return { base, port, call, stop, log: () => log };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bw-data-'));
const stateFile = (dir) => path.join(dir, 'state.json');


module.exports = { start, tmpDir, stateFile, iso, DAY };
