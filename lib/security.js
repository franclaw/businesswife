// Security headers for every response, and a tiny CSP violation sink.
//
// No page loads scripts, styles or images from another origin, so the
// policy is 'self' (plus data:/blob: for uploaded portraits). The four pages with an inline <script> are allowed by the
// sha256 of that exact script, computed from the HTML files at startup
// (restart the server after editing one). Styles stay 'unsafe-inline':
// style attributes are used throughout and cannot run code.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const REPORT_PATH = '/csp-report';

function inlineScriptHashes(files) {
  const hashes = new Set();
  for (const file of files) {
    let html = '';
    try { html = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const m of html.matchAll(INLINE_SCRIPT)) {
      hashes.add(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
    }
  }
  return [...hashes];
}

function createSecurity(root) {
  const pages = ['hub.html', 'index.html', 'poll/index.html', 'pomodoro/index.html', 'dates/index.html', 'feedback/index.html']
    .map((p) => path.join(root, p));
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(pages).join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    // The picker reads uploads back via fetch(dataURL) and can fetch a pasted
    // https image link (CORS permitting) to store it with the seat.
    "connect-src 'self' https: data: blob:",
    "font-src 'self' data:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `report-uri ${REPORT_PATH}`,
  ].join('; ');

  const HEADERS = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };

  function apply(req, res) {
    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
    // TLS ends at the proxy; only claim HSTS when the request really came in over https.
    if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }

  // Browsers POST violations here. Log one short line, never the body verbatim.
  function report(req, res, pathname) {
    if (pathname !== REPORT_PATH || req.method !== 'POST') return false;
    let size = 0, body = '';
    req.on('data', (c) => { size += c.length; if (size <= 8192) body += c; });
    req.on('end', () => {
      try {
        const r = JSON.parse(body)['csp-report'] || {};
        const clip = (s) => String(s || '').slice(0, 160).replace(/\s+/g, ' ');
        console.warn(`[csp] ${clip(r['violated-directive'] || r['effective-directive'])} blocked ${clip(r['blocked-uri'])} on ${clip(r['document-uri'])}`);
      } catch { /* not a report */ }
      res.writeHead(204); res.end();
    });
    req.on('error', () => {});
    return true;
  }

  return { apply, report, csp };
}

module.exports = { createSecurity, inlineScriptHashes };
