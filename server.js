/* Impose web server.
   One interface: every path that is not a real file resolves to index.html,
   which owns its own state. Nothing is served from a second page.
   Production headers live here rather than in render.yaml: the Blueprint has
   no `headers` field for a web service, and a key it does not recognise fails
   validation for the whole file. */
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const root = __dirname;
const port = Number(process.env.PORT || 3000);
const shell = path.join(root, 'index.html');

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'sha256-0veUJDTsBMiTL9D+bxTQUQaWGGcKCSOgssmNQiYop6s=' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  // The interface embeds its typeface as data:font/woff2, so data: is required.
  "font-src 'self' data:",
  "connect-src 'self' https: http: localhost http://127.0.0.1 ws: wss:",
  "frame-src https://www.youtube-nocookie.com https://player.twitch.tv https://clips.twitch.tv",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.set('Content-Security-Policy', CSP);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  next();
});

// index.html is an implementation detail, never a public URL.
app.get(['/index.html', '/index.html/'], (_req, res) => res.redirect(308, '/'));

app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

app.use(express.static(root, {
  extensions: ['html'],
  index: 'index.html',
  redirect: false,
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    // The document names which build to load, and a stale copy pins a browser
    // to an old one. Code is revalidated because filenames are not hashed.
    if (ext === '.html' || filePath.endsWith('sw.js')) res.set('Cache-Control', 'no-cache');
    else if (ext === '.js' || ext === '.css' || ext === '.json') res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    else res.set('Cache-Control', 'public, max-age=604800');
  },
}));

/* Deep links and refreshes reach the same interface instead of a 404.
   A middleware fallback rather than a wildcard route: the path is never
   parsed, so this behaves the same on Express 4 and 5. */
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (!fs.existsSync(shell)) return next(new Error('index.html is missing from the deployment'));
  res.set('Cache-Control', 'no-cache');
  res.sendFile(shell);
});

app.use((err, _req, res, _next) => {
  console.error('[impose]', err.message);
  res.status(500).type('text/plain').send('Server error: ' + err.message);
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Impose web server listening on ${port}`);
});
