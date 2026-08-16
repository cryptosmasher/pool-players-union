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
const aliasFor = routes.aliasFor;
const field = routes.field;

router.use(auth.requireAuth);

async function loadDocument(slug) {
  const result = await db.query('SELECT * FROM documents WHERE slug = $1', [slug]);
  return result.rows[0] || null;
}

async function loadVersion(documentId, versionNumber) {
  if (versionNumber) {
    const result = await db.query(
      'SELECT * FROM document_versions WHERE document_id = $1 AND version_number = $2',
      [documentId, versionNumber]
    );
    return result.rows[0] || null;
  }
  const result = await db.query(
    'SELECT * FROM document_versions WHERE document_id = $1 ORDER BY is_current DESC, version_number DESC LIMIT 1',
    [documentId]
  );
  return result.rows[0] || null;
}

async function loadComments(documentId) {
  const result = await db.query(
    'SELECT c.id, c.body, c.section, c.created_at, c.parent_id, c.author_id, c.deleted_at, c.deleted_reason, ' +
    'v.version_number FROM comments c LEFT JOIN document_versions v ON v.id = c.version_id ' +
    'WHERE c.document_id = $1 ORDER BY c.created_at ASC',
    [documentId]
  );
  return result.rows;
}

function commentBody(row) {
  if (!row.deleted_at) return '<div class="body">' + esc(row.body) + '</div>';
  const reason = row.deleted_reason === 'withdrawn'
    ? 'This comment was withdrawn by its author.'
    : 'This comment was removed by a moderator.';
  return '<div class="body">' + esc(reason) + '</div>';
}

function commentCard(row, doc, user, isReply) {
  const p = [];
  p.push('<div class="comment' + (isReply ? ' reply' : '') + (row.deleted_at ? ' removed' : '') + '" id="c' + row.id + '">');
  p.push('<div class="meta">');
  p.push('<span class="alias">' + esc(aliasFor(doc.id, row.author_id)) + '</span>');
  p.push('<span>' + esc(views.formatDate(row.created_at)) + '</span>');
  if (row.version_number) p.push('<span class="pill">version ' + Number(row.version_number) + '</span>');
  if (row.section) p.push('<span class="pill">' + esc(row.section) + '</span>');
  p.push('</div>');
  p.push(commentBody(row));

  if (!row.deleted_at) {
    const tools = [];
    if (!isReply && doc.comments_enabled) {
      tools.push('<details style="margin-top:8px"><summary class="small muted" style="cursor:pointer">Reply</summary>' +
        '<form method="post" action="/documents/' + esc(doc.slug) + '/comments" style="margin-top:8px">' +
        views.csrfField(user.csrf) +
        '<input type="hidden" name="parent_id" value="' + row.id + '" />' +
        '<textarea name="body" maxlength="' + routes.MAX_COMMENT + '" required placeholder="Reply anonymously"></textarea>' +
        '<button class="btn tiny" type="submit" style="margin-top:8px">Post reply</button>' +
        '</form></details>');
    }
    if (row.author_id === user.id) {
      tools.push('<form method="post" action="/comments/' + row.id + '/withdraw" style="margin-top:8px">' +
        views.csrfField(user.csrf) +
        '<button class="btn ghost tiny" type="submit">Withdraw this comment</button></form>');
    }
    if (tools.length) p.push('<div>' + tools.join('') + '</div>');
  }
  p.push('</div>');
  return p.join('');
}

function renderThread(rows, doc, user) {
  const children = new Map();
  const roots = [];
  for (const row of rows) {
    if (row.parent_id) {
      const list = children.get(row.parent_id) || [];
      list.push(row);
      children.set(row.parent_id, list);
    } else {
      roots.push(row);
    }
  }
  roots.reverse();
  if (!roots.length) {
    return '<p class="muted">No comments yet. Be the first: nothing you write here carries your name.</p>';
  }
  const out = [];
  for (const root of roots) {
    out.push(commentCard(root, doc, user, false));
    for (const child of (children.get(root.id) || [])) {
      out.push(commentCard(child, doc, user, true));
    }
  }
  return out.join('');
}

router.get('/proposal', wrap(async function (req, res) {
  const result = await db.query('SELECT slug FROM documents WHERE is_primary = true AND archived = false ORDER BY sort_order ASC LIMIT 1');
  if (!result.rowCount) return res.redirect('/documents');
  return res.redirect('/documents/' + encodeURIComponent(result.rows[0].slug));
}));

router.get('/documents', wrap(async function (req, res) {
  const result = await db.query(
    'SELECT d.*, v.version_number, v.created_at AS revised_at, ' +
    '(SELECT count(*)::int FROM comments c WHERE c.document_id = d.id AND c.deleted_at IS NULL) AS comment_count ' +
    'FROM documents d LEFT JOIN document_versions v ON v.document_id = d.id AND v.is_current = true ' +
    'WHERE d.archived = false ORDER BY d.sort_order ASC, d.title ASC'
  );

  const p = [];
  p.push('<h1>Documents</h1>');
  p.push('<p class="muted">Every document is open for comment. Comments are pseudonymous.</p>');
  p.push('<div class="grid">');
  for (const doc of result.rows) {
    p.push('<a class="card" href="/documents/' + esc(doc.slug) + '" style="display:block;color:inherit">');
    if (doc.is_primary) p.push('<p style="margin:0 0 8px"><span class="pill on">Central proposal</span></p>');
    p.push('<h3 style="margin:0 0 8px">' + esc(doc.title) + '</h3>');
    p.push('<p class="small muted" style="margin:0 0 10px">' + esc(doc.summary || '') + '</p>');
    p.push('<p class="small muted" style="margin:0">Version ' + Number(doc.version_number || 1) +
      ' &middot; ' + Number(doc.comment_count || 0) + ' comment' + (Number(doc.comment_count) === 1 ? '' : 's') + '</p>');
    p.push('</a>');
  }
  p.push('</div>');
  return res.send(views.layout({ title: 'Documents', user: req.user, active: 'documents', body: p.join('') }));
}));

router.get('/documents/:slug', wrap(async function (req, res, next) {
  const doc = await loadDocument(req.params.slug);
  if (!doc) return next();

  const requested = parseInt(req.query.v, 10);
  const version = await loadVersion(doc.id, isNaN(requested) ? null : requested);
  if (!version) return next();

  const currentResult = await db.query('SELECT version_number FROM document_versions WHERE document_id = $1 ORDER BY is_current DESC, version_number DESC LIMIT 1', [doc.id]);
  const currentNumber = currentResult.rows[0] ? currentResult.rows[0].version_number : version.version_number;
  const isCurrent = version.version_number === currentNumber;

  const rendered = views.renderMarkdown(version.body);
  const sections = rendered.sections.filter(function (s) { return s.level === 2; });
  const comments = await loadComments(doc.id);
  const live = comments.filter(function (c) { return !c.deleted_at; });

  const p = [];
  p.push('<div class="card">');
  if (doc.is_primary) p.push('<p style="margin:0 0 8px"><span class="pill on">Central proposal</span></p>');
  p.push('<h1>' + esc(doc.title) + '</h1>');
  if (doc.summary) p.push('<p class="muted">' + esc(doc.summary) + '</p>');
  p.push('<p class="small muted">Version ' + Number(version.version_number) +
    ' &middot; published ' + esc(views.formatDate(version.created_at)) +
    ' &middot; <a href="/documents/' + esc(doc.slug) + '/history">version history</a></p>');
  if (version.change_note) {
    p.push('<p class="small"><strong>Change note:</strong> ' + esc(version.change_note) + '</p>');
  }
  p.push('</div>');

  if (!isCurrent) {
    p.push('<div class="flash">You are reading version ' + Number(version.version_number) +
      '. The current version is ' + Number(currentNumber) +
      '. <a href="/documents/' + esc(doc.slug) + '">Read the current version</a>.</div>');
  }

  if (sections.length > 2) {
    p.push('<div class="card tight toc"><strong class="small">On this page</strong>');
    for (const s of sections) p.push('<a href="#' + esc(s.id) + '">' + esc(s.title) + '</a>');
    p.push('</div>');
  }

  p.push('<div class="card doc">' + rendered.html + '</div>');

  p.push('<div class="card" id="comments">');
  p.push('<h2 style="margin-top:0">Discussion (' + live.length + ')</h2>');
  p.push('<p class="small muted">You appear here as <strong>' + esc(aliasFor(doc.id, req.user.id)) +
    '</strong> on this document only. Your name and email are never shown, including to administrators.</p>');

  if (doc.comments_enabled && isCurrent) {
    p.push('<form method="post" action="/documents/' + esc(doc.slug) + '/comments" style="margin-bottom:26px">');
    p.push(views.csrfField(req.user.csrf));
    if (sections.length) {
      p.push('<label for="section">Which part does this concern?</label>');
      p.push('<select id="section" name="section"><option value="">General comment</option>');
      for (const s of sections) p.push('<option value="' + esc(s.title) + '">' + esc(s.title) + '</option>');
      p.push('</select>');
    }
    p.push('<label for="body">Your comment</label>');
    p.push('<textarea id="body" name="body" maxlength="' + routes.MAX_COMMENT + '" required placeholder="Say what you actually think. Nobody will know it was you."></textarea>');
    p.push('<button class="btn" type="submit" style="margin-top:12px">Post anonymously</button>');
    p.push('</form>');
  } else if (!doc.comments_enabled) {
    p.push('<p class="muted">Comments are closed on this document.</p>');
  } else {
    p.push('<p class="muted">Comments can only be added on the current version. ' +
      '<a href="/documents/' + esc(doc.slug) + '">Go to version ' + Number(currentNumber) + '</a>.</p>');
  }

  p.push(renderThread(comments, doc, req.user));
  p.push('</div>');

  return res.send(views.layout({
    title: doc.title,
    user: req.user,
    active: doc.is_primary ? 'proposal' : 'documents',
    body: p.join(''),
    notice: routes.NOTICES[req.query.notice]
  }));
}));

router.get('/documents/:slug/history', wrap(async function (req, res, next) {
  const doc = await loadDocument(req.params.slug);
  if (!doc) return next();
  const versions = await db.query(
    'SELECT v.*, u.full_name AS editor FROM document_versions v LEFT JOIN users u ON u.id = v.created_by ' +
    'WHERE v.document_id = $1 ORDER BY v.version_number DESC',
    [doc.id]
  );

  const p = [];
  p.push('<h1>Version history</h1>');
  p.push('<p class="muted">' + esc(doc.title) + '</p>');
  p.push('<div class="card"><table><tr><th>Version</th><th>Published</th><th>Change note</th><th></th></tr>');
  for (const v of versions.rows) {
    p.push('<tr><td>' + Number(v.version_number) + (v.is_current ? ' <span class="pill on">current</span>' : '') + '</td>');
    p.push('<td class="small">' + esc(views.formatDate(v.created_at)) + (v.editor ? '<br /><span class="muted">' + esc(v.editor) + '</span>' : '') + '</td>');
    p.push('<td class="small">' + esc(v.change_note || '') + '</td>');
    p.push('<td class="small"><a href="/documents/' + esc(doc.slug) + '?v=' + Number(v.version_number) + '">read</a>');
    if (v.version_number > 1) {
      p.push(' &middot; <a href="/documents/' + esc(doc.slug) + '/compare?a=' + Number(v.version_number - 1) + '&b=' + Number(v.version_number) + '">changes</a>');
    }
    p.push('</td></tr>');
  }
  p.push('</table></div>');
  p.push('<p><a href="/documents/' + esc(doc.slug) + '">Back to the document</a></p>');
  return res.send(views.layout({ title: 'History', user: req.user, active: 'documents', body: p.join('') }));
}));

router.get('/documents/:slug/compare', wrap(async function (req, res, next) {
  const doc = await loadDocument(req.params.slug);
  if (!doc) return next();
  const a = parseInt(req.query.a, 10);
  const b = parseInt(req.query.b, 10);
  if (isNaN(a) || isNaN(b)) return res.redirect('/documents/' + encodeURIComponent(doc.slug) + '/history');

  const left = await loadVersion(doc.id, a);
  const right = await loadVersion(doc.id, b);
  if (!left || !right) return res.redirect('/documents/' + encodeURIComponent(doc.slug) + '/history');

  const p = [];
  p.push('<h1>Changes from version ' + a + ' to version ' + b + '</h1>');
  p.push('<p class="muted">' + esc(doc.title) + '</p>');
  if (right.change_note) p.push('<div class="card tight"><strong class="small">Change note</strong><p style="margin:6px 0 0">' + esc(right.change_note) + '</p></div>');
  p.push('<div class="card">' + views.renderDiff(left.body, right.body) + '</div>');
  p.push('<p><a href="/documents/' + esc(doc.slug) + '/history">Back to version history</a></p>');
  return res.send(views.layout({ title: 'Compare', user: req.user, active: 'documents', body: p.join('') }));
}));

router.post('/documents/:slug/comments', wrap(async function (req, res, next) {
  const doc = await loadDocument(req.params.slug);
  if (!doc) return next();
  if (!doc.comments_enabled || doc.archived) return res.status(403).send('Comments are closed on this document.');

  const body = field(req.body, 'body').slice(0, routes.MAX_COMMENT);
  if (!body) return res.redirect('/documents/' + encodeURIComponent(doc.slug) + '#comments');

  const version = await loadVersion(doc.id, null);
  let parentId = parseInt(field(req.body, 'parent_id'), 10);
  if (isNaN(parentId)) parentId = null;
  if (parentId) {
    const parent = await db.query('SELECT id FROM comments WHERE id = $1 AND document_id = $2 AND parent_id IS NULL', [parentId, doc.id]);
    if (!parent.rowCount) parentId = null;
  }

  let section = field(req.body, 'section').slice(0, 120);
  if (parentId) section = '';

  await db.query(
    'INSERT INTO comments (document_id, version_id, author_id, parent_id, section, body) VALUES ($1,$2,$3,$4,$5,$6)',
    [doc.id, version ? version.id : null, req.user.id, parentId, section || null, body]
  );

  return res.redirect('/documents/' + encodeURIComponent(doc.slug) + '?notice=commented#comments');
}));

router.post('/comments/:id/withdraw', wrap(async function (req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.redirect('/documents');
  const result = await db.query(
    "UPDATE comments SET deleted_at = now(), deleted_by = $2, deleted_reason = 'withdrawn' " +
    'WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL RETURNING document_id',
    [id, req.user.id]
  );
  if (!result.rowCount) return res.redirect('/documents');
  const doc = await db.query('SELECT slug FROM documents WHERE id = $1', [result.rows[0].document_id]);
  const slug = doc.rows[0] ? doc.rows[0].slug : '';
  return res.redirect('/documents/' + encodeURIComponent(slug) + '?notice=withdrawn#comments');
}));

// ---------------------------------------------------------------- account

router.get('/account', wrap(async function (req, res) {
  const result = await db.query(
    'SELECT email, full_name, phone, city, region, country, player_status, affiliations, role, created_at, last_login_at, recovery_hashes ' +
    'FROM users WHERE id = $1',
    [req.user.id]
  );
  const me = result.rows[0];
  let remaining = 0;
  try { remaining = (JSON.parse(me.recovery_hashes || '[]') || []).length; } catch (err) { remaining = 0; }

  const sessions = await db.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [req.user.id]);
  const mine = await db.query('SELECT count(*)::int AS n FROM comments WHERE author_id = $1 AND deleted_at IS NULL', [req.user.id]);

  const p = [];
  p.push('<h1>Your account</h1>');
  p.push('<div class="card"><h2 style="margin-top:0">Membership record</h2><table>');
  p.push('<tr><th>Name</th><td>' + esc(me.full_name) + '</td></tr>');
  p.push('<tr><th>Email</th><td>' + esc(me.email) + '</td></tr>');
  if (me.phone) p.push('<tr><th>Phone</th><td>' + esc(me.phone) + '</td></tr>');
  p.push('<tr><th>Location</th><td>' + esc([me.city, me.region, me.country].filter(Boolean).join(', ') || 'Not given') + '</td></tr>');
  p.push('<tr><th>Status</th><td>' + esc(me.player_status || 'Not given') + '</td></tr>');
  if (me.affiliations) p.push('<tr><th>Affiliations</th><td>' + esc(me.affiliations) + '</td></tr>');
  p.push('<tr><th>Role</th><td>' + esc(me.role) + '</td></tr>');
  p.push('<tr><th>Joined</th><td>' + esc(views.formatDate(me.created_at)) + '</td></tr>');
  p.push('<tr><th>Last sign in</th><td>' + esc(views.formatDate(me.last_login_at) || 'This is your first session') + '</td></tr>');
  p.push('<tr><th>Live comments</th><td>' + Number(mine.rows[0].n) + ' (shown under a different pseudonym on each document)</td></tr>');
  p.push('</table><p class="small muted">To correct any of these details, ask an administrator.</p></div>');

  p.push('<div class="card"><h2 style="margin-top:0">Change your password</h2>');
  p.push('<form method="post" action="/account/password">');
  p.push(views.csrfField(req.user.csrf));
  p.push('<label for="current">Current password</label><input id="current" name="current" type="password" autocomplete="current-password" required />');
  p.push('<div class="row"><div><label for="next">New password (at least ' + routes.MIN_PASSWORD + ' characters)</label>');
  p.push('<input id="next" name="next" type="password" autocomplete="new-password" required /></div>');
  p.push('<div><label for="next2">Repeat new password</label><input id="next2" name="next2" type="password" autocomplete="new-password" required /></div></div>');
  p.push('<button class="btn" type="submit" style="margin-top:14px">Update password</button></form></div>');

  p.push('<div class="card"><h2 style="margin-top:0">Two-factor authentication</h2>');
  p.push('<p class="small muted">Authenticator enrolment is active. You have <strong>' + remaining +
    '</strong> unused recovery code' + (remaining === 1 ? '' : 's') + ', and ' + Number(sessions.rows[0].n) + ' active session' + (Number(sessions.rows[0].n) === 1 ? '' : 's') + '.</p>');
  p.push('<form method="post" action="/account/2fa/reset">');
  p.push(views.csrfField(req.user.csrf));
  p.push('<label for="pw2">Confirm your password to move to a new device</label>');
  p.push('<input id="pw2" name="password" type="password" autocomplete="current-password" required />');
  p.push('<button class="btn ghost" type="submit" style="margin-top:12px">Reset and set up again</button>');
  p.push('<p class="small muted" style="margin-top:10px">This signs out every device and issues new recovery codes.</p>');
  p.push('</form></div>');

  return res.send(views.layout({
    title: 'Account', user: req.user, active: 'account',
    body: p.join(''), notice: routes.NOTICES[req.query.notice], error: req.query.error === 'password' ? 'That password was not correct.' : null
  }));
}));

router.post('/account/password', wrap(async function (req, res) {
  const current = String((req.body && req.body.current) || '');
  const next = String((req.body && req.body.next) || '');
  const next2 = String((req.body && req.body.next2) || '');

  const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!result.rowCount || !security.verifyPassword(current, result.rows[0].password_hash)) {
    return res.redirect('/account?error=password');
  }
  if (next.length < routes.MIN_PASSWORD || next !== next2) {
    return res.redirect('/account?error=password');
  }

  await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, security.hashPassword(next)]);
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user.id, req.sessionId]);
  await auth.logAudit(req.user.id, 'member.password_changed', 'changed own password');
  return res.redirect('/account?notice=password');
}));

router.post('/account/2fa/reset', wrap(async function (req, res) {
  const password = String((req.body && req.body.password) || '');
  const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!result.rowCount || !security.verifyPassword(password, result.rows[0].password_hash)) {
    return res.redirect('/account?error=password');
  }
  await db.query('UPDATE users SET totp_enabled = false, totp_secret = NULL, recovery_hashes = NULL WHERE id = $1', [req.user.id]);
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user.id, req.sessionId]);
  await db.query("UPDATE sessions SET stage = 'awaiting_2fa' WHERE id = $1", [req.sessionId]);
  await auth.logAudit(req.user.id, 'member.2fa_reset', 'reset own two-factor enrolment');
  return res.redirect('/join/2fa');
}));

module.exports = router;
