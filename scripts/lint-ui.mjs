#!/usr/bin/env node
// UI lint for the Business Wife hub: boots the zero-dependency server on a
// throwaway port, then runs lintapple against every app route.
// Usage: npm run lint:ui   (or: PORT=6975 node scripts/lint-ui.mjs)

import { spawn } from 'node:child_process';
import { once } from 'node:events';

const PORT = Number(process.env.PORT || 6971);
const BASE = `http://127.0.0.1:${PORT}`;
const ROUTES = ['/', '/planning-poker', '/pomodoro', '/poll', '/dates'];

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: `/tmp/businesswife-lint-${PORT}` },
  stdio: 'ignore',
});

async function waitForServer(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/');
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

let failed = false;
try {
  if (!(await waitForServer())) {
    console.error(`Server did not come up on ${BASE}`);
    process.exitCode = 2;
  } else {
    for (const route of ROUTES) {
      const child = spawn('npx', ['lintapple', BASE + route], { stdio: 'inherit' });
      const [code] = await once(child, 'exit');
      if (code !== 0) failed = true;
    }
    process.exitCode = failed ? 1 : 0;
  }
} finally {
  server.kill();
}
