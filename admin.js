'use strict';

const express = require('express');
const db = require('./db');
const security = require('./security');
const auth = require('./auth');
const views = require('./views');
const routes = require('./routes');

const router = express.Router();
const esc = views.esc;
const wrap = auth.wrap;
const field = routes.field;

const DONE = {
  invited: 'Invitation created. Copy the link below and send it privately.',
  revoked: 'Invitation revoked.',
  member: 'Member record updated.',
  reset2fa: 'Two-factor enrolment reset. That member will enrol again at next sign in.',
  doc: 'Document created.',
  version: 'New version published.',
  settings: 'Document settings updated.',
  removed: 'Comment removed from the discussion.',
  restored: 'Comment restored.'
};

const PROBLEMS = {
  self: 'You cannot apply that change to your own account.',
  lastadmin: 'That would leave the portal with no active administrator.',
  body: 'The document text cannot be empty.',
  title: 'A title is required.'
};

function baseUrl(req) {
  const configured = String(process.env.PUBLIC_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return proto + '://' + req.headers.host;
}

function adminNav(active) {
  const items = [
    ['/admin', 'Overview', 'overview'],
    ['/admin/invites', 'Invitations', 'invites'],
    ['/admin/members', 'Members', 'members'],
    ['/admin/documents', 'Documents', 'documents'],
    ['/admin/comments', 'Moderation', 'comments'],
    ['/admin/audit', 'Audit log', 'audit']
  ];
  const links = items.map(function (i) {
    return '<a class="btn ' + (active === i[2] ? '' : 'ghost') + ' tiny" href="' + i[0] + '">' + esc(i[1]) + '</a>';
  }).join('');
  return '<div class="card tight"><div style="display:flex;gap:8px;flex-wrap:wrap">' + links + '</div></div>';
}

function adminPage(req, active, title, body) {
  return views.layout({
    title: title,
    user: req.user,
    active: 'admin',
    body: adminNav(active) + body,
    notice: DONE[req.query.done],
    error: PROBLEMS[req.query.problem]
  });
}

router.use(auth.requireAdmin);

// ---------------------------------------------------------------- overview

router.get('/', wrap(async function (req, res) {
  const stats = await db.query(
    'SELECT ' +
    "(SELECT count(*)::int FROM users WHERE status = 'active') AS members, " +
    "(SELECT count(*)::int FROM users WHERE role = 'admin' AND status = 'active') AS admins, " +
    "(SELECT count(*)::int FROM users WHERE status <> 'active') AS inactive, " +
    '(SELECT count(*)::int FROM invites WHERE used_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS open_invites, ' +
    '(SELECT count(*)::int FROM comments WHERE deleted_at IS NULL) AS comments, ' +
    '(SELECT count(*)::int FROM comments WHERE deleted_at IS NOT NULL) AS hidden, ' +
    '(SELECT count(*)::int FROM documents WHERE archived = false) AS documents, ' +
    '(SELECT count(*)::int FROM document_versions) AS versions'
  );
  const s = stats.rows[0];

  const recent = await db.query(
    'SELECT a.action, a.detail, a.created_at, u.full_name FROM audit_log a ' +
    'LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT 8'
  );

  const cards = [
    ['Active members', s.members],
    ['Administrators', s.admins],
    ['Suspended or removed', s.inactive],
    ['Open invitations', s.open_invites],
    ['Live comments', s.comments],
    ['Hidden comments', s.hidden],
    ['Documents', s.documents],
    ['Published versions', s.versions]
  ];

  const p = [];
  p.push('<h1>Admin overview</h1>');
  p.push('<div class="grid">');
  for (const c of cards) {
    p.push('<div class="card"><p class="small muted" style="margin:0">' + esc(c[0]) +
      '</p><p style="font-size:30px;font-weight:700;margin:6px 0 0">' + Number(c[1]) + '</p></div>');
  }
  p.push('</div>');

  p.push('<div class="card"><h2 style="margin-top:0">Recent activity</h2><table>');
  p.push('<tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr>');
  for (const r of recent.rows) {
    p.push('<tr><td class="small">' + esc(views.formatDate(r.created_at)) + '</td><td class="small">' +
      esc(r.full_name || 'system') + '</td><td class="small">' + esc(r.action) + '</td><td class="small">' +
      esc(r.detail || '') + '</td></tr>');
  }
  p.push('</table><p class="small muted">The audit log never records who wrote a comment.</p></div>');

  return res.send(adminPage(req, 'overview', 'Admin', p.join('')));
}));

// --------------------------------------------------------------- invitations

router.get('/invites', wrap(async function (req, res) {
  const result = await db.query(
    'SELECT i.*, c.full_name AS creator, u.full_name AS redeemer FROM invites i ' +
    'LEFT JOIN users c ON c.id = i.created_by LEFT JOIN users u ON u.id = i.used_by ' +
    'ORDER BY i.created_at DESC LIMIT 200'
  );
  const root = baseUrl(req);

  const p = [];
  p.push('<h1>Invitations</h1>');
  p.push('<div class="card"><h2 style="margin-top:0">Issue an invitation</h2>');
  p.push('<form method="post" action="/admin/invites">');
  p.push(views.csrfField(req.user.csrf));
  p.push('<div class="row">');
  p.push('<div><label for="email">Tie to an email address (optional)</label><input id="email" name="email" type="email" /></div>');
  p.push('<div><label for="role">Role</label><select id="role" name="role"><option value="member">Member</option><option value="admin">Administrator</option></select></div>');
  p.push('<div><label for="days">Valid for (days)</label><input id="days" name="days" type="text" value="21" /></div>');
  p.push('</div>');
  p.push('<label for="note">Private note (who is this for?)</label><input id="note" name="note" type="text" />');
  p.push('<button class="btn" type="submit" style="margin-top:14px">Create invitation</button>');
  p.push('<p class="small muted">Send the link over a private channel. Anyone holding the link can register once.</p>');
  p.push('</form></div>');

  p.push('<div class="card"><h2 style="margin-top:0">Issued invitations</h2><table>');
  p.push('<tr><th>Code and link</th><th>For</th><th>Status</th><th>Created</th><th></th></tr>');
  for (const i of result.rows) {
    const link = root + '/join?code=' + encodeURIComponent(i.code);
    let status = '<span class="pill on">open</span>';
    if (i.used_at) status = '<span class="pill">used by ' + esc(i.redeemer || 'a member') + '</span>';
    else if (i.revoked_at) status = '<span class="pill bad">revoked</span>';
    else if (i.expires_at && new Date(i.expires_at).getTime() < Date.now()) status = '<span class="pill warn">expired</span>';

    p.push('<tr><td class="small"><strong>' + esc(i.code) + '</strong>');
    if (!i.used_at && !i.revoked_at) p.push('<br /><span class="muted" style="word-break:break-all">' + esc(link) + '</span>');
    p.push('</td>');
    p.push('<td class="small">' + esc(i.email || 'anyone with the link') +
      (i.role === 'admin' ? '<br /><span class="pill warn">admin</span>' : '') +
      (i.note ? '<br /><span class="muted">' + esc(i.note) + '</span>' : '') + '</td>');
    p.push('<td class="small">' + status + '</td>');
    p.push('<td class="small">' + esc(views.formatDate(i.created_at)) +
      (i.creator ? '<br /><span class="muted">' + esc(i.creator) + '</span>' : '') + '</td>');
    p.push('<td>');
    if (!i.used_at && !i.revoked_at) {
      p.push('<form method="post" action="/admin/invites/' + i.id + '/revoke">' + views.csrfField(req.user.csrf) +
        '<button class="btn ghost tiny" type="submit">Revoke</button></form>');
    }
    p.push('</td></tr>');
  }
  p.push('</table></div>');

  return res.send(adminPage(req, 'invites', 'Invitations', p.join('')));
}));

router.post('/invites', wrap(async function (req, res) {
  const email = field(req.body, 'email').toLowerCase() || null;
  const role = field(req.body, 'role') === 'admin' ? 'admin' : 'member';
  const note = field(req.body, 'note').slice(0, 200) || null;
  let days = parseInt(field(req.body, 'days'), 10);
  if (isNaN(days) || days < 1) days = 21;
  if (days > 365) days = 365;

  const code = security.inviteCode();
  await db.query(
    "INSERT INTO invites (code, email, role, note, created_by, expires_at) VALUES ($1,$2,$3,$4,$5, now() + ($6 * interval '1 day'))",
    [code, email, role, note, req.user.id, days]
  );
  await auth.logAudit(req.user.id, 'invite.created', 'issued a ' + role + ' invitation' + (email ? ' for ' + email : ''));
  return res.redirect('/admin/invites?done=invited');
}));

router.post('/invites/:id/revoke', wrap(async function (req, res) {
  const id = parseInt(req.params.id, 10);
  if (!isNaN(id)) {
    await db.query('UPDATE invites SET revoked_at = now() WHERE id = $1 AND used_at IS NULL', [id]);
    await auth.logAudit(req.user.id, 'invite.revoked', 'revoked invitation ' + id);
  }
  return res.redirect('/admin/invites?done=revoked');
}));

// ------------------------------------------------------------------ members

router.get('/members', wrap(async function (req, res) {
  const result = await db.query(
    'SELECT id, email, full_name, phone, city, region, country, player_status, affiliations, role, status, ' +
    'totp_enabled, created_at, last_login_at FROM users ORDER BY created_at ASC'
  );

  const p = [];
  p.push('<h1>Members</h1>');
  p.push('<p class="muted small">Suspending a member blocks sign in and ends their sessions. Their ' +
    'comments stay in the discussion under their pseudonym. Nothing here shows who wrote what.</p>');
  p.push('<div class="card"><table>');
  p.push('<tr><th>Member</th><th>Details</th><th>Role</th><th>Status</th><th>Security</th><th>Actions</th></tr>');

  for (const m of result.rows) {
    p.push('<tr>');
    p.push('<td class="small"><strong>' + esc(m.full_name) + '</strong><br /><span class="muted">' + esc(m.email) + '</span></td>');
    p.push('<td class="small muted">' + esc([m.city, m.region, m.country].filter(Boolean).join(', ') || '-') +
      (m.player_status ? '<br />' + esc(m.player_status) : '') +
      (m.affiliations ? '<br />' + esc(m.affiliations) : '') +
      (m.phone ? '<br />' + esc(m.phone) : '') + '</td>');
    p.push('<td class="small">' + (m.role === 'admin' ? '<span class="pill warn">admin</span>' : '<span class="pill">member</span>') + '</td>');
    p.push('<td class="small">' + (m.status === 'active' ? '<span class="pill on">active</span>' : '<span class="pill bad">' + esc(m.status) + '</span>') +
      '<br /><span class="muted">joined ' + esc(views.formatDate(m.created_at)) + '</span></td>');
    p.push('<td class="small">' + (m.totp_enabled ? 'authenticator enrolled' : '<span class="pill warn">not enrolled</span>') +
      '<br /><span class="muted">last seen ' + esc(views.formatDate(m.last_login_at) || 'never') + '</span></td>');

    p.push('<td class="small"><div style="display:flex;flex-direction:column;gap:6px">');
    if (m.id !== req.user.id) {
      p.push('<form method="post" action="/admin/members/' + m.id + '/role">' + views.csrfField(req.user.csrf) +
        '<input type="hidden" name="role" value="' + (m.role === 'admin' ? 'member' : 'admin') + '" />' +
        '<button class="btn ghost tiny" type="submit">' + (m.role === 'admin' ? 'Make member' : 'Make admin') + '</button></form>');
      p.push('<form method="post" action="/admin/members/' + m.id + '/status">' + views.csrfField(req.user.csrf) +
        '<input type="hidden" name="status" value="' + (m.status === 'active' ? 'suspended' : 'active') + '" />' +
        '<button class="btn ' + (m.status === 'active' ? 'danger' : 'ghost') + ' tiny" type="submit">' +
        (m.status === 'active' ? 'Suspend' : 'Reinstate') + '</button></form>');
    } else {
      p.push('<span class="muted">this is you</span>');
    }
    p.push('<form method="post" action="/admin/members/' + m.id + '/reset-2fa">' + views.csrfField(req.user.csrf) +
      '<button class="btn ghost tiny" type="submit">Reset 2FA</button></form>');
    p.push('</div></td></tr>');
  }
  p.push('</table></div>');

  return res.send(adminPage(req, 'members', 'Members', p.join('')));
}));

async function activeAdminCount() {
  const result = await db.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'");
  return result.rows[0].n;
}

router.post('/members/:id/role', wrap(async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const role = field(req.body, 'role') === 'admin' ? 'admin' : 'member';
  if (isNaN(id)) return res.redirect('/admin/members');
  if (id === req.user.id) return res.redirect('/admin/members?problem=self');

  const target = await db.query('SELECT role, status, full_name FROM users WHERE id = $1', [id]);
  if (!target.rowCount) return res.redirect('/admin/members');
  if (target.rows[0].role === 'admin' && role === 'member' && (await activeAdminCount()) <= 1) {
    return res.redirect('/admin/members?problem=lastadmin');
  }

  await db.query('UPDATE users SET role = $2 WHERE id = $1', [id, role]);
  await auth.logAudit(req.user.id, 'member.role_changed', 'set ' + target.rows[0].full_name + ' to ' + role);
  return res.redirect('/admin/members?done=member');
}));

router.post('/members/:id/status', wrap(async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const status = field(req.body, 'status') === 'active' ? 'active' : 'suspended';
  if (isNaN(id)) return res.redirect('/admin/members');
  if (id === req.user.id) return res.redirect('/admin/members?problem=self');

  const target = await db.query('SELECT role, status, full_name FROM users WHERE id = $1', [id]);
  if (!target.rowCount) return res.redirect('/admin/members');
  if (status !== 'active' && target.rows[0].role === 'admin' && (await activeAdminCount()) <= 1) {
    return res.redirect('/admin/members?problem=lastadmin');
  }

  await db.query('UPDATE users SET status = $2 WHERE id = $1', [id, status]);
  if (status !== 'active') await auth.destroyUserSessions(id);
  await auth.logAudit(req.user.id, 'member.status_changed', 'set ' + target.rows[0].full_name + ' to ' + status);
  return res.redirect('/admin/members?done=member');
}));

router.post('/members/:id/reset-2fa', wrap(async function (req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.redirect('/admin/members');
  const target = await db.query('SELECT full_name FROM users WHERE id = $1', [id]);
  if (!target.rowCount) return res.redirect('/admin/members');

  await db.query('UPDATE users SET totp_enabled = false, totp_secret = NULL, recovery_hashes = NULL WHERE id = $1', [id]);
  await auth.destroyUserSessions(id);
  await auth.logAudit(req.user.id, 'member.2fa_reset', 'reset two-factor for ' + target.rows[0].full_name);
  return res.redirect('/admin/members?done=reset2fa');
}));

// ---------------------------------------------------------------- audit log

router.get('/audit', wrap(async function (req, res) {
  const result = await db.query(
    'SELECT a.action, a.detail, a.created_at, u.full_name FROM audit_log a ' +
    'LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT 300'
  );
  const p = [];
  p.push('<h1>Audit log</h1>');
  p.push('<p class="muted small">Administrative and account actions. Comment authorship is never recorded here.</p>');
  p.push('<div class="card"><table><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr>');
  for (const r of result.rows) {
    p.push('<tr><td class="small">' + esc(views.formatDate(r.created_at)) + '</td><td class="small">' +
      esc(r.full_name || 'system') + '</td><td class="small">' + esc(r.action) + '</td><td class="small">' +
      esc(r.detail || '') + '</td></tr>');
  }
  p.push('</table></div>');
  return res.send(adminPage(req, 'audit', 'Audit log', p.join('')));
}));

module.exports = router;
module.exports.adminPage = adminPage;
module.exports.baseUrl = baseUrl;
