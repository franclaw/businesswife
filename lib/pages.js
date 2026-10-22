// Pages and static assets for the hub and every app.
const path = require('path');
const fs = require('fs');
const { sendFile, serveUnder, redirect, forbidden } = require('./http');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// Preview crawlers usually do not run JavaScript. Render only the public
// question into the initial HTML, never ballots or owner/voter credentials.
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

function createPages(root, { pollTitle = () => null } = {}) {
  const PUBLIC = path.join(root, 'public');
  const apps = {
    'planning-poker': { dir: path.join(root, 'planning-poker'), page: path.join(root, 'index.html'), routes: [/^\/r\/[a-z0-9]{6}\/?$/] },
    pomodoro: { dir: path.join(root, 'pomodoro'), routes: [] },
    poll: { dir: path.join(root, 'poll'), routes: [/^\/[a-z0-9]{6}\/?$/] },
    // /feedback/<id> is the participant view; /feedback/<id>/facilitator the
    // facilitator view. The page reads its own path and decides.
    feedback: { dir: path.join(root, 'feedback'), routes: [/^\/[a-z0-9]{6}(\/facilitator)?\/?$/] },
    // /dates/<id> is the shared board; /dates/<id>/<uuid> a person's private
    // edit link; /dates/<id>/admin[/<uuid>] the creator's view. The page reads
    // its own path and decides.
    dates: {
      dir: path.join(root, 'dates'),
      routes: [/^\/[a-z0-9]{6}(\/admin)?\/?$/, new RegExp(`^/[a-z0-9]{6}/(admin/)?${UUID}/?$`)],
    },
  };
  const ASSET = /^(manifest\.webmanifest|sw\.js|app\.js|app\.css|icons\/[a-z0-9-]+\.png)$/;

  function handle(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    if (pathname === '/' || pathname === '/index.html' || pathname === '/hub.html') {
      return sendFile(res, path.join(root, 'hub.html'));
    }
    const legacy = pathname.match(/^\/r\/([a-z0-9]{6})\/?$/);
    if (legacy) return redirect(res, '/planning-poker/r/' + legacy[1]);

    const m = pathname.match(/^\/([a-z-]+)(\/.*)?$/);
    const app = m && Object.prototype.hasOwnProperty.call(apps, m[1]) ? apps[m[1]] : null;
    if (app) {
      const rest = m[2] || '';
      const pollLink = m[1] === 'poll' && rest.match(/^\/([a-z0-9]{6})\/?$/);
      const question = pollLink && pollTitle(pollLink[1]);
      if (question) {
        fs.readFile(path.join(app.dir, 'index.html'), 'utf8', (err, html) => {
          if (err) return sendFile(res, path.join(app.dir, 'index.html'));
          const title = escapeHtml(question);
          // Use the canonical public origin, not an untrusted Host header.
          const url = 'https://businesswife.nl/poll/' + pollLink[1];
          const description = 'Vote in this Business Wife poll.';
          const metadata = [
            `<meta property="og:type" content="website">`,
            `<meta property="og:site_name" content="Business Wife">`,
            `<meta property="og:title" content="${title}">`,
            `<meta property="og:description" content="${description}">`,
            `<meta property="og:url" content="${url}">`,
            `<meta property="og:image" content="https://businesswife.nl/poll/icons/icon-512.png">`,
            `<meta name="twitter:card" content="summary">`,
            `<meta name="twitter:title" content="${title}">`,
            `<meta name="twitter:description" content="${description}">`,
            `<meta name="twitter:image" content="https://businesswife.nl/poll/icons/icon-512.png">`,
            `<link rel="canonical" href="${url}">`,
          ].join('\n');
          html = html.replace('<title>Poll — Business Wife</title>', () => `<title>${title} — Poll · Business Wife</title>`)
            .replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${description}">`)
            .replace('</head>', () => metadata + '\n</head>');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(html);
        });
        return;
      }
      if (rest === '' || rest === '/' || rest === '/index.html' || app.routes.some((re) => re.test(rest))) {
        return sendFile(res, app.page || path.join(app.dir, 'index.html'));
      }
      const rel = rest.slice(1);
      if (ASSET.test(rel)) return serveUnder(res, app.dir, rel);
      return false;
    }

    if (pathname === '/favicon.ico' || pathname === '/favicon.png' || pathname === '/apple-touch-icon.png') {
      return sendFile(res, path.join(PUBLIC, pathname.slice(1)));
    }
    // Shared UI components (web components, their stylesheets, the SW core).
    if (pathname.startsWith('/components/')) {
      const rel = pathname.slice(1);
      if (!/^components\/[a-z0-9-]+\.(js|css)$/.test(rel)) return forbidden(res);
      return sendFile(res, path.join(PUBLIC, rel));
    }
    if (pathname.startsWith('/img/')) {
      const rel = pathname.slice(1);
      if (!/^img(\/thumb)?\/[a-z0-9-]+\.(png|jpe?g)$/.test(rel)) return forbidden(res);
      return sendFile(res, path.join(PUBLIC, rel));
    }
    return false;
  }

  return { handle };
}

module.exports = { createPages };
