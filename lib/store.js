// Persistence: one JSON file, rewritten whole (temp file + rename, so a crash
// mid-write never leaves half a file) at most once a second after a change. It
// lives outside every served directory and holds only hashes of secrets.
//
// Each feature registers a section with dump() and load(list); the file keeps
// the `{ version, savedAt, <section>: [...] }` shape it has always had.
const fs = require('fs');
const path = require('path');
const { now } = require('./util');

const SAVE_DEBOUNCE_MS = 1_000;

function createStore(dataDir) {
  const file = path.join(dataDir, 'state.json');
  const sections = new Map();
  let timer = null;

  function register(name, section) {
    sections.set(name, section);
  }

  function scheduleSave() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; saveNow(); }, SAVE_DEBOUNCE_MS);
  }

  function saveNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    const data = { version: 1, savedAt: now() };
    for (const [name, s] of sections) data[name] = s.dump();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(data));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error('could not save state:', err.message);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('could not read state:', err.message);
      return;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      // Keep the unreadable file for inspection rather than overwriting it.
      const aside = `${file}.corrupt-${now()}`;
      console.error(`state file unreadable (${err.message}); moved to ${aside}`);
      try { fs.renameSync(file, aside); } catch {}
      return;
    }
    const counts = [];
    for (const [name, s] of sections) {
      const n = s.load(Array.isArray(data[name]) ? data[name] : []);
      counts.push(`${n} ${name}`);
    }
    console.log(`loaded ${counts.join(', ')} from ${file}`);
  }

  return { register, scheduleSave, saveNow, load };
}

module.exports = { createStore };
