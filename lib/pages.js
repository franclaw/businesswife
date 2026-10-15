// Pages and static assets for the hub and every app.
const path = require('path');
const { sendFile, serveUnder, redirect, forbidden } = require('./http');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function createPages(root) {
  const PUBLIC = path.join(root, 'public');
  const apps = {
    'planning-poker': { dir: path.join(root, 'planning-poker'), page: path.join(root, 'index.html'), routes: [/^\/r\/[a-z0-9]{6}\/?$/] },
    pomodoro: { dir: path.join(root, 'pomodoro'), routes: [] },
    poll: { dir: path.join(root, 'poll'), routes: [/^\/[a-z0-9]{6}\/?$/] },
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
