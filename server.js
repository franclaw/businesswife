#!/usr/bin/env node
// Business Wife hub — planning poker, pomodoro, poll and date picker.
// Zero runtime dependencies. This file only wires the pieces together:
//   lib/pages   static pages and assets
//   lib/poker   planning poker rooms (persisted, 24 h idle expiry)
//   lib/polls   polls (persisted)
//   lib/dates   date picks (persisted)
//   lib/feedback   feedback & voting sessions (persisted)
//   lib/store   the JSON file polls and date picks are saved to
//   lib/sse     server-sent event streams
//   lib/http    bodies, JSON replies, static files
//   lib/ratelimit  per-IP limit on the create endpoints
const http = require('http');
const path = require('path');
const sse = require('./lib/sse');
const { json, notFound, HttpError } = require('./lib/http');
const { createStore } = require('./lib/store');
const { createPages } = require('./lib/pages');
const { createPoker } = require('./lib/poker');
const { createPolls } = require('./lib/polls');
const { createDates } = require('./lib/dates');
const { createFeedback } = require('./lib/feedback');
const { createRateLimit } = require('./lib/ratelimit');

const PORT = process.env.PORT ? Number(process.env.PORT) : 6969;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const store = createStore(DATA_DIR);
const poker = createPoker(store);
const polls = createPolls(store);
const pages = createPages(ROOT, { pollTitle: polls.title, pokerTitle: poker.title });
const dates = createDates(store);
const feedback = createFeedback(store);
const rateLimit = createRateLimit();

sse.keepAlive(() => [...poker.listeners(), ...polls.listeners(), ...dates.listeners(), ...feedback.listeners()]);

const handlers = [pages, polls, dates, feedback, poker];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+/g, '/');
  try {
    if (rateLimit.handle(req, res, pathname)) return;
    for (const h of handlers) {
      if (await h.handle(req, res, pathname, url.searchParams) !== false) return;
    }
    notFound(res);
  } catch (err) {
    // Bad input (HttpError: oversized or malformed bodies) is the caller's
    // problem; anything else is ours: log it and answer 500.
    const known = err instanceof HttpError;
    if (!known) console.error(`${new Date().toISOString()} ${req.method} ${pathname} failed:`, err && err.stack || err);
    if (res.headersSent) return res.end();
    const status = known ? err.status : 500;
    json(res, status, { error: status === 413 ? 'body too large' : status === 500 ? 'server error' : 'bad request' });
  }
});

store.load();
server.listen(PORT, () => console.log(`business wife hub on :${server.address().port}`));

// Docker stops the container with SIGTERM: write any pending change first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    store.saveNow();
    process.exit(0);
  });
}
