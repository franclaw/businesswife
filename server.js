#!/usr/bin/env node
// Business Wife hub — planning poker + pomodoro + poll
// Zero-dependency Node: rooms + polls + static UI + in-memory state + SSE.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT ? Number(process.env.PORT) : 6969;
const ROOT = __dirname;
const HUB = path.join(ROOT, 'hub.html');
const POKER_INDEX = path.join(ROOT, 'index.html');
const POMODORO_DIR = path.join(ROOT, 'pomodoro');
const POLL_DIR = path.join(ROOT, 'poll');
const DATES_DIR = path.join(ROOT, 'dates');
const POKER_PWA_DIR = path.join(ROOT, 'planning-poker');
const PUBLIC = path.join(ROOT, 'public');
const ROOM_RE = /^[a-z0-9]{6}$/;
const ID_CHARS = '23456789abcdefghjkmnpqrstuvwxyz';
const STALE_MS = 45_000;
const IDLE_REMOVE_MS = 90_000;
const SUBTITLE_MAX = 40;

/** Custom wife subtitle — optional, short, single line. */
function cleanSubtitle(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, SUBTITLE_MAX);
}

const rooms = new Map(); // id -> room
const polls = new Map(); // id -> poll
const dates = new Map(); // id -> date pick

const POLL_QUESTION_MAX = 200;
const POLL_OPTION_MAX = 80;
const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 8;
const POLL_VOTER_MAX = 64;
const POLL_SWEEP_MS = 60_000;
const POLL_TTL_MS = 6 * 3_600_000;
const POLL_EMPTY_TTL_MS = 30 * 60_000;

const DATE_TITLE_MAX = 80;
const DATE_MAX_DAYS = 14;
const DATE_MAX_AHEAD_DAYS = 90;
const DATE_VOTER_MAX = 64;
const DATE_SWEEP_MS = 60_000;
const DATE_TTL_MS = 6 * 3_600_000;
const DATE_EMPTY_TTL_MS = 30 * 60_000;
const DATE_NAME_MAX = 24;
const DATE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Coarse by design: a phone grid cannot hold day x block x precise hour.
const DATE_BLOCKS = [
  { id: 'morning', label: 'Morning', short: 'M' },
  { id: 'afternoon', label: 'Afternoon', short: 'A' },
  { id: 'evening', label: 'Evening', short: 'E' },
];

function newRoomId() {
  for (let n = 0; n < 20; n++) {
    let id = '';
    const buf = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) id += ID_CHARS[buf[i] % ID_CHARS.length];
    if (!rooms.has(id)) return id;
  }
  return crypto.randomBytes(4).toString('hex').slice(0, 6);
}

function makeRoom(id) {
  return {
    id,
    round: 1,
    phase: 'lobby',
    question: '',
    hostId: null,
    locked: false,
    players: {},
    history: [],
    sse: new Set(),
  };
}

function now() {
  return Date.now();
}

// ---------- Polls ----------
function newPollId() {
  for (let n = 0; n < 20; n++) {
    let id = '';
    const buf = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) id += ID_CHARS[buf[i] % ID_CHARS.length];
    if (!polls.has(id)) return id;
  }
  return crypto.randomBytes(4).toString('hex').slice(0, 6);
}

function makePoll(question, options) {
  return {
    id: null,
    question,
    options: options.map((label, i) => ({ id: 'o' + (i + 1), label })),
    votes: new Map(), // voterId -> optionId
    creatorId: null,
    closed: false,
    createdAt: now(),
    sse: new Set(),
  };
}

function pollState(poll) {
  const counts = new Map(poll.options.map(o => [o.id, 0]));
  for (const optionId of poll.votes.values()) {
    if (counts.has(optionId)) counts.set(optionId, counts.get(optionId) + 1);
  }
  return {
    id: poll.id,
    question: poll.question,
    closed: poll.closed,
    totalVotes: poll.votes.size,
    options: poll.options.map(o => ({ id: o.id, label: o.label, count: counts.get(o.id) || 0 })),
  };
}

function broadcastPoll(poll) {
  const data = `data: ${JSON.stringify(pollState(poll))}\n\n`;
  for (const res of poll.sse) {
    try { res.write(data); } catch { poll.sse.delete(res); }
  }
}

function validVoterId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);
}

function parsePollCreate(body) {
  const question = String(body?.question ?? '').trim().slice(0, POLL_QUESTION_MAX);
  if (!question) return { error: 'question required' };
  const raw = Array.isArray(body?.options) ? body.options : [];
  const options = raw.map(o => String(o ?? '').trim().slice(0, POLL_OPTION_MAX)).filter(Boolean);
  if (options.length < POLL_MIN_OPTIONS) return { error: `at least ${POLL_MIN_OPTIONS} options required` };
  if (options.length > POLL_MAX_OPTIONS) return { error: `at most ${POLL_MAX_OPTIONS} options` };
  const seen = new Set();
  for (const o of options) {
    const key = o.toLowerCase();
    if (seen.has(key)) return { error: 'duplicate options' };
    seen.add(key);
  }
  return { question, options };
}

// Poll sweeper — retire stale polls so memory doesn't creep
setInterval(() => {
  const t = now();
  for (const [id, poll] of polls) {
    const idle = t - poll.createdAt;
    const empty = !poll.votes.size && !poll.sse.size;
    if (idle > POLL_TTL_MS || (empty && idle > POLL_EMPTY_TTL_MS)) polls.delete(id);
  }
}, POLL_SWEEP_MS).unref();

// ---------- Date picker ----------
function newDateId() {
  for (let n = 0; n < 20; n++) {
    let id = '';
    const buf = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) id += ID_CHARS[buf[i] % ID_CHARS.length];
    if (!dates.has(id)) return id;
  }
  return crypto.randomBytes(4).toString('hex').slice(0, 6);
}

function slotKey(date, block) {
  return date + '|' + block;
}

function makeDatePick(title, days) {
  return {
    id: null,
    title,
    days,                                  // ['2026-10-15', ...] sorted
    marks: new Map(),                      // voterId -> Set<slotKey>
    names: new Map(),                      // voterId -> display name
    creatorId: null,
    closed: false,
    chosen: null,                          // slotKey once locked
    createdAt: now(),
    sse: new Set(),
  };
}

// Overlap wins: most people free, then earliest day, then earliest block.
function bestSlot(pick) {
  const tally = new Map();
  for (const set of pick.marks.values()) {
    for (const key of set) tally.set(key, (tally.get(key) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [key, count] of tally) {
    if (!count) continue;
    const [date, block] = key.split('|');
    const rank = pick.days.indexOf(date) * 10 + DATE_BLOCKS.findIndex((b) => b.id === block);
    if (!best) { best = { key, date, block, count, rank }; bestCount = count; continue; }
    if (count > bestCount || (count === bestCount && rank < best.rank)) {
      best = { key, date, block, count, rank };
      bestCount = count;
    }
  }
  return best;
}

function dateState(pick) {
  const voters = [...pick.marks.keys()];
  const total = voters.length;
  const days = pick.days.map((date) => ({
    date,
    blocks: DATE_BLOCKS.map((b) => {
      const key = slotKey(date, b.id);
      // IDs, not names: two people called "Marc" must not light each other's dot.
      const who = voters
        .filter((v) => pick.marks.get(v).has(key))
        .map((v) => ({ id: v, name: pick.names.get(v) || 'Guest' }));
      return { id: b.id, label: b.label, short: b.short, count: who.length, who };
    }),
  }));
  const best = bestSlot(pick);
  return {
    id: pick.id,
    title: pick.title,
    closed: pick.closed,
    chosen: pick.chosen,
    totalVoters: total,
    participants: voters.map((v) => ({
      id: v,
      name: pick.names.get(v) || 'Guest',
      count: pick.marks.get(v).size,
    })),
    days,
    best: best ? { date: best.date, block: best.block, count: best.count } : null,
  };
}

function broadcastDate(pick) {
  const data = `data: ${JSON.stringify(dateState(pick))}\n\n`;
  for (const res of pick.sse) {
    try { res.write(data); } catch { pick.sse.delete(res); }
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseDateCreate(body) {
  const title = String(body?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, DATE_TITLE_MAX);
  if (!title) return { error: 'title required' };
  const raw = Array.isArray(body?.days) ? body.days : [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxDate = new Date(today.getTime() + DATE_MAX_AHEAD_DAYS * 86_400_000);
  const seen = new Set();
  const days = [];
  for (const value of raw) {
    const d = String(value ?? '');
    if (!ISO_DAY.test(d)) return { error: 'bad date' };
    const t = new Date(d + 'T00:00:00Z').getTime();
    if (Number.isNaN(t)) return { error: 'bad date' };
    if (t < today.getTime() - 86_400_000 || t > maxDate.getTime()) return { error: 'date out of range' };
    if (seen.has(d)) continue;
    seen.add(d);
    days.push(d);
  }
  if (!days.length) return { error: 'pick at least one day' };
  if (days.length > DATE_MAX_DAYS) return { error: `at most ${DATE_MAX_DAYS} days` };
  days.sort();
  return { title, days };
}

// Date sweeper — same shape as polls so memory cannot creep.
setInterval(() => {
  const t = now();
  for (const [id, pick] of dates) {
    const idle = t - pick.createdAt;
    const empty = !pick.marks.size && !pick.sse.size;
    if (idle > DATE_TTL_MS || (empty && idle > DATE_EMPTY_TTL_MS)) dates.delete(id);
  }
}, DATE_SWEEP_MS).unref();

function isNumericVote(v) {
  return v != null && /^\d+$/.test(String(v));
}

function voteSummary(players) {
  const votes = Object.values(players)
    .filter(p => p.role !== 'observer' && p.vote != null)
    .map(p => ({ name: p.name, vote: p.vote }));
  const numeric = votes
    .map(v => v.vote)
    .filter(isNumericVote)
    .map(Number);
  let average = null;
  if (numeric.length) {
    average = Math.round((numeric.reduce((a, b) => a + b, 0) / numeric.length) * 10) / 10;
  }
  const counts = {};
  for (const v of votes) counts[v.vote] = (counts[v.vote] || 0) + 1;
  let mode = null;
  let modeCount = 0;
  for (const [val, c] of Object.entries(counts)) {
    if (c > modeCount) { mode = val; modeCount = c; }
  }
  const special = votes.filter(v => !isNumericVote(v.vote)).map(v => v.vote);
  return {
    average,
    mode,
    modeCount,
    count: votes.length,
    numericCount: numeric.length,
    spread: counts,
    special,
    votes,
  };
}

function archiveRound(room) {
  if (room.phase !== 'revealed') return;
  const summary = voteSummary(room.players);
  room.history.unshift({
    round: room.round,
    question: room.question || '',
    at: now(),
    summary,
  });
  if (room.history.length > 40) room.history.length = 40;
}

function pickHost(room) {
  const ids = Object.keys(room.players);
  if (!ids.length) {
    room.hostId = null;
    return;
  }
  if (room.hostId && room.players[room.hostId]) return;
  // Prefer a non-observer
  const player = Object.values(room.players).find(p => p.role !== 'observer');
  room.hostId = player ? player.id : ids[0];
}

function removePlayer(room, playerId) {
  if (!room.players[playerId]) return;
  const wasHost = room.hostId === playerId;
  delete room.players[playerId];
  if (wasHost) pickHost(room);
  if (!Object.keys(room.players).length && !room.sse.size) {
    // keep empty rooms briefly for rejoin codes; sweeper can drop later
  }
}

function publicState(room) {
  const t = now();
  const players = Object.values(room.players).map(p => ({
    id: p.id,
    name: p.name,
    icon: p.icon,
    role: p.role || 'player',
    subtitle: p.subtitle || null,
    vote: p.revealed ? p.vote : (p.vote ? '🔒' : null),
    revealed: p.revealed,
    hasVoted: p.role !== 'observer' && !!p.vote,
    isHost: p.id === room.hostId,
    lastSeen: p.lastSeen,
    connected: (t - (p.lastSeen || 0)) < STALE_MS,
    stale: (t - (p.lastSeen || 0)) >= STALE_MS,
  }));
  const summary = room.phase === 'revealed' ? voteSummary(room.players) : null;
  return {
    roomId: room.id,
    round: room.round,
    phase: room.phase,
    question: room.question,
    hostId: room.hostId,
    locked: !!room.locked,
    history: room.history,
    summary,
    players: players.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

function broadcast(room) {
  const data = `data: ${JSON.stringify(publicState(room))}\n\n`;
  for (const res of room.sse) {
    try { res.write(data); } catch { room.sse.delete(res); }
  }
}

function requireHost(room, requesterId) {
  return room && requesterId && room.hostId === requesterId && room.players[requesterId];
}

setInterval(() => {
  for (const room of rooms.values()) {
    for (const res of room.sse) {
      try { res.write(': ping\n\n'); } catch { room.sse.delete(res); }
    }
  }
  for (const poll of polls.values()) {
    for (const res of poll.sse) {
      try { res.write(': ping\n\n'); } catch { poll.sse.delete(res); }
    }
  }
}, 25000);

// Presence sweeper — drop idle seats so ghosts don't linger
setInterval(() => {
  const t = now();
  for (const [id, room] of rooms) {
    let changed = false;
    for (const p of Object.values(room.players)) {
      if (t - (p.lastSeen || 0) > IDLE_REMOVE_MS) {
        removePlayer(room, p.id);
        changed = true;
      }
    }
    if (changed) broadcast(room);
    // Drop empty rooms with no SSE listeners after idle
    if (!Object.keys(room.players).length && !room.sse.size) {
      rooms.delete(id);
    }
  }
}, 15000);

function readBody(req, maxBytes = 4e5) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/** Accept roster emoji, built-in /img path, data URL, or short http(s) image URL. */
function validIcon(icon) {
  if (typeof icon !== 'string' || !icon) return false;
  if (icon.length > 280000) return false;
  if (/^\/img\/[a-z0-9-]+\.png$/.test(icon)) return true;
  if (/^data:image\/(png|jpe?g|webp);base64,/.test(icon)) return true;
  if (/^https?:\/\/\S{1,500}$/i.test(icon)) return true;
  // roster emoji / short glyph
  if ([...icon].length <= 8 && icon.length <= 32) return true;
  return false;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function sendFile(res, filePath, contentType, cache) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const headers = { 'Content-Type': contentType };
    if (cache) headers['Cache-Control'] = cache;
    res.writeHead(200, headers);
    res.end(buf);
  });
}

function serveHtml(res, filePath) {
  sendFile(res, filePath, 'text/html; charset=utf-8');
}

/** Poker shell. ?lobby= is ignored; the home screen is always the mix layout. */
function servePokerHtml(res) {
  fs.readFile(POKER_INDEX, 'utf8', (err, html) => {
    if (err) { res.writeHead(500); return res.end('error'); }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(html);
  });
}

function redirect(res, location, code = 302) {
  res.writeHead(code, { Location: location });
  res.end();
}

function roomFromPath(pathname, prefix) {
  const rest = pathname.slice(prefix.length);
  const id = rest.split('/')[0];
  return ROOM_RE.test(id) ? id : null;
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.css': 'text/css; charset=utf-8',
  })[ext] || 'application/octet-stream';
}

/** Serve a file under a rooted directory; reject path escape. */
function serveUnder(res, rootDir, relUrlPath, cache) {
  const rel = path.normalize(relUrlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  if (rel.startsWith('..')) { res.writeHead(403); return res.end(); }
  const full = path.join(rootDir, rel);
  if (!full.startsWith(rootDir)) { res.writeHead(403); return res.end(); }
  const cacheHdr = cache || (/\.(png|jpe?g|ico|webp)$/i.test(full) ? 'public, max-age=86400' : undefined);
  sendFile(res, full, mimeFor(full), cacheHdr);
}

const API_PREFIX = '/planning-poker/api/rooms';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+/g, '/');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // --- Hub ---
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/hub.html')) {
    return serveHtml(res, HUB);
  }

  // --- Legacy room URL redirect ---
  const legacyRoom = pathname.match(/^\/r\/([a-z0-9]{6})\/?$/);
  if (req.method === 'GET' && legacyRoom) {
    return redirect(res, '/planning-poker/r/' + legacyRoom[1], 302);
  }

  // --- Planning poker UI ---
  if (req.method === 'GET' && (
    pathname === '/planning-poker' ||
    pathname === '/planning-poker/' ||
    pathname === '/planning-poker/index.html' ||
    /^\/planning-poker\/r\/[a-z0-9]{6}\/?$/.test(pathname)
  )) {
    return servePokerHtml(res);
  }

  // Poker PWA assets under /planning-poker/{manifest,sw,icons}
  if (req.method === 'GET' && pathname === '/planning-poker/manifest.webmanifest') {
    return sendFile(res, path.join(POKER_PWA_DIR, 'manifest.webmanifest'), 'application/manifest+json; charset=utf-8');
  }
  if (req.method === 'GET' && pathname === '/planning-poker/sw.js') {
    return sendFile(res, path.join(POKER_PWA_DIR, 'sw.js'), 'application/javascript; charset=utf-8', 'no-cache');
  }
  if (req.method === 'GET' && pathname.startsWith('/planning-poker/icons/')) {
    return serveUnder(res, path.join(POKER_PWA_DIR, 'icons'), pathname.slice('/planning-poker/icons/'.length));
  }

  // --- Pomodoro ---
  if (req.method === 'GET' && (pathname === '/pomodoro' || pathname === '/pomodoro/')) {
    return serveHtml(res, path.join(POMODORO_DIR, 'index.html'));
  }
  if (req.method === 'GET' && pathname === '/pomodoro/index.html') {
    return serveHtml(res, path.join(POMODORO_DIR, 'index.html'));
  }
  if (req.method === 'GET' && pathname === '/pomodoro/manifest.webmanifest') {
    return sendFile(res, path.join(POMODORO_DIR, 'manifest.webmanifest'), 'application/manifest+json; charset=utf-8');
  }
  if (req.method === 'GET' && pathname === '/pomodoro/sw.js') {
    return sendFile(res, path.join(POMODORO_DIR, 'sw.js'), 'application/javascript; charset=utf-8', 'no-cache');
  }
  if (req.method === 'GET' && pathname.startsWith('/pomodoro/icons/')) {
    return serveUnder(res, path.join(POMODORO_DIR, 'icons'), pathname.slice('/pomodoro/icons/'.length));
  }

  // --- Poll ---
  if (req.method === 'GET' && (
    pathname === '/poll' || pathname === '/poll/' ||
    pathname === '/poll/index.html' ||
    /^\/poll\/[a-z0-9]{6}\/?$/.test(pathname)
  )) {
    return serveHtml(res, path.join(POLL_DIR, 'index.html'));
  }
  if (req.method === 'GET' && pathname === '/poll/manifest.webmanifest') {
    return sendFile(res, path.join(POLL_DIR, 'manifest.webmanifest'), 'application/manifest+json; charset=utf-8');
  }
  if (req.method === 'GET' && pathname === '/poll/sw.js') {
    return sendFile(res, path.join(POLL_DIR, 'sw.js'), 'application/javascript; charset=utf-8', 'no-cache');
  }
  if (req.method === 'GET' && pathname.startsWith('/poll/icons/')) {
    return serveUnder(res, path.join(POLL_DIR, 'icons'), pathname.slice('/poll/icons/'.length));
  }

  // --- Date picker ---
  if (req.method === 'GET' && (
    pathname === '/dates' || pathname === '/dates/' ||
    pathname === '/dates/index.html' ||
    /^\/dates\/[a-z0-9]{6}\/?$/.test(pathname)
  )) {
    return serveHtml(res, path.join(DATES_DIR, 'index.html'));
  }
  if (req.method === 'GET' && pathname === '/dates/manifest.webmanifest') {
    return sendFile(res, path.join(DATES_DIR, 'manifest.webmanifest'), 'application/manifest+json; charset=utf-8');
  }
  if (req.method === 'GET' && pathname === '/dates/sw.js') {
    return sendFile(res, path.join(DATES_DIR, 'sw.js'), 'application/javascript; charset=utf-8', 'no-cache');
  }
  if (req.method === 'GET' && pathname.startsWith('/dates/icons/')) {
    return serveUnder(res, path.join(DATES_DIR, 'icons'), pathname.slice('/dates/icons/'.length));
  }

  // --- Poll API ---
  try {
    if (req.method === 'POST' && pathname === '/poll/api/polls') {
      const body = await readBody(req);
      const parsed = parsePollCreate(body);
      if (parsed.error) return json(res, 400, { error: parsed.error });
      const id = newPollId();
      const poll = makePoll(parsed.question, parsed.options);
      poll.id = id;
      if (validVoterId(body && body.creatorId)) poll.creatorId = body.creatorId;
      polls.set(id, poll);
      return json(res, 200, { id });
    }

    const pollM = pathname.match(/^\/poll\/api\/polls\/([a-z0-9]{6})(\/.*)?$/);
    if (pollM) {
      const poll = polls.get(pollM[1]);
      const sub = pollM[2] || '';
      if (!poll) return json(res, 404, { error: 'poll not found' });

      if (req.method === 'GET' && !sub) {
        return json(res, 200, pollState(poll));
      }

      if (req.method === 'GET' && sub === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*',
        });
        poll.sse.add(res);
        res.write(`data: ${JSON.stringify(pollState(poll))}\n\n`);
        req.on('close', () => poll.sse.delete(res));
        return;
      }

      if (req.method === 'POST' && sub === '/vote') {
        const { voterId, optionId } = await readBody(req);
        if (!validVoterId(voterId)) return json(res, 400, { error: 'bad voter' });
        if (poll.closed) return json(res, 409, { error: 'poll closed' });
        if (!poll.options.some(o => o.id === optionId)) return json(res, 400, { error: 'bad option' });
        poll.votes.set(voterId, optionId);
        if (!poll.creatorId) poll.creatorId = voterId;
        broadcastPoll(poll);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && sub === '/close') {
        const { voterId } = await readBody(req);
        if (!poll.creatorId || voterId !== poll.creatorId) return json(res, 403, { error: 'creator only' });
        poll.closed = true;
        broadcastPoll(poll);
        return json(res, 200, { ok: true, closed: true });
      }
    }
  } catch {
    return json(res, 400, { error: 'bad request' });
  }

  // --- Date picker API ---
  try {
    if (req.method === 'POST' && pathname === '/dates/api/picks') {
      const body = await readBody(req);
      const parsed = parseDateCreate(body);
      if (parsed.error) return json(res, 400, { error: parsed.error });
      const id = newDateId();
      const pick = makeDatePick(parsed.title, parsed.days);
      pick.id = id;
      if (validVoterId(body && body.creatorId)) pick.creatorId = body.creatorId;
      dates.set(id, pick);
      return json(res, 200, { id });
    }

    const dateM = pathname.match(/^\/dates\/api\/picks\/([a-z0-9]{6})(\/.*)?$/);
    if (dateM) {
      const pick = dates.get(dateM[1]);
      const sub = dateM[2] || '';
      if (!pick) return json(res, 404, { error: 'pick not found' });

      if (req.method === 'GET' && !sub) {
        return json(res, 200, dateState(pick));
      }

      if (req.method === 'GET' && sub === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*',
        });
        pick.sse.add(res);
        res.write(`data: ${JSON.stringify(dateState(pick))}\n\n`);
        req.on('close', () => pick.sse.delete(res));
        return;
      }

      if (req.method === 'POST' && sub === '/mark') {
        const { voterId, name, date, block, on } = await readBody(req);
        if (!validVoterId(voterId)) return json(res, 400, { error: 'bad voter' });
        if (pick.closed) return json(res, 409, { error: 'date is locked' });
        if (!pick.days.includes(date)) return json(res, 400, { error: 'day not in this pick' });
        if (!DATE_BLOCKS.some((b) => b.id === block)) return json(res, 400, { error: 'bad block' });
        if (!pick.marks.has(voterId)) {
          if (pick.marks.size >= DATE_VOTER_MAX) return json(res, 409, { error: 'room is full' });
          pick.marks.set(voterId, new Set());
          const first = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, DATE_NAME_MAX);
          pick.names.set(voterId, first || 'Guest');
        }
        const key = slotKey(date, block);
        const set = pick.marks.get(voterId);
        if (on) set.add(key);
        else set.delete(key);
        if (name != null) {
          const clean = String(name).replace(/\s+/g, ' ').trim().slice(0, DATE_NAME_MAX);
          if (clean) pick.names.set(voterId, clean);
        }
        if (!pick.creatorId) pick.creatorId = voterId;
        broadcastDate(pick);
        return json(res, 200, { ok: true, count: set.size });
      }

      if (req.method === 'POST' && (sub === '/lock' || sub === '/unlock')) {
        const body = await readBody(req);
        const { voterId, date, block } = body;
        if (!pick.creatorId || voterId !== pick.creatorId) return json(res, 403, { error: 'creator only' });
        if (sub === '/unlock') {
          pick.closed = false;
          pick.chosen = null;
          broadcastDate(pick);
          return json(res, 200, { ok: true, closed: false });
        }
        if (!pick.days.includes(date)) return json(res, 400, { error: 'day not in this pick' });
        if (!DATE_BLOCKS.some((b) => b.id === block)) return json(res, 400, { error: 'bad block' });
        pick.closed = true;
        pick.chosen = slotKey(date, block);
        broadcastDate(pick);
        return json(res, 200, { ok: true, closed: true, chosen: pick.chosen });
      }
    }
  } catch {
    return json(res, 400, { error: 'bad request' });
  }

  // --- Shared static ---
  if (req.method === 'GET' && (pathname === '/favicon.ico' || pathname === '/favicon.png' || pathname === '/apple-touch-icon.png')) {
    const full = path.join(PUBLIC, pathname.slice(1));
    return sendFile(res, full, pathname.endsWith('.ico') ? 'image/x-icon' : 'image/png', 'public, max-age=86400');
  }

  if (req.method === 'GET' && pathname.startsWith('/img/')) {
    const rel = path.normalize(pathname.slice(1));
    if (!/^img(\/thumb)?\/[a-z0-9-]+\.(png|jpe?g)$/.test(rel)) { res.writeHead(403); return res.end(); }
    const full = path.join(PUBLIC, rel);
    const type = rel.endsWith('.jpg') || rel.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    return sendFile(res, full, type, 'public, max-age=86400');
  }

  // --- Poker API (new path) ---
  try {
    const apiPath = pathname.startsWith(API_PREFIX)
      ? pathname.slice('/planning-poker'.length) // -> /api/rooms/...
      : (pathname.startsWith('/api/rooms') ? pathname : null); // legacy optional

    if (apiPath) {
      // Normalize: work with /api/rooms...
      if (req.method === 'POST' && apiPath === '/api/rooms') {
        const id = newRoomId();
        rooms.set(id, makeRoom(id));
        return json(res, 200, { id });
      }

      const roomId = apiPath.startsWith('/api/rooms/') ? roomFromPath(apiPath, '/api/rooms/') : null;
      const room = roomId ? rooms.get(roomId) : null;

      if (req.method === 'GET' && apiPath.match(/^\/api\/rooms\/[a-z0-9]{6}$/)) {
        if (!room) return json(res, 404, { error: 'room not found' });
        return json(res, 200, { id: room.id, exists: true, locked: !!room.locked });
      }

      if (req.method === 'GET' && apiPath.match(/^\/api\/rooms\/[a-z0-9]{6}\/state$/)) {
        if (!room) return json(res, 404, { error: 'room not found' });
        return json(res, 200, publicState(room));
      }

      if (req.method === 'GET' && apiPath.match(/^\/api\/rooms\/[a-z0-9]{6}\/events$/)) {
        if (!room) return json(res, 404, { error: 'room not found' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*',
        });
        room.sse.add(res);
        res.write(`data: ${JSON.stringify(publicState(room))}\n\n`);
        req.on('close', () => room.sse.delete(res));
        return;
      }

      if (req.method === 'POST' && apiPath.match(/^\/api\/rooms\/[a-z0-9]{6}\/join$/)) {
        if (!room) return json(res, 404, { error: 'room not found' });
        const body = await readBody(req);
        const { name, icon, role, reclaimId, subtitle } = body;
        // Soft rejoin: reclaim existing seat by id (refresh / reconnect)
        if (reclaimId) {
          if (room.players[reclaimId]) {
            const existing = room.players[reclaimId];
            existing.lastSeen = now();
            if (name) existing.name = String(name).slice(0, 24);
            if (icon && validIcon(icon) && existing.role !== 'observer') existing.icon = icon;
            if (subtitle != null && existing.role !== 'observer') existing.subtitle = cleanSubtitle(subtitle);
            pickHost(room);
            broadcast(room);
            return json(res, 200, { id: existing.id, roomId: room.id, reclaimed: true, hostId: room.hostId });
          }
          // Seat gone (idle timeout / kick) — do not create a new player from reclaim
          return json(res, 404, { error: 'seat not found' });
        }
        if (room.locked) return json(res, 403, { error: 'room locked' });
        if (!name) return json(res, 400, { error: 'name required' });
        const isObserver = role === 'observer';
        if (!isObserver && !icon) return json(res, 400, { error: 'name and icon required' });
        if (!isObserver && !validIcon(icon)) return json(res, 400, { error: 'bad icon' });
        if (!isObserver) {
          const taken = Object.values(room.players).find(
            x => x.role !== 'observer' && x.name.toLowerCase() === String(name).toLowerCase()
          );
          if (taken) return json(res, 409, { error: 'taken' });
        }
        const p = {
          id: crypto.randomUUID(),
          name: String(name).slice(0, 24),
          icon: isObserver ? '👁️' : icon,
          role: isObserver ? 'observer' : 'player',
          subtitle: isObserver ? '' : cleanSubtitle(subtitle),
          vote: null,
          revealed: !isObserver && room.phase === 'revealed',
          lastSeen: now(),
        };
        room.players[p.id] = p;
        if (!room.hostId) room.hostId = p.id;
        broadcast(room);
        return json(res, 200, { id: p.id, roomId: room.id, hostId: room.hostId });
      }

      if (req.method === 'POST' && apiPath.match(/^\/api\/rooms\/[a-z0-9]{6}\/heartbeat$/)) {
        if (!room) return json(res, 404, { error: 'room not found' });
        const { id } = await readBody(req);
        const p = room.players[id];
        if (!p) return json(res, 404, { error: 'unknown player' });
        p.lastSeen = now();
        // Light broadcast only when someone was stale and is now fresh — skip for noise;
        // clients poll presence via SSE state already; still nudge occasionally
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && apiPath.match(/^\/api\/rooms\/[a-z0-9]{6}\/kick$/)) {
        if (!room) return json(res, 404, { error: 'room not found' });
        const { id, targetId } = await readBody(req);
        if (!requireHost(room, id)) return json(res, 403, { error: 'host only' });
        if (!targetId || targetId === id) return json(res, 400, { error: 'bad target' });
        if (!room.players[targetId]) return json(res, 404, { error: 'unknown player' });
        removePlayer(room, targetId);
        broadcast(room);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && apiPath.match(/^\/api\/rooms\/[a-z0-9]{6}\/lock$/)) {
        if (!room) return json(res, 404, { error: 'room not found' });
        const { id, locked } = await readBody(req);
        if (!requireHost(room, id)) return json(res, 403, { error: 'host only' });
        room.locked = !!locked;
        broadcast(room);
        return json(res, 200, { ok: true, locked: room.locked });
      }

      if (req.method === 'POST' && apiPath.match(/^\/api\/rooms\/[a-z0-9]{6}\/vote$/)) {
        if (!room) return json(res, 404, { error: 'room not found' });
        const { id, value } = await readBody(req);
        const p = room.players[id];
        if (!p) return json(res, 404, { error: 'unknown player' });
        if (p.role === 'observer') return json(res, 403, { error: 'observers cannot vote' });
        if (room.phase === 'revealed') return json(res, 409, { error: 'round already revealed' });
        if (!/^[0-9?☕∞]+$/.test(String(value))) return json(res, 400, { error: 'bad vote' });
        p.vote = String(value).slice(0, 4);
        p.lastSeen = now();
        if (room.phase === 'lobby') room.phase = 'voting';
        broadcast(room);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && apiPath.match(/^\/api\/rooms\/[a-z0-9]{6}\/reveal$/)) {
        if (!room) return json(res, 404, { error: 'room not found' });
        if (room.phase !== 'voting' && room.phase !== 'lobby') return json(res, 409, { error: 'nothing to reveal' });
        room.phase = 'revealed';
        for (const p of Object.values(room.players)) p.revealed = true;
        broadcast(room);
        return json(res, 200, { ok: true, summary: voteSummary(room.players) });
      }

      if (req.method === 'POST' && apiPath.match(/^\/api\/rooms\/[a-z0-9]{6}\/next$/)) {
        if (!room) return json(res, 404, { error: 'room not found' });
        archiveRound(room);
        room.round += 1;
        room.phase = 'voting';
        room.question = '';
        for (const p of Object.values(room.players)) { p.vote = null; p.revealed = false; }
        broadcast(room);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && apiPath.match(/^\/api\/rooms\/[a-z0-9]{6}\/question$/)) {
        if (!room) return json(res, 404, { error: 'room not found' });
        const { question } = await readBody(req);
        room.question = String(question || '').slice(0, 200);
        broadcast(room);
        return json(res, 200, { ok: true });
      }

      const leaveM = apiPath.match(/^\/api\/rooms\/([a-z0-9]{6})\/leave\/([^/]+)$/);
      if (req.method === 'DELETE' && leaveM) {
        const r = rooms.get(leaveM[1]);
        if (r && r.players[leaveM[2]]) {
          removePlayer(r, leaveM[2]);
          broadcast(r);
        }
        return json(res, 200, { ok: true });
      }
    }
  } catch {
    return json(res, 400, { error: 'bad request' });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => console.log(`business wife hub on :${PORT}`));
