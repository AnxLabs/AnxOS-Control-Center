> **SUPERSEDED (2026-09-16).** The defect this report documents was fixed and
> shipped: agent `/api/v1/stats` 401s are now surfaced as an actionable error
> (commit `1bed0b7`, build 201, carried into build 202). This report is
> retained for historical record only; it does not describe current behavior.

# BUILD201 — `/api/v1/stats` returns UNAUTHORIZED from the desktop → Agent

**Investigated by:** Read-only diagnostic subagent
**Date:** 2026-09-16
**Status:** Root cause identified (code-verified); live-repro steps pending confirmation

---

## 1. Symptom

The AnxOS desktop app calls the local/remote Agent (port `47131`) and receives `401 UNAUTHORIZED`
for `/api/v1/stats` (and every other authenticated route), while `/api/v1/health` always succeeds.

Observed evidence in `.dev-logs/auth.log` (Agent side, operation `authentication`,
`errorCode: UNAUTHORIZED`), e.g.:

```
context: {"method":"GET","pathname":"/api/v1/stats","code":"UNAUTHORIZED"}
```

This matches the report "agent log UNAUTHORIZED 04:52:39".

`/api/v1/stats` is **not** a public route — it *requires* a valid Agent token + the
`system:read` API permission (`agent/src/server.js:168`). `/api/v1/health` is the **only**
public route (`agent/src/auth.js:24`). The symptom is therefore expected behavior of the
Agent's auth guard when the desktop sends a missing/mismatched token; the "mystery" is only
*which* token the desktop is (not) sending, and why it diverges from the token the Agent holds.

---

## 2. Root cause (verified)

**The desktop and the Agent resolve the shared Agent token from two different
`agent.json` locations, so each side holds a different value. The desktop then sends (or
omits) a Bearer token that does not match the token the Agent configured, and the Agent
correctly rejects every authenticated route with `401 UNAUTHORIZED`. `/api/v1/health` passes
only because it is exempted from auth.**

More precisely, the token mismatch is a **credential-routing gap** across two code paths:

### 2a. Agent side (what it expects)

- `agent/src/config.js:121` resolves the server token:
  `resolveSharedAgentToken({ cwd: process.cwd(), environmentToken: process.env.AGENT_TOKEN })`.
- `src/shared/agentTokenStore.js:56-68` candidate config paths (in order):
  `options.configPath` → `ANXHUB_AGENT_CONFIG_PATH` → `ANXHUB_CONFIG_DIR/agent.json` →
  `cwd/config/agent.json` → `cwd/../config/agent.json` → `cwd/agent.json`.
  When the agent is started by helper scripts (`AnxAgent.sh:20`, `start-agent-mode.ps1:10,228-229`)
  `ANXHUB_CONFIG_DIR` points at the **repo `config/`** (e.g. `…/AnxOS-Control-Center/config`),
  so the agent read;   
  when started by `agentControlService`, `ANXHUB_CONFIG_DIR` is the **app userData** config dir.
- `agent/src/auth.js:44` reads the incoming token from `x-agent-token` OR `Authorization: Bearer …`,
  then `agent/src/auth.js:47` compares with an **execution-time snapshot** of `config.token`
  (taken once at agent startup). Mismatch/absent → `401 UNAUTHORIZED` (`auth.js:49`).
  A token that is entirely unset would instead yield `503 AGENT_TOKEN_MISSING` (`auth.js:39`) —
  the fact the logs show **`401 UNAUTHORIZED`** proves the Agent *does* have a token configured,
  and the incoming one is *different/absent*.

### 2b. Desktop side (what it sends)

All desktop→Agent HTTP is funneled through `src/services/agentClient.js`. Headers are built in
`requestJson` (`agentClient.js:700`), `requestBuffer` (`:1423`), `requestStream` (`:1527`), and the
token is attached **only if `config.token` is truthy**. A falsey `config.token` ⇒ no header ⇒ 401.

The token itself is chosen by `getAgentConfig()`:

- Global/local call (e.g. `systemService.getSystemStats()`, `agentClient.js:1065`): resolves via
  `getEffectiveAgentSettings()` → `agentClient.js:240` `agentToken: tokenStatus.token || stored.agentToken`.
  `getSharedAgentTokenStatus()` (`:128`) calls
  `resolveSharedAgentToken({ configPath: getAgentConfigPath(), … })`, where
  `getAgentConfigPath()` (`:124`) = `ANXHUB_CONFIG_DIR` **else** `app.getPath("userData")/config/agent.json`.
- Node-scoped call (e.g. `systemService.getAgentSystemSnapshot` → `forNode(nodeId)` →
  `NodeAgentClient.get("/stats")`, `agentClient.js:1403`, `:1130`):
  token comes from `getNodeAgentConfigFromNode(node)` (`src/services/nodeService.js:1412`) →
  `nodeCredentialStore.getNodeToken` (**separate encrypted store** `node-agent-credentials.json`).

**The gap:** the desktop's `config.token` (userData or node-credential store) and the Agent's
`config.token` (ANXHUB_CONFIG_DIR/cwd-based `agent.json`) can resolve to **different files/values**:
- When the Agent is launched from a helper script with `ANXHUB_CONFIG_DIR` = repo `config/` while
  the desktop Electron app reads userData `agent.json` — each side auto-generates its own distinct
  `anxos_…` token on first run (`agentTokenStore.js` `generateAgentToken`/`writeAgentConfigToken`).
- When a selected Agent **node** is the target, the token is read from the encrypted node-credential
  store; if that stored token is stale or absent, the request carries no/wrong token.
- A token that is **weak/empty** is dropped by `normalizeAgentSettings` (`agentClient.js:102`,
  `isWeakAgentToken`), also producing a header-less request.

Either way, `Authorization: Bearer <mismatch>` (or no header) reaches an Agent that *has* a token →
`401 UNAUTHORIZED`. Health is unaffected because it never reaches the token check.

### 2c. Why stats appears uniquely "unexplained"

- Health is public ⇒ always 200.
- The desktop's node health probe (`nodeService.js:1198` `probeAuthenticatedAgentEndpoint`) can mark a
  node healthy via the *public* health route even while every authenticated route 401s, masking the
  credential mismatch.
- `agentClient.isCompatibilityFallbackAllowed(error)` (`:1056`) returns **false** for `401/403/
  UNAUTHORIZED`, so `getSystemStats` / `getAgentSystemSnapshot` **do not fall back**
  to `/api/v1/system/summary` on a token failure (`systemService.js:523`). A bad token is therefore a
  hard, persistent stats failure with no recovery path, unlike 404/405 which fall through.

---

## 3. Evidence trail

| Step | Evidence |
| --- | --- |
| Agent marks only `/api/v1/health` public | `agent/src/auth.js:23-24` |
| Agent rejects missing/mismatched token with 401 | `agent/src/auth.js:44-49` |
| Agent requires token (never public) | `agent/src/config.js:121`; `server.js:381,383` |
| `stats` requires `system:read` permission | `agent/src/server.js:168` |
| Desktop attaches Bearer only when token truthy | `agentClient.js:700,1423,1527` |
| Desktop global token source | `agentClient.js:128-132, 240` |
| Desktop config path = userData/ANXHUB_CONFIG_DIR | `agentClient.js:124` |
| Desktop node-scoped token source (separate store) | `nodeService.js:1412`; `nodeCredentialStore.getNodeToken` |
| Agent token source = ANXHUB_CONFIG_DIR / cwd | `agentTokenStore.js:56-68`; `config.js:121`; `AnxAgent.sh:20`; `start-agent-mode.ps1:10,228-229` |
| No auth fallback on 401 for stats | `agentClient.js:1056` (returns false for 401) |
| Agent logs 401 for `GET /api/v1/stats` | `.dev-logs/auth.log` (`errorCode: UNAUTHORIZED`) |
| Health public ⇒ always works | `agentClient.js:1040` `getHealth` → `/api/v1/health` |

> Gap I could not close from code alone: **which** of the two sources (userData `agent.json` vs
> node-credential store vs repo `config/agent.json`) was actually active at the exact moment of the
> `04:52:39` failure. The auth log does not record the source or fingerprint of the Agent's
> `config.token`, nor whether the desktop request included an `Authorization` header. This requires a
> live run (Section 5).

---

## 4. Proposed minimal fix (conceptual)

Constraint honored: **no edit to the Agent runtime here**; the Agent auth layer is owned by a parallel
agent. The fix below is scoped to the desktop call/credential routing so both sides converge on one
token. If a change to the Agent runtime is ultimately required, it is limited to the areas noted in
`[optional agent-side]` below and must be handed to the owner of `agent/src`.

Primary targets (desktop, `src/services/agentClient.js`):

1. **Force token-source convergence for the local Agent** in `getSharedAgentTokenStatus()` /
   `getEffectiveAgentSettings()`: resolve the local-Agent token through the **same** `agent.json`
   candidate list the Agent uses (honor `ANXHUB_CONFIG_DIR`, `ANXHUB_AGENT_CONFIG_PATH`, and
   fall back to the Agent's working/config dir), instead of resolving only the Electron
   `userData/…/config/agent.json`. Concretely: call `resolveSharedAgentToken()` without forcing a
   desktop-only `configPath` when the target is the local agent, so the shared
   `writeAgentConfigToken` writes to the one file both processes read.

2. **Reconcile on 401 for authenticated snapshot routes** in `getSystemStats()` /
   `getAgentSystemSnapshot()`: today `isCompatibilityFallbackAllowed(401)` = false, so a token
   failure is fatal. Add an explicit auth-recovery path (separate from the 404/405 compatibility
   fallback) that, for 401/AGENT_TOKEN_MISSING, re-resolves the current token (re-run
   `resolveSharedAgentToken`), compares fingerprints, and either reuses the corrected token for a
   single retry or surfaces a clear "re-pair / rotate Agent credential" error instead of a generic 401.

3. **Node-scoped routing** (`NodeAgentClient.request`, `agentClient.js`): ensure the node token is
   present and current before the request; if the stored node credential is empty or mismatched,
   return the actionable `NODE_CREDENTIAL_MISSING` / re-pair error rather than sending a tokenless
   request. (Mirrors the existing guard at `agentClient.js:331-338`.)

`[optional agent-side, for the parallel owner]`: in `agent/src/config.js` / `agent/src/auth.js`,
prefer resolving `config.token` lazily (or re-check `resolveSharedAgentToken` per non-public request)
rather than a one-time startup snapshot, so a credential rotation by the desktop takes effect without
an Agent restart. No change to the 401 code/behaviour otherwise.

---

## 5. Live-repro steps needed to confirm

1. Start the Agent via the same helper used in production (`AnxAgent.sh` / `start-agent-mode.ps1`)
   so `ANXHUB_CONFIG_DIR` is set; note the Agent’s resolved `proxy` => `agent.json` path and
   `tokenFingerprint` (add a temporary, redacted log line — do not print the token).
2. From the desktop, invoke `system:getSnapshot` / the dashboard tiles that call `/api/v1/stats`
   against `127.0.0.1:47131` and capture the request `Authorization` header length/fingerprint on
   the desktop side.
3. Compare the two fingerprints. Mismatch confirms the divergence in Section 2b.
4. Test both scope selectors: `application-host`/local agent and an explicit Agent node, to see which
   path (`getEffectiveAgentSettings` vs `forNode`)/node-credential source is at fault.
5. Verify that `/api/v1/health` returns 200 while `/api/v1/stats` returns 401 in the same session.
6. Apply the Section 4 desktop fix and confirm stats returns 200 and the token files converge.

---

## 6. Risk of the fix

- **Low–medium.** Convergence forces both processes onto one `agent.json`. Main risks:
  - If `userData` and repo/cwd `agent.json` already hold different (both valid) tokens, choosing one
    source may drop connectivity to an agent that is currently paired with the *other* token —
    mitigated by the 401 auth-recovery/retry (fix 2) and by re-running `resolveSharedAgentToken`
    which rewrites the chosen file.
  - The 401 auth-recovery retry adds one extra request on token mismatches; must be rate-limited and
    must not weaken the existing `isCompatibilityFallbackAllowed` semantics for 404/405.
  - Agent-side lazy token re-resolution (optional) slightly increases per-request work; should be
    scoped only to authenticated routes and is owned by the agent-area maintainer.
- **Security:** no auth boundary is weakened. The Agent still requires a valid token for
  `/api/v1/stats`; this only ensures the desktop sends the *correct* one. No credentials are logged
  (redaction util is preserved).

No source files other than this report were changed.