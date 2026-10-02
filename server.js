#!/usr/bin/env node
// Business Wife hub — planning poker + pomodoro
// Zero-dependency Node: rooms + static UI + in-memory state + SSE.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT ? Number(process.env.PORT) : 6969;
const ROOT = __dirname;
const HUB = path.join(ROOT, 'hub.html');
const POKER_INDEX = path.join(ROOT, 'index.html');
const POMODORO_DIR = path.join(ROOT, 'pomodoro');
const POKER_PWA_DIR = path.join(ROOT, 'planning-poker');
const PUBLIC = path.join(ROOT, 'public');
const ROOM_RE = /^[a-z0-9]{6}$/;
const ID_CHARS = '23456789abcdefghjkmnpqrstuvwxyz';

const rooms = new Map(); // id -> room

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
    players: {},
    sse: new Set(),
  };
}

function publicState(room) {
  const players = Object.values(room.players).map(p => ({
    id: p.id,
    name: p.name,
    icon: p.icon,
    role: p.role || 'player',
    vote: p.revealed ? p.vote : (p.vote ? '🔒' : null),
    revealed: p.revealed,
    hasVoted: p.role !== 'observer' && !!p.vote,
  }));
  return {
    roomId: room.id,
    round: room.round,
    phase: room.phase,
    question: room.question,
    players: players.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

function broadcast(room) {
  const data = `data: ${JSON.stringify(publicState(room))}\n\n`;
  for (const res of room.sse) {
    try { res.write(data); } catch { room.sse.delete(res); }
  }
}

setInterval(() => {
  for (const room of rooms.values()) {
    for (const res of room.sse) {
      try { res.write(': ping\n\n'); } catch { room.sse.delete(res); }
    }
  }
}, 25000);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
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
    return serveHtml(res, POKER_INDEX);
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
        return json(res, 200, { id: room.id, exists: true });
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
        const { name, icon, role } = await readBody(req);
        if (!name) return json(res, 400, { error: 'name required' });
        const isObserver = role === 'observer';
        if (!isObserver && !icon) return json(res, 400, { error: 'name and icon required' });
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
          vote: null,
          revealed: !isObserver && room.phase === 'revealed',
        };
        room.players[p.id] = p;
        broadcast(room);
        return json(res, 200, { id: p.id, roomId: room.id });
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
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && apiPath.match(/^\/api\/rooms\/[a-z0-9]{6}\/next$/)) {
        if (!room) return json(res, 404, { error: 'room not found' });
        room.round += 1;
        room.phase = 'voting';
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
        if (r && r.players[leaveM[2]]) delete r.players[leaveM[2]];
        if (r) broadcast(r);
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
