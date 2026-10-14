# AnxOS CC — Autonomous Infrastructure Management Plan

| Field | Value |
| --- | --- |
| Status | **FROZEN at revision 3.1 (Owner-approved, 2026-10-14). PLANNING ONLY — not approved for implementation.** Any change requires a new revision and Owner approval. |
| Prepared | 2026-10-14 |
| Revision | 3.1 (2026-10-14): freeze-review fixes B1–B5, N1–N7, polish items 1–4, and independent-review fixes (AIM-1/AIM-3 live-test approvals; immutable-ID execution with Agent-side identity guard; plan-level approval definition; process and instance identity; catalog mapped to implemented Agent routes; kill-switch in-flight behavior; probe opt-in; wording) and final-review fixes (AIM-7 AnxGraph negative-capability tests fenced from production; Agent-side host-identity check for instance restart; Open Terminal session probe opt-in; AIM-5 route wording) (image-digest rollback marked unimplemented; identity-changing steps; R2+ production gate in §5.2; CC-specific AnxGraph read consumer) — non-production scopes made proposed-only (§5.6); execution-time identity and precondition re-verification (§5.4); CL9 target identity defined (§5.7); AnxGraph writer access made an unverified, Owner-granted, append-only prerequisite (§4.3); equal caller-authentication requirement for Agent Office (§3.2, §4.4); roadmap prerequisites (§7.0); dependency and AIM-0 corrections. D1–D5, V2-L policy and production protections unchanged. Revision 3 (2026-10-14): Owner resolved D1–D5 (§10); Debian ANX-CorTex port corrected to `8090` (`8080` is AMP); production protection scopes defined (§5.6); AnxLabs HQ and AnxLabs Sentinel inspected from read-only scratch clones. Revision 2: case study updated with recorded recovery results; source availability classified; D3 reconciled with V2-L. |
| Relationship to roadmap | Operationalizes proposed `V2-L` (AnxOS Intelligence) and `V2-M` (Automation Engine) from `MASTER_ROADMAP.md` §6A.2, and feeds `V2-O` (Mission Control). The V2-L approval policy is **unchanged** by this plan. |
| Current priority | ANX-CorTex remains the active development priority. Nothing in this plan starts until it is explicitly scheduled. |
| Evidence labels | **VERIFIED** = inspected in source or recorded runtime evidence on/before 2026-10-14. **REPORTED** = from earlier session records, not re-run today. **OWNER** = decision or fact stated by the Owner on 2026-10-14. Source availability is classified separately (§1.2). **PROPOSED** = new planning in this document. |

## 0. Executive summary

AnxOS CC already has most of the *safe execution substrate* an autonomous
administrator needs: an authenticated per-node Agent, a deny-by-default Docker
policy, durable lock-keyed operations with honest rollback flags, an audit log,
redaction, a six-state health vocabulary, a no-fake-green connectivity
pipeline, verified backups with confirmed restore, and a notification
transition journal. What it lacks is (1) a unified inventory and dependency
graph across machines, containers, volumes, GPUs and AI services, (2)
**functional-correctness contracts** (as opposed to liveness), (3) a
persistence-baseline gate for deployments, (4) a typed runbook and policy
engine that converts diagnoses into bounded, verifiable, reversible actions,
and (5) adapters to the AnxLabs agents that already exist.

The plan's central rule is a strict **separation of reasoning from authority**:

- **Agents reason.** Agent Office (Vera) is the first delegation target for
  diagnosis (AIM-6); authenticated AnxLabs HQ is the later migration target.
  Agents diagnose and *propose*; they never execute.
- **AnxGraph remembers.** Prior decisions are *evidence* attached to a
  proposal; they can never grant permission. ANX EIDOLON is planned and may
  implement the same contract once it exists.
- **AnxOS CC decides and executes, only with per-action Owner approval.** Only
  the existing main-process policy chain and the node's AnxOS Agent may mutate
  infrastructure, through typed runbook steps that map onto already-implemented
  Agent actions. Sentinel *policy patterns* are reused inside CC's own policy,
  not called as a runtime.

No new agent framework, database engine, message bus, or orchestration runtime
is proposed.

---

## 1. Current architecture assessment

### 1.1 AnxOS Control Center (this repository) — VERIFIED

| Capability area | Existing component(s) | Reuse value for autonomy | Gaps |
| --- | --- | --- | --- |
| Trust boundary | `main.js` composes and registers the `src/ipc/*` registrars, which apply the guard chain; `preload.js` (context isolation); guard chain `requireLocalOwnerAuthenticated` → `requirePermission` → `requireNodeContext` → `audit` | All autonomous actions must pass this same chain. Renderer stays presentation-only. | No non-interactive "policy principal" yet (every privileged action today assumes an interactive Local Owner). |
| Node execution | `agent/src/server.js`, per-node tokens (`nodeCredentialStore`), `serviceRouter` → `nodeRouter`/`agentClient` | The Agent is the only executor on a node. Remote nodes already supported. | Agent `capabilities.supportsServiceControl` is `false` (no systemd/Windows service control). |
| Action catalog | `agent/src/actions/actionRegistry.js` (`docker.start/stop/restart` implemented; `amp.*`, `backup.*`, `file.*` registered as `implemented: false`), `src/services/actionRouter.js` | The natural home for runbook step primitives; already permission-tagged. | Small catalog; no risk class, precondition, or verification metadata per action. |
| Docker | `src/shared/dockerService.js` + `agent/src/routes/docker.js`: containers (inspect/stats/logs/exec/lifecycle), images, **volumes** (list/inspect/prune), **networks** (list/inspect/connect), **compose** (projects/config/status/up/down/recreate/logs), cleanup preview | Complete read surface for inventory; lifecycle verbs for repair. | No volume content fingerprinting; compose dependency graph not modeled. |
| Docker safety policy | `src/shared/dockerPolicy.js` (deny-by-default privileged/host-mount/socket/host-network; volume-touching cleanup needs explicit confirmation), `workloadTrustPolicy.js` | Directly reusable as a hard floor under any autonomy policy. "A grant can never lift a trust refusal" is the right composition rule. | — |
| Long operations | `src/shared/longOperationService.js` (lockKey dedupe, timeouts, `interrupted` on restart, retry handlers, `rollbackSupported` never inferred, redacted persistence) | The execution record for every repair attempt. | No parent "incident" grouping beyond `parentId`. |
| Health vocabulary | `src/shared/healthModel.js` (six states, aggregation, reachability scopes), instance `processState/readinessState/healthState` | Base for service health. | Health ≠ functional correctness; no per-service functional contracts. |
| Connectivity diagnostics | `connectivityDiagnosticsService.js` (six stages, cached, read-only, `NOT_EVALUATED` sentinel), `connectivityGraph.js`, `connectivityPresentation.js` | Diagnostic pipeline pattern and graph builder are the template for the infrastructure graph and diagnosers. Pipeline is already contractually read-only. | Network-path only; no container/volume/GPU/model nodes. |
| Inventory | `computerService.js` (computer read model), `networkInventoryService.js` (listeners, port conflicts, interfaces), `systemService.js` (CPU/mem/disk, Windows GPU temperatures) | Machine + port inventory exists. | No GPU inventory (model, VRAM, driver, utilization, which process holds VRAM); no service-to-port-to-container attribution. |
| Notifications | `operationalNotificationService.js` (transition journal, bounded), `alertService.js` | The detection event stream. | No incident correlation/dedup across symptoms. |
| Telemetry | `telemetryStore.js` + `telemetryService.js` (bounded series, missing-is-not-zero) | Baselines for anomaly detection without new infra. | No AI-service metrics (model load, queue depth, VRAM). |
| Backup/restore | `agent/src/services/backupService.js` (verify lifecycle; restore requires `confirmOverwrite`; safety snapshot + partial-restore rollback) | The only *proven* rollback path today. Required precondition for R3 repairs. | Instance-scoped; not yet for arbitrary Docker volumes / external DBs. |
| Audit | `securityService.audit` (actor, action, outcome, target, reason; identifier-only) | The repair history. | Needs actor type `policy:<id>` and `agent:<external>` attribution. |
| Redaction | `src/shared/redaction.js`, `structuredLogger.js` | Mandatory for all evidence, replays, and outbound adapter payloads. | — |
| Workload transfer | `workloadTransferService.js` (preview-first, declines delete only what they created) | Pattern for preview → confirm → execute → verify. | — |

Agent `/api/v1/health` reports a computed `mode` (`read-write` under the default
wildcard Owner profile) — REPORTED from live probe. Any autonomy design must
assume the Agent token is powerful and must scope autonomous calls with a
**narrower, least-privilege credential** — built on the existing V2-I scoped Agent tokens (§5.4) — rather than reusing the Owner wildcard.

### 1.2 AnxLabs systems — source availability

**Availability classes.** These describe *what this planning pass could
inspect*, not whether a project exists:

- **LOCAL+REMOTE** — local checkout inspected and a repository exists in the
  `AnxLabs` GitHub account.
- **LOCAL-ONLY** — local source inspected; no repository of that name in the
  `AnxLabs` GitHub account (it may live elsewhere).
- **REMOTE + SCRATCH CLONE** — repository exists in the `AnxLabs` account; a
  read-only clone was made in this session's temporary scratchpad (approved by
  the Owner, 2026-10-14) and inspected. Nothing was installed, built, executed,
  or modified; the clones have no local changes. There is no persistent local
  working checkout.
- **PLANNED** — the Owner states the project is planned and not implemented.
- **NOT LOCATED** — no source, repository, or session record found in the
  searched locations; existence undetermined. (No system currently has this
  class; EIDOLON moved to PLANNED per D1.)

**Search coverage (2026-10-14).** Directory names under `C:\Users\anjor` to depth 5
(excluding `AppData`, `OneDrive`, `node_modules`, `.git`, `Credentials-SECURE`);
content search in AnxOS CC, Anx-CorTex, AnxCorTex HQ (`server/`, `docs/`) and
Agent Office; Codex memory summaries; claude-mem session records; the full
repository list of the `AnxLabs` GitHub account (17 repositories; the account
belongs to no organizations). **Not searched:** `AppData`, OneDrive, other local
drives, the Debian/anxlab host filesystem, other GitHub accounts. The
repository count and the scratch-clone commit hashes below were recorded by
this planning pass on 2026-10-14 (`gh repo list AnxLabs`, `git log -1` in each
clone); they are point-in-time observations to re-check in AIM-0, not
independently verified facts.

| System | Availability | Location / interface | Relevant facts |
| --- | --- | --- | --- |
| **AnxOS Control Center** | LOCAL+REMOTE | This repository; `AnxLabs/AnxOS-Control-Center` | §1.1. REPORTED: an Agent source checkout also exists on the anxlab host (`/home/anx/Projects/AnxOS-Control-Center`, branch `dev`). |
| **Agent Office** (Vera = director agent) | LOCAL-ONLY | `C:\Users\anjor\.zcode\workspace\default\agent-office`; HTTP `127.0.0.1:7777` (`/api/snapshot`), MCP at `/api/mcp` (REPORTED live probe) | `server/levels.js`: cumulative autonomy levels (observe → maintain → develop → push → release → deploy) with hard-blocked actions at every level. `server/immune.js`: symptom→remedy "antibodies" verified by re-running the detector, byte-for-byte rollback, auto-quarantine after three consecutive real failures, bounded application rates. `server/learning/` (experiences, judge, learners). `server/ops/` (machine, recovery, janitor, drift, models…). `server/runtime/sentinel.js`. Scope today is **source repositories**, not infrastructure. **First delegation target (D2, AIM-6).** |
| **AnxLabs HQ** | REMOTE + SCRATCH CLONE | `AnxLabs/AnxLabs-HQ` (private) at `2d3c9e4` (2026-10-12) | Built **to replace Agent Office as the frontend and orchestration interface**, with Agent Office backends migrated behind adapters (README, `docs/INTEGRATIONS.md`). Agents include Vera, Atlas, Nova, Onyx, Moss, Pip. Ports in `src/orchestration/ports.ts`: `ExecutionAdapter`; `SentinelPort.review(request, ctx) → { decision: 'allow' \| 'hold' \| 'deny', reasons[] }` (synchronous, runs in the browser before every out-of-engine dispatch); `MemoryPort.recall(...)` (read-only over office state today); `TaskSyncPort { pull(), push(event) }` (documented contract; **no adapter ships**). Remote execution protocol `anxlabs-hq/execution@1` (`POST {base}/runs`, `GET {base}/runs/{id}`). Simulation mode by default; browser `localStorage` state; remote reports are displayed, not verified. **No server-side, authenticated intake exists today**, so CC cannot submit work to it yet. Later migration target (D2). |
| **AnxCorTex HQ** (Sentinel workspace) | LOCAL+REMOTE | `C:\Users\anjor\Documents\AnxCorTex HQ`; `AnxLabs/AnxCorTex-HQ`; loopback, port 4310 in dev / ephemeral when packaged | Ten departments incl. Security (Sentinel center: pending/history/blocked actions/blockers/evidence status). **Content-hash-bound approvals** for Change Sets and Execution Plans (pattern reused in §5.3). Single FIFO local inference queue. REPORTED gap: **no API-wide caller authentication** (loopback ≠ auth). Not integrated in V2. |
| **AnxLabs Sentinel** (guardrail standard) | REMOTE + SCRATCH CLONE | `AnxLabs/Sentinel` (private) at `fa896d5` (2026-09-13); v0.1 ZCode adapter | Deterministic PreToolUse guards for development agents (`hooks/sentinel-core.mjs`, `command-guard.mjs`, `write-guard.mjs`) classifying operations **SAFE / REVIEW / BLOCK**; secret values never logged; local-only, no network calls. Sensitive-path rules mark `.env*`, CI workflows, auth/permission config, `docker-compose*.yml`, credential files, private keys and network/firewall config as REVIEW. **Policy patterns reused in CC (D1); no runtime coupling.** |
| **AnxGraph** | LOCAL+REMOTE | `AnxLabs/AnxGraph`; M5 worktree `C:\Users\anjor\.codex\worktrees\m5-anxgraph-auth\AnxGraph`; staging recorded as `127.0.0.1:7385` (host and identity unverified, §5.6) | Authoritative structured memory. Bounded **consumer delivery API**; actors are capability-scoped (`READ_MEMORY`, `DELIVER_CONTEXT`); project-scoped consumers; delivery receipts with source/claim ids and graph fingerprint. Correction/retraction is a separately authorized operator workflow. **Precedent store (D1).** |
| **ANX-CorTex** | LOCAL+REMOTE | `C:\Users\anjor\Documents\Anx-CorTex`; `AnxLabs/open-webui` (public fork); **Debian production on port `8090`** (OWNER; corroborated by `work/cloudflared-anx-cortex.yml` → `http://127.0.0.1:8090`); AI-BOX compose (Qdrant, Tika, Infinity, Open Terminal, SearXNG) | `INTEGRATION_BOUNDARY.md`: **no source coupling** with sibling projects; integrate via APIs only. Port `8080` on that host belongs to **AMP** (OWNER). The M5 handoff recorded production on `127.0.0.1:8080`; that record conflicts with the Owner's statement and is superseded for the Debian deployment. Which host the handoff described was not verified. |
| **ANX AgentOS** | LOCAL-ONLY (experimental) | `C:\Users\anjor\Documents\Codex\2026-10-13\new-chat-2\outputs\anx-agentos` (commits `83a153b`, `13d4f3c`, `6efb521`); FastAPI `127.0.0.1:4871` | Isolated M0 prototype, explicitly separate from production AnxLabs systems. OpenHands Software Agent SDK `v1.54.0`; SQLite task/event store; routes `/api/health`, `/api/config`, `/api/tasks` (create/get/cancel/events/stream); Docker sandbox (digest-pinned open-terminal image, network disabled, non-root, read-only root fs). Host-header allowlist on loopback; no caller token observed in `server/app.py`. **M0 freeze review: NOT ACCEPTED (2026-10-13).** **Experimental until accepted and authenticated (D1).** |
| **COMBO'S M1** | LOCAL-ONLY (REPORTED) | `outputs/combos-app`, `127.0.0.1:4399` | Read-only unified dashboard over Agent Office / HQ / AnxOS with single-use launch token. A possible *consumer* of AnxOS facts, not an executor. |
| **ANX EIDOLON** | **PLANNED** (OWNER) | — | Planned, not implemented (D1). Consistent with the search finding no source or record. No integration until it exists; it may later implement the §4.3 precedent contract. |

**Three distinct "Sentinel" components exist:** (a) the AnxLabs Sentinel v0.1
guardrail standard/plugins; (b) the Sentinel security workspace inside
AnxCorTex HQ; (c) the `SentinelPort` adapter in AnxLabs HQ. **Resolved (D1):**
CC reuses Sentinel *policy patterns* — deterministic SAFE/REVIEW/BLOCK
classification, allow/hold/deny verdicts with reasons, sensitive-path rules,
never logging secret values — inside its own policy service (§5.2). CC does not
call or depend on any Sentinel runtime in V2.

### 1.3 Key architectural conclusions

1. AnxOS CC is the correct **authority and execution owner** for
   infrastructure: it already owns node credentials, Agent tokens, Docker
   policy, backup rollback, and audit.
2. Agent Office already contains the best **verified-remedy learning pattern**
   (`immune.js`) and an autonomy-level vocabulary; AnxCorTex HQ contains the
   best **approval-binding pattern** (content hashes); AnxLabs Sentinel contains
   the deterministic **classification pattern**. Reuse the *patterns and
   interfaces*, not their code (no source coupling).
3. The largest real gap is not "AI" — it is **functional verification and
   persistence baselines**. The ANX-CorTex incident (§2) passed every liveness
   check while user data was missing.
4. Delegation targets are in flux: AnxLabs HQ declares itself the replacement
   orchestration interface for Agent Office but has no authenticated
   server-side intake yet, and ANX AgentOS is an unaccepted prototype. AnxOS CC
   therefore integrates through a **narrow, target-neutral contract**
   (incident packet in, structured proposal out), implemented first for Agent
   Office and migrated to AnxLabs HQ later (D2).

---

## 2. Case study — ANX-CorTex Debian deployment (2026-10-13/14)

**Evidence basis.** Recovery results below were verified *during the ANX-CorTex
recovery sessions* on 2026-10-14 and are taken from their recorded results
(claude-mem sessions S307, S308 and observations 5546–5549, 5574, 5592). This
planning pass **did not re-probe** the Debian node or production; treat these
as recorded verification, current as of those sessions. Locally inspected
artifacts: `Anx-CorTex/work/migrate-anx-cortex-workspace.py`,
`work/recovery-ai-box-compose.yaml`, `work/recovery-e2e-tests.py`,
`work/recovery-backups/20261014-0115/`, `work/cloudflared-anx-cortex.yml`,
`docs/AI_BOX_STACK.md`. Debian production ANX-CorTex listens on port `8090`.

### 2.1 Incident timeline and current status

| # | Failure as first observed | Why liveness checks passed | Recorded recovery result (latest) | Status |
| --- | --- | --- | --- | --- |
| C1 | **Workspace metadata missing.** Debian `webui.db` was a fresh minimal DB at the *same* Alembic revision (`d4c1a8e37b62`) but with a **different admin user UUID**; no user-scoped objects (20 chats/120 messages, 4 knowledge bases, 8 prompts, 6 skills, 2 tools, 9 notes, 352 config rows) had been migrated. | `/health` returned `{"status": true}`; container healthy; schema revision matched. | Additive, identity-preserving migration (user-id remapping, transactional, `PRAGMA integrity_check` on both sides, refuses mismatched revision or identity, protects deployment-owned config keys); restart persistence verified. | **Recovered** |
| C2 | Merge dry-runs hit a `tag UNIQUE(id,user_id)` collision on the shared `general` tag and a root-owned `uploads` directory inside the anx-owned data volume. | Not a liveness concern. | Resolved through three dry-run sandboxes (`merge-dry-run`, `-v2`, `-v3`) before the real merge. | **Resolved** |
| C3 | **Qdrant recovery.** Windows Qdrant volume imported into an isolated Debian recovery volume; authenticated calls first failed with `invalid Header provided`. | Container healthy; unauthenticated 401 looked like "up". | Original Windows volume inspected **read-only** (`anx-cortex_knowledge` 4 points, `anx-cortex_files` 1, `anx-cortex_memories` 1; 384-dim cosine) and a validated compressed backup staged. Isolated Debian recovery stack (`127.0.0.1:16333`) passed an **authenticated retrieval test (3 scored matches)**; Tika and Infinity checks passed. Collection names match Open WebUI's multitenancy prefix (`QDRANT_COLLECTION_PREFIX=anx-cortex`). | **Data recovered and retrievable in isolation; not in production.** Production M5 still uses **Chroma**; the Chroma→Qdrant production switch is **deferred pending explicit user approval**. One uploaded image in the Windows backup has **no corresponding Qdrant file point** (open). |
| C4 | **Open Terminal.** `terminal_server.connections` pointed at the Windows-only endpoint (`127.0.0.1:8000`), unreachable from Debian; the key was deliberately protected during migration. | Open Terminal `/health` → 200; ANX-CorTex healthy. | New authenticated connection `anx-cortex-debian-recovery-terminal` (bearer, `http://127.0.0.1:18000`) added to the production `webui.db` in a transaction with integrity check; production container restarted and healthy; diagnostics show Open Terminal v0.14.0 healthy. A "runs as root" signal was a **test-parser false positive** (raw-byte match); processes run as UID 1000. Authorized/unauthorized (200/401) and restricted-read denial verified. | **Reconfigured (recorded).** Production now depends on a container from the **recovery** compose stack; long-term ownership of that stack is open ANX-CorTex work. |
| C5 | Windows Docker Desktop unavailable; the source Qdrant volume could not be inspected. | — | Windows Docker visibility restored; source volume inspected read-only and backed up. Post-recovery backup of the `anx-cortex-m5` data volume taken (436,154 bytes; SHA-256 recorded in the session). | **Resolved** |
| C6 | Production diagnostics show **2/6 services healthy** (Qdrant, Tika, SearXNG, Infinity "down"). | — | Expected: production M5 does not use those services yet (still on Chroma); the healthy recovery stack runs on alternate ports. | **Misleading signal, not an outage** |

Unchanged throughout (recorded): original Windows Qdrant volume, AMP (port
`8080`), both Ollama nodes, Cloudflare Access (302 login redirect re-verified),
recovered workspace, and existing backups. No destructive operations were
performed. Mobile access confirmation through Cloudflare Access still requires
the user.

### 2.2 How each failure maps to this plan

| # | Capability that would have caught or handled it |
| --- | --- |
| C1 | **Persistence Baseline Gate (AIM-3):** owner-identity hash, per-table row counts and protected-config keys; post-deploy diff → `IDENTITY_CHANGED`, `WORKSPACE_OBJECTS_MISSING`; success cannot be declared. |
| C2 | **Runbook preflight (AIM-4):** ownership/permission check on mounted volume paths; dry-run merge as a mandatory R3 precondition (codifies what the manual recovery did). |
| C3 | **Qdrant functional contract (AIM-2):** authenticated collection/point counts vs baseline plus a retrieval probe; distinguishes `AUTH_INVALID`, `COLLECTION_MISSING`, `EMPTY`, and **`NOT_WIRED`** (data healthy but not the backend the app is configured to use). Point-count reconciliation against uploads would have flagged the image with no file point. |
| C4 | **Dependency graph (AIM-1) + config-reference check (AIM-2):** `DANGLING_DEPENDENCY`; repair is an **R3** proposal (changes a tool trust boundary). The graph would also show production depending on a stack labelled *recovery*. |
| C5 | **Inventory honesty (AIM-1):** `docker: unavailable:<reason>`, never "no volumes"; the data gate refuses "source verified" while the source is uninspectable. |
| C6 | **Declared expected dependencies (AIM-2):** a service adapter declares which dependencies the deployed configuration actually uses, so unused services render as `not-in-use`, not `down`. |

**Lessons encoded as requirements:**
- CL1. `healthy` is a precondition of success, never the definition of it.
- CL2. Identity continuity (owner/user ids) is a first-class data-protection invariant.
- CL3. Unauthenticated 401 is "reachable", not "working".
- CL4. Config that references endpoints is part of the dependency graph.
- CL5. Unknown/uninspectable is its own state and blocks success claims.
- CL6. "Recovered" and "in production" are different states; data recovered in isolation must be shown as `NOT_WIRED` until the app is switched.
- CL7. Probes must parse structured output; substring matching produced a false "root" finding.
- CL8. Health views must know which dependencies are expected; otherwise intentional non-use looks like an outage.
- CL9. Scopes and plan targets are identified by verified inventory identity as defined in §5.7, never by port alone; a port mix-up (`8080` AMP vs `8090` ANX-CorTex) must not be able to retarget a plan.

The remaining ANX-CorTex items stay **open ANX-CorTex work**, outside this plan:
the Chroma→Qdrant production switch (needs approval), the missing image file
point, long-term ownership of the recovery-stack services production now uses,
and the user's Cloudflare Access mobile confirmation. AnxOS CC does not fix
them. They serve as acceptance fixtures (§7) once the relevant milestones exist.

---

## 3. Proposed architecture

### 3.1 Layered model

```
┌──────────────────────────────────────────────────────────────────────────┐
│ T5  Visual Operations Center  (app.js / index.html — presentation only)  │
│     topology · service health · incidents · approval queue · replay      │
├──────────────────────────────────────────────────────────────────────────┤
│ T4  Policy & Approval  (main process — NEW: autonomyPolicyService)       │
│     level × risk × workload trust × production scope × Sentinel-pattern  │
│     rules → APPROVAL_REQUIRED | MANUAL_ONLY | REFUSED (R0: automatic)     │
│     desktop per-action, plan-hash-bound approvals; kill switch; breakers │
├──────────────────────────────────────────────────────────────────────────┤
│ T3  Incident & Runbook Engine  (main process — NEW: incidentService,     │
│     runbookService; executes ONLY via existing permissioned Agent        │
│     routes — actionRouter actions or Agent REST lifecycle routes —       │
│     by immutable ID; records via longOperationService + audit)           │
├──────────────────────────────────────────────────────────────────────────┤
│ T2  Diagnosis  (EXTEND connectivityDiagnosticsService pattern;           │
│     deterministic diagnosers through AIM-5; target-neutral delegation    │
│     adapter from AIM-6 — proposals only)                                 │
├──────────────────────────────────────────────────────────────────────────┤
│ T1  Facts: Inventory graph + Functional contracts + Persistence baselines│
│     (EXTEND computerService, networkInventoryService, dockerService,     │
│      systemService, serviceCapabilityContract, healthModel)              │
├──────────────────────────────────────────────────────────────────────────┤
│ T0  AnxOS Agent on each node (EXISTING) — read routes + permissioned     │
│     actions; V2-I scoped Agent token for approved executions only        │
└──────────────────────────────────────────────────────────────────────────┘
          ▲ read-only facts out                 ▲ proposals in (AIM-6)
          │                                     │
   ┌──────┴───────────┐  ┌──────────────┐  ┌────┴─────────────┐  ┌───────────┐
   │ COMBO'S / HQ /   │  │ AnxGraph     │  │ Agent Office     │  │ AnxLabs HQ│
   │ mobile read-only │  │ precedent    │  │ (Vera) diagnosis │  │ (later,   │
   │ incident views   │  │ (EIDOLON:    │  │ — first target   │  │ authen-   │
   │                  │  │  planned)    │  │                  │  │ ticated)  │
   └──────────────────┘  └──────────────┘  └──────────────────┘  └───────────┘
```

### 3.2 Integration map

| Integration | Direction | Interface (existing where possible) | Payload | Trust rule |
| --- | --- | --- | --- | --- |
| AnxOS Agent (each node) | CC → Agent | Existing REST `/api/v1/*`, existing tokens | Inventory reads, approved action invocations | A least-privilege credential issued through the existing **V2-I scoped Agent tokens** (§5.4); Owner wildcard never used by AIM. |
| Agent Office / Vera | CC → AO (request) ; AO → CC (proposal) | **AIM-6:** target-neutral diagnosis adapter over AO HTTP/MCP (`/api/mcp`, `/api/snapshot`); read `ops.machine`, submit a *diagnosis task*; AO returns a structured proposal | Redacted incident packet (symptoms, graph slice, log excerpts post-redaction) | AO output is **untrusted data**. It can only name runbook IDs from the CC catalog; free-form commands are rejected. Read-only diagnosis; no execution delegated. **Same caller-authentication prerequisite as every other runtime integration:** the adapter is not enabled until AO authenticates CC's requests and CC can authenticate AO's responses (AO's MCP/HTTP authentication model is **unverified** and is pinned in AIM-0). No exception is granted by this plan; any exception would need a separate Owner decision. |
| AnxLabs HQ | CC → HQ (read) ; later CC ↔ HQ (diagnosis) | Read-only Infrastructure Facts API (AIM-6). Diagnosis migration (later, separate milestone): the same adapter contract behind an **authenticated, server-side HQ intake** (e.g. a server implementation of `TaskSyncPort` or an `execution@1` executor) — none exists today | Graph, health, incidents; later diagnosis tasks | Read-only by default; authenticated; rate-limited. HQ displays remote reports without verifying them, so CC remains the verifier of any infrastructure outcome. Migration requires HQ caller authentication first. |
| Sentinel policy patterns | — (no runtime call) | CC-native deterministic rule tables in `src/shared/` following the AnxLabs Sentinel v0.1 SAFE/REVIEW/BLOCK model and the allow/hold/deny-with-reasons verdict shape | — | Rules can only **add** restriction (REVIEW ⇒ approval required; BLOCK ⇒ refused). No dependency on the Sentinel plugin, AnxLabs HQ `SentinelPort`, or AnxCorTex HQ Sentinel runtime. |
| AnxGraph | CC → AnxGraph | Bounded consumer delivery API (read precedents); writer access for decision records **only if** AIM-0 confirms AnxGraph supports it and the Owner grants it (§4.3) | Incident fingerprint → precedent claims with source ids | AnxGraph production is a `production` scope (§5.6). Read and write actors are distinct; the existing M5 delivery actor is never widened; CC never receives admin, export, correction or deletion capability. Writes are append-only, project-scoped, and outside the runbook/repair path. |
| ANX EIDOLON | None (PLANNED) | No interface; may later implement the §4.3 contract | — | No integration until it exists and a separate integration is approved. Evidence only; never permission. |
| ANX AgentOS | None in V2 | `/api/tasks` on `127.0.0.1:4871` recorded for reference only | — | Experimental until its acceptance passes and caller authentication exists; then a separate decision. |
| AnxCorTex HQ | None in V2 | — | — | Patterns only (content-hash approvals). Any runtime integration requires caller authentication and a separate decision. |
| ANX-CorTex / Open WebUI | CC → app | Open WebUI's own authenticated API on the Debian production port `8090`, via a **service adapter** (`serviceCapabilityContract`) | Functional probes: object counts, retrieval probe | Read-only service account; no source coupling (respects `INTEGRATION_BOUNDARY.md`). |
| Qdrant / Ollama / Infinity / Tika / Open Terminal | CC → service | Native health + authenticated read endpoints via service adapters | Collections/points, loaded models, `/health` | Keys held only in `nodeCredentialStore`-style secure store; never in graph, logs, or adapter payloads. |

### 3.3 Proven open-source components to prefer (only where a gap exists)

| Need | Preferred | Why / constraint |
| --- | --- | --- |
| GPU inventory | `nvidia-smi --query-gpu … --format=csv`, `rocm-smi --json` / `amd-smi`, Windows `Get-CimInstance Win32_VideoController` + existing temperature path | CLI tools already present with drivers; no daemon. AMD RX 9060 XT on the Windows host → Windows path first. |
| Container metrics | Existing `docker stats` route | No cAdvisor/Prometheus needed at current scale. |
| Graph layout (UI) | Existing connectivity graph renderer; if a library is required, a small vendored force-layout (e.g. d3-force) behind a decision | Avoid heavy dependencies in the renderer. |
| Rule evaluation | Plain JS predicate tables in `src/shared/` (pattern of `dockerPolicy.js` and AnxLabs Sentinel v0.1) | No rules engine dependency. |
| Metrics/observability at larger scale | Prometheus node-exporter + existing `telemetryStore.exportSeries()` seam | Explicitly **deferred**; only if fleet size requires it. |

---

## 4. Capability designs

### 4.1 Infrastructure Discovery (Inventory Graph)

**Model** (PROPOSED, `src/shared/infraGraphModel.js`, dependency-free so the
Agent can share it):

- Node kinds: `computer`, `gpu`, `docker-engine`, `container`, `compose-project`,
  `volume`, `bind-mount`, `network`, `service` (logical app: e.g. ANX-CorTex),
  `port-listener`, `endpoint` (existing `endpointModel`), `model-runtime`
  (Ollama/llama.cpp), `ai-model`, `datastore` (SQLite file, Qdrant collection),
  `instance` (existing game/app instances).
- Edge kinds: `runs-on`, `mounts`, `attached-to`, `listens-on`, `exposes`,
  `depends-on` (declared: compose `depends_on`, labels; inferred: config
  references, env URLs — always marked `inferred`), `uses-gpu`, `stores-data-in`.
- Every node carries `source` (`agent-observed` | `declared` | `inferred` |
  `operator`), `observedAt`, `staleness`, `inspectability`
  (`inspected` | `unavailable:<reason>` | `unauthorized`), and a **protection
  scope** (`production` | `non-production`; unclassified ⇒ `production`, §5.6).
- **No secrets**: env values, keys and connection strings are never stored;
  only key *names* and a "has value" flag (reuse `endpointModel` no-secrets contract).

**Collection** (extend, do not replace):
- Agent: add `GET /api/v1/inventory` composing existing `dockerService`
  (containers/volumes/networks/compose), `networkInventoryService`
  (listeners → container attribution via `docker inspect` port maps),
  `systemService` + new GPU probe. Bounded: single-flight, 30 s cache, cap rows.
- Desktop: `infrastructureInventoryService` merges per-node inventories with
  `computerService`, `endpointStore`, instances; builds the graph with the same
  construction/validation approach as `connectivityGraph.js`.
- Service adapters (`serviceCapabilityContract` extension) declare how to
  recognise a known service from image/labels (Open WebUI, Qdrant, Ollama,
  Infinity, Tika, Open Terminal, SearXNG, AMP) and which dependency hints to read.

### 4.2 Functional correctness contracts

Extend the closed `SERVICE_CAPABILITY_IDS` vocabulary with a
`functionalProbes` capability. Each probe is declarative, read-only, bounded,
and returns one of: `pass`, `fail:<code>`, `degraded:<code>`, `not-evaluated:<reason>`.

| Service | Liveness (exists today in principle) | Functional probe (NEW) |
| --- | --- | --- |
| Open WebUI / ANX-CorTex | `/health` | Authenticated read with a dedicated read-only account: owner identity hash matches baseline; counts of knowledge bases / prompts / tools / skills / notes ≥ baseline; configured terminal & tool server references resolve from this node. |
| Qdrant | `/healthz` | Authenticated `GET /collections`; expected collections present; `points_count` within tolerance of baseline; distinguishes `AUTH_INVALID` / `AUTH_REQUIRED` / `COLLECTION_MISSING` / `EMPTY` / `NOT_WIRED`. |
| Ollama | `/api/version` | Expected models present (`/api/tags`); optional tiny generation probe **only on demand** (GPU cost). |
| Infinity | `/health` | Embedding of a fixed string returns expected dimension. |
| Tika | `/tika` | Parse of a bundled tiny fixture returns expected text. |
| Open Terminal | `/health` | Authenticated session open/close, no command execution. Because opening a session is a small state change, this probe runs against a `production` scope **only after the Owner opts in for that scope** (same opt-in as §9.1); otherwise only `/health` is checked. |
| RAG end-to-end | — | Optional, on demand: known fixture query returns known document id (mirrors `recovery-e2e-tests.py`). |

Result model: **service health** (from `healthModel`) and **functional state**
are displayed separately; overall status is the worse of the two, and a
`not-evaluated` functional state can never render as green (extends the
existing no-fake-green contract).

### 4.3 Learning as evidence — AnxGraph precedent store (EIDOLON planned)

Per D1, **AnxGraph is the precedent store**. ANX EIDOLON is planned and not
implemented; this section defines the contract CC needs so that EIDOLON can
implement it later without changing the policy design. Any EIDOLON integration
is a separate, later approval.

**Write-access prerequisite (unverified).** The only AnxGraph actors verified
so far are delivery-only (`READ_MEMORY`, `DELIVER_CONTEXT`), and the M5
boundary forbids widening them; correction and deletion use a separately
authorized, user-bound operator workflow. AnxGraph production is a
`production` scope (§5.6). Writing decision records therefore requires, before
AIM-7 starts:

1. AIM-0 confirms that AnxGraph can host a dedicated writer actor with
   append-only capability in its own project scope (e.g. an infrastructure
   precedent project), separate from all existing consumers.
2. The Owner grants that actor through AnxGraph's own operator workflow. CC
   never self-grants, and never receives admin, export, correction or
   deletion capability.
2a. Reading precedent likewise needs a **CC-specific read consumer**, separate
   from the existing `anx-cortex-m5` consumer and limited to the same
   precedent project, granted by the Owner through the same workflow. The M5
   consumer is never reused or widened.
3. Writes are append-only records, rate-limited, redacted, and issued outside
   the runbook/repair path; they are not repair actions and never mutate
   existing memory.

If any step fails, AIM-7 is **blocked** and returned to the Owner for a
decision; this plan introduces no alternative precedent store. AIM-1 through
AIM-6 do not depend on precedent and are unaffected.

- **Decision record** (written by CC after every approval/rejection/correction,
  through the writer actor above once granted): `{ incidentFingerprint,
  runbookId@version, planHash, riskClass, decision: approved|rejected|modified,
  operatorCorrection?, outcome: verified|failed|rolled-back|not-verified,
  verificationEvidenceIds[], node/service scope ids, at }`. Identifier-only,
  redacted; screenshots only by reference to redacted evidence artifacts.
- **Precedent query** (read actor): given an incident fingerprint, return prior
  records with similarity, counts (`n_verified`, `n_failed`, `n_rejected`), and
  source ids.
- **How precedent is used:**
  - Ranks candidate runbooks and pre-fills the rationale in the approval card.
  - Shows the operator a runbook's verified track record for this scope.
    It is display context only; any use of track record to justify automatic
    repair belongs to a future, separately approved policy change (D3).
  - **Never** auto-approves, never raises an autonomy level, never applies to
    a different service/node scope than it was recorded for, and is ignored
    for R3/R4 risk classes except as display context.
  - Rejections and failed verifications weigh more than successes (mirrors
    Agent Office immune-system quarantine after three consecutive real failures).
- Screenshots: allowed as acceptance/replay evidence only after redaction; they
  are never used as an input to execution decisions.

### 4.4 Agent delegation — target-neutral, Agent Office first (no new agent framework)

Per D2:

- **Through AIM-5: deterministic diagnosis only.** CC's own diagnosers produce
  hypotheses and runbook recommendations; no agent is called.
- **AIM-6: target-neutral diagnosis adapter, first implemented for Agent
  Office.** CC creates an **incident packet** (redacted symptoms, graph slice,
  recent transitions, bounded log excerpts) and submits a read-only *diagnosis
  task*; Vera routes it to a role. The adapter is enabled only after Agent
  Office meets the same caller-authentication prerequisite as every other
  runtime integration (requests authenticated to AO, responses attributable to
  AO). Until then it stays disabled and CC remains deterministic-only.
- **Later (separate milestone): migrate the same contract to authenticated
  AnxLabs HQ** once HQ has a server-side, authenticated intake. ANX AgentOS and
  AnxCorTex HQ are not delegation targets in V2.
- Allowed response schema (identical for every target): `{ hypotheses[{cause,
  confidence, evidenceRefs}], recommendedRunbooks[{runbookId, params}],
  questionsForOperator[] }`. Parameters are validated against the runbook's
  typed schema; unknown runbook ids or free-form shell are rejected and logged.
- Deterministic diagnosers always run first; delegation is optional and on
  demand, so CC remains fully functional when the target is offline.
- Local inference only (AO's pool policy already enforces local-only); CC never
  sends packets to cloud providers.

### 4.5 Self-healing loop

```
Detect ─► Correlate ─► Diagnose ─► Recommend ─► Approve ─► Execute ─► Verify ─► Record
  │          │            │            │           │          │          │         │
transition  incident    diagnosers  runbook     Owner,     action-    re-run     audit +
journal +   (dedupe by  (determin-  candidates  desktop,   router →   detecting  decision
functional  fingerprint istic;      + precedent per-action Agent;     probe +    record →
probes      + graph     delegation  (evidence)  plan-hash  long-op    functional AnxGraph
            ancestry)   from AIM-6)             bound      lockKey    contract
                                                                         │
                                                           fail ─► rollback step ─► verify ─► escalate
```

- **Correlation:** a failing volume/datastore suppresses duplicate incidents
  for dependents (graph ancestry), so one root cause yields one incident.
- **Runbook** (PROPOSED `src/shared/runbookCatalog.js`): versioned, declarative,
  each step = existing Agent action id + typed params; declares `riskClass`,
  `preconditions`, `verification` (probe ids), `rollback` (steps or `none` —
  `none` forces at least R2), `cooldown`, `maxAttemptsPerWindow`, `blastRadius`.
- **Initial low-risk catalog.** Every step maps to an **existing, implemented,
  permissioned Agent route**; everything above R0 needs per-action approval:

  | # | Runbook | Class | Existing Agent route used |
  | --- | --- | --- | --- |
  | 1 | Re-evaluate probes / refresh inventory | R0, automatic | Existing read routes (+ AIM-1 inventory route) |
  | 2 | Restart a crashed **stateless** container (e.g. Tika, Infinity, SearXNG) | R1 | `docker.restart` in `agent/src/actions/actionRegistry.js` (`implemented: true`), by full container ID |
  | 3 | Restart a crashed **managed instance** | R1 | Agent REST `POST /api/v1/instances/:id/restart` (`agent/src/routes/instances.js`, `restartInstance`), by AnxOS instance id — a REST lifecycle route, **not** an `actionRegistry` action |
  | 4 | Clear stale PID record | R0 evidence only | None — already performed by existing reconciliation; AIM only surfaces it |
  | 5 | Restart a **stateful** container (Qdrant, Open WebUI) | R2 | `docker.restart`, by full container ID |

  Registry entries marked `implemented: false` (`amp.*`, `backup.*`,
  `file.*`) are **not** usable by any runbook. Adding a runbook that needs a
  new Agent capability is a separate, reviewed change to both the Agent and
  the catalog.
- Explicitly *not* in the catalog: volume prune, `compose down -v`, image
  removal while referenced, credential rotation, firewall/public exposure,
  certificate/signing changes, DB migrations, cross-node data moves.

### 4.6 Data protection — Persistence Baseline Gate

Applies to Marketplace installs, compose up/recreate/pull, workload transfer,
Agent updates, and any R2+ runbook. Mandatory for every `production` scope.

1. **Pre-change baseline** (read-only): for each datastore in the affected
   graph slice — volume name, driver, mountpoint, size, file count (bounded),
   ownership of top-level dirs; SQLite: Alembic/schema revision, owner identity
   hash, per-table row counts for adapter-declared "workspace" tables,
   `PRAGMA integrity_check` (read-only copy when needed); Qdrant: collections +
   point counts; protected config keys (names + value hashes).
2. **Post-change verification:** same capture; diff against declared
   expectations (`unchanged`, `grow-only`, `may-change`).
3. **Outcome:** `VERIFIED` only if every invariant holds and every functional
   probe passes. Otherwise `DATA_DRIFT_DETECTED` with typed findings:
   `VOLUME_REPLACED`, `VOLUME_MISSING`, `IDENTITY_CHANGED`,
   `WORKSPACE_OBJECTS_MISSING`, `MIGRATION_REVISION_REGRESSED`,
   `COLLECTION_MISSING`, `PERMISSION_DRIFT`, `UNINSPECTABLE`.
4. A deployment/repair with `DATA_DRIFT_DETECTED` is never shown as
   successful; rollback is proposed and needs its own approval for R3+.

### 4.7 Visual Operations Center

Extends the existing **Network** and **Notifications** pages and the node
details drawer (no redesign, ADP UI rules apply):

- **Topology:** infrastructure graph view (filter by node/service; color by
  combined health/functional state; dashed edges for `inferred`; production
  scopes marked).
- **Service health board:** two columns per service — *Health* and *Functional*.
- **Incidents:** open/closed, root cause hypothesis, linked runbook attempts.
- **Approval queue (desktop only, D5):** plan card showing exact steps,
  targets (with verified identity, not just port), risk class, production
  scope, preconditions, verification, rollback, precedent summary,
  Sentinel-pattern rule findings, plan hash, expiry. Approve / Reject /
  Modify-and-approve (modification re-hashes the plan).
- **Repair history & replay:** step-by-step timeline from long-operation logs
  + audit + before/after baseline diffs; redacted screenshots attached only
  when they came from an acceptance run. Replay is a *read-only re-render* of
  recorded evidence, never re-execution.
- **Mobile (D5):** incidents may be *viewed* read-only (through the read-only
  Facts API); mobile never shows approve/reject controls in V2.
- Polling: tab-activation and drawer refresh only (existing rule); live updates
  through the notification scheduler.

### 4.8 Autonomy levels

Per scope (node, service, or service class), default **L1**:

| Level | Name | CC may do without asking | V2 status |
| --- | --- | --- | --- |
| L0 | Observe | Inventory, probes, telemetry. No incidents opened automatically. | In scope |
| L1 | Diagnose | + Open incidents, run deterministic diagnosers, request delegated diagnosis (from AIM-6). | In scope |
| L2 | Recommend | + Produce runbook plans and approval cards. Executes only what the Owner approves **per action**. | In scope — **V2 ceiling** |
| L3 | Repair (bounded) | + Automatically execute scoped, revocable, low-risk (R1) runbooks. | **Reserved** for a future, separately approved policy change (D3) |
| L4 | Repair + Verify (extended) | + Automatically execute scoped R2 runbooks on non-production scopes. | **Reserved** for a future, separately approved policy change (D3) |

"Repair" and "Verify" from the requested Observe → Diagnose → Recommend →
Repair → Verify ladder are delivered within the V2 ceiling: at L2 an approved
plan is executed by CC and verified automatically. What is reserved is
**execution without a per-action approval**, not repair itself.

Verification is not a level — it is **mandatory for every executed action**.

#### D3 — V2-L approval policy preserved (resolved)

Existing policy, which this plan does not change:

- `MASTER_ROADMAP.md` §6A.2, V2-L: "AI assistance must remain advisory; no
  repair action executes without explicit user approval, and diagnostics must
  use existing redaction rules."
- V2-M: destructive actions must respect V2-I permissions and require
  confirmation policies.
- ADP Approval Matrix (`AGENTS.md`): restarting an application or service
  when it may disrupt work requires explicit approval.

Resolution (OWNER, 2026-10-14):

1. V2 preserves V2-L's **per-action approval** requirement: every repair
   execution above R0 requires an explicit, desktop, per-action Owner approval
   bound to the plan hash (§5.3). AI/agent output is advisory only.
2. Scoped, revocable, low-risk automatic repairs (L3/L4) are **reserved** for a
   future, separately approved policy change. That change would have to amend
   V2-L in `MASTER_ROADMAP.md` and settle how the ADP restart rule applies to
   automated restarts before any design or implementation (AIM-5b).
3. The existing bounded automatic restart of managed instances
   (`RECOVERY_MODEL.md`) predates this plan, is instance lifecycle rather than
   an AIM runbook, and is unchanged.

---

## 5. Risk and permission model

### 5.1 Risk classes

| Class | Definition | Examples | V2 (V2-L preserved) | Reserved future policy change (not in V2) |
| --- | --- | --- | --- | --- |
| R0 | Read-only | Probes, inventory, log read | Automatic | Automatic |
| R1 | Reversible, no persistent-data contact, bounded interruption of a stateless component | Restart stateless container; restart crashed managed instance | Per-action approval | Possible scoped, revocable automation (L3) |
| R2 | Reversible but interrupts a stateful service | Restart Qdrant / Open WebUI container | Per-action approval | Possible scoped automation on non-production only (L4) |
| R3 | Touches configuration or persistent data; requires verified backup + dry-run | Reconfigure terminal connection; restore a volume; additive DB merge | **Per-action approval** with verified backup and rollback plan | Unchanged — always approval |
| R4 | Destructive, irreversible, security/network-boundary, or insufficiently understood | Prune/delete volumes, `down -v`, credential/cert/signing/firewall/public-exposure changes, unknown root cause | **Manual only** — CC presents instructions; never executes | Unchanged — manual only |

**Outside the R0–R4 classes:** AnxGraph decision-record writes (§4.3) are not
infrastructure actions and are not repairs. They are append-only records
under a separate, Owner-granted, standing AnxGraph grant, so they need no
per-action approval. They cannot change any infrastructure target, approval or
policy decision, and are not an approval bypass.

Unknown root cause or `not-evaluated` precondition ⇒ **escalate one class**.
Any step without a tested rollback ⇒ minimum R2. Any target on a `production`
scope (§5.6) ⇒ verified backup and baseline gate required from R2 upward.

### 5.2 Policy decision (composition, strictest wins)

```
decision = strictest(
  levelAllows(scope.level, runbook.riskClass),       // V2 ceiling: L2
  riskClass == R0 ? allow : APPROVAL_REQUIRED,       // V2-L preserved (D3)
  riskClass == R4 ? MANUAL_ONLY : allow,
  dockerPolicy / workloadTrustPolicy outcome,        // existing hard floor
  sentinelPatternRules(plan),                        // CC-native: SAFE ⇒ allow,
                                                     //   REVIEW ⇒ approval, BLOCK ⇒ REFUSED
  (scope.production && riskClass >= R2)
    ? requireVerifiedBackupAndBaselineGate : allow,  // unclassified ⇒ production (D4)
  targetIdentityVerified ? allow : REFUSED,          // CL9: never by port alone
  circuitBreaker.state,                              // open ⇒ REFUSED
  killSwitch ? REFUSED : allow
)
precedent → display/ranking only; never an input to `decision`.
```

### 5.3 Approvals

- Bound to `planHash` (runbook id@version, params, full target identity tuples
  per §5.7, node ids, baseline id, step preconditions, and the declared
  rollback steps) — the AnxCorTex HQ content-hash pattern. Any change
  invalidates the approval, and execution re-verifies the bound values before
  every step (§5.4).
- **What "per-action" means.** The approved unit is **one plan**: a fixed,
  ordered list of steps plus its declared rollback steps, every one of which is
  shown on the approval card with its exact target identity. One approval
  authorizes exactly that plan once. It never covers a step, target, parameter
  or rollback step that was not on the card; adding or changing anything
  requires a new plan and a new approval. This is consistent with V2-L's
  per-action approval and with the plan-approval model the roadmap describes
  for V2-O.
- Expire (default 15 min) and are single-use.
- **Desktop only in V2 (D5):** require an interactive Local Owner session in the
  desktop app (existing guard). Mobile is read-only for incidents; secure
  mobile approval is a separate future milestone (AIM-M).
- Rejections require a reason code (recorded as precedent evidence).

### 5.4 Execution safety

- **Execution-time re-verification (no time-of-check/time-of-use gap).**
  Immediately before **every** step — including every rollback step — CC
  re-resolves each target's identity (§5.7) and re-evaluates the step's
  preconditions, then compares both with the values bound into the approved
  plan hash. Any mismatch (container recreated, volume replaced, listener
  owner changed, host identity changed, precondition no longer true) stops the
  plan: the step is refused, no automatic retry or re-targeting occurs, the
  incident records `TARGET_IDENTITY_CHANGED` or `PRECONDITION_CHANGED`, and a
  new plan with a new approval is required. A failed re-verification during
  rollback is escalated to the Owner as manual-only.
- **Execution only against verified immutable IDs.** Every Agent call made by
  an AIM step addresses its target by the immutable identifier bound in the
  plan — the full 64-hex Docker container ID, the AnxOS instance id, or the
  volume name checked against its recorded creation timestamp — never by a
  container name, compose service name, display name or port. Because the
  current Docker action resolves `target.container` as either a name or an ID
  (`agent/src/actions/dockerActions.js`, via `docker container inspect`), the
  CC-side re-verification alone leaves a gap between check and call. AIM-5
  therefore adds an **Agent-side expected-identity guard**: the call carries
  the expected immutable ID **and the expected host identity** (`deviceId`,
  `agentInstallationId`, `agentIdentityGeneration`, §5.7). The Agent compares
  both with what it resolves at execution time on its own node, and refuses
  with `TARGET_IDENTITY_CHANGED` on any mismatch or on any target given only as
  a name. For the instance restart route the instance id is the path
  parameter, so comparing it alone would always match; the host-identity
  comparison is therefore mandatory there, together with a check that the
  instance record exists on that host.
- **Least-privilege Agent credential built on V2-I scoped Agent tokens.** The
  credential used for approved executions is a scoped token from the existing
  V2-I mechanism (roadmap V2-I bullet "Scope service/API tokens"), not a new
  token system: e.g. `docker:read`, `docker:write` restricted to catalog-runbook
  targets where the scope model allows, no `files:write`, no `agent:manage`, no
  `backups:restore`. The Owner wildcard is never used by AIM.
- `longOperationService` lockKey per target (`autonomy:<node>:<target>`),
  timeouts, `interrupted` on restart — never silently resumed.
- Circuit breaker per runbook×scope: 3 consecutive failed verifications ⇒ open, quarantine,
  notify (Agent Office immune-system rule).
- Global rate limit (default ≤ 6 executed repair actions/hour/node) and
  per-target cooldowns.
- **Kill switch** in Settings (Owner-only) and on the Operations page. On
  activation, immediately:
  1. sets all scopes to L1 and revokes every unexpired approval;
  2. cancels every queued plan and every not-yet-started step — **no new step,
     including any rollback step, starts after activation**;
  3. lets an Agent call already in flight finish (Agent actions are not
     interruptible mid-call), then runs only the read-only post-step
     verification for it and records the result;
  4. marks each interrupted plan `HALTED_BY_KILL_SWITCH` and, where that leaves
     a target changed or unverified, raises a manual-only incident with any
     declared rollback presented as instructions for the Owner.
  Releasing the kill switch does not resume halted plans; each needs a new
  plan and approval.
- All evidence passes `redaction.js`; outbound adapter payloads are
  allow-list serialized (only declared fields leave the process).

### 5.5 Protected assets (never automated)

Persistent volumes' contents, credential stores (`security.json`, node
credentials, `.env*` files, API keys), certificates/signing config, firewall and
public-access/tunnel configuration, GitHub workflows, the installed AnxOS
application itself, and anything under `Credentials-SECURE`.

### 5.6 Production protection scopes (D4, resolved)

The **production** list below was accepted by the Owner on 2026-10-14. **Any
scope that is not on the accepted production list and has not been verified
and Owner-confirmed as non-production is treated as `production`.** Scopes are
bound to verified target identity (§5.7), never to a port alone (CL9); ports
below are identification aids only.

**Production (accepted):**

| Scope | Notes |
| --- | --- |
| Debian **ANX-CorTex** production (port `8090`) and its `anx-cortex-m5` data volume | Port corrected by the Owner; corroborated by the CorTex Cloudflare tunnel config. |
| Recovery-stack **Open Terminal** (`127.0.0.1:18000`) | Now used by production ANX-CorTex (C4) despite its "recovery" name. |
| Recovery **Qdrant** volume (`anx-cortex-recovery-qdrant-data`) | Holds the verified recovered vectors (C3). |
| Original **Windows Qdrant volume** and its backups | Source of record for the recovered vectors. |
| **AnxGraph** production runtime | Staging (`:7385`) is only a proposed non-production candidate (below). |
| **AI-BOX volumes** | All named volumes of the AI-BOX stack. |
| Both **Ollama nodes** | |
| **AMP** (port `8080`) | |
| **Cloudflare tunnel** for ANX-CorTex | Also a protected asset (§5.5). |
| Installed **AnxOS Control Center** application | Also a protected asset (§5.5). |
| **AnxOS Agent** on every node | |

**Proposed non-production candidates (NOT accepted; treated as `production`
until verified):**

These candidates were recommended but have **not** been accepted by the Owner,
and their identities are unverified (the staging ports come from the M5
handoff, whose production-port record proved wrong for Debian). Each remains
`production` until AIM-0 verifies its identity (§5.7) read-only and the Owner
confirms the classification.

| Candidate | Notes |
| --- | --- |
| M5/M6 staging (recorded as ANX-CorTex `:8081`, AnxGraph `:7385`) | Host and identity unverified. |
| ANX AgentOS prototype (`127.0.0.1:4871`) | Experimental (D1). |
| QA fixture roots | e.g. `Documents\AnxCorTex-QA`. |
| Disposable AIM test stacks | Must be created for AIM acceptance, identity-recorded at creation, and confirmed by the Owner before being treated as non-production. |

Effect under preserved V2-L: every repair above R0 needs approval regardless of
scope; the `production` tag adds mandatory verified backups and the baseline
gate from R2 upward, stronger approval-card warnings, and exclusion from any
future reserved automation.

### 5.7 Target identity (CL9)

A target is **verified** only when every applicable identity component below
was observed by the AnxOS Agent on the target's own node during the current
inventory refresh. Ports and display names are **hints only** and never
identify a target.

| Target kind | Identity components (all required) | Identity changes when |
| --- | --- | --- |
| Host / node | Agent `deviceId` + `agentInstallationId` + `agentIdentityGeneration` — **all three required** (`agent/src/services/deviceIdentityService.js`) | Any component differs. `agentIdentityGeneration` rotates on re-pairing or credential rotation, so either invalidates every outstanding plan and approval for that host (fails closed). |
| Managed instance (AnxOS instance record) | Host identity + AnxOS instance id | The instance record is removed or recreated, or it moves to another host. Its process ID is **not** part of the identity; a restart is expected to change it. |
| Docker container | Host identity + compose project + compose service (or container name when not compose-managed) + **container ID** | The container is recreated (new ID), renamed, or moved to another project/service |
| Docker volume | Host identity + volume name + volume creation timestamp (+ driver) | The volume is removed and recreated, even with the same name |
| Compose project | Host identity + project name + project working directory/config path | Path or name changes |
| Other non-container process (e.g. AMP, host Ollama) | Host identity + executable path + process ID + process start time | Any component changes (so any restart of the process is an identity change). Today `networkInventoryService` attributes listeners by process ID and process name only; **executable path and start time are not collected yet** (added in AIM-1, confirmed obtainable in AIM-0 item 6). Until all four components are collected, these processes are `unverified` and **read-only**: no plan above R0 can target them. No V2 catalog runbook targets them. |
| Datastore (SQLite file, Qdrant collection) | Identity of the containing volume/container + path or collection name | The containing target's identity changes |

Rules:

- Plans and approvals bind the full identity tuple of every target (§5.3).
- Execution re-resolves the tuple before every step (§5.4); any difference is
  `TARGET_IDENTITY_CHANGED`.
- A target that cannot be fully resolved is `unverified`: R0 reads may show it,
  but no plan above R0 can be produced for it.
- A step that intentionally changes a target's identity (for example a compose
  recreate) must declare the expected post-step identity rule in the runbook,
  and that rule is bound into the plan hash. Later steps re-verify against the
  declared new identity; an undeclared change is `TARGET_IDENTITY_CHANGED`. The
  initial catalog (§4.5) contains no identity-changing steps; adding one is a
  reviewed catalog change.
- Scope classification (§5.6) attaches to the identity tuple, not to a port or
  name; a recreated target keeps its *protection* classification only through
  an explicit compose-project/service or volume-name mapping confirmed by the
  Owner, and otherwise becomes unclassified (⇒ `production`).

---

## 6. Verification and rollback strategy

| Layer | Verification | Rollback |
| --- | --- | --- |
| Every executed step | Before the step: re-verify target identity and preconditions against the plan hash (§5.4). After the step: re-run the detecting probe + the service's functional contract; compare to pre-step baseline | Declared rollback steps are part of the approved, hashed plan and shown on the approval card; they run without a second approval only for R1/R2, only if the rollback is itself tested, and only after the same identity re-verification passes; R3 rollback needs its own approval |
| R1 restart | Container running + health + functional probe within deadline | Not applicable (restart is idempotent); failure ⇒ incident escalates to R2 recommendation |
| R2 restart of stateful service | Baseline invariants `unchanged`; functional probe pass | None needed if invariants hold; drift ⇒ stop, escalate to R3 with restore proposal |
| R3 config change | Config hash matches plan; dependent functional probes pass | Restore previous config from pre-change snapshot (taken by the runbook); verify |
| R3 data restore | Existing backup restore contract (safety snapshot, partial-restore rollback, `RESTORE_ROLLBACK_FAILED` reported separately) | Existing backup service rollback |
| Deployment (Marketplace/compose) | Persistence Baseline Gate + functional contracts | Proposed rollback plan (previous compose config, volume snapshot if taken); approval required. Rollback to a **previous image digest** is **not an implemented capability**: controlled image rollback is an open Owner decision under roadmap V2-C. Until that decision and a tested implementation exist, a plan may only list it as a manual instruction and never declares `rollbackSupported` for it. |
| Autonomy framework itself | Hermetic smokes (no Docker engine required) for policy decisions, circuit breakers, plan hashing, redaction of packets | Kill switch; disable feature flag; all new stores versioned with future-schema refusal (`CONFIG_MIGRATIONS.md` pattern) |

`rollbackSupported` honesty from `OPERATION_FRAMEWORK.md` applies unchanged:
a runbook may declare rollback only with regression coverage proving it.

---

## 7. Phased milestone roadmap

Complexity: **S** ≈ ≤1 week, **M** ≈ 1–3 weeks, **L** ≈ 3–6 weeks, **XL** > 6
weeks of focused work (single developer + agents; estimates are PROPOSED and
low-confidence until AIM-0 completes).

### 7.0 Roadmap entry prerequisites

`MASTER_ROADMAP.md` §6A.4 leaves V2-L/V2-M sequencing undecided. These AIM
milestones therefore carry their own entry gates against the existing roadmap
tracks (status as recorded in `MASTER_ROADMAP.md` on 2026-10-14):

| Gate | Roadmap dependency | Recorded status | Required before |
| --- | --- | --- | --- |
| P1 | **V2-A** job lifecycle, identity and Agent foundation (V2-M "Requires V2-A job lifecycle") | Implemented; acceptance PARTIAL | **AIM-4** — V2-A acceptance gaps relevant to job lifecycle and Agent identity closed or explicitly accepted by the Owner |
| P2 | **V2-I** role/resource-scope permissions and **scoped Agent tokens** | Partial: scoped tokens ship; session revocation, credential rotation and protected recovery remain partial; acceptance not verified | **AIM-5** — scoped-token enforcement verified for the AIM credential, and the open revocation/rotation items closed or explicitly accepted by the Owner |
| P3 | **V2-C** Docker policy gate and volume protection | Partial (lifecycle, policy gate, volume protection, preflight shipped) | **AIM-5** — policy gate and volume protection covered by the AIM runbook actions |
| P4 | **V2-J** health unification, correlation IDs, redacted diagnostics, alerts | Partial; acceptance not verified | **AIM-2** — health vocabulary and alert surfacing reused as-is |

No AIM milestone changes these roadmap tracks; a failed gate blocks only the
dependent AIM milestone.

### AIM-0 — Discovery & contracts (S)
- D1–D5 are resolved (§10). Remaining work is read-only contract pinning and
  identity verification. One contract document per integration, each covering
  fields, **authentication**, rate limits and failure modes:
  1. **Agent Office** — `/api/mcp` and `/api/snapshot` schemas **and its caller
     authentication model** (prerequisite for the AIM-6 adapter, §3.2).
  2. **AnxGraph read actor** — consumer delivery API for precedent reads.
  3. **AnxGraph writer actor** — whether a dedicated, append-only,
     project-scoped writer actor is supported, and the Owner grant workflow
     (prerequisite for AIM-7, §4.3).
  4. **AnxLabs Sentinel v0.1 rule set** — mapped to CC-native rule tables
     (patterns only, no runtime).
  5. **AnxLabs HQ** — record of `ports.ts`, `anxlabs-hq/execution@1` and
     `TaskSyncPort` at `2d3c9e4`, for AIM-6b; re-checked when AIM-6b is scheduled.
  6. **Target identity** — confirm each §5.7 identity component is
     obtainable from the Agent on Windows and Debian, including executable
     path and process start time for non-container processes (not collected
     today), the full container ID for every container, and the volume
     creation timestamp; and confirm the Agent-side expected-identity guard
     design for `docker.restart` and the instance restart route (§5.4).
- Verify the §5.6 production scopes and the proposed non-production candidates
  against live identities (§5.7), including the `8090`/`8080` assignment.
- **Acceptance:**
  - All six contract documents exist and are **signed off by the Owner**.
  - Any live check of production systems is **read-only and approved by the
    Owner beforehand**; no production data or configuration is changed.
  - Every accepted production scope is mapped to a verified identity tuple, or
    remains `production` with the gap recorded.
  - Each non-production candidate is either verified and **Owner-confirmed**
    as non-production, or remains `production`.
  - No code changes.
- **Depends on:** Owner availability; no ANX-CorTex disruption.

### AIM-1 — Inventory graph, read-only (M)
- Agent `GET /api/v1/inventory`; GPU probe (Windows/AMD first, then NVIDIA/ROCm
  on Debian); desktop `infrastructureInventoryService`; `infraGraphModel.js`
  carrying §5.7 identity tuples and protection scope on every node.
- **Acceptance:**
  - **Live-run rule:** every live inventory run on the Windows host or the
    Debian node is read-only and approved by the Owner beforehand; no
    acceptance step in AIM-1 changes any live target.
  - On the Windows host and the Debian node, the graph lists every running
    container, volume, network, compose project, listening port (attributed to
    process/container), and GPU with VRAM — reconciled against
    `docker ps/volume ls/network ls` and `ss`/`netstat` output captured in the
    same run (100% match, documented).
  - Every target carries a complete §5.7 identity tuple or is marked
    `unverified`; ANX-CorTex is attributed to `8090` and AMP to `8080` on
    Debian by identity, not by assumption.
  - Recreating a container or volume produces a different identity tuple —
    proven on a hermetic fixture, or on a disposable stack that was
    identity-recorded at creation and Owner-confirmed as non-production, with
    Owner approval for the run. Never on any other target.
  - An unavailable Docker engine renders `unavailable:<reason>`, never empty.
  - Unclassified and unconfirmed scopes render as `production`.
  - No secret value appears in graph JSON (secret-boundary smoke extended).
  - Agent CPU overhead of an inventory refresh < 2 s CPU, cached 30 s.
- **Depends on:** AIM-0.

### AIM-2 — Functional contracts & dual health (M)
- `functionalProbes` capability; adapters for Open WebUI, Qdrant, Ollama,
  Infinity, Tika, Open Terminal; dangling-dependency detection from config
  references; declared expected dependencies; UI shows Health vs Functional.
- **Acceptance:**
  - Fixture replays of C1, C3, C4, C6 (hermetic stubs) produce
    `WORKSPACE_OBJECTS_MISSING`/`IDENTITY_CHANGED`, `AUTH_INVALID` vs
    `COLLECTION_MISSING` vs `NOT_WIRED`, `DANGLING_DEPENDENCY`, and
    `not-in-use` respectively, while liveness reports healthy.
  - One live read-only run against an ANX-CorTex scope that AIM-0 verified and
    the Owner confirmed as **non-production**, using a read-only account, with
    Owner approval for the run. If no such scope is confirmed, this criterion is
    deferred and recorded, never run against production.
  - `not-evaluated` never renders green (no-fake-green smoke extended).
- **Depends on:** AIM-1; gate P4; a read-only service account in ANX-CorTex (user-created).

### AIM-3 — Persistence Baseline Gate (M)
- Baseline capture/diff service; integrate into Marketplace install, compose
  up/recreate/pull, workload transfer.
- **Acceptance:**
  - Hermetic smoke: replacing a volume, changing the owner identity, dropping
    rows, regressing a schema revision, removing a Qdrant collection each
    produce the correct typed finding and block "success".
  - A clean redeploy of a disposable AIM test stack — created for this purpose,
    identity-recorded at creation and Owner-confirmed as non-production — yields
    `VERIFIED` with zero false positives across 10 consecutive runs on the
    Debian node, **with Owner approval for the runs** obtained beforehand. No
    redeploy touches any production scope.
  - Baseline capture is read-only (verified by file mtime/hash checks on
    fixtures) and bounded in time (< 30 s for the AI-BOX stack).
- **Depends on:** AIM-2.

### AIM-4 — Incidents, runbooks, policy (Recommend only) (L)
- `incidentService` (correlation by graph ancestry), `runbookCatalog`,
  `autonomyPolicyService` with CC-native Sentinel-pattern rule tables, plan
  hashing over §5.7 identity tuples, desktop approval queue UI, kill switch,
  V2-I scoped credential for AIM, audit actor types, production-scope
  enforcement. Levels L0–L2 only.
- **Acceptance:**
  - Policy decision table pinned by hermetic smoke covering every
    level × risk × trust × production × Sentinel-pattern × breaker ×
    identity-verified combination.
  - Modified plans invalidate approvals; expired approvals refuse.
  - A plan whose target lacks a complete §5.7 identity tuple is refused (CL9).
  - One root-cause failure (volume missing) yields one incident, not N.
  - No action executes without approval (verified by Agent request log in smoke).
- **Depends on:** AIM-1–3; gate P1; existing permission matrix (`test-helpers/permission-matrix.js`).

### AIM-5 — Approved repair + verify (L2 ceiling) (L)
- Execute **per-action approved** R1/R2/R3 runbooks via the §4.5 mapped Agent routes;
  execution-time identity and precondition re-verification (§5.4);
  verification loop; circuit breakers; rollback for declared steps; replay
  view. No execution path exists without a valid, unexpired, plan-hash-bound
  desktop approval. Diagnosis remains deterministic.
- **Acceptance:**
  - Disposable, Owner-confirmed non-production test stack on Debian: kill a
    stateless container → detected, recommended, **approved**, restarted,
    verified within deadline, recorded.
  - With no approval, or an expired or plan-mismatched approval, nothing
    executes (verified by the Agent request log).
  - **Identity race test:** after approval and before execution, the target
    container is recreated (new container ID) → the step is refused with
    `TARGET_IDENTITY_CHANGED`, nothing is sent to the new container, and no
    retry occurs. The same holds for a rollback step.
  - **Precondition race test:** a precondition is invalidated after approval
    → `PRECONDITION_CHANGED`, step refused.
  - Stateful restart passes the baseline gate with `unchanged`.
  - Forced verification failure ×3 opens the breaker and quarantines the runbook.
  - **Agent-side identity guard test:** a step whose expected container ID,
    instance id **or expected host identity** does not match what the Agent
    resolves on its node is refused by the Agent with
    `TARGET_IDENTITY_CHANGED`; a step that names a container only by name is
    refused; an instance restart sent to a different host (or after that
    host's `agentIdentityGeneration` rotated) is refused even though the
    instance id matches; none of these reaches Docker or the instance lifecycle.
  - Only catalog runbooks mapped to implemented Agent routes can be planned; a
    runbook referencing an `implemented: false` action is rejected at catalog
    load.
  - **Kill switch test:** activation during a multi-step plan → no further step
    or rollback step starts; the in-flight Agent call completes and gets its
    read-only verification; the plan is `HALTED_BY_KILL_SWITCH`; all approvals
    are revoked; releasing the switch does not resume the plan.
- **Depends on:** AIM-4; gates P2 and P3. **Requires user approval to run against any real stack.**

### AIM-5b — Scoped automatic low-risk repair (L3/L4) — RESERVED, not scheduled
- Reserved for a future, separately approved policy change to V2-L (D3). No
  design or work is planned in this document.

### AIM-6 — Diagnosis adapter and read-only Facts API (M–L, can overlap AIM-5)
- Target-neutral **diagnosis adapter**, implemented first for **Agent Office**
  (read-only diagnosis tasks, structured proposals only), consuming AIM-4
  incident packets and validating proposals against the AIM-4 runbook catalog.
- Read-only Infrastructure Facts API for COMBO'S, AnxLabs HQ, and read-only
  mobile incident viewing.
- **Acceptance:**
  - The Agent Office adapter stays disabled unless the AIM-0 Agent Office
    contract shows caller authentication in both directions; a test confirms
    unauthenticated requests or responses are refused.
  - Proposals naming unknown runbooks or containing free-form commands are
    rejected and audited (adversarial fixture set).
  - The adapter contract has no Agent Office-specific fields (target-neutral,
    pinned by a contract test with a stub second target).
  - With Agent Office offline, CC behaves identically except for the absence
    of delegated hypotheses (degraded, not failed).
  - Outbound payloads contain only allow-listed fields (secret-boundary smoke).
  - The Facts API is authenticated and exposes no approve/reject capability.
  - The Facts API rate limit is enforced: requests above the configured rate
    are refused with a typed error and do not trigger extra inventory or probe
    work on any node.
- **Depends on:** AIM-0 (Agent Office contract), AIM-4 (incident packets,
  runbook catalog, approval queue).

### AIM-6b — Migrate diagnosis adapter to authenticated AnxLabs HQ — later, separately scheduled
- Prerequisite: AnxLabs HQ provides an authenticated, server-side intake
  (none exists today). Same contract as AIM-6; Agent Office adapter retired
  only after HQ passes the AIM-6 acceptance set.
- **Depends on:** AIM-6.

### AIM-7 — Learning loop (AnxGraph precedent) (M)
- Decision records, precedent reads, track-record display; operator
  corrections captured. Store: AnxGraph via the read actor and the Owner-granted
  append-only writer actor (§4.3). An EIDOLON backend is a later, separately
  approved integration once EIDOLON exists.
- **Acceptance:**
  - The writer actor holds only append capability in its own project scope;
    attempts to correct, delete, export or read outside scope are refused.
  - Negative-capability tests (correct/delete/export/out-of-scope read), and
    the decision-record write test, run only against a hermetic AnxGraph stub
    or an AnxGraph instance verified in AIM-0 and Owner-confirmed as
    non-production, with Owner approval for each run; never against
    production AnxGraph.
  - Every approval/rejection/modification produces a redacted decision record.
  - Approval cards show precedent with source ids; precedent never changes a
    policy decision (pinned by smoke).
  - A rejection or failed verification is shown with at least the same
    prominence as successes.
  - With AnxGraph offline, approvals and executions are unaffected (precedent
    shown as unavailable).
- **Depends on:** AIM-5; AIM-0 items 2–3 confirmed; Owner grants of the
  CC-specific read consumer and the writer actor. If the writer actor is not supported or not granted, AIM-7 is blocked
  and returned to the Owner (§4.3).

### AIM-M — Secure mobile approval — future milestone, not scheduled
- Separate security design (device binding, step-up authentication, plan-hash
  display, replay/phishing resistance) and separate approval (D5). Not part of V2.

### Sequencing

```
AIM-0 ─► AIM-1 ─► AIM-2 ─► AIM-3 ─► AIM-4 ─► AIM-5 ─► AIM-7
                                      └────► AIM-6 ─ ─► AIM-6b (later)
AIM-0 contract gates: Agent Office auth → AIM-6 · AnxGraph writer actor → AIM-7
Roadmap gates:        P4 → AIM-2 · P1 → AIM-4 · P2, P3 → AIM-5
Reserved, unscheduled: AIM-5b (needs V2-L policy change), AIM-M (mobile approval)
```

AIM-6 and AIM-7 are independent of each other: diagnosis delegation does not
use precedent, and precedent does not use delegation.

Recommended earliest value: **AIM-1 → AIM-3** are read-only and directly
prevent a repeat of the ANX-CorTex incident; they need no execution at all.

---

## 8. Feature reuse vs. missing capabilities

| Requirement | Reuse (existing) | Missing (to build) |
| --- | --- | --- |
| Discovery | dockerService (containers/volumes/networks/compose), networkInventoryService, systemService, computerService, endpointStore | GPU inventory, port→container attribution, unified graph model, service recognition adapters, scope tagging |
| Health vs correctness | healthModel, instance readiness, connectivity diagnostics, no-fake-green contract | Functional probe capability + adapters, dangling-dependency checks, expected-dependency declarations |
| Self-healing | actionRegistry/actionRouter, longOperationService, bounded instance restart, backup restore rollback, audit | Incident correlation, runbook catalog, policy service, approval queue, verification loop, breakers |
| Learning | AnxGraph delivery API; Agent Office immune/learning patterns | Decision-record contract, AnxGraph writer actor, precedent query |
| Agent delegation | Agent Office (Vera, MCP) | Target-neutral incident packet / proposal contract and validator; Agent Office adapter |
| Visual Ops | Network/Notifications pages, connectivity graph renderer, node drawer | Topology view, desktop approval queue, incident view, replay, read-only Facts API |
| Data protection | backup verify/restore, dockerPolicy volume confirmation, config migration backups | Baseline capture/diff, identity invariants, Qdrant/SQLite adapters |
| AnxLabs | COMBO'S read adapters (pattern), AnxCorTex HQ approval-hash pattern, AnxLabs Sentinel rule patterns, AnxGraph | Facts API, CC-native Sentinel-pattern rule tables, HQ migration prerequisites |
| Autonomy levels | Agent Office `levels.js` vocabulary (pattern), dockerPolicy/workloadTrust floor | Per-scope level store (L0–L2), kill switch |

---

## 9. Dependencies, resources, and risks

### 9.1 Resource budget (existing AnxLabs hardware)

- Inventory: on demand + 30 s cache; background refresh ≤ every 5 min.
- Functional probes: every 5 min for monitored services, jittered; generation
  probes (GPU) **on demand only**. Scheduled probes against a `production`
  scope run only after the Owner **opts in for that scope**; until then that
  scope is probed on demand only. Opting in is reversible and recorded in audit.
- No always-on LLM. Delegated diagnosis (from AIM-6) uses Agent Office's local
  pool and is triggered only for incidents the deterministic diagnosers cannot
  classify.
- Target added steady-state footprint: Agent < 1% CPU avg, < 50 MB RSS;
  desktop < 100 MB additional heap; stores bounded with retention like
  `telemetry.json` / `notifications.json`.

### 9.2 Principal risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Execution on a misdiagnosis | Data loss / outage | Per-action approval; R-class escalation on unknown cause; verification + breakers; R4 never executed |
| Agent token over-privilege | Lateral damage | Least-privilege V2-I scoped token (§5.4); gate P2 before AIM-5 |
| Prompt injection via logs/agent output | Arbitrary action | Agents can only name catalog runbook ids with typed params; outputs treated as data |
| Precedent drift ("it was approved before") | Silent permission creep | Precedent excluded from policy decision by construction + smoke |
| Scope/port misidentification (e.g. `8080` AMP vs `8090` ANX-CorTex) | Wrong service targeted | Identity-bound scopes and plan hashes (CL9); unclassified ⇒ production; AIM-1 identity reconciliation |
| Agent Office adapter becomes throwaway when HQ replaces AO | Rework | Target-neutral contract; migration milestone AIM-6b |
| Delegation targets without caller auth (AnxLabs HQ, AnxCorTex HQ, AgentOS; Agent Office unverified) | Spoofed proposals; incident data sent to an impersonating listener | No runtime integration — including the Agent Office adapter — until caller authentication is verified in AIM-0; proposals still limited to catalog runbook ids and Owner approval |
| Target changes between approval and execution (TOCTOU) | Approved action hits a different container/volume | Identity tuples bound into the plan hash (§5.7) and re-verified before every step and rollback (§5.4); mismatch ⇒ refuse, no retry |
| Writes into production AnxGraph | Corruption or pollution of authoritative memory | Writer actor only if supported and Owner-granted; append-only, own project scope, outside repair path; otherwise AIM-7 blocked (§4.3) |
| Unverified non-production classification | Production treated as test target | Candidates stay `production` until AIM-0 verifies identity and the Owner confirms (§5.6) |
| Probe credentials leak | Credential exposure | Secure store only; secret-boundary smokes; redaction |
| Probe load on GPUs/services | Performance | On-demand generation probes, jitter, caps |
| False "verified" | Repeat of C1 | Baseline gate + functional contracts; `not-evaluated` ≠ green |
| Scope creep into orchestration | Project risk | No new runtime/bus/agent; catalog grows only through reviewed runbooks |
| ANX-CorTex disruption | Priority work blocked | Changing tests only on Owner-confirmed non-production or Owner-confirmed disposable stacks, each run Owner-approved; production checks read-only with prior Owner approval |

---

## 10. Decision register (resolved by the Owner, 2026-10-14)

All five decisions are resolved. They govern this plan; they do not authorize
implementation, freezing, or committing.

| ID | Question | Decision (OWNER) | Consequences in this plan | Status |
| --- | --- | --- | --- | --- |
| D1 | Identity and interfaces of EIDOLON, AgentOS, Sentinel; access to the REMOTE-ONLY repos | **EIDOLON** is planned, not implemented; **AnxGraph** is the precedent store. **AgentOS** remains experimental until accepted and authenticated. **Sentinel:** reuse policy patterns without coupling to an unverified runtime. **Read-only scratch clones** of `AnxLabs-HQ` and `Sentinel` approved; no execution or modification. | §1.2 (EIDOLON ⇒ PLANNED; clones inspected at `2d3c9e4` / `fa896d5`, no local changes); §3.2 (no EIDOLON, AgentOS, or Sentinel runtime integration); §4.3 (AnxGraph store; writer access is an unverified, Owner-granted, append-only prerequisite — if unavailable AIM-7 is blocked, no alternative store); §5.2 (CC-native Sentinel-pattern rules); AIM-0 items 2–4, AIM-4, AIM-7. | **RESOLVED** |
| D2 | Default owner of delegated diagnosis | **Deterministic diagnosis through AIM-5.** Plan a **target-neutral Agent Office diagnosis adapter for AIM-6**, with **migration to authenticated AnxLabs HQ later**. | §3.1, §3.2, §4.4; AIM-0 item 1 (Agent Office contract incl. authentication); AIM-6 (adapter enabled only with verified caller authentication; target-neutral contract test); AIM-6b (HQ migration, prerequisite: authenticated server-side intake). | **RESOLVED** |
| D3 | May V2 execute any repair without per-action approval? | **Preserve V2-L's per-action approval requirement.** Scoped, revocable, low-risk automatic repairs are **reserved for a future, separately approved policy change**. | §4.8 (L2 ceiling; L3/L4 reserved), §5.1, §5.2, §5.3; AIM-5 (approved execution only); AIM-5b (reserved). `MASTER_ROADMAP.md` V2-L unchanged. | **RESOLVED** |
| D4 | Which scopes are tagged `production` | **Accept the recommended production protection scopes**, with Debian **ANX-CorTex on port `8090`**; port **`8080` belongs to AMP**. **Unclassified scopes are production until verified.** | §5.6 (accepted production list; non-production candidates are proposed only and stay `production` until verified and Owner-confirmed); §1.2 and §2 (port correction); §4.1 (scope field); §5.2, §5.4, §5.7 (identity tuples, execution-time re-verification, CL9); AIM-0/AIM-1 (identity verification). | **RESOLVED** |
| D5 | Approval channel | **Desktop-only approvals for V2.** Mobile incident viewing may be read-only; **secure mobile approval is a separate future milestone**. | §4.7, §5.3; AIM-6 (Facts API, no approve capability); AIM-M (reserved). | **RESOLVED** |

---

## 11. Out of scope for this plan

Kubernetes/Nomad/Proxmox orchestration, cloud providers, cross-node data
migration automation, credential rotation, automatic DB migrations, public
exposure changes, Agent self-update automation, automatic repair without
per-action approval, mobile approval, and any change to ANX-CorTex source. Any
of these require a separate plan and approval.
