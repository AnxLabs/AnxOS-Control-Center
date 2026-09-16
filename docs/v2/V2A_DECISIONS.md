# V2-A Design Decisions

Recorded 2026-09-16. Owner-approved decisions that constrain the V2-A
implementation (Wave 1+). Companion to the Wave-0 design briefs in this
directory. These are authoritative unless a later owner decision revises them.

## Decision 1 — Agent identity source (standalone/headless)

**Approve:** Enforce the desktop-spawn contract.

- `ANXHUB_CONFIG_DIR` is the single canonical identity + config source. The
  desktop always spawns the agent with it.
- An agent that starts WITHOUT the spawn env must log a loud, actionable
  diagnostic and **must not** silently fall back to a stray instance root
  (`/srv/...` or `%LOCALAPPDATA%\anxos\...`).
- This closes the defect in `docs/v2/V2A_AGENT_ENROLLMENT.md` (legacy
  `%APPDATA%\AnxHub` fallback). The enrollment handshake binds identity +
  instance-root pin + protocol version + token fingerprint.

## Decision 2 — Credential scope

**Approve:** Defer scoped per-node/per-workload credentials to V2-I.

- V2-A keeps the single shared agent token + Owner wildcard.
- The identity/permission SCHEMA must be designed to allow per-node and
  per-workload grants later, but no migration or scoping implementation lands
  in this wave. V2-I ships the scoped credential + fail-closed grants.

## Decision 3 — Legacy User role mapping

**Approve:** Map legacy `User` → new `operator` role.

- Backwards compatible: an existing `User` keeps lifecycle capability
  (start/stop/config). `viewer` is a new read-only tier. Owner/Admin remain.

## Decision 4 — Agent default API permissions

**Approve:** Fail-closed for remote agents, Owner wildcard preserved locally.

- Remote agents default to no implicit `*` grants; grants are explicit per
  principal.
- The local single-node Owner keeps its existing wildcard so current installs
  are unaffected.
- The agent health `mode` must reflect the configured permissions truthfully
  (already implemented as computed `read-write`/`read-only`/`no-access`; the
  computed-mode change is HELD in stash (b201-hold) to be recommitted in a
  later build).

## Deferred / to resolve in Wave 1 design review

Not blocking the above; recommended defaults noted for Wave 1:

- **Job store location (V2-A_JOB_LIFECYCLE):** prefer per-node
  `jobs/<jobId>.json`; keep instance `config` untouched for V1→V2 back-compat.
- **No-orphan scope:** remote-agent jobs must survive client restart; local
  host detached-runtime re-adoption only if the gate requires it (recommend
  remote-only for V2-A, reassess at V2-G multi-node).
- **Enrollment challenge:** short-TTL single-use nonce for `/enroll/complete`
  (defer client-signed nonce / mTLS to a future hardening).
- **Revoke/rotate tiering:** owner-only for both; admin may rotate but not
  revoke; revoke carries an explicit confirmation.
- **Legacy binding migration:** auto-migrate existing `%APPDATA%\AnxHub`
  bindings into `enrolled` (do not force a fresh enrollment that breaks
  current sessions).
- **Idempotency scope:** curated set (create/start/stop/restart/install/
  update/backup/restore) with an explicit non-replay stance for destructive
  ops.