'use strict';

const express = require('express');
const db = require('./db');
const auth = require('./auth');
const views = require('./views');
const routes = require('./routes');
const admin = require('./admin');

const router = express.Router();
const esc = views.esc;
const wrap = auth.wrap;
const field = routes.field;

router.use(auth.requireAdmin);

async function loadDocument(slug) {
  const result = await db.query('SELECT * FROM documents WHERE slug = $1', [slug]);
  return result.rows[0] || null;
}

async function currentVersion(documentId) {
  const result = await db.query(
    'SELECT * FROM document_versions WHERE document_id = $1 ORDER BY is_current DESC, version_number DESC LIMIT 1',
    [documentId]
  );
  return result.rows[0] || null;
}

async function uniqueSlug(title) {
  const base = views.slugify(title);
  let candidate = base;
  let n = 1;
  while (true) {
    const taken = await db.query('SELECT 1 FROM documents WHERE slug = $1', [candidate]);
    if (!taken.rowCount) return candidate;
    n += 1;
    candidate = base + '-' + n;
  }
}

// -------------------------------------------------------------- documents

router.get('/documents', wrap(async function (req, res) {
  const result = await db.query(
    'SELECT d.*, v.version_number, v.created_at AS revised_at, ' +
    '(SELECT count(*)::int FROM document_versions x WHERE x.document_id = d.id) AS version_count, ' +
    '(SELECT count(*)::int FROM comments c WHERE c.document_id = d.id AND c.deleted_at IS NULL) AS comment_count ' +
    'FROM documents d LEFT JOIN document_versions v ON v.document_id = d.id AND v.is_current = true ' +
    'ORDER BY d.sort_order ASC, d.title ASC'
  );

  const p = [];
  p.push('<h1>Documents</h1>');
  p.push('<div class="card"><table>');
  p.push('<tr><th>Document</th><th>Current</th><th>Comments</th><th>Settings</th><th></th></tr>');
  for (const d of result.rows) {
    p.push('<tr>');
    p.push('<td class="small"><strong>' + esc(d.title) + '</strong>' +
      (d.is_primary ? ' <span class="pill on">central</span>' : '') +
      (d.archived ? ' <span class="pill bad">archived</span>' : '') +
      '<br /><span class="muted">/documents/' + esc(d.slug) + '</span></td>');
    p.push('<td class="small">v' + Number(d.version_number || 1) + ' of ' + Number(d.version_count) +
      '<br /><span class="muted">' + esc(views.formatDate(d.revised_at)) + '</span></td>');
    p.push('<td class="small">' + Number(d.comment_count) +
      '<br /><span class="muted">' + (d.comments_enabled ? 'open' : 'closed') + '</span></td>');

    p.push('<td class="small"><form method="post" action="/admin/documents/' + esc(d.slug) + '/settings" ' +
      'style="display:flex;flex-direction:column;gap:6px">' + views.csrfField(req.user.csrf));
    p.push('<label style="margin:0"><input type="checkbox" name="comments_enabled" value="1"' + (d.comments_enabled ? ' checked' : '') + ' style="width:auto"> comments open</label>');
    p.push('<label style="margin:0"><input type="checkbox" name="is_primary" value="1"' + (d.is_primary ? ' checked' : '') + ' style="width:auto"> central proposal</label>');
    p.push('<label style="margin:0"><input type="checkbox" name="archived" value="1"' + (d.archived ? ' checked' : '') + ' style="width:auto"> archived</label>');
    p.push('<button class="btn ghost tiny" type="submit">Save</button></form></td>');

    p.push('<td class="small"><a class="btn tiny" href="/admin/documents/' + esc(d.slug) + '/edit">New version</a>' +
      '<br /><br /><a href="/documents/' + esc(d.slug) + '/history">history</a></td>');
    p.push('</tr>');
  }
  p.push('</table></div>');

  p.push('<div class="card"><h2 style="margin-top:0">Add a document</h2>');
  p.push('<form method="post" action="/admin/documents">' + views.csrfField(req.user.csrf));
  p.push('<label for="title">Title</label><input id="title" name="title" type="text" required />');
  p.push('<label for="summary">One line summary</label><input id="summary" name="summary" type="text" />');
  p.push('<label for="body">Text (Markdown: use ## for section headings, - for bullets)</label>');
  p.push('<textarea id="body" name="body" required style="min-height:220px"></textarea>');
  p.push('<button class="btn" type="submit" style="margin-top:14px">Publish document</button></form></div>');

  return res.send(admin.adminPage(req, 'documents', 'Documents', p.join('')));
}));

router.post('/documents', wrap(async function (req, res) {
  const title = field(req.body, 'title').slice(0, 200);
  const summary = field(req.body, 'summary').slice(0, 400);
  const body = String((req.body && req.body.body) || '');
  if (!title) return res.redirect('/admin/documents?problem=title');
  if (!body.trim()) return res.redirect('/admin/documents?problem=body');

  const slug = await uniqueSlug(title);
  const inserted = await db.query(
    'INSERT INTO documents (slug, title, summary, kind, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [slug, title, summary || null, 'document', 100]
  );
  await db.query(
    'INSERT INTO document_versions (document_id, version_number, body, change_note, created_by, is_current) ' +
    'VALUES ($1,1,$2,$3,$4,true)',
    [inserted.rows[0].id, body, 'First published version.', req.user.id]
  );
  await auth.logAudit(req.user.id, 'document.created', 'created ' + slug);
  return res.redirect('/admin/documents?done=doc');
}));

router.get('/documents/:slug/edit', wrap(async function (req, res, next) {
  const doc = await loadDocument(req.params.slug);
  if (!doc) return next();
  const version = await currentVersion(doc.id);

  const p = [];
  p.push('<h1>Publish a new version</h1>');
  p.push('<p class="muted">' + esc(doc.title) + ' - currently version ' + Number(version ? version.version_number : 1) + '</p>');
  p.push('<div class="flash">Editing here never overwrites the old text. The previous version stays ' +
    'readable to members, and existing comments keep the version number they were written against.</div>');
  p.push('<div class="card"><form method="post" action="/admin/documents/' + esc(doc.slug) + '/versions">');
  p.push(views.csrfField(req.user.csrf));
  p.push('<label for="title">Title</label><input id="title" name="title" type="text" value="' + esc(doc.title) + '" required />');
  p.push('<label for="summary">One line summary</label><input id="summary" name="summary" type="text" value="' + esc(doc.summary || '') + '" />');
  p.push('<label for="change_note">Change note (what moved, and why)</label>');
  p.push('<input id="change_note" name="change_note" type="text" required />');
  p.push('<label for="body">Full text of the new version</label>');
  p.push('<textarea id="body" name="body" required style="min-height:520px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px">' +
    esc(version ? version.body : '') + '</textarea>');
  p.push('<button class="btn" type="submit" style="margin-top:14px">Publish version ' +
    Number((version ? version.version_number : 0) + 1) + '</button>');
  p.push(' <a class="btn ghost" href="/admin/documents">Cancel</a>');
  p.push('</form></div>');
  return res.send(admin.adminPage(req, 'documents', 'New version', p.join('')));
}));

router.post('/documents/:slug/versions', wrap(async function (req, res, next) {
  const doc = await loadDocument(req.params.slug);
  if (!doc) return next();

  const body = String((req.body && req.body.body) || '');
  const note = field(req.body, 'change_note').slice(0, 500);
  const title = field(req.body, 'title').slice(0, 200) || doc.title;
  const summary = field(req.body, 'summary').slice(0, 400);
  if (!body.trim()) return res.redirect('/admin/documents/' + encodeURIComponent(doc.slug) + '/edit?problem=body');

  const max = await db.query('SELECT coalesce(max(version_number),0)::int AS n FROM document_versions WHERE document_id = $1', [doc.id]);
  const nextNumber = max.rows[0].n + 1;

  await db.query('UPDATE document_versions SET is_current = false WHERE document_id = $1', [doc.id]);
  await db.query(
    'INSERT INTO document_versions (document_id, version_number, body, change_note, created_by, is_current) ' +
    'VALUES ($1,$2,$3,$4,$5,true)',
    [doc.id, nextNumber, body, note || null, req.user.id]
  );
  await db.query('UPDATE documents SET title = $2, summary = $3 WHERE id = $1', [doc.id, title, summary || null]);
  await auth.logAudit(req.user.id, 'document.version_published', 'published ' + doc.slug + ' version ' + nextNumber);
  return res.redirect('/admin/documents?done=version');
}));

router.post('/documents/:slug/settings', wrap(async function (req, res, next) {
  const doc = await loadDocument(req.params.slug);
  if (!doc) return next();

  const commentsEnabled = !!(req.body && req.body.comments_enabled);
  const isPrimary = !!(req.body && req.body.is_primary);
  const archived = !!(req.body && req.body.archived);

  if (isPrimary) await db.query('UPDATE documents SET is_primary = false WHERE id <> $1', [doc.id]);
  await db.query(
    'UPDATE documents SET comments_enabled = $2, is_primary = $3, archived = $4 WHERE id = $1',
    [doc.id, commentsEnabled, isPrimary, archived]
  );
  await auth.logAudit(req.user.id, 'document.settings_changed', 'updated settings for ' + doc.slug);
  return res.redirect('/admin/documents?done=settings');
}));

// -------------------------------------------------------------- moderation

router.get('/comments', wrap(async function (req, res) {
  const showRemoved = req.query.show === 'removed';
  const result = await db.query(
    'SELECT c.id, c.body, c.section, c.created_at, c.parent_id, c.author_id, c.deleted_at, c.deleted_reason, ' +
    'v.version_number, d.title AS doc_title, d.slug AS doc_slug, d.id AS doc_id ' +
    'FROM comments c JOIN documents d ON d.id = c.document_id ' +
    'LEFT JOIN document_versions v ON v.id = c.version_id ' +
    'WHERE c.deleted_at IS ' + (showRemoved ? 'NOT NULL' : 'NULL') + ' ' +
    'ORDER BY c.created_at DESC LIMIT 200'
  );

  const p = [];
  p.push('<h1>Comment moderation</h1>');
  p.push('<p class="muted small">Comments are shown under the same pseudonym that members see. ' +
    'This console does not reveal, and cannot reveal, who wrote a comment. Removing a comment hides ' +
    'it from the discussion; it is never erased, so moderation can be reviewed.</p>');
  p.push('<p><a class="btn ' + (showRemoved ? 'ghost' : '') + ' tiny" href="/admin/comments">Live comments</a> ' +
    '<a class="btn ' + (showRemoved ? '' : 'ghost') + ' tiny" href="/admin/comments?show=removed">Removed comments</a></p>');

  if (!result.rowCount) {
    p.push('<div class="card"><p class="muted">Nothing to show here.</p></div>');
  }

  for (const c of result.rows) {
    p.push('<div class="comment">');
    p.push('<div class="meta">');
    p.push('<span class="alias">' + esc(routes.aliasFor(c.doc_id, c.author_id)) + '</span>');
    p.push('<span>' + esc(views.formatDate(c.created_at)) + '</span>');
    p.push('<span class="pill"><a href="/documents/' + esc(c.doc_slug) + '#c' + c.id + '">' + esc(c.doc_title) + '</a></span>');
    if (c.version_number) p.push('<span class="pill">version ' + Number(c.version_number) + '</span>');
    if (c.section) p.push('<span class="pill">' + esc(c.section) + '</span>');
    if (c.parent_id) p.push('<span class="pill">reply</span>');
    p.push('</div>');
    p.push('<div class="body">' + esc(c.body) + '</div>');

    if (c.deleted_at) {
      p.push('<p class="small muted" style="margin:8px 0 0">Removed ' + esc(views.formatDate(c.deleted_at)) +
        (c.deleted_reason ? ' - ' + esc(c.deleted_reason) : '') + '</p>');
      if (c.deleted_reason !== 'withdrawn') {
        p.push('<form method="post" action="/admin/comments/' + c.id + '/restore" style="margin-top:8px">' +
          views.csrfField(req.user.csrf) + '<button class="btn ghost tiny" type="submit">Restore</button></form>');
      } else {
        p.push('<p class="small muted">Withdrawn by its author, so it is not for a moderator to restore.</p>');
      }
    } else {
      p.push('<form method="post" action="/admin/comments/' + c.id + '/remove" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
        views.csrfField(req.user.csrf) +
        '<input name="reason" type="text" placeholder="Reason (recorded in the audit log)" style="flex:1 1 260px" />' +
        '<button class="btn danger tiny" type="submit">Remove</button></form>');
    }
    p.push('</div>');
  }

  return res.send(admin.adminPage(req, 'comments', 'Moderation', p.join('')));
}));

router.post('/comments/:id/remove', wrap(async function (req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.redirect('/admin/comments');
  const reason = field(req.body, 'reason').slice(0, 200) || 'removed by a moderator';
  const result = await db.query(
    'UPDATE comments SET deleted_at = now(), deleted_by = $2, deleted_reason = $3 WHERE id = $1 AND deleted_at IS NULL RETURNING id',
    [id, req.user.id, reason]
  );
  if (result.rowCount) await auth.logAudit(req.user.id, 'comment.removed', 'removed comment ' + id + ': ' + reason);
  return res.redirect('/admin/comments?done=removed');
}));

router.post('/comments/:id/restore', wrap(async function (req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.redirect('/admin/comments');
  const result = await db.query(
    "UPDATE comments SET deleted_at = NULL, deleted_by = NULL, deleted_reason = NULL " +
    "WHERE id = $1 AND deleted_at IS NOT NULL AND coalesce(deleted_reason,'') <> 'withdrawn' RETURNING id",
    [id]
  );
  if (result.rowCount) await auth.logAudit(req.user.id, 'comment.restored', 'restored comment ' + id);
  return res.redirect('/admin/comments?show=removed&done=restored');
}));

module.exports = router;
