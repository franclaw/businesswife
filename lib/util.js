// Small shared helpers: ids, hashing, the clock.
const crypto = require('crypto');

const ID_RE = /^[a-z0-9]{6}$/;
const ID_CHARS = '23456789abcdefghjkmnpqrstuvwxyz';
const DAY_MS = 86_400_000;

function now() {
  return Date.now();
}

/** A short, unambiguous public id not yet used in `taken` (a Map or Set). */
function newShortId(taken) {
  for (let n = 0; n < 20; n++) {
    let id = '';
    const buf = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) id += ID_CHARS[buf[i] % ID_CHARS.length];
    if (!taken.has(id)) return id;
  }
  return crypto.randomBytes(4).toString('hex').slice(0, 6);
}

// Capability links, owner tokens, seat secrets and voter ids are kept only as
// hashes: the server just has to recognise them, never to show them again.
function hashKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Does `token` hash to `hash`? Constant-time, and false for anything missing. */
function matchesHash(token, hash) {
  if (typeof token !== 'string' || !token || typeof hash !== 'string' || !hash) return false;
  const a = Buffer.from(hashKey(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newSecret() {
  return crypto.randomUUID();
}

module.exports = { ID_RE, DAY_MS, now, newShortId, hashKey, matchesHash, newSecret };
