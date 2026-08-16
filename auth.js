'use strict';

const db = require('./db');
const security = require('./security');

const SESSION_COOKIE = 'ppu_sid';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const PENDING_MINUTES = 10;

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(function (part) {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try { out[key] = decodeURIComponent(value); } catch (err) { out[key] = value; }
    }
  });
  return out;
}

function isSecureRequest(req) {
  if (req.secure) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

function setSessionCookie(req, res, id, maxAgeSeconds) {
  const attrs = [
    SESSION_COOKIE + '=' + encodeURIComponent(id),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + Math.round(maxAgeSeconds)
  ];
  if (isSecureRequest(req)) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req, res) {
  const attrs = [SESSION_COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecureRequest(req)) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

async function createSession(req, res, userId, stage) {
  const id = security.randomToken(32);
  const csrf = security.randomToken(24);
  const seconds = stage === 'awaiting_2fa' ? PENDING_MINUTES * 60 : SESSION_HOURS * 3600;
  const expires = new Date(Date.now() + seconds * 1000);
  await db.query(
    'INSERT INTO sessions (id, user_id, stage, csrf, expires_at) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, stage || 'authenticated', csrf, expires]
  );
  setSessionCookie(req, res, id, seconds);
  return { id: id, csrf: csrf };
}

async function promoteSession(req, res, sessionId) {
  const seconds = SESSION_HOURS * 3600;
  const expires = new Date(Date.now() + seconds * 1000);
  await db.query("UPDATE sessions SET stage = 'authenticated', expires_at = $2 WHERE id = $1", [sessionId, expires]);
  setSessionCookie(req, res, sessionId, seconds);
}

async function destroySession(req, res, sessionId) {
  if (sessionId) {
    try { await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]); } catch (err) { /* ignore */ }
  }
  clearSessionCookie(req, res);
}

async function destroyUserSessions(userId) {
  await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

const SESSION_SQL =
  'SELECT s.id AS sid, s.stage, s.csrf, u.id AS uid, u.email, u.full_name, u.role, u.status, u.totp_enabled ' +
  'FROM sessions s JOIN users u ON u.id = s.user_id ' +
  'WHERE s.id = $1 AND s.expires_at > now()';

async function loadSession(req, res, next) {
  req.user = null;
  req.pending = null;
  req.sessionId = null;
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return next();
  try {
    const result = await db.query(SESSION_SQL, [sid]);
    if (!result.rowCount) {
      clearSessionCookie(req, res);
      return next();
    }
    const row = result.rows[0];
    if (row.status !== 'active') {
      await destroySession(req, res, sid);
      return next();
    }
    const account = {
      id: row.uid,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      status: row.status,
      totpEnabled: row.totp_enabled,
      csrf: row.csrf,
      sessionId: row.sid
    };
    req.sessionId = row.sid;
    if (row.stage === 'authenticated') {
      req.user = account;
    } else {
      req.pending = account;
    }
  } catch (err) {
    console.error('[auth] session load failed:', err.message);
  }
  return next();
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.pending) return res.redirect('/login/verify');
  return res.redirect('/?notice=signin');
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (!req.user) return res.redirect('/?notice=signin');
  return res.status(403).send('Administrator access required.');
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === req.headers.host;
  } catch (err) {
    return false;
  }
}

function csrfGuard(req, res, next) {
  if (req.method !== 'POST') return next();
  if (!sameOrigin(req)) return res.status(403).send('Request rejected: cross-origin form submission.');
  const account = req.user || req.pending;
  if (!account) return next();
  const supplied = (req.body && req.body._csrf) || '';
  if (!security.safeEqual(supplied, account.csrf)) {
    return res.status(403).send('Request rejected: session token mismatch. Reload the page and try again.');
  }
  return next();
}

const attempts = new Map();

function throttleKey(req, extra) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  return ip + '|' + String(extra || '');
}

function tooManyAttempts(key, limit, windowMs) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter(function (t) { return now - t < windowMs; });
  attempts.set(key, list);
  return list.length >= limit;
}

function recordAttempt(key) {
  const list = attempts.get(key) || [];
  list.push(Date.now());
  attempts.set(key, list);
}

function clearAttempts(key) {
  attempts.delete(key);
}

setInterval(function () {
  const now = Date.now();
  for (const [key, list] of attempts) {
    const kept = list.filter(function (t) { return now - t < 3600000; });
    if (kept.length) attempts.set(key, kept);
    else attempts.delete(key);
  }
}, 900000).unref();

async function logAudit(actorId, action, detail) {
  try {
    await db.query('INSERT INTO audit_log (actor_id, action, detail) VALUES ($1,$2,$3)', [actorId || null, action, detail || null]);
  } catch (err) {
    console.error('[audit] failed to record ' + action + ':', err.message);
  }
}

function wrap(handler) {
  return function (req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = {
  SESSION_COOKIE,
  parseCookies,
  createSession,
  promoteSession,
  destroySession,
  destroyUserSessions,
  loadSession,
  requireAuth,
  requireAdmin,
  csrfGuard,
  throttleKey,
  tooManyAttempts,
  recordAttempt,
  clearAttempts,
  logAudit,
  wrap
};
