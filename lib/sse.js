// Server-sent events: one Set of open responses per room, poll or pick.
const PING_MS = 25_000;

function open(req, res, listeners, first) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  listeners.add(res);
  res.write(`data: ${JSON.stringify(first)}\n\n`);
  req.on('close', () => listeners.delete(res));
}

function send(listeners, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of listeners) {
    try { res.write(data); } catch { listeners.delete(res); }
  }
}

/** Keep proxies from closing idle streams. `each` yields every listener Set. */
function keepAlive(each) {
  setInterval(() => {
    for (const listeners of each()) {
      for (const res of listeners) {
        try { res.write(': ping\n\n'); } catch { listeners.delete(res); }
      }
    }
  }, PING_MS).unref();
}

module.exports = { open, send, keepAlive };
