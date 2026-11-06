# Release Notes — AnxOS Control Center v2.0 build 203

**Channel:** Private Alpha
**Status:** Release candidate — V2 foundation and browser management surface

Build 203 ships the V2-A Wave-1 close-out, the first V2-C and V2-D slices,
and the authenticated browser management surface. It rides on top of the
published Build 202 stable.

## Added

### V2-A close-out

- Shared instance identity model, authenticated agent enrollment handshake
  with nonce-protected start/complete/status paths, and fail-closed
  owner/admin/operator/viewer role enforcement.
- Durable per-instance job lifecycle: state machine, idempotency keys,
  cancellation, audit events, and restart re-observation. A keyed repeat
  returns the original job; destructive operations are never replayed.
- The agent spawn contract is now explicit: `ANXHUB_CONFIG_DIR` is the sole
  canonical identity source; legacy `%APPDATA%\AnxHub` bindings auto-migrate
  only during an explicit enrollment handshake.
- A Windows/Linux support matrix documents what is tested, partial, and
  absent per platform.

### V2-C container lifecycle

- Docker engine detection with per-prerequisite diagnostics (not installed,
  permission denied, daemon unreachable, socket access denied).
- Container create/start/stop/restart/delete/pull ride the durable V2-A job
  store — a client restart can no longer orphan an in-flight container
  operation. Destructive container operations refuse idempotency keys.
- A dedicated smoke pins the docker route manifest, capability report,
  prerequisite classification, and per-platform executable resolution.

### V2-D package metadata

- Marketplace templates carry opt-in version stamps, sha256 checksums,
  and provenance (source) fields. Invalid metadata fails closed
  with distinct codes; the shipped 33-template catalog is unaffected.

### V2-B app slice

- Instances carry managed/imported/external ownership. Silent ownership
  flips are refused; adoption is an explicit one-way transition that stamps
  `adoptedAt`.
- The instance detail panel surfaces ownership; imported and external
  services show an "Adopt service" action.
- The dashboard gains a widget row (servers, remote systems, node health,
  metrics freshness) with a staleness policy: when the underlying data is
  not current, tiles show "Checking…" instead of a fake zero.

### Browser management surface

- The agent serves a session-gated, read-only management page at
  `/api/v1/ui`. Sessions are short-lived (15 min), bounded (16 active),
  issued in exchange for the existing bearer credential or a one-time
  bootstrap code, and use HttpOnly + SameSite=Strict cookies scoped to the
  UI path.
- The session is a transport credential only: it never widens permissions.
  Docker, instances, jobs, and every other authenticated route still
  require the bearer token — verified live.
- Agent Control gains a "New Browser Code" action that mints a one-time
  bootstrap code (10-minute TTL, single use, bounded at 5 pending) for the
  browser paste-code form.
- Bootstrap and management pages carry a tightened Content-Security-Policy
  (`default-src 'none'`) and render via textContent only.

## Fixed

- Docker target ids are guarded against decoded path traversal
  (`%2F..%2F`-shaped requests return 404, never reach the engine).
- Degenerate docker job types (`docker.`, `docker.x`, extra segments) are
  rejected at the boundary instead of minting malformed job records.
- The docker capabilities report honestly labels its scope as
  "route-manifest" and points engine-state questions at `/docker/snapshot`.
- The stale jobs-route header comment no longer claims the routes are
  dormant; the exported destructive job set is pinned by a smoke.
- The superseded stats-401 report is marked as historical.

## QA

- `rc:validate` passed 193/193 suites on the release commit (Windows, Node 24).
- New smokes: ownership model, docker capabilities/route manifest, docker
  route IO with stubbed engine, docker hostile input, docker job lifecycle,
  UI session issue/validate/limit/bootstrap, agent enrollment, spawn
  contract, identity mint/resolution, authority permissions, job lifecycle,
  job reobservation, runtime reconciliation, remote identity rendering.
- The full browser-side loop (bootstrap form → code exchange → management
  page) was verified live in Edge against a running agent.
- The versioning smoke's RC-retry provenance scenario is advanced together
  with each build bump so release metadata checks track the current build.

## Security

- All session and bootstrap state is in-memory only: an agent restart
  invalidates every session and bootstrap code (fail-closed).
- The management page's CSP blocks all sources except self; scripts use
  textContent rendering with no innerHTML sinks.
- Bootstrap codes use an unambiguous charset (no 0/1/I/O), are consumed on
  first use, and are rate-limited per client address.
