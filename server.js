/* Impose production web server.
   Express owns clean deep-link routing while the browser application keeps
   its internal state machine compatible with existing hash links. */
const express = require('express');
const path = require('path');

const app = express();
const root = __dirname;
const port = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
// index.html is an implementation detail, never a public application URL.
// Redirect old bookmarks before the shell is served so the address bar is
// canonical even when a legacy link is opened directly.
app.get(['/index.html', '/index.html/'], (_req, res) => res.redirect(308, '/'));

app.get('/workspace-sync.js', (_req, res) => res.sendFile(path.join(root, 'workspace-sync.js')));

app.use(express.static(root, { extensions: ['html'], index: 'index.html' }));

// Clean application entry points. The client loads the same shell and owns
// auth/data routing; Express must never return a 404 for a shared deep link.
app.get(['/workspace', '/workspace/'], (_req, res) => res.sendFile(path.join(root, 'index.html')));
app.get(['/g/:id', '/g/:id/'], (_req, res) => res.sendFile(path.join(root, 'index.html')));
app.get(['/u/:handle', '/u/:handle/'], (_req, res) => res.sendFile(path.join(root, 'index.html')));
/* Profile-scoped post URLs are a first-class deep link: /u/@handle/post/<id>
   names the same detail as /g/<id>. The handle is decorative, the id is
   authoritative; routeHash() normalizes the long form to the short one.
   Until this rule existed the alias 404'd on every cold load. */
app.get(['/u/:handle/post/:id', '/u/:handle/post/:id/'], (_req, res) => res.sendFile(path.join(root, 'index.html')));
app.get(['/admin', '/admin/'], (_req, res) => res.sendFile(path.join(root, 'index.html')));

/* Auth deep links. auth.html's own boot script reads location.pathname to
   pick the view (sign-in, sign-up, ...), the service worker's offline
   fallback already maps these exact paths to auth.html, and render.yaml
   already declares cache headers for them - only Express was missing the
   route, so a cold load, bookmark, or hard refresh of any of these 404'd
   instead of reaching the form. */
app.get(['/sign-in', '/sign-in/', '/sign-up', '/sign-up/',
  '/forgot-password', '/forgot-password/', '/otp', '/otp/',
  '/reset-password', '/reset-password/'],
  (_req, res) => res.sendFile(path.join(root, 'auth.html')));

app.use((_req, res) => res.status(404).sendFile(path.join(root, '404.html')));

app.listen(port, '0.0.0.0', () => {
  console.log(`Impose web server listening on ${port}`);
});
