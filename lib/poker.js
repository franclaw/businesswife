// Planning poker rooms. Presence-based and in memory: a room empties when
// everyone leaves, so it does not need to survive a restart.
//
// Auth model. Every seat has two ids:
//   - `id`, public: broadcast in room state so clients can draw the table.
//     It never authorises anything.
//   - `secret`, private: returned once by /join, kept only as a hash. Every
//     mutation must carry it (X-Seat-Secret header or `secret` in the body).
// There is no host guard on the round: any seated player may reveal, re-vote,
// start the next round or edit the story. What we guarantee is that the caller
// is a real, visible seat, and every such action is attributed on the table
// through `lastAction`. Kick and lock stay host tools.
const sse = require('./sse');
const { now, newShortId, hashKey, newSecret } = require('./util');
const { json, readBody } = require('./http');
const { validIcon } = require('./icons');

const STALE_MS = 45_000;
const IDLE_REMOVE_MS = 90_000;
const NAME_MAX = 24;
const SUBTITLE_MAX = 40;
const QUESTION_MAX = 200;
const HISTORY_MAX = 40;
const SEATS_MAX = 40;

const cleanName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
/** Custom wife subtitle — optional, short, single line. */
const cleanSubtitle = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, SUBTITLE_MAX));
const isNumericVote = (v) => v != null && /^\d+$/.test(String(v));

function voteSummary(players) {
  const votes = Object.values(players)
    .filter((p) => p.role !== 'observer' && p.vote != null)
    .map((p) => ({ name: p.name, vote: p.vote }));
  const numeric = votes.map((v) => v.vote).filter(isNumericVote).map(Number);
  const sorted = [...numeric].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length
    ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2)
    : null;
  return {
    median,
    count: votes.length,
    numericCount: numeric.length,
    special: votes.filter((v) => !isNumericVote(v.vote)).map((v) => v.vote),
    votes,
  };
}

function createPoker() {
  const rooms = new Map();

  function makeRoom(id) {
    return {
      id,
      round: 1,
      phase: 'lobby',
      question: '',
      hostId: null,
      locked: false,
      players: {},     // public id -> player (with secretHash)
      history: [],
      lastAction: null, // { type, playerId, playerName, detail?, at }
      sse: new Set(),
    };
  }

  function pickHost(room) {
    if (room.hostId && room.players[room.hostId]) return;
    const all = Object.values(room.players);
    const player = all.find((p) => p.role !== 'observer') || all[0];
    room.hostId = player ? player.id : null;
  }

  function removePlayer(room, playerId) {
    if (!room.players[playerId]) return;
    delete room.players[playerId];
    if (room.hostId === playerId) { room.hostId = null; pickHost(room); }
  }

  function archiveRound(room) {
    if (room.phase !== 'revealed') return;
    room.history.unshift({ round: room.round, question: room.question || '', at: now(), summary: voteSummary(room.players) });
    if (room.history.length > HISTORY_MAX) room.history.length = HISTORY_MAX;
  }

  function clearVotes(room) {
    for (const p of Object.values(room.players)) { p.vote = null; p.revealed = false; }
  }

  // Never includes a secret or its hash: this goes to every listener.
  function publicState(room) {
    const t = now();
    const players = Object.values(room.players).map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon,
      role: p.role,
      raw: p.raw ? true : null,
      subtitle: p.subtitle || null,
      vote: p.revealed ? p.vote : (p.vote ? '🔒' : null),
      revealed: p.revealed,
      hasVoted: p.role !== 'observer' && !!p.vote,
      isHost: p.id === room.hostId,
      lastSeen: p.lastSeen,
      connected: (t - (p.lastSeen || 0)) < STALE_MS,
      stale: (t - (p.lastSeen || 0)) >= STALE_MS,
    }));
    return {
      roomId: room.id,
      round: room.round,
      phase: room.phase,
      question: room.question,
      hostId: room.hostId,
      locked: !!room.locked,
      history: room.history,
      summary: room.phase === 'revealed' ? voteSummary(room.players) : null,
      lastAction: room.lastAction,
      players: players.sort((a, b) => (a.id < b.id ? -1 : 1)),
    };
  }

  const broadcast = (room) => sse.send(room.sse, publicState(room));

  function attribute(room, p, type, detail) {
    room.lastAction = { type, playerId: p.id, playerName: p.name, at: now() };
    if (detail != null) room.lastAction.detail = detail;
  }

  function secretOf(req, body) {
    const h = req.headers['x-seat-secret'];
    if (typeof h === 'string' && h) return h;
    return typeof body.secret === 'string' ? body.secret : '';
  }

  function seatBySecret(room, secret) {
    if (!secret) return null;
    const hash = hashKey(secret);
    return Object.values(room.players).find((p) => p.secretHash === hash) || null;
  }

  // Fails closed. An old client still sending a bare `id` gets a clear reason.
  function requireSeat(req, res, room, body) {
    const secret = secretOf(req, body);
    const p = seatBySecret(room, secret);
    if (p) { p.lastSeen = now(); return p; }
    json(res, 401, secret
      ? { error: 'seat not found', rejoin: true }
      : { error: 'refresh to rejoin', rejoin: true });
    return null;
  }

  // Presence sweeper — drop idle seats so ghosts don't linger, and drop rooms
  // nobody is in or watching.
  setInterval(() => {
    const t = now();
    for (const [id, room] of rooms) {
      let changed = false;
      for (const p of Object.values(room.players)) {
        if (t - (p.lastSeen || 0) > IDLE_REMOVE_MS) { removePlayer(room, p.id); changed = true; }
      }
      if (changed) broadcast(room);
      if (!Object.keys(room.players).length && !room.sse.size) rooms.delete(id);
    }
  }, 15_000).unref();

  function join(req, res, room, body) {
    const { name, icon, role, subtitle, raw } = body;
    // Soft rejoin (refresh / reconnect): the secret proves it is the same seat.
    const secret = secretOf(req, body);
    if (secret || body.reclaimId) {
      const existing = seatBySecret(room, secret);
      if (!existing) return json(res, 404, { error: 'seat not found' });
      existing.lastSeen = now();
      const clean = cleanName(name);
      if (clean) existing.name = clean;
      if (icon && validIcon(icon) && existing.role !== 'observer') existing.icon = icon;
      if (icon && validIcon(icon)) existing.raw = raw === true && /^data:image\//.test(icon) ? true : null;
      if (subtitle != null && existing.role !== 'observer') existing.subtitle = cleanSubtitle(subtitle);
      pickHost(room);
      broadcast(room);
      return json(res, 200, { id: existing.id, secret, roomId: room.id, reclaimed: true, hostId: room.hostId });
    }
    if (room.locked) return json(res, 403, { error: 'room locked' });
    const clean = cleanName(name);
    if (!clean) return json(res, 400, { error: 'name required' });
    if (Object.keys(room.players).length >= SEATS_MAX) return json(res, 409, { error: 'room full' });
    const isObserver = role === 'observer';
    if (!isObserver && !icon) return json(res, 400, { error: 'name and icon required' });
    if (!isObserver && !validIcon(icon)) return json(res, 400, { error: 'bad icon' });
    if (!isObserver) {
      const taken = Object.values(room.players).find((x) => x.role !== 'observer' && x.name.toLowerCase() === clean.toLowerCase());
      if (taken) return json(res, 409, { error: 'taken' });
    }
    const seatSecret = newSecret();
    const p = {
      id: newSecret(),
      secretHash: hashKey(seatSecret),
      name: clean,
      icon: isObserver ? '👁️' : icon,
      raw: !isObserver && raw === true && /^data:image\//.test(icon) ? true : null,
      role: isObserver ? 'observer' : 'player',
      subtitle: isObserver ? '' : cleanSubtitle(subtitle),
      vote: null,
      revealed: !isObserver && room.phase === 'revealed',
      lastSeen: now(),
    };
    room.players[p.id] = p;
    pickHost(room);
    broadcast(room);
    return json(res, 200, { id: p.id, secret: seatSecret, roomId: room.id, hostId: room.hostId });
  }

  // Seated actions. Each gets the room, the caller's seat and the body.
  const actions = {
    heartbeat(res) {
      return json(res, 200, { ok: true });
    },

    leave(res, room, p) {
      removePlayer(room, p.id);
      broadcast(room);
      return json(res, 200, { ok: true });
    },

    vote(res, room, p, body) {
      if (p.role === 'observer') return json(res, 403, { error: 'observers cannot vote' });
      if (room.phase === 'revealed') return json(res, 409, { error: 'round already revealed' });
      if (!/^[0-9?☕∞]{1,4}$/.test(String(body.value))) return json(res, 400, { error: 'bad vote' });
      p.vote = String(body.value);
      if (room.phase === 'lobby') room.phase = 'voting';
      broadcast(room);
      return json(res, 200, { ok: true });
    },

    reveal(res, room, p) {
      if (room.phase === 'revealed') return json(res, 409, { error: 'nothing to reveal' });
      room.phase = 'revealed';
      for (const x of Object.values(room.players)) x.revealed = true;
      attribute(room, p, 'reveal');
      broadcast(room);
      return json(res, 200, { ok: true, summary: voteSummary(room.players) });
    },

    revote(res, room, p) {
      if (room.phase !== 'revealed') return json(res, 409, { error: 'cards are not revealed' });
      room.phase = 'voting';
      clearVotes(room);
      attribute(room, p, 'revote');
      broadcast(room);
      return json(res, 200, { ok: true });
    },

    next(res, room, p) {
      archiveRound(room);
      room.round += 1;
      room.phase = 'voting';
      room.question = '';
      clearVotes(room);
      attribute(room, p, 'next', room.round);
      broadcast(room);
      return json(res, 200, { ok: true });
    },

    question(res, room, p, body) {
      const q = String(body.question ?? '').slice(0, QUESTION_MAX);
      if (q !== room.question) {
        room.question = q;
        attribute(room, p, 'question');
        broadcast(room);
      }
      return json(res, 200, { ok: true });
    },

    kick(res, room, p, body) {
      if (room.hostId !== p.id) return json(res, 403, { error: 'host only' });
      const target = room.players[body.targetId];
      if (!target || target.id === p.id) return json(res, 400, { error: 'bad target' });
      removePlayer(room, target.id);
      attribute(room, p, 'kick', target.name);
      broadcast(room);
      return json(res, 200, { ok: true });
    },

    lock(res, room, p, body) {
      if (room.hostId !== p.id) return json(res, 403, { error: 'host only' });
      room.locked = !!body.locked;
      attribute(room, p, room.locked ? 'lock' : 'unlock');
      broadcast(room);
      return json(res, 200, { ok: true, locked: room.locked });
    },
  };

  async function handle(req, res, pathname) {
    // /planning-poker/api/rooms/... and the legacy /api/rooms/...
    let api = null;
    if (pathname.startsWith('/planning-poker/api/rooms')) api = pathname.slice('/planning-poker'.length);
    else if (pathname.startsWith('/api/rooms')) api = pathname;
    if (!api) return false;

    if (req.method === 'POST' && api === '/api/rooms') {
      const id = newShortId(rooms);
      rooms.set(id, makeRoom(id));
      return json(res, 200, { id });
    }

    const m = api.match(/^\/api\/rooms\/([a-z0-9]{6})(?:\/([a-z]+))?(?:\/[^/]+)?$/);
    if (!m) return false;
    const room = rooms.get(m[1]);
    const sub = m[2] || '';
    if (!room) return json(res, 404, { error: 'room not found' });

    if (req.method === 'GET' && !sub) return json(res, 200, { id: room.id, exists: true, locked: !!room.locked });
    if (req.method === 'GET' && sub === 'state') return json(res, 200, publicState(room));
    if (req.method === 'GET' && sub === 'events') return sse.open(req, res, room.sse, publicState(room));

    if (req.method === 'POST' && sub === 'join') return join(req, res, room, await readBody(req));

    // DELETE /leave/<id> is the old shape; it now needs the secret too.
    const isLeave = sub === 'leave' && (req.method === 'DELETE' || req.method === 'POST');
    if (req.method === 'POST' || isLeave) {
      const action = actions[sub];
      if (!action || (sub === 'leave' && !isLeave)) return false;
      const body = req.method === 'POST' ? await readBody(req) : {};
      const p = requireSeat(req, res, room, body);
      if (!p) return;
      return action(res, room, p, body);
    }
    return false;
  }

  return { handle, listeners: () => [...rooms.values()].map((r) => r.sse) };
}

module.exports = { createPoker, voteSummary };
