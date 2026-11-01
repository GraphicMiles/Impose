/* Impose web server.
   One interface: every path that is not a real file resolves to index.html,
   which owns its own state. Nothing is served from a second page. */
const express = require('express');
const path = require('path');

const app = express();
const root = __dirname;
const port = Number(process.env.PORT || 3000);

app.disable('x-powered-by');

// index.html is an implementation detail, never a public URL.
app.get(['/index.html', '/index.html/'], (_req, res) => res.redirect(308, '/'));

app.use(express.static(root, { extensions: ['html'], index: 'index.html', redirect: false }));

// Deep links and refreshes reach the same interface instead of a 404.
app.get('*', (_req, res) => res.sendFile(path.join(root, 'index.html')));

app.listen(port, '0.0.0.0', () => {
  console.log(`Impose web server listening on ${port}`);
});
