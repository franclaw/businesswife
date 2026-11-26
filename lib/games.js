// Curve Club: fixed-step, server-authoritative Zatacka simulation.
// Rooms are intentionally ephemeral. Reconnecting players reclaim their seat.
const crypto = require('crypto');
const { performance } = require('node:perf_hooks');
const { readBody, json } = require('./http');
const sse = require('./sse');
const { Sim, wormTemplate, RADIUS, FIELD_W, FIELD_H, BORDER } = require('../games/vendor/zatacka/engine.cjs');

const MAX_PLAYERS = 10;
const DT = 1 / 60;
const { collectItems } = require('./curve-items');
const COLORS = ['#7d9dff', '#ff737e', '#f4cd70', '#65d69b', '#ed8cc9', '#84dfec', '#c6a0ff', '#ffa66e', '#d5e77e', '#e6e5ef'];
const id = () => crypto.randomBytes(4).toString('hex');
const rounded = (n, precision = 10) => Math.round(n * precision) / precision;

function roomState(room, full = false) {
  const sim = room.sim;
  return {
    id: room.id, host: room.host, phase: room.phase, generation: room.generation, trailEpoch: room.trailEpoch,
    items: room.items, pickupNotice: room.pickupNotice || null,
    full, trailFrom: full ? 0 : room.sent, trailTo: room.trails.length,
    trails: full ? room.trails : room.trails.slice(room.sent),
    players: room.players.map(p => ({
      id: p.id, name: p.name, color: p.color, slot: p.slot, alive: p.alive,
      x: rounded(p.x), y: rounded(p.y), yaw: rounded(p.yaw || 0, 10000),
      inHole: !!p.inHole, turn: p.turn, inputSeq: p.inputSeq, score: p.score, totalScore: p.totalScore || 0, roundsPlayed: p.roundsPlayed || 0, effect: p.effect || null, spawn: p.spawn || null,
    })),
    countdown: room.phase === 'playing' && sim?.phase === 'countdown' ? Math.max(1, Math.ceil(3 - sim.phaseT)) : null,
    elapsed: rounded(sim?.time || 0), solo: room.players.length === 1,
    winner: room.winner, reason: room.reason, maxPlayers: MAX_PLAYERS,
    field: { width: FIELD_W, height: FIELD_H, border: BORDER, radius: RADIUS, speed: sim?.speed || 108, turnRate: sim?.turnRate || 2.85 },
  };
}

function broadcast(room) {
  const frame = `data: ${JSON.stringify(roomState(room))}\n\n`;
  for (const res of room.listeners) {
    // A slow consumer must rejoin with a full snapshot, not accumulate stale play.
    if (res.writableLength > 256 * 1024) { res.destroy(); room.listeners.delete(res); continue; }
    try { res.write(frame); } catch { room.listeners.delete(res); }
  }
  room.sent = room.trails.length;
}

function makeSim(room, seed) {
  return new Sim({ speed: 1, holes: true, barriers: 0, targetScore: 5 }, seed, room.players.map(p => ({ ...wormTemplate(p.id, p.name, 0, 'human'), color: p.color, dim: p.color })));
}
function prepareRoom(room) {
  room.nextSeed = crypto.randomBytes(4).readUInt32LE();
  if (!room.players.length) return;
  const preview = makeSim(room, room.nextSeed);
  room.players.forEach((p, i) => {
    const { x, y, yaw } = preview.worms[i];
    p.spawn = { x, y, yaw };
  });
}

function finish(room, reason = 'collision') {
  if (room.phase === 'over') return;
  room.phase = 'over'; room.reason = reason;
  const survivors = room.sim.worms.filter(w => w.alive);
  room.winner = room.players.length > 1 && survivors.length === 1 ? survivors[0].id : null;
  if (room.players.length === 1) room.players[0].score = rounded(room.sim.time);
  for (const p of room.players) {
    p.totalScore = rounded((p.totalScore || 0) + p.score);
    p.roundsPlayed = (p.roundsPlayed || 0) + 1;
    p.turn = 0;
  }
  prepareRoom(room);
}

function step(room, now) {
  const sim = room.sim;
  for (const p of room.players) {
    if (now - p.lastInputAt > 2500) p.turn = 0;
    sim.setInput(p.id, p.turn === -1, p.turn === 1);
  }
  if (sim.phase === 'playing') collectItems(room);
  sim.step(DT);
  for (const p of room.players) {
    const w = sim.worms.find(w => w.id === p.id);
    Object.assign(p, { x: w.x, y: w.y, yaw: w.yaw, alive: w.alive, inHole: w.inHole, score: w.score });
    if (sim.phase === 'playing' && w.alive && !w.inHole) room.trails.push([p.slot, rounded(w.x), rounded(w.y)]);
  }
  sim.drain();
  if (sim.phase === 'roundend' || (room.players.length === 1 && !sim.worms[0].alive)) finish(room);
  else if (sim.time >= 120) finish(room, 'time');
  room.tick++;
  if (room.tick % 3 === 0 || room.phase === 'over') broadcast(room);
}

function createGames() {
  const rooms = new Map();
  let last = performance.now(), accumulator = 0;
  // Poll the clock often; advance physics individually at 60 Hz, send at 20 Hz.
  const timer = setInterval(() => {
    const mono = performance.now(), now = Date.now();
    accumulator += Math.min((mono - last) / 1000, 0.1); last = mono;
    while (accumulator >= DT) {
      for (const room of rooms.values()) if (room.phase === 'playing') step(room, now);
      accumulator -= DT;
    }
    for (const [key, room] of rooms) {
      if (room.listeners.size) room.touched = now;
      if (now - room.touched > 3600000) { for (const res of room.listeners) res.end(); rooms.delete(key); }
    }
  }, 8);
  timer.unref();

  return {
    listeners: () => [...rooms.values()].map(r => r.listeners),
    async handle(req, res, path) {
      if (path === '/games/api/rooms' && req.method === 'POST') {
        if (rooms.size >= 200) return json(res, 503, { error: 'Room limit reached. Try again later.' });
        let key; do { key = id(); } while (rooms.has(key));
        const room = { id: key, host: null, phase: 'lobby', players: [], listeners: new Set(), trails: [], sent: 0, tick: 0, generation: 0, winner: null, reason: null, items: [], nextItem: 0, trailEpoch: 0, touched: Date.now() };
        rooms.set(key, room); return json(res, 201, { id: key });
      }
      const match = path.match(/^\/games\/api\/rooms\/([a-f0-9]{8})(?:\/(join|events|turn|start|leave))?$/);
      if (!match) return false;
      const room = rooms.get(match[1]), action = match[2];
      if (!room) return json(res, 404, { error: 'This room has expired. Create a new one to play.' });
      room.touched = Date.now();
      if (req.method === 'GET' && action === 'events') {
        req.socket.setNoDelay(true); sse.open(req, res, room.listeners, roomState(room, true)); return;
      }
      if (req.method === 'GET' && !action) return json(res, 200, roomState(room, true));
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      const body = await readBody(req, 2048);
      if (action === 'join') {
        const existing = room.players.find(p => p.token === body.token);
        if (existing) return json(res, 200, { id: existing.id, token: existing.token, inputSeq: existing.inputSeq });
        if (room.phase === 'playing') return json(res, 409, { error: 'This round is underway. Join when it finishes.' });
        if (room.players.length >= MAX_PLAYERS) return json(res, 409, { error: 'This room is full (10 players).' });
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 20) : '';
        if (!name) return json(res, 400, { error: 'Enter your name.' });
        const slot = COLORS.findIndex((_, i) => !room.players.some(p => p.slot === i));
        const p = { id: id(), token: crypto.randomBytes(16).toString('hex'), name, slot, color: COLORS[slot], x: 0, y: 0, yaw: 0, alive: false, turn: 0, score: 0, totalScore: 0, roundsPlayed: 0, inputSeq: 0, lastInputAt: Date.now() };
        room.players.push(p); if (!room.host) room.host = p.id;
        prepareRoom(room);
        json(res, 200, { id: p.id, token: p.token, inputSeq: p.inputSeq }); broadcast(room); return;
      }
      const p = room.players.find(p => p.token === body.token);
      if (!p) return json(res, 403, { error: 'Join the room first.' });
      if (action === 'turn') {
        if (![-1, 0, 1].includes(body.turn) || !Number.isSafeInteger(body.seq) || body.seq < 1) return json(res, 400, { error: 'Invalid steering input.' });
        if (body.generation === room.generation && body.seq > p.inputSeq) {
          p.inputSeq = body.seq; p.lastInputAt = Date.now();
          p.turn = room.phase === 'playing' ? body.turn : 0;
        }
        return json(res, 200, { ok: true, seq: p.inputSeq, generation: room.generation });
      }
      if (action === 'leave') {
        if (room.phase === 'playing') return json(res, 409, { error: 'Wait for this round to finish before leaving your seat.' });
        room.players = room.players.filter(player => player !== p);
        if (room.host === p.id) room.host = room.players[0]?.id || null;
        prepareRoom(room);
        json(res, 200, { ok: true }); broadcast(room); return;
      }
      if (action === 'start') {
        if (p.id !== room.host || room.phase === 'playing') return json(res, 409, { error: 'Only the host can start a new round.' });
        room.trails = []; room.sent = 0; room.tick = 0; room.winner = null; room.reason = null;
        room.generation++; room.phase = 'playing'; room.trailEpoch = 0; room.items = []; room.pickupNotice = null; room.nextItem = 1;
        room.sim = makeSim(room, room.nextSeed);
        room.players.forEach((player, i) => Object.assign(player, { x: room.sim.worms[i].x, y: room.sim.worms[i].y, yaw: room.sim.worms[i].yaw, alive: true, inHole: false, turn: 0, score: 0, lastInputAt: Date.now(), effect: null }));
        json(res, 200, { ok: true, generation: room.generation }); broadcast(room); return;
      }
      return json(res, 404, { error: 'Not found' });
    },
  };
}
module.exports = { createGames };
