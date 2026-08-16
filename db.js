'use strict';

const { Pool } = require('pg');
const content = require('./content');
const security = require('./security');

const connectionString = process.env.DATABASE_URL || '';
const needsSsl = /sslmode=require/.test(connectionString) ||
  /rlwy\.net/.test(connectionString) ||
  process.env.PGSSL === 'true';

const pool = new Pool({
  connectionString: connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 8,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

pool.on('error', function (err) {
  console.error('[db] idle client error:', err.message);
});

function query(text, params) {
  return pool.query(text, params);
}

const STATEMENTS = [
  'CREATE TABLE IF NOT EXISTS users (' +
    ' id serial PRIMARY KEY,' +
    ' email text UNIQUE NOT NULL,' +
    ' password_hash text NOT NULL,' +
    ' full_name text NOT NULL,' +
    ' phone text,' +
    ' city text,' +
    ' region text,' +
    ' country text,' +
    ' player_status text,' +
    ' affiliations text,' +
    ' role text NOT NULL DEFAULT ' + "'member'" + ',' +
    ' status text NOT NULL DEFAULT ' + "'active'" + ',' +
    ' totp_secret text,' +
    ' totp_enabled boolean NOT NULL DEFAULT false,' +
    ' recovery_hashes text,' +
    ' created_at timestamptz NOT NULL DEFAULT now(),' +
    ' last_login_at timestamptz' +
    ')',

  'CREATE TABLE IF NOT EXISTS invites (' +
    ' id serial PRIMARY KEY,' +
    ' code text UNIQUE NOT NULL,' +
    ' email text,' +
    ' role text NOT NULL DEFAULT ' + "'member'" + ',' +
    ' note text,' +
    ' created_by integer REFERENCES users(id) ON DELETE SET NULL,' +
    ' created_at timestamptz NOT NULL DEFAULT now(),' +
    ' expires_at timestamptz,' +
    ' revoked_at timestamptz,' +
    ' used_at timestamptz,' +
    ' used_by integer REFERENCES users(id) ON DELETE SET NULL' +
    ')',

  'CREATE TABLE IF NOT EXISTS sessions (' +
    ' id text PRIMARY KEY,' +
    ' user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
    ' stage text NOT NULL DEFAULT ' + "'authenticated'" + ',' +
    ' csrf text NOT NULL,' +
    ' created_at timestamptz NOT NULL DEFAULT now(),' +
    ' expires_at timestamptz NOT NULL' +
    ')',

  'CREATE TABLE IF NOT EXISTS documents (' +
    ' id serial PRIMARY KEY,' +
    ' slug text UNIQUE NOT NULL,' +
    ' title text NOT NULL,' +
    ' summary text,' +
    ' kind text NOT NULL DEFAULT ' + "'document'" + ',' +
    ' is_primary boolean NOT NULL DEFAULT false,' +
    ' comments_enabled boolean NOT NULL DEFAULT true,' +
    ' archived boolean NOT NULL DEFAULT false,' +
    ' sort_order integer NOT NULL DEFAULT 100,' +
    ' created_at timestamptz NOT NULL DEFAULT now()' +
    ')',

  'CREATE TABLE IF NOT EXISTS document_versions (' +
    ' id serial PRIMARY KEY,' +
    ' document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,' +
    ' version_number integer NOT NULL,' +
    ' body text NOT NULL,' +
    ' change_note text,' +
    ' created_by integer REFERENCES users(id) ON DELETE SET NULL,' +
    ' created_at timestamptz NOT NULL DEFAULT now(),' +
    ' is_current boolean NOT NULL DEFAULT false,' +
    ' UNIQUE (document_id, version_number)' +
    ')',

  'CREATE TABLE IF NOT EXISTS comments (' +
    ' id serial PRIMARY KEY,' +
    ' document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,' +
    ' version_id integer REFERENCES document_versions(id) ON DELETE SET NULL,' +
    ' author_id integer REFERENCES users(id) ON DELETE SET NULL,' +
    ' parent_id integer REFERENCES comments(id) ON DELETE CASCADE,' +
    ' section text,' +
    ' body text NOT NULL,' +
    ' created_at timestamptz NOT NULL DEFAULT now(),' +
    ' deleted_at timestamptz,' +
    ' deleted_by integer REFERENCES users(id) ON DELETE SET NULL,' +
    ' deleted_reason text' +
    ')',

  'CREATE TABLE IF NOT EXISTS audit_log (' +
    ' id serial PRIMARY KEY,' +
    ' actor_id integer REFERENCES users(id) ON DELETE SET NULL,' +
    ' action text NOT NULL,' +
    ' detail text,' +
    ' created_at timestamptz NOT NULL DEFAULT now()' +
    ')',

  'CREATE INDEX IF NOT EXISTS idx_comments_document ON comments (document_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_versions_document ON document_versions (document_id, version_number DESC)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC)'
];

async function migrate() {
  for (const sql of STATEMENTS) {
    await query(sql);
  }
}

async function seed() {
  const existing = await query('SELECT count(*)::int AS n FROM documents');
  if (existing.rows[0].n > 0) return;
  for (const doc of content.documents) {
    const inserted = await query(
      'INSERT INTO documents (slug, title, summary, kind, is_primary, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [doc.slug, doc.title, doc.summary, doc.kind, !!doc.isPrimary, doc.sortOrder || 100]
    );
    await query(
      'INSERT INTO document_versions (document_id, version_number, body, change_note, is_current) VALUES ($1,1,$2,$3,true)',
      [inserted.rows[0].id, doc.body, 'Initial draft published with the portal.']
    );
  }
  console.log('[db] seeded ' + content.documents.length + ' documents');
}

async function ensureBootstrapInvite() {
  const admins = await query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'");
  if (admins.rows[0].n > 0) return null;

  const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase() || null;
  let code = String(process.env.BOOTSTRAP_INVITE_CODE || '').trim().toUpperCase();
  if (!code) code = security.inviteCode();

  const existing = await query('SELECT id FROM invites WHERE code = $1', [code]);
  if (existing.rowCount === 0) {
    await query(
      "INSERT INTO invites (code, email, role, note, expires_at) VALUES ($1,$2,'admin',$3, now() + interval '30 days')",
      [code, email, 'Founding administrator bootstrap invite']
    );
  } else {
    await query("UPDATE invites SET revoked_at = NULL, expires_at = now() + interval '30 days' WHERE code = $1 AND used_at IS NULL", [code]);
  }

  console.log('==========================================================');
  console.log('[bootstrap] No administrator exists yet.');
  console.log('[bootstrap] Founding admin invite code: ' + code);
  console.log('[bootstrap] Redeem at: /join?code=' + encodeURIComponent(code));
  console.log('==========================================================');
  return code;
}

async function purgeExpiredSessions() {
  try {
    await query('DELETE FROM sessions WHERE expires_at < now()');
  } catch (err) {
    console.error('[db] session purge failed:', err.message);
  }
}

async function init() {
  await migrate();
  await seed();
  await purgeExpiredSessions();
  return ensureBootstrapInvite();
}

module.exports = {
  pool,
  query,
  init,
  purgeExpiredSessions
};
