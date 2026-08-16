'use strict';

const express = require('express');
const QRCode = require('qrcode');
const db = require('./db');
const security = require('./security');
const auth = require('./auth');
const views = require('./views');

const router = express.Router();
const esc = views.esc;
const wrap = auth.wrap;

const ANON_PEPPER = process.env.ANON_PEPPER || 'development-pepper-please-set-ANON_PEPPER';
const MIN_PASSWORD = 12;
const MAX_COMMENT = 5000;

const PLAYER_STATUS = [
  'Full-time professional',
  'Part-time professional',
  'Semi-professional or regional',
  'Retired professional',
  'Referee or official',
  'Instructor or coach',
  'Other'
];

const NOTICES = {
  signin: 'Please sign in to continue.',
  loggedout: 'You have been signed out.',
  commented: 'Your comment was posted. It appears under your pseudonym only.',
  withdrawn: 'Your comment has been withdrawn.',
  password: 'Your password has been updated.',
  recoveryused: 'You signed in with a recovery code. That code has now been used up.',
  reenrol: 'Two-factor authentication has been reset. Set it up again to continue.'
};

function field(body, name) {
  return String((body && body[name]) || '').trim();
}

function isEmail(value) {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(String(value || '').trim());
}

function aliasFor(documentId, authorId) {
  if (!authorId) return 'Former member';
  return security.anonAlias(ANON_PEPPER, documentId, authorId);
}

// ---------------------------------------------------------------- landing

function landingBody() {
  const p = [];
  p.push('<div class="card">');
  p.push('<h1>A proposal to form a union of professional pool players</h1>');
  p.push('<p>This portal hosts the draft charter, the supporting papers, and the discussion ');
  p.push('around them. Access is by invitation only. Comments on every document are ');
  p.push('pseudonymous: your name is never shown beside anything you write.</p>');
  p.push('<p class="muted small">If you were sent an invitation link, open it to register. ');
  p.push('If you have a code but no link, use the box below.</p>');
  p.push('</div>');

  p.push('<div class="card">');
  p.push('<h2 style="margin-top:0">Member sign in</h2>');
  p.push('<form method="post" action="/login">');
  p.push('<label for="email">Email address</label>');
  p.push('<input id="email" name="email" type="email" autocomplete="username" required />');
  p.push('<label for="password">Password</label>');
  p.push('<input id="password" name="password" type="password" autocomplete="current-password" required />');
  p.push('<p class="small muted">You will be asked for a code from your authenticator app next.</p>');
  p.push('<button class="btn" type="submit">Continue</button>');
  p.push('</form>');
  p.push('</div>');

  p.push('<div class="card tight">');
  p.push('<h3 style="margin-top:0">Have an invitation code?</h3>');
  p.push('<form method="get" action="/join">');
  p.push('<label for="code">Invitation code</label>');
  p.push('<input id="code" name="code" type="text" placeholder="XXXX-XXXX-XXXX-XXXX" required />');
  p.push('<button class="btn ghost" type="submit" style="margin-top:12px">Redeem invitation</button>');
  p.push('</form>');
  p.push('</div>');
  return p.join('');
}

function landingPage(opts) {
  const o = opts || {};
  return views.layout({
    title: 'Sign in',
    narrow: true,
    body: landingBody(),
    error: o.error,
    notice: o.notice
  });
}

router.get('/', wrap(async function (req, res) {
  if (req.user) return res.redirect('/proposal');
  if (req.pending) return res.redirect('/login/verify');
  return res.send(landingPage({ notice: NOTICES[req.query.notice] }));
}));

// ---------------------------------------------------------------- sign in

router.post('/login', wrap(async function (req, res) {
  const email = field(req.body, 'email').toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const key = auth.throttleKey(req, 'login:' + email);

  if (auth.tooManyAttempts(key, 8, 15 * 60 * 1000)) {
    return res.status(429).send(landingPage({ error: 'Too many sign-in attempts. Wait fifteen minutes and try again.' }));
  }

  const result = await db.query('SELECT id, password_hash, status FROM users WHERE email = $1', [email]);
  const row = result.rows[0];
  const ok = row && security.verifyPassword(password, row.password_hash);

  if (!ok || row.status !== 'active') {
    auth.recordAttempt(key);
    return res.status(401).send(landingPage({ error: 'That email address and password were not recognised.' }));
  }

  auth.clearAttempts(key);
  if (req.sessionId) await auth.destroySession(req, res, req.sessionId);
  await auth.createSession(req, res, row.id, 'awaiting_2fa');
  return res.redirect('/login/verify');
}));

function verifyPage(opts) {
  const o = opts || {};
  const p = [];
  p.push('<div class="card">');
  p.push('<h1>Two-factor verification</h1>');
  p.push('<p class="muted">Open your authenticator app and enter the current six digit code for ');
  p.push(esc(views.SITE_NAME) + '.</p>');
  p.push('<form method="post" action="/login/verify">');
  p.push(views.csrfField(o.csrf));
  p.push('<label for="token">Six digit code, or a recovery code</label>');
  p.push('<input id="token" name="token" type="text" inputmode="text" autocomplete="one-time-code" autofocus required />');
  p.push('<button class="btn" type="submit" style="margin-top:14px">Verify</button>');
  p.push('</form>');
  p.push('<p class="small muted" style="margin-top:18px">Lost your device? Use one of the recovery ');
  p.push('codes issued when you registered, or ask an administrator to reset your enrolment.</p>');
  p.push('</div>');
  p.push('<form method="post" action="/logout"><button class="btn ghost tiny" type="submit">Cancel and sign out</button>' + views.csrfField(o.csrf) + '</form>');
  return views.layout({ title: 'Verify', narrow: true, body: p.join(''), error: o.error });
}

router.get('/login/verify', wrap(async function (req, res) {
  if (req.user) return res.redirect('/proposal');
  if (!req.pending) return res.redirect('/');
  if (!req.pending.totpEnabled) return res.redirect('/join/2fa');
  return res.send(verifyPage({ csrf: req.pending.csrf }));
}));

router.post('/login/verify', wrap(async function (req, res) {
  const account = req.pending;
  if (!account) return res.redirect('/');
  if (!account.totpEnabled) return res.redirect('/join/2fa');

  const token = field(req.body, 'token');
  const key = auth.throttleKey(req, 'totp:' + account.id);
  if (auth.tooManyAttempts(key, 8, 15 * 60 * 1000)) {
    return res.status(429).send(verifyPage({ csrf: account.csrf, error: 'Too many attempts. Wait fifteen minutes and try again.' }));
  }

  const result = await db.query('SELECT totp_secret, recovery_hashes FROM users WHERE id = $1', [account.id]);
  const row = result.rows[0] || {};
  let ok = security.verifyTotp(row.totp_secret, token);
  let usedRecovery = false;

  if (!ok && row.recovery_hashes && security.normalizeCode(token).length >= 8) {
    let hashes = [];
    try { hashes = JSON.parse(row.recovery_hashes) || []; } catch (err) { hashes = []; }
    const candidate = security.hashRecoveryCode(ANON_PEPPER, token);
    const idx = hashes.indexOf(candidate);
    if (idx >= 0) {
      hashes.splice(idx, 1);
      await db.query('UPDATE users SET recovery_hashes = $2 WHERE id = $1', [account.id, JSON.stringify(hashes)]);
      ok = true;
      usedRecovery = true;
    }
  }

  if (!ok) {
    auth.recordAttempt(key);
    return res.status(401).send(verifyPage({ csrf: account.csrf, error: 'That code was not accepted. Check your clock and try the next code.' }));
  }

  auth.clearAttempts(key);
  await auth.promoteSession(req, res, account.sessionId);
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [account.id]);
  await auth.logAudit(account.id, 'auth.login', usedRecovery ? 'signed in with a recovery code' : 'signed in');
  return res.redirect(usedRecovery ? '/account?notice=recoveryused' : '/proposal');
}));

router.post('/logout', wrap(async function (req, res) {
  const id = req.sessionId;
  const who = req.user ? req.user.id : null;
  await auth.destroySession(req, res, id);
  if (who) await auth.logAudit(who, 'auth.logout', 'signed out');
  return res.redirect('/?notice=loggedout');
}));

// ---------------------------------------------------------------- joining

async function findInvite(rawCode) {
  const norm = security.normalizeCode(rawCode);
  if (!norm) return null;
  const result = await db.query("SELECT * FROM invites WHERE upper(replace(code, '-', '')) = $1", [norm]);
  return result.rows[0] || null;
}

function inviteProblem(invite) {
  if (!invite) return 'That invitation code was not recognised.';
  if (invite.revoked_at) return 'That invitation has been revoked.';
  if (invite.used_at) return 'That invitation has already been used.';
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) return 'That invitation has expired.';
  return null;
}

function joinPage(opts) {
  const o = opts || {};
  const v = o.values || {};
  const lockedEmail = o.invite && o.invite.email;
  const p = [];

  p.push('<div class="card">');
  p.push('<h1>Register your membership</h1>');
  p.push('<p class="muted">Your details are used to verify that members are genuine players and to ');
  p.push('run votes. They are never attached to anything you write on the documents.</p>');
  if (o.invite && o.invite.role === 'admin') {
    p.push('<p><span class="pill warn">Administrator invitation</span></p>');
  }
  p.push('<form method="post" action="/join">');
  p.push('<input type="hidden" name="code" value="' + esc(o.code) + '" />');

  p.push('<label for="full_name">Full name</label>');
  p.push('<input id="full_name" name="full_name" type="text" required value="' + esc(v.full_name) + '" />');

  p.push('<label for="email">Email address</label>');
  if (lockedEmail) {
    p.push('<input id="email" name="email" type="email" readonly value="' + esc(o.invite.email) + '" />');
    p.push('<p class="small muted">This invitation is tied to this address.</p>');
  } else {
    p.push('<input id="email" name="email" type="email" required value="' + esc(v.email) + '" />');
  }

  p.push('<div class="row">');
  p.push('<div><label for="phone">Phone (optional)</label>');
  p.push('<input id="phone" name="phone" type="tel" value="' + esc(v.phone) + '" /></div>');
  p.push('<div><label for="player_status">Competitive status</label><select id="player_status" name="player_status">');
  for (const status of PLAYER_STATUS) {
    p.push('<option value="' + esc(status) + '"' + (v.player_status === status ? ' selected' : '') + '>' + esc(status) + '</option>');
  }
  p.push('</select></div>');
  p.push('</div>');

  p.push('<div class="row">');
  p.push('<div><label for="city">City</label><input id="city" name="city" type="text" value="' + esc(v.city) + '" /></div>');
  p.push('<div><label for="region">State or region</label><input id="region" name="region" type="text" value="' + esc(v.region) + '" /></div>');
  p.push('<div><label for="country">Country</label><input id="country" name="country" type="text" value="' + esc(v.country) + '" /></div>');
  p.push('</div>');

  p.push('<label for="affiliations">Tours, leagues or federations you compete in (optional)</label>');
  p.push('<input id="affiliations" name="affiliations" type="text" value="' + esc(v.affiliations) + '" />');

  p.push('<div class="row">');
  p.push('<div><label for="password">Password (at least ' + MIN_PASSWORD + ' characters)</label>');
  p.push('<input id="password" name="password" type="password" autocomplete="new-password" required /></div>');
  p.push('<div><label for="password2">Repeat password</label>');
  p.push('<input id="password2" name="password2" type="password" autocomplete="new-password" required /></div>');
  p.push('</div>');

  p.push('<p class="small muted" style="margin-top:16px">The next step sets up two-factor ');
  p.push('authentication with an authenticator app. It is required, so have your phone to hand.</p>');
  p.push('<button class="btn" type="submit">Create account</button>');
  p.push('</form></div>');
  return views.layout({ title: 'Register', narrow: true, body: p.join(''), error: o.error });
}

router.get('/join', wrap(async function (req, res) {
  if (req.user) return res.redirect('/proposal');
  const code = String(req.query.code || '');
  const invite = await findInvite(code);
  const problem = inviteProblem(invite);
  if (problem) {
    return res.status(400).send(views.layout({
      title: 'Invitation',
      narrow: true,
      error: problem,
      body: '<div class="card"><h1>Invitation not valid</h1><p class="muted">Ask whoever invited you to ' +
        'issue a fresh invitation.</p><p><a href="/">Back to sign in</a></p></div>'
    }));
  }
  return res.send(joinPage({ code: code, invite: invite, values: {} }));
}));

router.post('/join', wrap(async function (req, res) {
  const code = field(req.body, 'code');
  const invite = await findInvite(code);
  const problem = inviteProblem(invite);
  const values = {
    full_name: field(req.body, 'full_name'),
    email: field(req.body, 'email').toLowerCase(),
    phone: field(req.body, 'phone'),
    city: field(req.body, 'city'),
    region: field(req.body, 'region'),
    country: field(req.body, 'country'),
    affiliations: field(req.body, 'affiliations'),
    player_status: field(req.body, 'player_status')
  };

  if (problem) {
    return res.status(400).send(views.layout({
      title: 'Invitation', narrow: true, error: problem,
      body: '<div class="card"><h1>Invitation not valid</h1><p><a href="/">Back to sign in</a></p></div>'
    }));
  }

  if (invite.email) values.email = String(invite.email).toLowerCase();

  const password = String((req.body && req.body.password) || '');
  const password2 = String((req.body && req.body.password2) || '');
  const fail = function (message) {
    return res.status(400).send(joinPage({ code: code, invite: invite, values: values, error: message }));
  };

  if (values.full_name.length < 2) return fail('Please give the name you compete under.');
  if (!isEmail(values.email)) return fail('That does not look like a valid email address.');
  if (password.length < MIN_PASSWORD) return fail('Your password must be at least ' + MIN_PASSWORD + ' characters long.');
  if (password !== password2) return fail('The two passwords did not match.');

  const existing = await db.query('SELECT id FROM users WHERE email = $1', [values.email]);
  if (existing.rowCount) return fail('An account already exists for that email address. Try signing in instead.');

  const hash = security.hashPassword(password);
  const secret = security.generateTotpSecret();
  const inserted = await db.query(
    'INSERT INTO users (email, password_hash, full_name, phone, city, region, country, player_status, affiliations, role, status, totp_secret, totp_enabled) ' +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,false) RETURNING id",
    [values.email, hash, values.full_name, values.phone || null, values.city || null, values.region || null,
      values.country || null, values.player_status || null, values.affiliations || null,
      invite.role === 'admin' ? 'admin' : 'member', secret]
  );
  const userId = inserted.rows[0].id;

  await db.query('UPDATE invites SET used_at = now(), used_by = $2 WHERE id = $1', [invite.id, userId]);
  await auth.logAudit(userId, 'member.register', 'redeemed invitation ' + invite.code);

  if (req.sessionId) await auth.destroySession(req, res, req.sessionId);
  await auth.createSession(req, res, userId, 'awaiting_2fa');
  return res.redirect('/join/2fa');
}));

// ------------------------------------------------------------ 2fa enrolment

router.get('/join/2fa', wrap(async function (req, res) {
  const account = req.pending || req.user;
  if (!account) return res.redirect('/');
  if (account.totpEnabled && req.user) return res.redirect('/account');
  if (account.totpEnabled && req.pending) return res.redirect('/login/verify');

  const result = await db.query('SELECT totp_secret FROM users WHERE id = $1', [account.id]);
  let secret = result.rows[0] && result.rows[0].totp_secret;
  if (!secret) {
    secret = security.generateTotpSecret();
    await db.query('UPDATE users SET totp_secret = $2 WHERE id = $1', [account.id, secret]);
  }

  const url = security.otpauthUrl(secret, account.email, views.SITE_NAME);
  let image = '';
  try {
    image = await QRCode.toDataURL(url, { margin: 1, width: 220, color: { dark: '#0b110f', light: '#e8f1ec' } });
  } catch (err) {
    console.error('[2fa] qr generation failed:', err.message);
  }

  const p = [];
  p.push('<div class="card">');
  p.push('<h1>Set up two-factor authentication</h1>');
  p.push('<p class="muted">Two-factor authentication is mandatory. A leaked membership list is the ');
  p.push('single most damaging thing that could happen to this effort.</p>');
  p.push('<ol><li>Open an authenticator app such as Aegis, Authy, 1Password, or Google Authenticator.</li>');
  p.push('<li>Scan this code, or enter the key by hand.</li>');
  p.push('<li>Type the six digit code it shows.</li></ol>');
  if (image) p.push('<p><img alt="Authenticator QR code" src="' + esc(image) + '" width="220" height="220" style="border-radius:8px" /></p>');
  p.push('<p class="small muted">Setup key</p><div class="code">' + esc(secret) + '</div>');
  p.push('<form method="post" action="/join/2fa">');
  p.push(views.csrfField(account.csrf));
  p.push('<label for="token">Six digit code</label>');
  p.push('<input id="token" name="token" type="text" inputmode="numeric" autocomplete="one-time-code" required />');
  p.push('<button class="btn" type="submit" style="margin-top:14px">Confirm and finish</button>');
  p.push('</form></div>');

  return res.send(views.layout({ title: 'Two-factor setup', narrow: true, body: p.join(''), error: NOTICES[req.query.notice] ? null : null, notice: NOTICES[req.query.notice] }));
}));

router.post('/join/2fa', wrap(async function (req, res) {
  const account = req.pending || req.user;
  if (!account) return res.redirect('/');

  const result = await db.query('SELECT totp_secret FROM users WHERE id = $1', [account.id]);
  const secret = result.rows[0] && result.rows[0].totp_secret;
  const token = field(req.body, 'token');

  if (!secret || !security.verifyTotp(secret, token)) {
    return res.redirect('/join/2fa?notice=badcode');
  }

  const codes = [];
  for (let i = 0; i < 8; i++) codes.push(security.recoveryCode());
  const hashes = codes.map(function (c) { return security.hashRecoveryCode(ANON_PEPPER, c); });

  await db.query('UPDATE users SET totp_enabled = true, recovery_hashes = $2 WHERE id = $1', [account.id, JSON.stringify(hashes)]);
  if (req.pending) await auth.promoteSession(req, res, account.sessionId);
  await auth.logAudit(account.id, 'member.2fa_enrolled', 'completed authenticator enrolment');

  const p = [];
  p.push('<div class="card">');
  p.push('<h1>You are registered</h1>');
  p.push('<p>Two-factor authentication is active on your account. Save these eight recovery codes ');
  p.push('now: each one can be used once if you lose your authenticator, and they will not be shown again.</p>');
  p.push('<div class="codes">' + codes.map(function (c) { return '<div>' + esc(c) + '</div>'; }).join('') + '</div>');
  p.push('<p class="small muted" style="margin-top:16px">Print them or put them in a password manager. ');
  p.push('If you lose them as well, an administrator can reset your enrolment.</p>');
  p.push('<p style="margin-top:20px"><a class="btn" href="/proposal">Read the charter</a></p>');
  p.push('</div>');
  return res.send(views.layout({ title: 'Registered', narrow: true, body: p.join(''), user: req.user || null }));
}));

module.exports = router;
module.exports.PLAYER_STATUS = PLAYER_STATUS;
module.exports.aliasFor = aliasFor;
module.exports.NOTICES = NOTICES;
module.exports.MAX_COMMENT = MAX_COMMENT;
module.exports.MIN_PASSWORD = MIN_PASSWORD;
module.exports.field = field;
