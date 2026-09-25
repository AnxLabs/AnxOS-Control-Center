# Security Threat Model — AnxOS Control Center V2

**Scope:** the V2 campaign's actual trust model for the desktop Control Center, the
standalone/local Agent, remote nodes, the browser-facing Agent surface and
third-party catalog content.
**Status:** describes the code as it exists at this revision. Every claim below
carries the code path it came from. Claims that could not be verified by reading
code are marked **UNPROVEN** and are not softened.
**Authority:** where this document and `docs/v2/V2_CAMPAIGN_QUEUES.md` disagree,
the campaign record wins; the accepted gaps here are the campaign's own,
restated without weakening. Sections 6.1–6.4 restate
`docs/v2/V2_CAMPAIGN_QUEUES.md:37-40` and `:69`.

This is the V2-I deliverable "document threat model, security reporting and
operator hardening guidance" (`docs/MASTER_ROADMAP.md:288`). It is **not** a
penetration-test report and makes no claim of completeness against a motivated
attacker. The only adversarial evidence attached to this revision is the
campaign's own record: the Mimosa static scan at `3f7c16e` was **incomplete**
(`completeness: partial`, `runStatus: inconclusive`) and therefore carries **no
security claim** (`docs/v2/V2_CAMPAIGN_QUEUES.md:11-12`), while the complete
static-only scan of cycle 14 is `docs/v2/V2_CAMPAIGN_QUEUES.md:24`.

---

## 1. Assets

| Asset | Where it lives | Confidentiality requirement |
| --- | --- | --- |
| Local Owner credential (bcrypt hash) | `security.json` (`src/services/securityService.js:164-166`) | Never leaves the device; never logged |
| Persistent session token | `session.dat`, encrypted (`src/services/secureSessionStore.js:33-46`) | Device-bound; invalidated on password-hash change (`src/services/securityService.js:606`) |
| Agent shared token / node credentials | `agent.json`, `node-agent-credentials.json` (`src/services/nodeCredentialStore.js:3,23-25`) | Encrypted at rest; only a fingerprint is ever surfaced (`src/shared/agentTokenStore.js:28`) |
| Account (cloud) session and refresh token | `account.json` via the same encrypted store | Never returned to the renderer |
| Instance/world data and backups | Agent instance root and backup root | Integrity + availability; restore is the recovery path |
| Audit log | `config/audit.log` (`src/services/securityService.js:183-185,639-651`) | Append-only evidence; redacted on read |
| Third-party catalog content | Marketplace archives downloaded by the Agent | Untrusted input; must not become code execution |

---

## 2. Trust boundaries

### 2.1 Renderer ⟷ desktop main (Electron)

- The renderer is created with `contextIsolation: true`, `nodeIntegration: false`
  and `sandbox: true` (`main.js:604-606`; also `:681-683`, `:729-731`, `:831-834`).
  *(Re-anchored 2026-09-19: the previous citations were ~11 lines stale after the
  startup-path refactor. The claims were re-verified against the current source; only
  the line numbers had drifted.)*
- Window-open and navigation are denied, or handed to the external-URL handler:
  `main.js:622`, `:629`, `:945`, `:952`.
  **Precision correction:** this is a **protocol** allowlist (`http:`/`https:`/`mailto:`),
  **not** a host allowlist. When `allowedHosts` is absent — which it is at every call
  site above — any host is accepted and opened in the OS browser
  (`src/services/externalUrlService.js:1-18`). The previous wording ("the external-URL
  allowlist") read as host-restricted and overstated the control. `shell.openExternal`
  is denial-of-privilege by construction, so this is a wording defect rather than a
  vulnerability — but the wording was wrong.
- The renderer reaches privileged functionality only through the preload bridge;
  the exposed surface is pinned by `scripts/preload-exposure-contract-smoke.js`
  (registered as `preload-exposure-contract:smoke`).
- **Trust statement:** the renderer is treated as untrusted input, not as a
  security boundary. Renderer-side hiding is presentation only
  (`AGENTS.md` — "Treat renderer hiding as presentation only"). Every privileged
  action is re-authorized in the main process.

### 2.2 IPC handler ⟷ service layer (authorization)

- Every privileged IPC handler calls `requirePermission(...)` before doing work
  (e.g. `src/ipc/backupsIpc.js:20` and its `requirePermission` use; the gate
  itself is `src/services/securityService.js:1667-1703`).
- Role permissions are a fail-closed table: unknown roles resolve through
  `normalizeRole` to a canonical role or are rejected
  (`src/services/securityService.js:1294-1303`), and the `"*"` passthrough is
  exclusive to `Owner` (`src/services/securityService.js:1648-1665`).
- Owner-only operations additionally call `requireOwner`
  (`src/services/securityService.js:1705-1715`), which audits its refusal as
  `security.ownerWorkspace` / `denied`.
- **Authenticated vs authorized:** `getStatus()` is the authentication view
  (`src/services/securityService.js:1338-1383`); the permission check is the
  authorization view and is evaluated on every protected call, not cached from
  the UI. A refused call is audited (`security.permission` / `denied` at
  `src/services/securityService.js:1695-1699`).
- **Local mode is a deliberate reduction:** with no Owner configured, the device
  is `localMode` and `requirePermission` returns a synthetic `local-device`
  principal with `local:*` (`src/services/securityService.js:1679-1686`,
  `:1667-1680`). This is the supported single-device posture; it is not an
  authenticated multi-user posture.

### 2.3 Desktop ⟷ Agent (remote node)

- The Agent validates the request `Host` **before** authentication, session
  creation, enrollment handling or route dispatch
  (`agent/src/server.js:455` → `agent/src/services/hostTrustPolicy.js:319-349`).
- Failure is `HOST_NOT_ALLOWED` (HTTP 421) and the refused host is neither echoed
  nor logged (`agent/src/server.js:572-586`).
- Authenticated Agent routes additionally run the enrollment binding gate
  (`agent/src/server.js:561` → `agent/src/routes/enroll.js:72`); a drifted
  binding is `NODE_BINDING_MISMATCH`, a revoked enrollment is `REVOKED`
  (`agent/src/services/enrollmentService.js:516-571`).
- The pairing surface authorizes on an already-enrolled node: loopback origin or
  the existing credential, else `PAIRING_REQUIRES_EXISTING_CREDENTIAL` (403),
  evaluated before any mutation (`agent/src/routes/pairing.js:83-110`, called at
  `:239`).
- **Authenticated vs authorized on the Agent:** presenting a valid Agent token
  authenticates the caller; the enrollment binding and the per-token scope
  evaluation authorize the specific route
  (`agent/src/permissions.js:321` → `authorizeApiPermission`, invoked at
  `agent/src/server.js:528`). A scoped token that lacks a family is refused with
  `API_SCOPE_DENIED` (`agent/src/permissions.js:315-318`).

### 2.4 Browser surface

- The Agent serves its own browser UI. It emits **no**
  `Access-Control-Allow-Origin`, and a state-changing request or `OPTIONS`
  preflight whose `Origin` does not match the request's own host is refused with
  `CROSS_ORIGIN_DENIED` (403) (`agent/src/services/hostTrustPolicy.js:19-23,289-304,341-346`).
- The pairing payload's `agentUrl` is not built from the caller's `Host`; a Host
  is echoed only when the Agent legitimately answers for it
  (`agent/src/routes/pairing.js:123-139`,
  `agent/src/services/hostTrustPolicy.js:237-251`).
- The desktop AMP panel link accepts only `http:`/`https:` URLs with a hostname
  (`app.js:26900-26908`, applied at `:26932-26938`). The *host* is deliberately
  unrestricted (any legitimate panel host is allowed), and the campaign records
  that `scripts/amp-panel-url-gate-smoke.js` does not cover tab/newline-encoded
  schemes, protocol-relative `//host`, `https:`/`https:/` normalisation, control
  or unicode characters, or the two sibling `href` sinks
  (`docs/v2/V2_CAMPAIGN_QUEUES.md:14`). The gate survived probing; the coverage
  gap is a test gap, not a proven defect.

### 2.5 Third-party catalog content

- Marketplace/provider archives are downloaded by the Agent, written through a
  unique sibling temporary path and renamed only after a complete validated
  write (see "Desktop file edits…" in `docs/RECOVERY_MODEL.md:99-108`).
- Archive extraction rejects absolute/traversal paths, excessive entry counts or
  expanded sizes, and unsafe compression ratios before reading entry bodies
  (`docs/RECOVERY_MODEL.md:28-31`), enforced by
  the `marketplace:archive-safety:smoke` suite.
- Container/host-affecting work passes a deny-by-default policy gate:
  privileged mode, host path mounts, engine-socket mounts and host networking
  need an explicit per-flag grant (`src/shared/dockerPolicy.js:1-7,67,178`;
  covered by `docker:policy:smoke`).
- **Trust statement:** catalog content is untrusted input. Its provenance is
  **not** verified — there is no publisher-trust warning
  (`docs/MASTER_ROADMAP.md:286`), so a catalog entry is trusted to the same
  degree as the catalog itself.

---

## 3. What is authenticated vs what is authorized

| Surface | Authenticated by | Authorized by | Failure mode |
| --- | --- | --- | --- |
| Privileged IPC | Local Owner session or an account session (`getStatus`, `securityService.js:1338`) | `requirePermission` / `requireOwner` (`securityService.js:1667-1703,1705-1715`) | `LOGIN_REQUIRED`, `PERMISSION_DENIED`, `OWNER_REQUIRED` |
| Local single-device mode | nothing (by design) | synthetic `local-device` principal, `local:*` (`securityService.js:1679-1686`) | n/a |
| Agent non-pairing routes | Agent token (or loopback for the local UI session) | Host trust → enrollment binding → API scope (`server.js:455,561,528`) | `HOST_NOT_ALLOWED` 421, `CROSS_ORIGIN_DENIED` 403, `NODE_BINDING_MISMATCH` 453, `REVOKED` 410, `API_SCOPE_DENIED` |
| Agent pairing routes | loopback `remoteAddress`, or the existing credential | pairing authorization gate (`pairing.js:83`) | `PAIRING_REQUIRES_EXISTING_CREDENTIAL` 403 |
| Agent browser UI | Agent session cookie (`agent/src/routes/ui.js`) | same-origin `Origin` check (`hostTrustPolicy.js:340-346`) | `CROSS_ORIGIN_DENIED` 403 |
| Account (cloud) sign-in | Supabase-issued tokens | account session store | refresh failure degrades to signed-out |

Loopback is treated as a trusted origin in two places
(`pairing.js:33,86` and the Host allowlist in `hostTrustPolicy.js:43`). That is a
deliberate choice with a stated cost; see §6.3.

---

## 4. Threats considered

| # | Threat | Control | Evidence |
| --- | --- | --- | --- |
| T1 | Untrusted renderer content reaches privileged code | context isolation + sandbox + re-authorization in main | `main.js:614-618`; `permission-matrix:smoke`; `renderer-safety:smoke` |
| T2 | A lower-privileged role performs a destructive action through IPC or the API | fail-closed role table + per-call permission check | `securityService.js:1648-1665,1667-1703`; `authority:permissions:smoke`; `permission-matrix:smoke` |
| T3 | Unauthenticated caller drives the Agent pairing surface | enrollment binding + pairing credential gate | `pairing.js:83-110`; `agent:pairing-credential-gate:smoke` |
| T4 | Scoped Agent token exceeds its grants | scope family evaluation, `API_SCOPE_DENIED` | `permissions.js:309-318`; `agent-scope-enforcement:smoke` |
| T5 | DNS-rebinding page reaches the loopback Agent | Host allowlist + explicit cross-origin denial | `hostTrustPolicy.js:319-349`; `agent:host-trust:smoke` |
| T6 | Hostile host is reflected back into `agentUrl` | echoability test + trusted-authority fallback | `hostTrustPolicy.js:237-281`; `pairing.js:132-139` |
| T7 | Credentials leak through logs, diagnostics or audit reads | `redaction.js` applied to diagnostics, audit projections and exports | `src/shared/redaction.js:1-4,87-89`; `securityService.js:1178-1208`; `redaction:smoke`; `diagnostics:smoke` |
| T8 | A destructive marketplace/container action runs without an explicit grant or confirmation | deny-by-default docker policy + volume-removal confirmation | `dockerPolicy.js:1-7`; `docker:policy:smoke` |
| T9 | A hostile archive escapes the backup/instance root | path/ratio/size validation before extracting | `docs/RECOVERY_MODEL.md:28-31,59-69`; backup archive smokes |
| T10 | Audit evidence is destroyed by retention | retention prunes only the read-only `routine` allowlist; a cap that would need a protected record is refused | `src/shared/auditRetentionPolicy.js:45-55,87-130,191-271`; `scripts/audit-retention-smoke.js` |
| T11 | Privileged host effects beyond the managed scope | documented, not eliminated — see §7 | `dockerPolicy.js:2-7`; `docs/MASTER_ROADMAP.md:285` |

---

## 5. Audit retention, access review and export (V2-I)

- The audit store is append-only (`securityService.js:639-651`).
- Retention is a **decision model**, not an automatic deletion: no call in this
  build removes an audit record (`securityService.js:1178-1201` reports
  `enforced: false`). Deleting audit data remains a user-approval action
  (`AGENTS.md`, Approval Matrix).
- Prunable by age: only the read-only/informational allowlist (`.list`,
  `alerts.acknowledge`, `docker.preflight.container`, successful reason-free
  `security.login` / `security.logout` / `security.session.restore` /
  `account.login` / `account.logout` / `account.refresh`)
  (`src/shared/auditRetentionPolicy.js:45-55`).
- **Protected classes — never pruned by age, never pruned to satisfy a size cap:**
  `authentication-failure`, `permission-denial`, `revocation`, `destructive`,
  `migration-repair`, `credential-rotation`, `unknown`
  (`src/shared/auditRetentionPolicy.js:27-35`).
- **Fail closed:** a record whose class cannot be determined (missing or unmapped
  action, missing or unparseable timestamp, a routine-looking action that failed
  or carried a reason) is treated as protected. A line the store cannot parse is
  counted as protected with no raw content retained
  (`securityService.js:1155-1176`).
- **Refusal:** if the size cap cannot be satisfied without pruning a protected
  record, `applyRetention` returns `refused: true`,
  `refusalReason: "CAP_EXCEEDED_PROTECTED_ONLY"` and prunes nothing
  (`src/shared/auditRetentionPolicy.js:218-232`).
- Access review is a pure projection (actor, action, outcome, count, first/last
  seen) with every field passed through `sanitizeForDiagnostics`
  (`src/shared/auditRetentionPolicy.js:308-373`).
- Export is bounded, redacted and deterministic: records are ordered by
  timestamp then canonical key, and the document is serialized with sorted keys,
  so two exports of the same window are byte-identical and diffable
  (`src/shared/auditRetentionPolicy.js:273-281,375-432`). An oversized record
  count, an over-wide span or an inverted window is refused with a typed error
  rather than truncated (`:389-401,136-155`).
- Reachability: retention, review and export require `settings:write`
  (`securityService.js:1142-1217`); a Viewer role is refused with
  `PERMISSION_DENIED` and the refusal is itself audited — proven by
  `scripts/audit-retention-smoke.js`.
- **NOT WIRED:** no IPC channel or REST route exposes these three functions yet.
  The service is implemented and smoke-covered; the channel required is
  `security:audit:retention|access-review|export` under the existing
  `settings:write` permission. Until it is registered, the operator reaches
  them only through code/tests, so the roadmap bullet is **code-complete but
  not operator-reachable**.

---

## 6. Accepted gaps (campaign record, unchanged)

These are **accepted**, not mitigated. They are restated from
`docs/v2/V2_CAMPAIGN_QUEUES.md:37-40,69` and must not be softened by future
documentation.

### 6.1 A wildcard bind is not strict

`AGENT_HOST=0.0.0.0` or `::` causes any syntactically valid `Host` to be
accepted, because deciding whether an arbitrary name resolves to a local address
would need a DNS lookup on the request path, which the Agent deliberately does
not perform (`agent/src/services/hostTrustPolicy.js:28-34,219-223`). Under a
wildcard bind a rebinding page's `pairing/start` would still succeed; its
`agentUrl` no longer reflects the hostile host
(`agent/src/routes/pairing.js:132-139`), and the pairing credential gate still
applies to an enrolled node. The strict allowlist requires a concrete bind.
Both the standalone Agent and the Control Center's own local Agent now default
to `127.0.0.1` (`agent/src/config.js:15`,
`src/services/agentControlService.js:69`); a wildcard bind is an explicit
opt-in (`AGENT_HOST`, or `host` in the runtime config) that the Agent reports
with a loud startup diagnostic (`agent/src/config.js:129-165`). A remote node
therefore sets `AGENT_HOST` explicitly; a concrete interface address is
recommended because it also enforces the strict allowlist. Follow-up option
recorded and **not implemented**: an operator-configured allowed-host list; the
desktop already stores an unused `allowedOrigins` setting
(`src/services/agentControlService.js:69`).

### 6.2 A remote Agent reachable only by DNS name needs that name in `agentUrl`

If a remote Agent is reachable only through a DNS name, that name must appear in
its `agent.json` `agentUrl` or requests addressed to it are refused
(`agent/src/services/hostTrustPolicy.js:183-198,224`). A remote Agent reached by
IP needs no configuration, because an IP literal is always accepted
(`:237-251`). Documented for operators in `docs/OPERATOR_NOTES_V2.md` §13.

### 6.3 Loopback trust is absolute — an on-host reverse proxy defeats both gates

Loopback is trusted with no further check in the Host allowlist
(`agent/src/services/hostTrustPolicy.js:43`) and in the pairing gate
(`agent/src/routes/pairing.js:33,86`). An on-host reverse proxy in front of the
Agent port therefore makes remote callers arrive from loopback and satisfies
**both** gates. Same-origin comparison is host+port only, so a scheme mismatch
behind a TLS-terminating proxy is not detected; a mismatched-origin page still
cannot read responses or change state (`agent/src/services/hostTrustPolicy.js:289-304`).

### 6.4 DNS rebinding: precondition proven, browser step UNPROVEN

**PROVEN:** the Agent previously trusted the caller's `Host` header when building
its pairing `agentUrl` and sent no CORS headers
(`agent/src/services/hostTrustPolicy.js:1-9`). **UNPROVEN:** whether a real
browser can complete the DNS-rebinding read, and whether the request-layer change
defeats it *in-browser* rather than only at the socket. No browser was driven; a
browser-based probe would need a real Chrome and a rebinding harness
(`docs/v2/V2_CAMPAIGN_QUEUES.md:40`). This document does not claim the attack is
blocked in a browser.

### 6.5 The agent trusts a validated `Host` but performs no request-path DNS lookup

The Host check is pure string work — no DNS, no filesystem work
(`agent/src/services/hostTrustPolicy.js:13-17`). Its consequence is §6.1: a bind
that means "any address this machine has" cannot distinguish an operator's DNS
name from an attacker's.

### 6.6 UNPROVEN items carried forward

- Whether a real browser can complete the DNS-rebinding read (§6.4).
- The four offline dependency advisories: the scanner persisted counts but no
  identifiers, so nothing can be assessed (`docs/v2/V2_CAMPAIGN_QUEUES.md:24`).
- Exploitability of the AMP panel `href` sink for a malicious node
  (`docs/v2/V2_CAMPAIGN_QUEUES.md:25`).
- `app.js` assigns `href` from `instance.connectionHost`, which is length-capped
  but not scheme/host-validated (`http://` is pinned, so no script execution);
  routed to the renderer lane (`docs/v2/V2_CAMPAIGN_QUEUES.md:15`).
- Runtime rendering of the alert surface: no Electron launch has been performed
  (`docs/MASTER_ROADMAP.md:300`).
- The Mimosa scan at `3f7c16e` is incomplete evidence and attaches **no**
  security claim (`docs/v2/V2_CAMPAIGN_QUEUES.md:11-12`).
- **The Mimosa deep scan re-run at `ff9d10a` COMPLETED and is SEALED**
  (`sha256:2ff5119642b552cb6e714f84c0b0b9199447e28f5a16610c5b27390964c64a0b`,
  1012 findings, 255 packages scanned, dependency check completed) — **and it still
  attaches NO security claim.** Every finding is **unvalidated** (0 investigated), the
  result carries `verdictEffect: none`, and its evidence boundary is
  `static_only_no_runtime_execution`. A completed scan whose findings were never
  investigated is not a clean verdict, and it is not reported as one here.

---

### 6.7 The remote-administration policy is NOT wired — it protects nothing at runtime

`src/shared/remoteAdminPolicy.js` is built, exported, and covered by a passing smoke,
and its header reads like a live control ("strong authentication for remote
administration"). **It is not enforced anywhere in the request path.** It is required
only by its own smoke (`scripts/remote-admin-authorization-smoke.js:38`), which carries
`REMOTE_ADMIN_ENFORCEMENT_WIRED = false` (`:506`) and prints
`[skip] request-layer enforcement is not wired in this build (owner decision)` (`:511`).

The consequence, stated plainly: origin is consulted for authorization **nowhere** on
the Agent except the pairing gate, so a valid Agent token — or an unscoped enrolled
credential — can reach `owner` (enroll/revoke) and `agent:manage` (credential rotation)
from anywhere the Agent is reachable. This is the owner's standing permissive-by-origin
decision, recorded here so a reader cannot mistake the module for a control that is
protecting the system. Wiring it is an **owner decision**, not an engineering default:
the options are to keep permissive-by-origin, to require opt-in (`AGENT_REMOTE_ADMIN`
plus family scopes), or to narrow enforcement to the credential-operation routes only.

---

## 7. Residual host-privilege statement

The Control Center and its Agent run as the operator's own user on the host. They
are **not** a sandbox and do not claim to confine what an authenticated operator
can do to the machine.

- Container operations can request effects that are equivalent to host control.
  Those requests fail closed unless the caller carries an explicit per-flag grant
  (`src/shared/dockerPolicy.js:1-7,67,178`), and volume removal needs an explicit
  confirmation flag — but a grant, once given, is exactly as powerful as the flag
  says (privileged mode, host path mounts, engine-socket mounts, host
  networking).
- Instance, backup and file operations reach the filesystem as the Agent's user;
  the agent's allowed roots are configuration, not an OS-level confinement
  (`AGENT_FILE_ROOTS`, `AGENT_INSTANCE_ROOT`, `AGENT_BACKUP_ROOT` in
  `src/services/agentControlService.js:109`).
- Host-level feature work (Windows firewall rules, elevation, systemd units,
  scheduled tasks) performs real host changes through the operating system's own
  privilege mechanisms.
- Resource limits and restricted host mounts are enforced at the policy layer,
  but the roadmap records that the residual-privilege documentation was not
  independently verified (`docs/MASTER_ROADMAP.md:285`).
- **Statement:** an actor who is already an authenticated Owner, or who has code
  execution as the Agent's user, has effects limited by the operating system, not
  by this application. The application's controls raise the cost of reaching that
  position; they do not cap what it can then do.

---

## 8. Security reporting

- Report a suspected vulnerability with: the affected component, the exact
  request/action, the expected vs observed result, and the build/commit SHA.
- **Do not attach** credentials, API keys, Agent tokens, session cookies, private
  keys or an unredacted diagnostic bundle. Use the redacted diagnostic export
  (`src/services/diagnosticsService.js:90-98`, which passes the bundle through
  `sanitizeForDiagnostics`) and `docs/KNOWN_LIMITATIONS.md` before sharing logs.
- A finding is only recorded as **proven** when it has a reproduction; otherwise
  it belongs in the UNPROVEN list (§6.6) and must say so.
- Severity is decided by reachability, not by the shape of the bug: the campaign's
  own pairing finding was P2 on a default install (loopback bind, no inbound
  firewall rule) and P0 on a standalone wildcard-bound remote node
  (`docs/v2/V2_CAMPAIGN_QUEUES.md:70`).
- Fixed findings get a hermetic smoke with proven teeth — a mutation that breaks
  the fix must fail the smoke
  (`docs/v2/V2_CAMPAIGN_QUEUES.md:50,57`).

---

## 9. Operator hardening guidance

The operational hardening steps live with the surfaces they belong to; this
document does not duplicate them.

| Hardening | Where |
| --- | --- |
| Which Host names/origins the Agent answers for, and the wildcard-bind caveat | `docs/OPERATOR_NOTES_V2.md` §13 |
| Re-pairing an already-enrolled Agent (lost-credential case is on-host) | `docs/OPERATOR_NOTES_V2.md` §12 |
| Docker policy grants and volume removal confirmation | `docs/OPERATOR_NOTES_V2.md` §1–2 |
| Node groups, disconnect and revocation | `docs/OPERATOR_NOTES_V2.md` §3 |
| Backup consistency/retention/integrity | `docs/OPERATOR_NOTES_V2.md` §4 |
| Rendering/preload/Agent boundary detail | `docs/SECURITY_BOUNDARIES.md` |
| Known limitations and downgrade behaviour | `docs/KNOWN_LIMITATIONS.md`, `docs/OPERATOR_NOTES_V2.md` §14 |

Minimum posture for a remote node: **set `AGENT_HOST` explicitly on the Agent
machine and prefer a concrete address** (the Agent is loopback-only by default,
and a wildcard bind is neither required nor strict), keep the pairing credential,
do not place the Agent port behind an on-host reverse proxy, and add the node's
DNS name to its `agent_url`/`agentUrl` if it is reached by name.

---

## 10. Verification ledger

| Claim | Verified by |
| --- | --- |
| Renderer isolation flags | reading `main.js:614-618,691-695,740-743,842-846` |
| IPC authorization on every protected path | reading `securityService.js:1667-1715` and the IPC call sites |
| Fail-closed role table | reading `securityService.js:1294-1303,1648-1665` |
| Host trust + cross-origin denial | reading `hostTrustPolicy.js:319-349`; `agent:host-trust:smoke` |
| Pairing credential gate | reading `pairing.js:83-110`; `agent:pairing-credential-gate:smoke` |
| Enrollment binding | reading `enroll.js:72`, `enrollmentService.js:516-571` |
| Agent scope denial | reading `permissions.js:309-318`; `agent-scope-enforcement:smoke` |
| Secret redaction in audit projections/exports | reading `redaction.js:1-4,87-89`, `securityService.js:1178-1217`; new `scripts/audit-retention-smoke.js`; `redaction:smoke` |
| Retention protects the stated classes and refuses a protected-only cap | new `scripts/audit-retention-smoke.js` with three mutation proofs |
| Accepted gaps 6.1–6.5 | reading the cited code paths; the campaign record is the authority |

**Not verified here:** anything in §6.6; end-to-end browser behaviour; runtime
rendering; anything requiring a real second machine, a real browser, or a live
drill.