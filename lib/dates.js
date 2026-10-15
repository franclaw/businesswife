// Date picker: the creator proposes days and parts of the day, people mark
// when they are free, the creator sets the final date.
//
// Availability is keyed by *name*, not by device: anyone may fill in or correct
// anyone else's dates. Locking a name hands back a secret edit link that becomes
// the only way to edit that name from then on. The creator link is a separate
// secret. Both are kept only as hashes.
const sse = require('./sse');
const { ID_RE, DAY_MS, now, newShortId, hashKey, matchesHash, newSecret } = require('./util');
const { json, readBody } = require('./http');

const DATE_TITLE_MAX = 80;
const DATE_MAX_DAYS = 14;
const DATE_MAX_AHEAD_DAYS = 90;
const DATE_PEOPLE_MAX = 64;
const DATE_MAX_SLOTS = 42;
const DATE_NAME_MAX = 24;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// A pick lives 60 days after its last change; once it has a set date it lives
// until 14 days after that date (never less than 14 days after its last change).
const KEEP_IDLE_MS = 60 * DAY_MS;
const KEEP_AFTER_DATE_MS = 14 * DAY_MS;
const MAX_STORED = 5_000;
const SWEEP_MS = 60_000;
// Coarse by design: a phone grid cannot hold day x block x precise hour.
const BLOCKS = [
  { id: 'morning', label: 'Morning', short: 'M' },
  { id: 'afternoon', label: 'Afternoon', short: 'A' },
  { id: 'evening', label: 'Evening', short: 'E' },
];

const slotKey = (date, block) => date + '|' + block;
const cleanPersonName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, DATE_NAME_MAX);
// "Sana", " sana " and "SANA" are one person.
const nameKey = (name) => cleanPersonName(name).toLowerCase();
const blockRank = (id) => BLOCKS.findIndex((b) => b.id === id);

function sortSlots(slots) {
  return slots.sort((a, b) => (a.date === b.date ? blockRank(a.block) - blockRank(b.block) : a.date < b.date ? -1 : 1));
}

function slotLimitError(slots) {
  if (new Set(slots.map((s) => s.date)).size > DATE_MAX_DAYS) return `at most ${DATE_MAX_DAYS} days`;
  if (slots.length > DATE_MAX_SLOTS) return `at most ${DATE_MAX_SLOTS} date parts`;
  return null;
}

/** Midnight UTC today. Days are plain calendar dates, compared in UTC. */
function todayUtc(t = now()) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Creator proposes the candidates: a list of days, each with the parts of the
// day that are actually on the table. Yesterday is allowed so a creator a few
// time zones west of UTC can still propose "today".
function parseCreate(body) {
  const title = String(body.title ?? '').replace(/\s+/g, ' ').trim().slice(0, DATE_TITLE_MAX);
  if (!title) return { error: 'title required' };
  const raw = Array.isArray(body.days) ? body.days : [];
  const today = todayUtc();
  const min = today - DAY_MS;
  const max = today + DATE_MAX_AHEAD_DAYS * DAY_MS;
  const seen = new Set();
  const slots = [];
  for (const entry of raw) {
    const date = String(entry?.date ?? '');
    if (!DAY_RE.test(date)) return { error: 'bad date' };
    const t = Date.parse(date + 'T00:00:00Z');
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date) return { error: 'bad date' };
    if (t < min || t > max) return { error: 'date out of range' };
    const blocks = Array.isArray(entry?.blocks) ? entry.blocks : [];
    const valid = BLOCKS.filter((b) => blocks.includes(b.id)).map((b) => b.id);
    if (!valid.length) return { error: 'each date needs at least one part of the day' };
    for (const block of valid) {
      const key = slotKey(date, block);
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push({ date, block });
    }
  }
  if (!slots.length) return { error: 'propose at least one date' };
  const tooMany = slotLimitError(slots);
  if (tooMany) return { error: tooMany };
  return { title, slots: sortSlots(slots) };
}

function createDates(store) {
  const picks = new Map();

  function makePick(title, slots) {
    return {
      id: null,
      title,
      slots,                 // [{date, block}] proposed by the creator
      people: new Map(),     // nameKey -> { name, slots:Set, none, locked, keyHash }
      ownerHash: null,       // hash of the creator link: portable across devices
      closed: false,         // final date set by the creator
      chosen: null,
      createdAt: now(),
      updatedAt: now(),
      sse: new Set(),
    };
  }

  const isAdmin = (pick, token) => matchesHash(token, pick.ownerHash);
  const holdsKey = (p, token) => matchesHash(token, p.keyHash);

  function expiresAt(pick) {
    const idle = pick.updatedAt + KEEP_IDLE_MS;
    if (!pick.chosen) return idle;
    const day = Date.parse(pick.chosen.split('|')[0] + 'T00:00:00Z');
    return Math.max(day + KEEP_AFTER_DATE_MS, pick.updatedAt + KEEP_AFTER_DATE_MS);
  }

  function person(pick, name) {
    const key = nameKey(name);
    if (!key) return null;
    if (!pick.people.has(key)) {
      if (pick.people.size >= DATE_PEOPLE_MAX) return null;
      pick.people.set(key, { name: cleanPersonName(name), slots: new Set(), none: false, locked: false, keyHash: null });
    }
    return pick.people.get(key);
  }

  // Someone with no answer left leaves the head count, so "everyone is free" is
  // not held hostage by an empty row. A name that ever had an edit link stays, so
  // the link keeps resolving.
  function dropIfEmpty(pick, p) {
    if (!p.slots.size && !p.none && !p.keyHash) pick.people.delete(nameKey(p.name));
  }

  // Overlap wins among proposed slots only: most people free, then earliest day,
  // then earliest block.
  function bestSlot(pick) {
    const tally = new Map();
    for (const p of pick.people.values()) {
      for (const key of p.slots) tally.set(key, (tally.get(key) || 0) + 1);
    }
    const order = pick.slots.map((s) => slotKey(s.date, s.block));
    let best = null;
    for (const [key, count] of tally) {
      const rank = order.indexOf(key);
      if (!count || rank < 0) continue;
      const [date, block] = key.split('|');
      if (!best || count > best.count || (count === best.count && rank < best.rank)) {
        best = { date, block, count, rank };
      }
    }
    return best;
  }

  function state(pick) {
    const people = [...pick.people.values()];
    const best = bestSlot(pick);
    const days = [...new Set(pick.slots.map((s) => s.date))].sort();
    return {
      id: pick.id,
      title: pick.title,
      closed: pick.closed,
      chosen: pick.chosen,
      totalPeople: people.length,
      days: days.map((date) => ({
        date,
        blocks: BLOCKS.filter((b) => pick.slots.some((s) => s.date === date && s.block === b.id))
          .map((b) => {
            const key = slotKey(date, b.id);
            const who = people.filter((p) => p.slots.has(key)).map((p) => ({ name: p.name, locked: p.locked }));
            return { id: b.id, label: b.label, short: b.short, count: who.length, who };
          }),
      })),
      people: people.map((p) => ({ name: p.name, locked: p.locked, count: p.slots.size, none: p.none })),
      best: best ? { date: best.date, block: best.block, count: best.count } : null,
      expiresAt: new Date(expiresAt(pick)).toISOString(),
    };
  }

  function changed(pick) {
    pick.updatedAt = now();
    store.scheduleSave();
    sse.send(pick.sse, state(pick));
  }

  store.register('dates', {
    dump: () => [...picks.values()].map((pick) => ({
      id: pick.id,
      title: pick.title,
      slots: pick.slots,
      people: [...pick.people.values()].map((p) => ({
        name: p.name, slots: [...p.slots], none: p.none, locked: p.locked, keyHash: p.keyHash,
      })),
      ownerHash: pick.ownerHash,
      closed: pick.closed,
      chosen: pick.chosen,
      createdAt: pick.createdAt,
      updatedAt: pick.updatedAt,
    })),
    load(list) {
      const t = now();
      for (const d of list) {
        if (!d || typeof d.id !== 'string' || !ID_RE.test(d.id) || !Array.isArray(d.slots)) continue;
        const pick = makePick(String(d.title || ''), d.slots.filter((x) => x && DAY_RE.test(x.date) && blockRank(x.block) >= 0));
        pick.id = d.id;
        pick.ownerHash = typeof d.ownerHash === 'string' ? d.ownerHash : null;
        pick.closed = !!d.closed;
        pick.chosen = typeof d.chosen === 'string' ? d.chosen : null;
        pick.createdAt = Number(d.createdAt) || t;
        pick.updatedAt = Number(d.updatedAt) || pick.createdAt;
        for (const p of Array.isArray(d.people) ? d.people : []) {
          const name = cleanPersonName(p && p.name);
          if (!name) continue;
          pick.people.set(nameKey(name), {
            name,
            slots: new Set(Array.isArray(p.slots) ? p.slots.map(String) : []),
            none: !!p.none,
            locked: !!p.locked,
            keyHash: typeof p.keyHash === 'string' ? p.keyHash : null,
          });
        }
        if (t <= expiresAt(pick)) picks.set(pick.id, pick);
      }
      return picks.size;
    },
  });

  setInterval(() => {
    const t = now();
    for (const [id, pick] of picks) {
      if (t > expiresAt(pick)) { picks.delete(id); store.scheduleSave(); }
    }
  }, SWEEP_MS).unref();

  const onTable = (pick, key) => pick.slots.some((x) => slotKey(x.date, x.block) === key);

  // Shared by /mark and /none: find (or add) the person and check their lock.
  function editable(res, pick, name, token, adding) {
    const clean = cleanPersonName(name);
    if (!clean) { json(res, 400, { error: 'name required' }); return null; }
    if (pick.closed) { json(res, 409, { error: 'a date is already set' }); return null; }
    const existing = pick.people.get(nameKey(clean));
    if (!adding && !existing) return { p: null };
    const p = existing || person(pick, clean);
    if (!p) { json(res, 409, { error: 'too many people on this pick' }); return null; }
    if (p.locked && !holdsKey(p, token)) { json(res, 423, { error: 'locked', name: p.name }); return null; }
    return { p };
  }

  const routes = {
    async 'POST /mark'(req, res, pick) {
      const { name, date, block, on, token } = await readBody(req);
      if (!cleanPersonName(name)) return json(res, 400, { error: 'name required' });
      if (pick.closed) return json(res, 409, { error: 'a date is already set' });
      const key = slotKey(date, block);
      if (!onTable(pick, key)) return json(res, 400, { error: 'that date is not on the table' });
      const got = editable(res, pick, name, token, !!on);
      if (!got) return;
      // Clearing a mark for someone who has none is a no-op, not a new person.
      if (!got.p) return json(res, 200, { ok: true, count: 0 });
      const p = got.p;
      if (on) {
        p.slots.add(key);
        p.none = false;                     // a real mark replaces "none of these work"
      } else {
        p.slots.delete(key);
      }
      dropIfEmpty(pick, p);
      changed(pick);
      return json(res, 200, { ok: true, count: p.slots.size });
    },

    // "None of these work for me" is an answer, not the absence of one: the
    // person stays in the head count, so "everyone is free" cannot be reached
    // while they are out. Choosing it clears their marks.
    async 'POST /none'(req, res, pick) {
      const { name, on, token } = await readBody(req);
      const got = editable(res, pick, name, token, !!on);
      if (!got) return;
      if (!got.p) return json(res, 200, { ok: true, none: false });
      const p = got.p;
      p.none = !!on;
      if (p.none) p.slots.clear();
      dropIfEmpty(pick, p);
      changed(pick);
      return json(res, 200, { ok: true, none: p.none });
    },

    // Lock a name in: mints the one edit link. The token is never broadcast.
    async 'POST /lock'(req, res, pick) {
      const { name } = await readBody(req);
      const clean = cleanPersonName(name);
      if (!clean) return json(res, 400, { error: 'name required' });
      if (pick.closed) return json(res, 409, { error: 'a date is already set' });
      const p = pick.people.get(nameKey(clean));
      if (!p || (!p.slots.size && !p.none)) return json(res, 400, { error: 'mark at least one date first' });
      if (p.locked) return json(res, 409, { error: 'already locked in' });
      p.locked = true;
      const editKey = newSecret();
      p.keyHash = hashKey(editKey);
      changed(pick);
      return json(res, 200, { ok: true, name: p.name, token: editKey });
    },

    // Reopen a name. The token stays valid, so the same link keeps working.
    // The creator may also reopen any name, so a name locked by the wrong
    // person is never stuck for good.
    async 'POST /unlock'(req, res, pick) {
      const { name, token, ownerToken } = await readBody(req);
      const clean = typeof name === 'string' ? cleanPersonName(name) : '';
      if (!clean) return json(res, 400, { error: 'name required' });
      const p = pick.people.get(nameKey(clean));
      if (!p) return json(res, 404, { error: 'nobody by that name' });
      if (!isAdmin(pick, ownerToken) && !holdsKey(p, token)) return json(res, 403, { error: 'wrong edit link' });
      p.locked = false;
      changed(pick);
      return json(res, 200, { ok: true, name: p.name });
    },

    // The creator may put more dates on the table after the fact.
    async 'POST /dates'(req, res, pick, body) {
      if (pick.closed) return json(res, 409, { error: 'a date is already set' });
      const extra = parseCreate({ title: pick.title, days: body.days });
      if (extra.error) return json(res, 400, { error: extra.error });
      const merged = [...pick.slots];
      for (const slot of extra.slots) {
        if (!merged.some((x) => x.date === slot.date && x.block === slot.block)) merged.push(slot);
      }
      const tooMany = slotLimitError(merged);
      if (tooMany) return json(res, 400, { error: tooMany });
      pick.slots = sortSlots(merged);
      changed(pick);
      return json(res, 200, { ok: true, slots: pick.slots.length });
    },

    async 'POST /reopen'(req, res, pick) {
      pick.closed = false;
      pick.chosen = null;
      changed(pick);
      return json(res, 200, { ok: true, closed: false });
    },

    async 'POST /choose'(req, res, pick, body) {
      const key = slotKey(body.date, body.block);
      if (!onTable(pick, key)) return json(res, 400, { error: 'that date is not on the table' });
      pick.closed = true;
      pick.chosen = key;
      changed(pick);
      return json(res, 200, { ok: true, closed: true, chosen: pick.chosen });
    },
  };
  const ADMIN_ROUTES = new Set(['POST /dates', 'POST /reopen', 'POST /choose']);

  async function handle(req, res, pathname, query) {
    if (req.method === 'POST' && pathname === '/dates/api/picks') {
      const parsed = parseCreate(await readBody(req));
      if (parsed.error) return json(res, 400, { error: parsed.error });
      if (picks.size >= MAX_STORED) return json(res, 503, { error: 'too many date picks right now' });
      const pick = makePick(parsed.title, parsed.slots);
      pick.id = newShortId(picks);
      const ownerToken = newSecret();
      pick.ownerHash = hashKey(ownerToken);
      picks.set(pick.id, pick);
      store.scheduleSave();
      // Returned once, here only. The server keeps just its hash.
      return json(res, 200, { id: pick.id, ownerToken });
    }

    const m = pathname.match(/^\/dates\/api\/picks\/([a-z0-9]{6})(\/.*)?$/);
    if (!m) return false;
    const pick = picks.get(m[1]);
    const sub = m[2] || '';
    if (!pick) return json(res, 404, { error: 'pick not found' });

    if (req.method === 'GET' && !sub) return json(res, 200, state(pick));
    if (req.method === 'GET' && sub === '/events') return sse.open(req, res, pick.sse, state(pick));

    // A lock link opened on another device knows the token but not the name.
    // The token is the only credential, so this cannot be probed without it.
    if (req.method === 'GET' && sub === '/who') {
      const token = (query.get('token') || '').trim();
      if (!token) return json(res, 400, { error: 'token required' });
      if (isAdmin(pick, token)) return json(res, 200, { role: 'admin' });
      for (const p of pick.people.values()) {
        if (holdsKey(p, token)) return json(res, 200, { role: 'person', name: p.name, locked: p.locked });
      }
      return json(res, 403, { error: 'not a valid edit link' });
    }

    const route = req.method + ' ' + sub;
    if (!routes[route]) return false;
    if (ADMIN_ROUTES.has(route)) {
      const body = await readBody(req);
      if (!isAdmin(pick, body.ownerToken)) return json(res, 403, { error: 'creator link only' });
      return routes[route](req, res, pick, body);
    }
    return routes[route](req, res, pick);
  }

  return { handle, listeners: () => [...picks.values()].map((p) => p.sse) };
}

module.exports = { createDates, parseCreate, todayUtc };
