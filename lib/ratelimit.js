// A small per-IP limit on the endpoints that create something (rooms, polls,
// date picks, feedback sessions). Every store has a global cap, so without
// this one script could fill a cap and lock everyone else out.
//
// Sliding window, in memory. BW_RATE_LIMIT overrides the count (the e2e
// server raises it; production keeps the default).
const { json } = require('./http');

const WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX = 30;

const CREATE_ROUTES = new Set([
  '/planning-poker/api/rooms',
  '/api/rooms',
  '/poll/api/polls',
  '/dates/api/picks',
  '/feedback/api/sessions',
]);

// Behind Traefik the socket peer is the proxy (a private address) and the
// client is the last X-Forwarded-For hop the proxy appended. A request that
// reaches the port directly is judged by its socket address, so a forged
// header cannot pick its own bucket.
const PRIVATE = /^(::ffff:)?(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$|^f[cd]/i;
function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  const fwd = req.headers['x-forwarded-for'];
  if (fwd && PRIVATE.test(peer)) {
    const hops = String(fwd).split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return peer;
}

function createRateLimit({ max = Number(process.env.BW_RATE_LIMIT) || DEFAULT_MAX, windowMs = WINDOW_MS } = {}) {
  const hits = new Map(); // ip -> [timestamps]

  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, list] of hits) {
      const fresh = list.filter((t) => t > cutoff);
      if (fresh.length) hits.set(ip, fresh); else hits.delete(ip);
    }
  }, 60_000).unref();

  /** Answers 429 and returns true when the caller is over the limit. */
  function handle(req, res, pathname) {
    if (req.method !== 'POST' || !CREATE_ROUTES.has(pathname.replace(/\/$/, ''))) return false;
    const ip = clientIp(req);
    const t = Date.now();
    const list = (hits.get(ip) || []).filter((x) => x > t - windowMs);
    if (list.length >= max) {
      const retry = Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000));
      res.setHeader('Retry-After', String(retry));
      json(res, 429, { error: 'Too many new sessions from here. Try again in a few minutes.' });
      return true;
    }
    list.push(t);
    hits.set(ip, list);
    return false;
  }

  return { handle };
}

module.exports = { createRateLimit, clientIp };
