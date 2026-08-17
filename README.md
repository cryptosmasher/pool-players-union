# pool-players-union

Invite-only portal hosting the proposal to form a union of professional pool
players. It carries the draft charter and supporting papers, collects
pseudonymous member comments on them, keeps every revision of every document,
and gives administrators a console to run the membership.

Node + Express + PostgreSQL. No build step, no client-side framework, three
runtime dependencies.

## What it does

**Invitation-only access.** Nobody can create an account without a single-use
invitation code. Codes can be tied to a specific email address, given an expiry,
marked as administrator invitations, and revoked before use.

**Mandatory two-factor authentication.** Registration is not complete until the
member enrols an authenticator app (TOTP, 30 second period, SHA-1, 6 digits).
Eight one-time recovery codes are issued at enrolment and stored only as keyed
hashes. Members can move to a new device themselves; administrators can reset an
enrolment for someone who is locked out.

**Pseudonymous comments.** Every comment is displayed under a pseudonym such as
"Chalk Fox 9A21", derived from a keyed hash of the member id and the document id.
It is stable within a document so conversations can be followed, and different on
every document so remarks cannot be correlated across documents. No name, email
or handle is rendered next to a comment anywhere in the application, including in
the moderation console.

**Versioned documents.** The charter and every supporting paper are stored as an
ordered series of versions with change notes. Members can read any past version,
see a line-level diff between consecutive versions, and comments record the
version they were written against.

**Admin console.** Overview statistics, invitation issue and revocation, member
roster with role and suspension controls and 2FA reset, document creation and
version publishing, comment moderation, and an audit log.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| DATABASE_URL | yes | Postgres connection string. On Railway, reference the database service. |
| ANON_PEPPER | yes | Long random secret. Keys the comment pseudonyms and the recovery-code hashes. Changing it changes every pseudonym and invalidates every outstanding recovery code, so set it once, before members start using the site. |
| BOOTSTRAP_INVITE_CODE | no | Fixes the founding administrator invitation code. If unset, one is generated and printed to the deploy log the first time the app starts with no administrator. |
| BOOTSTRAP_ADMIN_EMAIL | no | Ties the founding invitation to a single email address. |
| SITE_NAME | no | Defaults to "Professional Pool Players Union". |
| SESSION_HOURS | no | Session lifetime in hours. Defaults to 12. |
| PUBLIC_URL | no | Used to build invitation links. Falls back to the request host. |
| PORT | no | Supplied by the platform. Defaults to 3000. |

## First run

1. Deploy with DATABASE_URL and ANON_PEPPER set.
2. The app creates its schema, seeds the six starter documents, and creates a
   founding administrator invitation.
3. Read the invitation code from the deploy log, or set BOOTSTRAP_INVITE_CODE
   yourself beforehand.
4. Open /join?code=THE-CODE, register, and complete the authenticator enrolment.
5. Everything after that is done from /admin.

The bootstrap invitation is only created while no active administrator exists, so
it stops being issued as soon as the first administrator has registered.

## Running locally

    npm install
    DATABASE_URL=postgres://localhost/ppu ANON_PEPPER=dev-only npm start

Then open http://localhost:3000.

## Files

| File | Purpose |
| --- | --- |
| server.js | Express app, security headers, error handling, startup |
| db.js | Connection pool, schema migration, seeding, bootstrap invitation |
| security.js | scrypt password hashing, TOTP, invitation and recovery codes, pseudonyms |
| auth.js | Sessions, CSRF and origin checks, rate limiting, audit log helper |
| routes.js | Landing page, sign in, two-factor verification, registration, enrolment |
| documents.js | Document reading, version history, diffs, comments, member account |
| admin.js | Admin overview, invitations, members, audit log |
| admin-docs.js | Document management, version publishing, comment moderation |
| views.js | Layout, styles, Markdown renderer, diff renderer |
| content.js | The seed text of the charter and the supporting papers |

## Security notes

- Passwords are stored as salted scrypt hashes, never in plain text.
- Sessions live in a server-side table, are marked HttpOnly, SameSite=Lax and
  Secure behind TLS, and can be revoked by suspending the member.
- A session is only promoted from "awaiting two-factor" to "authenticated" after
  a valid TOTP or recovery code.
- Every state-changing form carries a per-session CSRF token and the origin of
  the request is checked.
- Sign-in and two-factor attempts are rate limited per address and account.
- A strict Content-Security-Policy is sent, and the site asks not to be indexed.
- Comments and members are never hard-deleted, only hidden or suspended, so that
  moderation decisions can be reviewed.

## The honest limitation on anonymity

The comment row stores the author id, because without it a member could not
withdraw their own comment and abuse could not be limited. The application never
exposes it, but anyone with direct database access could link a comment to an
account. If the membership would rather store only the derived pseudonym and drop
the author reference, that is a small change and is worth deciding early.
