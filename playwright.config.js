const os = require('os');
const path = require('path');
const { defineConfig, devices } = require('@playwright/test');

// Tests run against a throwaway local server by default: its own port and its
// own DATA_DIR, so a bare `npm test` can never write into production.
// The live site is only reachable on purpose: E2E_LIVE=1 (see test:e2e:live).
const LIVE = 'https://businesswife.nl';
const PORT = Number(process.env.E2E_PORT || 6983);
const live = process.env.E2E_LIVE === '1';
if (!live && process.env.BASE_URL && /businesswife\.nl/.test(process.env.BASE_URL)) {
  throw new Error('BASE_URL points at production. Use E2E_LIVE=1 if you really mean it.');
}
const external = live ? LIVE : process.env.BASE_URL;
const baseURL = external || `http://127.0.0.1:${PORT}`;
const dataDir = path.join(os.tmpdir(), `bw-e2e-${PORT}-${process.pid}`);

module.exports = defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: external ? undefined : {
    command: `node server.js`,
    url: `${baseURL}/`,
    reuseExistingServer: false,
    timeout: 20_000,
    env: { PORT: String(PORT), DATA_DIR: dataDir, BW_RATE_LIMIT: process.env.BW_RATE_LIMIT || '1000' },
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
});
