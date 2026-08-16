'use strict';

const express = require('express');
const db = require('./db');
const auth = require('./auth');
const views = require('./views');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(function (req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  next();
});

app.get('/healthz', function (req, res) {
  res.type('text/plain').send('ok');
});

app.get('/robots.txt', function (req, res) {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(auth.loadSession);
app.use(auth.csrfGuard);

app.use(require('./routes'));
app.use(require('./documents'));
app.use('/admin', require('./admin'));
app.use('/admin', require('./admin-docs'));

app.use(function (req, res) {
  res.status(404).send(views.layout({
    title: 'Not found',
    user: req.user,
    narrow: true,
    body: '<div class="card"><h1>Not found</h1><p class="muted">There is nothing at that address.</p>' +
      '<p><a href="/">Back to the portal</a></p></div>'
  }));
});

app.use(function (err, req, res, next) {
  console.error('[error]', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).send(views.layout({
    title: 'Something went wrong',
    user: req.user,
    narrow: true,
    body: '<div class="card"><h1>Something went wrong</h1><p class="muted">The problem has been ' +
      'written to the server log. Try again, and tell an administrator if it keeps happening.</p>' +
      '<p><a href="/">Back to the portal</a></p></div>'
  }));
});

const port = Number(process.env.PORT || 3000);

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function initWithRetry() {
  let lastError = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      return await db.init();
    } catch (err) {
      lastError = err;
      console.error('[startup] database not ready (attempt ' + attempt + '): ' + err.message);
      await sleep(Math.min(attempt * 2000, 10000));
    }
  }
  throw lastError;
}

async function start() {
  if (!process.env.DATABASE_URL) {
    console.error('[startup] DATABASE_URL is not set. Attach a Postgres database to this service.');
  }
  if (!process.env.ANON_PEPPER) {
    console.warn('[startup] ANON_PEPPER is not set. Set it before members start commenting, ' +
      'because changing it later changes every pseudonym.');
  }

  await initWithRetry();

  setInterval(function () {
    db.purgeExpiredSessions();
  }, 3600000).unref();

  app.listen(port, '0.0.0.0', function () {
    console.log('[ready] ' + views.SITE_NAME + ' listening on port ' + port);
  });
}

start().catch(function (err) {
  console.error('[fatal] startup failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
