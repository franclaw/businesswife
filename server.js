#!/usr/bin/env node
// Business Wife hub — planning poker, pomodoro, poll and date picker.
// Zero runtime dependencies. This file only wires the pieces together:
//   lib/pages   static pages and assets
//   lib/poker   planning poker rooms (in memory)
//   lib/polls   polls (persisted)
//   lib/dates   date picks (persisted)
//   lib/store   the JSON file polls and date picks are saved to
//   lib/sse     server-sent event streams
//   lib/http    bodies, JSON replies, static files
const http = require('http');
const path = require('path');
const sse = require('./lib/sse');
const { json, notFound, HttpError } = require('./lib/http');
const { createStore } = require('./lib/store');
const { createPages } = require('./lib/pages');
const { createPoker } = require('./lib/poker');
const { createPolls } = require('./lib/polls');
const { createDates } = require('./lib/dates');

const PORT = process.env.PORT ? Number(process.env.PORT) : 6969;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const store = createStore(DATA_DIR);
const pages = createPages(ROOT);
const poker = createPoker();
const polls = createPolls(store);
const dates = createDates(store);

sse.keepAlive(() => [...poker.listeners(), ...polls.listeners(), ...dates.listeners()]);

const handlers = [pages, polls, dates, poker];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+/g, '/');
  try {
    for (const h of handlers) {
      if (await h.handle(req, res, pathname, url.searchParams) !== false) return;
    }
    notFound(res);
  } catch (err) {
    if (res.headersSent) return res.end();
    const status = err instanceof HttpError ? err.status : 400;
    json(res, status, { error: status === 413 ? 'body too large' : 'bad request' });
  }
});

store.load();
server.listen(PORT, () => console.log(`business wife hub on :${PORT}`));

// Docker stops the container with SIGTERM: write any pending change first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    store.saveNow();
    process.exit(0);
  });
}
