// Reusable rooms own identity and sessions; activity modules own voting rules.
const sse = require('./sse');
const { json, readBody } = require('./http');
const { newShortId, newSecret, hashKey, matchesHash, ID_RE } = require('./util');
const { validIcon, isUpload } = require('./icons');
const { activityTypes, text } = require('./meeting-activities');

// Calendar month, UTC, clamped at month end (Jan 31 -> Feb 28/29).
function monthAfter(timestamp) {
  const date = new Date(timestamp), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + 1);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime();
}
function createMeetings(store, uploads) {
  const rooms = new Map();
  const session = () => ({ id: newSecret(), startedAt: Date.now(), endedAt: null, activities: [] });
  const current = r => r.sessions.at(-1);
  const active = r => current(r).activities.find(a => a.id === r.activeId);
  function state(r) {
    return { id: r.id, title: r.title, expiresAt: monthAfter(r.usedAt), hostId: r.hostId, activeId: r.activeId,
      members: Object.values(r.members).map(({ secretHash, ...m }) => m),
      sessions: r.sessions.map(s => ({ ...s, activities: s.activities.map(a => {
        const { responses, ...publicActivity } = a;
        return { ...publicActivity, responseIds: Object.keys(responses), results: a.phase === 'closed' ? activityTypes[a.type].results(a, r.members) : null };
      }) })) };
  }
  function changed(r) { r.usedAt = Date.now(); store.scheduleSave(); sse.send(r.sse, state(r)); }
  function expired(r) { return Date.now() >= monthAfter(r.usedAt); }
  store.register('meetingRooms', {
    dump: () => [...rooms.values()].filter(r => !expired(r)).map(({ sse, ...r }) => r),
    load(list) {
      for (const r of list) {
        if (!r || !ID_RE.test(r.id) || !Number.isFinite(r.usedAt) || expired(r) || !r.members || !Array.isArray(r.sessions) || !r.sessions.length) continue;
        r.sse = new Set(); rooms.set(r.id, r);
      }
      return rooms.size;
    },
  });
  setInterval(() => {
    for (const [id, r] of rooms) if (expired(r)) {
      for (const res of r.sse) res.end();
      rooms.delete(id); store.scheduleSave();
    }
  }, 60_000).unref();
  async function handle(req, res, pathname) {
    if (req.method === 'POST' && pathname === '/meeting-room/api/rooms') {
      const body = await readBody(req);
      if (rooms.size >= 5000) return json(res, 503, { error: 'Too many rooms right now.' });
      const id = newShortId(rooms), ownerToken = newSecret();
      const r = { id, title: text(body.title, 120) || 'Meeting Room', ownerHash: hashKey(ownerToken), usedAt: Date.now(), hostId: null, members: {}, sessions: [session()], activeId: null, sse: new Set() };
      rooms.set(id, r); changed(r);
      return json(res, 200, { id, ownerToken });
    }
    const match = pathname.match(/^\/meeting-room\/api\/rooms\/([a-z0-9]{6})(?:\/([a-z-]+))?$/);
    if (!match) return false;
    const r = rooms.get(match[1]), action = match[2];
    if (!r || expired(r)) return json(res, 404, { error: 'Room not found or expired.' });
    // Public reads, reconnects and link previews deliberately never renew expiry.
    if (req.method === 'GET' && !action) return json(res, 200, state(r));
    if (req.method === 'GET' && action === 'events') return sse.open(req, res, r.sse, state(r));
    if (req.method !== 'POST') return false;
    const body = await readBody(req);
    const secret = req.headers['x-seat-secret'] || body.secret;
    let member = Object.values(r.members).find(m => matchesHash(secret, m.secretHash));
    if (action === 'join') {
      if (secret && !member) return json(res, 401, { error: 'Please choose your identity again.' });
      if (!member) {
        const name = text(body.name, 24);
        if (!name || (body.icon && !validIcon(body.icon))) return json(res, 400, { error: 'Choose a name and valid portrait.' });
        if (Object.values(r.members).some(m => m.name.toLowerCase() === name.toLowerCase())) return json(res, 409, { error: 'That name is already taken.' });
        if (Object.keys(r.members).length >= 64) return json(res, 409, { error: 'This room is full.' });
        const token = newSecret();
        member = { id: newSecret(), name, icon: body.icon ? uploads.intake(body.icon) : '💼', raw: body.raw === true && isUpload(body.icon), secretHash: hashKey(token) };
        r.members[member.id] = member;
        if (matchesHash(body.ownerToken, r.ownerHash)) r.hostId = member.id;
        changed(r); return json(res, 200, { id: member.id, secret: token });
      }
      if (matchesHash(body.ownerToken, r.ownerHash)) r.hostId = member.id;
      changed(r); return json(res, 200, { id: member.id });
    }
    if (!member) return json(res, 401, { error: 'Join the room first.' });
    if (action === 'respond') {
      const a = active(r);
      if (!a || a.phase !== 'open') return json(res, 409, { error: 'No open activity.' });
      if (body.activityId !== a.id) return json(res, 409, { error: 'The activity changed. Please vote again.' });
      if (!activityTypes[a.type].valid(body.value, a)) return json(res, 400, { error: 'Invalid response.' });
      if (a.type === 'poll' && Object.hasOwn(a.responses, member.id) && a.responses[member.id] !== body.value) return json(res, 409, { error: 'Your poll vote is final.' });
      a.responses[member.id] = body.value;
    } else {
      if (member.id !== r.hostId) return json(res, 403, { error: 'Facilitator only.' });
      if (action === 'activity') {
        const type = Object.hasOwn(activityTypes, body.type) && activityTypes[body.type];
        const config = type && type.configure(body);
        if (!config) return json(res, 400, { error: 'Provide a question and 2–8 distinct poll options.' });
        if (current(r).endedAt) return json(res, 409, { error: 'Start a new meeting first.' });
        if (current(r).activities.length >= 200) return json(res, 409, { error: 'Start a new meeting to add more activities.' });
        const a = { id: newSecret(), type: body.type, ...config, phase: 'open', responses: {}, createdAt: Date.now() };
        // Suspended activities retain responses and can be resumed unchanged.
        current(r).activities.push(a); r.activeId = a.id;
      } else if (action === 'switch') {
        if (current(r).endedAt || !current(r).activities.some(a => a.id === body.activityId)) return json(res, 400, { error: 'Activity not in this meeting.' });
        r.activeId = body.activityId;
      } else if (action === 'close' || action === 'revote') {
        const a = active(r);
        if (!a || a.id !== body.activityId) return json(res, 409, { error: 'The activity changed.' });
        if (action === 'revote') {
          if (a.type !== 'poker' || a.phase !== 'closed') return json(res, 409, { error: 'Reveal poker cards before re-voting.' });
          a.responses = {}; a.phase = 'open';
        } else { a.phase = 'closed'; }
      } else if (action === 'handover') {
        if (!Object.hasOwn(r.members, body.memberId)) return json(res, 400, { error: 'Participant not found.' });
        r.hostId = body.memberId;
      } else if (action === 'end') {
        const s = current(r); s.endedAt = s.endedAt || Date.now();
        for (const a of s.activities) a.phase = 'closed';
        r.activeId = null;
      } else if (action === 'session') {
        if (!current(r).endedAt) return json(res, 409, { error: 'End this meeting first.' });
        if (r.sessions.length >= 100) return json(res, 409, { error: 'This room has reached its meeting limit. Create a new room.' });
        r.sessions.push(session()); r.activeId = null;
      } else return false;
    }
    changed(r); return json(res, 200, { ok: true });
  }
  return { handle, listeners: () => [...rooms.values()].map(r => r.sse), iconsInUse: () => [...rooms.values()].flatMap(r => Object.values(r.members).map(m => m.icon)) };
}
module.exports = { createMeetings, monthAfter };
