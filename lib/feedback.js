// Feedback & voting: a facilitator collects anonymous feedback per category,
// reveals it to the room, then everyone votes on the items they find most
// important. Four states — collecting, revealed, voting, results — and the
// facilitator may move one step in either direction without losing data.
//
// The facilitator gets a token once, at creation; the server keeps only its
// hash. Participants are identified by a per-browser id, also kept only as a
// hash, so feedback stays anonymous but editable from the device it came from.
const sse = require('./sse');
const { ID_RE, DAY_MS, now, newShortId, hashKey, matchesHash, newSecret } = require('./util');
const { json, readBody } = require('./http');

const FEEDBACK_TITLE_MAX = 120;
const FEEDBACK_DESC_MAX = 500;
const FEEDBACK_CATEGORY_MAX = 80;
const FEEDBACK_MIN_CATEGORIES = 1;
const FEEDBACK_MAX_CATEGORIES = 8;
const FEEDBACK_TEXT_MAX = 300;
const FEEDBACK_MAX_ITEMS = 500;
const FEEDBACK_MAX_VOTES = 10;
const FEEDBACK_PARTICIPANT_MAX = 200;
const MAX_STORED = 2_000;
// Like polls: a session is forgotten 60 days after its last change, so the
// store cannot silt up and lock everyone out.
const KEEP_IDLE_MS = 60 * DAY_MS;
const SWEEP_MS = 60_000;

const STATES = ['collecting', 'revealed', 'voting', 'results'];

function createFeedback(store) {
  const sessions = new Map();

  function makeSession(title, description, categories, votesPerParticipant) {
    return {
      id: null,
      title,
      description,
      categories, // [{ id, label }]
      votesPerParticipant,
      state: 'collecting',
      items: [], // [{ id, categoryId, text, author, mergedFrom: [text] }]
      votes: new Map(), // hashKey(participantId) -> Set(itemIds)
      facilitatorHash: null,
      createdAt: now(),
      updatedAt: now(),
      sse: new Set(),
    };
  }

  const findItem = (s, id) => s.items.find((i) => i.id === id) || null;

  // GET and SSE use the same per-device projection. Never send blind items,
  // author hashes, other voters or hidden totals to a browser.
  function state(s, viewer = {}) {
    const key = validParticipantId(viewer.participantId) ? hashKey(viewer.participantId) : null;
    const mine = s.votes.get(key) || new Set();
    const fac = isFacilitator(viewer.facilitatorToken, s);
    const counts = {};
    if (s.state === 'results') {
      for (const set of s.votes.values()) for (const id of set) counts[id] = (counts[id] || 0) + 1;
    }
    return {
      id: s.id, rev: s.updatedAt, title: s.title, description: s.description,
      createdAt: s.createdAt, state: s.state, facilitator: fac,
      votesPerParticipant: s.votesPerParticipant, categories: s.categories,
      myVotes: [...mine], remainingVotes: s.votesPerParticipant - mine.size,
      items: s.items.filter((i) => s.state !== 'collecting' || i.author === key).map((i) => ({
        id: i.id, categoryId: i.categoryId, text: i.text, mine: i.author === key,
        mergedFrom: i.mergedFrom,
        ...(s.state === 'results' ? { votes: counts[i.id] || 0 } : {}),
      })),
    };
  }

  function changed(s) {
    s.updatedAt = Math.max(now(), s.updatedAt + 1);
    store.scheduleSave();
    for (const res of s.sse) sse.send(new Set([res]), state(s, res.feedbackViewer));
  }

  const validParticipantId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);
  const isFacilitator = (token, s) => matchesHash(token, s.facilitatorHash);

  function parseCreate(body) {
    const title = String(body.title ?? '').trim().slice(0, FEEDBACK_TITLE_MAX);
    if (!title) return { error: 'title required' };
    const description = String(body.description ?? '').trim().slice(0, FEEDBACK_DESC_MAX);
    const raw = Array.isArray(body.categories) ? body.categories : [];
    const categories = raw
      .map((c, i) => ({ id: 'c' + (i + 1), label: String(c ?? '').trim().slice(0, FEEDBACK_CATEGORY_MAX) }))
      .filter((c) => c.label);
    if (categories.length < FEEDBACK_MIN_CATEGORIES) return { error: 'at least one question required' };
    if (categories.length > FEEDBACK_MAX_CATEGORIES) return { error: `at most ${FEEDBACK_MAX_CATEGORIES} questions` };
    let votesPerParticipant = Number(body.votesPerParticipant);
    if (!Number.isInteger(votesPerParticipant)) votesPerParticipant = 3;
    votesPerParticipant = Math.min(Math.max(votesPerParticipant, 1), FEEDBACK_MAX_VOTES);
    return { title, description, categories, votesPerParticipant };
  }

  store.register('feedback', {
    dump: () => [...sessions.values()].map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      categories: s.categories,
      votesPerParticipant: s.votesPerParticipant,
      state: s.state,
      items: s.items,
      votes: [...s.votes].map(([k, set]) => [k, [...set]]),
      facilitatorHash: s.facilitatorHash,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
    load(list) {
      const t = now();
      for (const d of list) {
        if (!d || typeof d.id !== 'string' || !ID_RE.test(d.id) || !Array.isArray(d.categories)) continue;
        const s = makeSession(String(d.title || ''), String(d.description || ''), [], 3);
        s.id = d.id;
        s.categories = d.categories
          .filter((c) => c && typeof c.id === 'string')
          .map((c) => ({ id: c.id, label: String(c.label || '') }));
        s.votesPerParticipant = Math.min(Math.max(Number(d.votesPerParticipant) || 3, 1), FEEDBACK_MAX_VOTES);
        s.state = STATES.includes(d.state) ? d.state : 'collecting';
        s.items = (Array.isArray(d.items) ? d.items : [])
          .filter((i) => i && typeof i.id === 'string')
          .map((i) => ({
            id: i.id,
            categoryId: String(i.categoryId || ''),
            text: String(i.text || ''),
            author: String(i.author || ''),
            mergedFrom: Array.isArray(i.mergedFrom) ? i.mergedFrom.map(String) : [],
          }));
        for (const v of Array.isArray(d.votes) ? d.votes : []) {
          if (Array.isArray(v) && typeof v[0] === 'string') s.votes.set(v[0], new Set((v[1] || []).map(String)));
        }
        s.facilitatorHash = typeof d.facilitatorHash === 'string' ? d.facilitatorHash : null;
        s.createdAt = Number(d.createdAt) || t;
        s.updatedAt = Number(d.updatedAt) || s.createdAt;
        if (t - s.updatedAt <= KEEP_IDLE_MS) sessions.set(s.id, s);
      }
      return sessions.size;
    },
  });

  setInterval(() => {
    const t = now();
    for (const [id, s] of sessions) {
      if (t - s.updatedAt > KEEP_IDLE_MS) { sessions.delete(id); store.scheduleSave(); }
    }
  }, SWEEP_MS).unref();

  // One step forward or back; anything else is a no-op with 409.
  function nextState(current, target) {
    const a = STATES.indexOf(current);
    const b = STATES.indexOf(target);
    return a !== -1 && b !== -1 && Math.abs(a - b) === 1;
  }

  async function handle(req, res, pathname, query = new URLSearchParams()) {
    if (req.method === 'POST' && pathname === '/feedback/api/sessions') {
      const parsed = parseCreate(await readBody(req));
      if (parsed.error) return json(res, 400, { error: parsed.error });
      if (sessions.size >= MAX_STORED) return json(res, 503, { error: 'too many sessions right now' });
      const s = makeSession(parsed.title, parsed.description, parsed.categories, parsed.votesPerParticipant);
      s.id = newShortId(sessions);
      const facilitatorToken = newSecret();
      s.facilitatorHash = hashKey(facilitatorToken);
      sessions.set(s.id, s);
      store.scheduleSave();
      // Returned once, here only. The server keeps just its hash.
      return json(res, 200, { id: s.id, facilitatorToken });
    }

    const m = pathname.match(/^\/feedback\/api\/sessions\/([a-z0-9]{6})(\/.*)?$/);
    if (!m) return false;
    const s = sessions.get(m[1]);
    const sub = m[2] || '';
    if (!s) return json(res, 404, { error: 'session not found' });

    // Clients send the facilitator token as a header; the query parameter is
    // only honoured for tabs opened before the header existed.
    const viewer = { participantId: query.get('participantId'), facilitatorToken: req.headers['x-facilitator-token'] || query.get('facilitatorToken') };
    if (req.method === 'GET' && !sub) return json(res, 200, state(s, viewer));
    if (req.method === 'GET' && sub === '/events') {
      res.feedbackViewer = viewer;
      return sse.open(req, res, s.sse, state(s, viewer));
    }

    if (req.method === 'POST' && sub === '/items') {
      const { participantId, categoryId, text } = await readBody(req);
      if (!validParticipantId(participantId)) return json(res, 400, { error: 'bad participant' });
      if (s.state !== 'collecting') return json(res, 409, { error: 'feedback is closed' });
      if (!s.categories.some((c) => c.id === categoryId)) return json(res, 400, { error: 'bad category' });
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, FEEDBACK_TEXT_MAX);
      if (!clean) return json(res, 400, { error: 'text required' });
      if (s.items.length >= FEEDBACK_MAX_ITEMS) return json(res, 409, { error: 'this session is full' });
      const item = {
        id: 'i' + (s.items.reduce((n, i) => Math.max(n, Number(i.id.slice(1)) || 0), 0) + 1),
        categoryId, text: clean, author: hashKey(participantId), mergedFrom: [],
      };
      s.items.push(item);
      changed(s);
      return json(res, 200, { ok: true, item: { id: item.id } });
    }

    if (req.method === 'POST' && (sub === '/items/update' || sub === '/items/delete')) {
      const { participantId, facilitatorToken, itemId, text } = await readBody(req);
      const item = findItem(s, String(itemId ?? ''));
      if (!item) return json(res, 404, { error: 'item not found' });
      const fac = isFacilitator(facilitatorToken, s);
      const mine = validParticipantId(participantId) && item.author === hashKey(participantId);
      if (!fac && !mine) return json(res, 403, { error: 'not your item' });
      // Owners may only touch their items while collecting; the facilitator
      // keeps the pen afterwards (that is what revealing is for).
      if (!fac && s.state !== 'collecting') return json(res, 409, { error: 'feedback is closed' });
      if (sub === '/items/update') {
        const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, FEEDBACK_TEXT_MAX);
        if (!clean) return json(res, 400, { error: 'text required' });
        item.text = clean;
      } else {
        s.items = s.items.filter((i) => i !== item);
        for (const set of s.votes.values()) set.delete(item.id);
      }
      changed(s);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && sub === '/merge') {
      const { facilitatorToken, targetId, sourceIds } = await readBody(req);
      if (!isFacilitator(facilitatorToken, s)) return json(res, 403, { error: 'facilitator only' });
      const target = findItem(s, String(targetId ?? ''));
      const sources = [...new Set(Array.isArray(sourceIds) ? sourceIds : [])].map((id) => findItem(s, String(id))).filter(Boolean);
      if (!target || !sources.length) return json(res, 400, { error: 'need a target and a source' });
      if (sources.includes(target)) return json(res, 400, { error: 'cannot merge an item into itself' });
      // Merging stays inside one category so the questions keep their meaning.
      if (sources.some((i) => i.categoryId !== target.categoryId)) return json(res, 400, { error: 'same category only' });
      if (!target.mergedFrom.length) target.mergedFrom.push(target.text);
      for (const src of sources) {
        target.mergedFrom.push(...(src.mergedFrom.length ? src.mergedFrom : [src.text]));
        s.items = s.items.filter((i) => i !== src);
        for (const set of s.votes.values()) {
          if (set.delete(src.id)) set.add(target.id); // votes follow the merge; one per participant either way
        }
      }
      changed(s);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && sub === '/state') {
      const { facilitatorToken, state: target } = await readBody(req);
      if (!isFacilitator(facilitatorToken, s)) return json(res, 403, { error: 'facilitator only' });
      if (!nextState(s.state, target)) return json(res, 409, { error: `cannot go from ${s.state} to ${target}` });
      s.state = target; // votes and items survive every move, forward or back
      changed(s);
      return json(res, 200, { ok: true, state: s.state });
    }

    if (req.method === 'POST' && sub === '/vote') {
      const { participantId, itemId, add } = await readBody(req);
      if (!validParticipantId(participantId)) return json(res, 400, { error: 'bad participant' });
      if (s.state !== 'voting') return json(res, 409, { error: 'voting is not open' });
      const item = findItem(s, String(itemId ?? ''));
      if (!item) return json(res, 404, { error: 'item not found' });
      const key = hashKey(participantId);
      let set = s.votes.get(key);
      if (!set) {
        if (s.votes.size >= FEEDBACK_PARTICIPANT_MAX) return json(res, 409, { error: 'this session is full' });
        s.votes.set(key, (set = new Set()));
      }
      if (typeof add !== 'boolean') return json(res, 400, { error: 'add must be a boolean' });
      if (add) {
        if (!set.has(item.id) && set.size >= s.votesPerParticipant) {
          return json(res, 409, { error: `you have ${s.votesPerParticipant} votes` });
        }
        set.add(item.id);
      } else {
        set.delete(item.id);
      }
      changed(s);
      return json(res, 200, { ok: true });
    }

    return false;
  }

  return { handle, listeners: () => [...sessions.values()].map((s) => s.sse) };
}

module.exports = { createFeedback };
