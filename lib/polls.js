// Polls: a question, 2–8 options, one final vote per voter, closed by the owner.
//
// The creator gets an owner token once, at creation; the server keeps only its
// hash. Voters are identified by a per-tab voter id, also kept only as a hash.
const sse = require('./sse');
const { ID_RE, DAY_MS, now, newShortId, hashKey, matchesHash, newSecret } = require('./util');
const { json, readBody } = require('./http');
const { validIcon } = require('./icons');

const POLL_QUESTION_MAX = 200;
const POLL_OPTION_MAX = 80;
const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 8;
const POLL_VOTER_MAX = 64;
const POLL_NAME_MAX = 24;
const KEEP_IDLE_MS = 60 * DAY_MS;
const MAX_STORED = 5_000;
const SWEEP_MS = 60_000;

function createPolls(store) {
  const polls = new Map();

  function makePoll(question, options) {
    return {
      id: null,
      question,
      options: options.map((label, i) => ({ id: 'o' + (i + 1), label })),
      votes: new Map(), // hashKey(voterId) -> { optionId, name?, icon? }
      identities: new Map(), // voter hash -> reserved Business Wife
      ownerHash: null,
      closed: false,
      createdAt: now(),
      updatedAt: now(),
      sse: new Set(),
    };
  }

  const expiresAt = (poll) => poll.updatedAt + KEEP_IDLE_MS;

  function state(poll) {
    const counts = new Map(poll.options.map((o) => [o.id, 0]));
    const voters = new Map(poll.options.map((o) => [o.id, []]));
    const allVoters = [];
    for (const v of poll.votes.values()) {
      if (counts.has(v.optionId)) counts.set(v.optionId, counts.get(v.optionId) + 1);
      if (v.name) {
        const info = { name: v.name, icon: v.icon || null };
        if (v.raw === true && v.icon) info.raw = true;
        allVoters.push(info);
        if (voters.has(v.optionId)) voters.get(v.optionId).push(info);
      }
    }
    return {
      id: poll.id,
      // Clients drop any state older than one they already drew, so a slow
      // GET cannot undo a newer SSE update (e.g. reopen a closed poll).
      rev: poll.updatedAt,
      question: poll.question,
      closed: poll.closed,
      totalVotes: poll.votes.size,
      options: poll.options.map((o) => ({ id: o.id, label: o.label, count: counts.get(o.id) || 0, voters: voters.get(o.id) || [] })),
      voters: allVoters,
      identities: [...poll.identities.values()],
    };
  }

  function changed(poll) {
    poll.updatedAt = now();
    store.scheduleSave();
    sse.send(poll.sse, state(poll));
  }

  const validVoterId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);

  function parseCreate(body) {
    const question = String(body.question ?? '').trim().slice(0, POLL_QUESTION_MAX);
    if (!question) return { error: 'question required' };
    const raw = Array.isArray(body.options) ? body.options : [];
    const options = raw.map((o) => String(o ?? '').trim().slice(0, POLL_OPTION_MAX)).filter(Boolean);
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

  store.register('polls', {
    dump: () => [...polls.values()].map((poll) => ({
      id: poll.id,
      question: poll.question,
      options: poll.options,
      votes: [...poll.votes],
      identities: [...poll.identities],
      ownerHash: poll.ownerHash,
      closed: poll.closed,
      createdAt: poll.createdAt,
      updatedAt: poll.updatedAt,
    })),
    load(list) {
      const t = now();
      for (const d of list) {
        if (!d || typeof d.id !== 'string' || !ID_RE.test(d.id) || !Array.isArray(d.options)) continue;
        const poll = makePoll(String(d.question || ''), []);
        poll.id = d.id;
        poll.options = d.options.filter((o) => o && typeof o.id === 'string').map((o) => ({ id: o.id, label: String(o.label || '') }));
        for (const v of Array.isArray(d.votes) ? d.votes : []) {
          if (!Array.isArray(v) || v.length !== 2 || v[1] == null) continue;
          poll.votes.set(String(v[0]), typeof v[1] === 'string' ? { optionId: v[1] } : v[1]);
        }
        for (const [key, identity] of Array.isArray(d.identities) ? d.identities : []) {
          if (identity && typeof identity.name === 'string') poll.identities.set(String(key), identity);
        }
        // Existing named votes also reserve their wives after upgrading.
        for (const [key, vote] of poll.votes) {
          if (vote.name) poll.identities.set(key, { name: vote.name, icon: vote.icon || null, raw: vote.raw === true });
        }
        // Older files called it creatorHash (the hash of the creator's voter id).
        const owner = d.ownerHash || d.creatorHash;
        poll.ownerHash = typeof owner === 'string' ? owner : null;
        poll.closed = !!d.closed;
        poll.createdAt = Number(d.createdAt) || t;
        poll.updatedAt = Number(d.updatedAt) || poll.createdAt;
        if (t <= expiresAt(poll)) polls.set(poll.id, poll);
      }
      return polls.size;
    },
  });

  setInterval(() => {
    const t = now();
    for (const [id, poll] of polls) {
      if (t > expiresAt(poll)) { polls.delete(id); store.scheduleSave(); }
    }
  }, SWEEP_MS).unref();

  async function handle(req, res, pathname) {
    if (req.method === 'POST' && pathname === '/poll/api/polls') {
      const parsed = parseCreate(await readBody(req));
      if (parsed.error) return json(res, 400, { error: parsed.error });
      if (polls.size >= MAX_STORED) return json(res, 503, { error: 'too many polls right now' });
      const poll = makePoll(parsed.question, parsed.options);
      poll.id = newShortId(polls);
      const ownerToken = newSecret();
      poll.ownerHash = hashKey(ownerToken);
      polls.set(poll.id, poll);
      store.scheduleSave();
      // Returned once, here only. The server keeps just its hash.
      return json(res, 200, { id: poll.id, ownerToken });
    }

    const m = pathname.match(/^\/poll\/api\/polls\/([a-z0-9]{6})(\/.*)?$/);
    if (!m) return false;
    const poll = polls.get(m[1]);
    const sub = m[2] || '';
    if (!poll) return json(res, 404, { error: 'poll not found' });

    if (req.method === 'GET' && !sub) return json(res, 200, state(poll));
    if (req.method === 'GET' && sub === '/events') return sse.open(req, res, poll.sse, state(poll));

    if (req.method === 'POST' && sub === '/identity') {
      const { voterId, name, icon, raw, subtitle } = await readBody(req);
      if (!validVoterId(voterId)) return json(res, 400, { error: 'bad voter' });
      const key = hashKey(voterId);
      // A submitted ballot and the wife attached to it are immutable.
      const previous = poll.votes.get(key);
      if (previous) return json(res, 200, { optionId: previous.optionId, identity: { name: previous.name || 'Voter', icon: previous.icon || null, raw: previous.raw === true } });
      const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, POLL_NAME_MAX) : '';
      if (!clean) return json(res, 400, { error: 'name required' });
      if (icon != null && icon !== '' && !validIcon(icon)) return json(res, 400, { error: 'bad icon' });
      if ([...poll.identities].some(([other, identity]) => other !== key && identity.name.toLowerCase() === clean.toLowerCase())) {
        return json(res, 409, { error: 'That Business Wife is already taken. Pick another.' });
      }
      if (!poll.identities.has(key) && poll.identities.size >= POLL_VOTER_MAX) return json(res, 409, { error: 'this poll is full' });
      const identity = { name: clean, icon: icon || null, raw: raw === true && !!icon && /^data:image\//.test(icon) };
      if (typeof subtitle === 'string') identity.subtitle = subtitle.trim().slice(0, 40);
      poll.identities.set(key, identity);
      changed(poll);
      return json(res, 200, { identity });
    }

    if (req.method === 'POST' && sub === '/vote') {
      const { voterId, optionId, name, icon, raw } = await readBody(req);
      if (!validVoterId(voterId)) return json(res, 400, { error: 'bad voter' });
      if (poll.closed) return json(res, 409, { error: 'poll closed' });
      if (!poll.options.some((o) => o.id === optionId)) return json(res, 400, { error: 'bad option' });
      if (icon != null && icon !== '' && !validIcon(icon)) return json(res, 400, { error: 'bad icon' });
      const key = hashKey(voterId);
      // Results are revealed immediately after submitting, so the first
      // ballot is final. Exact retries are harmless but may not rewrite identity.
      const previous = poll.votes.get(key);
      if (previous) {
        if (previous.optionId === optionId) return json(res, 200, { ok: true, optionId });
        return json(res, 409, { error: 'Your vote is final once results are shown.', optionId: previous.optionId });
      }
      if (poll.votes.size >= POLL_VOTER_MAX || (!poll.identities.has(key) && poll.identities.size >= POLL_VOTER_MAX)) return json(res, 409, { error: 'this poll is full' });
      const vote = { optionId };
      let clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, POLL_NAME_MAX) : '';
      const reserved = poll.identities.get(key);
      if (reserved) clean = reserved.name;
      if (clean && [...poll.identities].some(([other, identity]) => other !== key && identity.name.toLowerCase() === clean.toLowerCase())) {
        return json(res, 409, { error: 'That Business Wife is already taken. Pick another.' });
      }
      if (clean) vote.name = clean;
      if (icon) vote.icon = icon;
      vote.raw = raw === true && vote.icon && /^data:image\//.test(vote.icon) ? true : null;
      if (reserved) {
        vote.icon = reserved.icon;
        vote.raw = reserved.raw;
      }
      if (vote.name) poll.identities.set(key, { name: vote.name, icon: vote.icon || null, raw: vote.raw === true });
      poll.votes.set(key, vote);
      changed(poll);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && sub === '/close') {
      const { ownerToken } = await readBody(req);
      if (!matchesHash(ownerToken, poll.ownerHash)) return json(res, 403, { error: 'creator only' });
      poll.closed = true;
      changed(poll);
      return json(res, 200, { ok: true, closed: true });
    }
    return false;
  }

  return { title: (id) => polls.get(id)?.question || null, handle, listeners: () => [...polls.values()].map((p) => p.sse), limits: { POLL_VOTER_MAX, POLL_MAX_OPTIONS } };
}

module.exports = { createPolls };
