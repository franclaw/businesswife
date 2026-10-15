// HTTP plumbing: bodies, JSON replies, static files.
const fs = require('fs');
const path = require('path');

const BODY_MAX = 64_000; // the largest legitimate body is a join with a small picture

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req, maxBytes = BODY_MAX) {
  return new Promise((resolve, reject) => {
    let body = '';
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      body += c;
      if (body.length > maxBytes) {
        over = true;
        reject(new HttpError(413, 'body too large'));
      }
    });
    req.on('end', () => {
      if (over) return;
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new HttpError(400, 'bad json'));
      }
    });
    req.on('error', reject);
  });
}

// Same-origin apps only: no CORS headers, so other sites cannot read replies.
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

function forbidden(res) {
  res.writeHead(403);
  res.end();
}

function redirect(res, location, code = 302) {
  res.writeHead(code, { Location: location });
  res.end();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// Pages, scripts and styles revalidate on every load so a deploy shows up at
// once; images change rarely and may be cached for a day.
function defaultCache(filePath) {
  return /\.(png|jpe?g|ico|webp)$/i.test(filePath) ? 'public, max-age=86400' : 'no-cache';
}

function sendFile(res, filePath, cache) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return notFound(res);
    res.writeHead(200, { 'Content-Type': mimeFor(filePath), 'Cache-Control': cache || defaultCache(filePath) });
    res.end(buf);
  });
}

/** Serve `rel` under `rootDir`, refusing anything that escapes it. */
function serveUnder(res, rootDir, rel) {
  const full = path.join(rootDir, path.normalize('/' + rel));
  if (!full.startsWith(rootDir + path.sep)) return forbidden(res);
  sendFile(res, full);
}

module.exports = { HttpError, readBody, json, notFound, forbidden, redirect, sendFile, serveUnder, mimeFor };
