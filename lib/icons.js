// What may be stored and broadcast as a person's picture.
//
// Built-in portraits (/img/<name>.png), an uploaded picture, or a short emoji.
// External URLs are refused: they would let any page owner see who opens a
// room or poll.
//
// Uploads arrive as small data URLs (the client resizes them), but are kept
// on disk once and broadcast as a link, /img/u/<sha256>.<ext>: a room of eight
// custom wives used to resend ~160 KB of base64 on every vote.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { notFound, forbidden } = require('./http');

const ICON_DATA_MAX = 20_000; // characters; the client resizes uploads to fit
const DATA_ICON = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/;
const UPLOAD_LINK = /^\/img\/u\/([a-f0-9]{32})\.(png|jpg|webp)$/;
const UPLOAD_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

function validIcon(icon) {
  if (typeof icon !== 'string' || !icon) return false;
  if (/^\/img\/[a-z0-9-]+\.png$/.test(icon)) return true;
  if (UPLOAD_LINK.test(icon)) return true;
  if (DATA_ICON.test(icon)) return icon.length <= ICON_DATA_MAX;
  if (/^[a-z]+:/i.test(icon) || icon.includes('/')) return false;
  return [...icon].length <= 8 && icon.length <= 32;
}

/** An uploaded picture (as data or as its stored link), not a portrait or emoji. */
const isUpload = (icon) => typeof icon === 'string' && (DATA_ICON.test(icon) || UPLOAD_LINK.test(icon));

function createUploads(dataDir) {
  const dir = path.join(dataDir, 'uploads');
  let ready = false;

  /** data URL -> stored link; anything else is returned unchanged. */
  function intake(icon) {
    // A link whose picture has been swept (it outlived every room and poll).
    const link = typeof icon === 'string' ? UPLOAD_LINK.exec(icon) : null;
    if (link) return fs.existsSync(path.join(dir, `${link[1]}.${link[2]}`)) ? icon : '👤';
    const m = typeof icon === 'string' && icon.length <= ICON_DATA_MAX ? DATA_ICON.exec(icon) : null;
    if (!m) return icon;
    const bytes = Buffer.from(m[2], 'base64');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    const file = path.join(dir, `${hash}.${ext}`);
    try {
      if (!ready) { fs.mkdirSync(dir, { recursive: true }); ready = true; }
      if (!fs.existsSync(file)) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, file);
      }
    } catch (err) {
      console.error('upload store failed, keeping the data URL:', err.message);
      return icon;
    }
    return `/img/u/${hash}.${ext}`;
  }

  function handle(req, res, pathname) {
    if (!pathname.startsWith('/img/u/')) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const m = UPLOAD_LINK.exec(pathname);
    if (!m) return forbidden(res);
    fs.readFile(path.join(dir, `${m[1]}.${m[2]}`), (err, buf) => {
      if (err) return notFound(res);
      // Content-addressed: the bytes behind a link never change.
      res.writeHead(200, { 'Content-Type': UPLOAD_MIME[m[2]], 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
    return true;
  }

  /** Delete stored pictures nobody references any more (older than `graceMs`). */
  function sweep(inUse, graceMs = 3_600_000) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return 0; }
    let removed = 0;
    const cutoff = Date.now() - graceMs;
    for (const name of names) {
      if (inUse.has(`/img/u/${name}`)) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) { fs.unlinkSync(file); removed++; }
      } catch { /* raced with another sweep */ }
    }
    return removed;
  }

  return { intake, handle, sweep };
}

module.exports = { validIcon, isUpload, createUploads, ICON_DATA_MAX };
