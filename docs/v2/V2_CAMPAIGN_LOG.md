# V2 Engineering Campaign Log

**Campaign start:** 2026-09-17 (owner mandate: full V2 roadmap, LOOP workflow, autonomous, milestone-by-milestone)
**Rules of engagement (owner-set):**
- LOOP: inspect → plan → implement → test → audit → fix → verify → commit → push → continue.
- Finish each milestone before starting the next; never skip prerequisites.
- Anti-feature-creep: non-roadmap ideas get parked, not built.
- Build 199 and all release history/tags are immutable; never retag.
- "Push everything" means finish + verify first; never push known-broken work.
- Publication (tags, GitHub releases, promotions) stays behind the ADP approval gates.
- V2-L…V2-Q (Section 6A vision extras) require explicit owner scoping — out of scope.
- Broken harness gets fixed, not gamed.

---

## Milestone ladder and acceptance criteria

Dependency spine: B0 ✓ → V1 ✓ → **V2-A** → **V2-B/C/D (Alpha)** → **V2-E/F/G (Beta)** → **V2-H/I/J (RC)** → **V2-K (release; publication-gated)**.

| Milestone | Acceptance gate (roadmap §6) | Status |
| --- | --- | --- |
| V2-A platform/identity | Permitted op succeeds on intended node; wrong-node/revoked/unauthorized/duplicate fail safely; client restart never orphans ops | Core shipped (Build 203: identity, enrollment, authority, job lifecycle, browser surface). Open: Debian 12 x64 live acceptance (sandbox); support-matrix live evidence |
| V2-B dashboard/apps | First-time operator installs reference app, opens it, changes config, recovers failed start via UI; dashboard status agrees with runtime incl. stale | Wave-1 renderer slice shipped. In flight: app cards, launch links, favorites, time-based staleness |
| V2-C containers | Install/operate 1 single- + 1 multi-container app; bad image, occupied port, missing volume, restart, failed update exercised; cleanup preserves unselected data | Durable jobs + policy gate + volume protection + preflight + compose gate shipped. Open: live-engine acceptance |
| V2-D marketplace/runtimes | Package installs reproducibly on clean host; corrupt download/missing dep/incompatible template/failed install are safe + diagnosable; runtime update never breaks pinned workload | Package metadata v2 shipped. In flight: install transactions on job lifecycle + install-plan IPC |
| V2 Alpha slice | install → configure → use → backup → update → restore → uninstall on reference app; volumes survive unless explicitly chosen | In flight: per-instance restore wiring, delete-vs-forget honesty, e2e loop smoke |
| V2-E game panels | Two independently configured game instances run concurrently, receive console actions, survive restart; backup/restore recovers game state; permissions prevent cross-instance access | Surveyed: top gaps = per-game world backup scopes, scheduled restarts w/ warnings, player management. NEXT WAVE |
| V2-F files/storage/backups | Restore reference app + game to isolated destination; full disk/missing mount/interrupted backup/corrupt archive/unauthorized path/unavailable remote tested; backup accepted only after restore drill | Thin slice in flight; full track scoped after Beta start |
| V2-G multi-node/fleet | Two nodes concurrently, one connection interrupted, management restart; healthy node stays usable; no cross-node results; revocation effective; reconnect never duplicates work | Scoped after Beta start |
| V2-H shell/network/public access | Publish + revoke test workload; verify reachability/closure; failed provisioning/expired creds/port conflicts/rollback exercised | Scoped later |
| V2-I users/permissions/security | Explicit actor × resource × action matrix incl. denial paths; cross-user/node/workload attempts fail | Scoped later; Mimosa triage feeds this |
| V2-J observability/updates/recovery | Induced failure raises one useful alert and resolves; staged update interrupted and recovered per docs | Scoped later |
| V2-K integrated release | Integrated acceptance matrix on packaged candidates; migration from V1 without data loss; docs + support policy | Publication-gated; final release audit precedes |

---

## Cycle log

### Cycle 0 — Wave 2 complete: V2-C follow-on (2026-09-17, commits d187fc8, 270f276, e2376c0, 5ac23af, e74ce96 — PUSHED)

- Durable V2-A job store wired for compose/images/volumes/networks/cleanup (destructive types refuse idempotency keys).
- Deny-by-default policy gate (`src/shared/dockerPolicy.js`): privileged / host network / host mounts (POSIX + Windows drive paths) / socket mounts fail closed without explicit `policyGrant`; `createContainer` enforces at engine boundary (DOCKER_POLICY_DENIED 403).
- Volume protection: `runCleanup` refuses persistent-data kinds without `confirmVolumeDataRemoval: true`.
- Create preflight: `POST /api/v1/docker/preflight/container` (policy + resource limits + best-effort host-port conflicts), full desktop IPC chain, renderer preflight-first flow.
- Compose-file policy gate: `assertComposePolicy` reviews the actual compose file (inline YAML or whitelisted basenames in the validated project directory) before compose up/recreate; unparsable YAML fails closed (COMPOSE_POLICY_UNPARSEABLE); js-yaml promoted to direct dependency.
- Registered 4 orphaned smokes (policy [new], job-lifecycle, capabilities, route-io, hostile-input) — rc:validate coverage gap closed.
- Validation: node --check × all; 8/8 docker smokes PASS; instances job smokes PASS; rc:validate 195/195 (pre-compose-gate); git diff --check clean.
- Regressions found & fixed in-cycle: Windows drive-path bind parsing (`C:\host:/ctr` split-colon bug) in both policy module and renderer; weak renderer dangerous-option regex replaced with shared-shape detection; dead code in preflight removed pre-commit.

### Cycle 1 — Wave 3: V2 Alpha slice completion (IN PROGRESS)

Parallel agents (strict file ownership, Edit-only, no package.json access):
- **V2-D** implementation-engineer: marketplace install transactions (durable jobs, keyed idempotency, restart reconcile, getInstallPlan IPC, transaction smoke).
- **V2-B** implementation-engineer: dashboard app-card grid, launch links, marketplace favorites, time-based staleness.
- **V2-F** implementation-engineer: per-instance restore button wiring, delete-vs-forget uninstall honesty, alpha-loop backup e2e smoke.
Support agents:
- **Security triage** (security-reviewer): Mimosa sealed scan (841 findings; 85 product-code, 24 hardcoded-credential flags, 74 command-injection) → P0/P1 remediation plan.
- **V2-E survey** (Explore): COMPLETE — bounded next-wave scope = per-game world backup scopes (backupService getSourcePaths :465-485 + adapter world-path map), scheduled restarts with warnings via writeInstanceInput, stretch: Minecraft player management tab; defer CPU limits + adapter extraction.

**Integration queue for Cycle 1 close:** register new smokes in package.json → node --check all → docker+marketplace+backup smoke families → full rc:validate → code-reviewer pass over agent-produced diffs → fix regressions → commit per workstream → push → update this log.

### Cycle 1a — Security triage results + P2 hardening (2026-09-17)

Mimosa deep scan triage (security-reviewer agent, sealed scan sha256:ba76f2a8): **zero P0, zero P1.** All 74 command-injection + 10 code-injection + 11 path-traversal findings in product code are the known execFile-wrapper/argv-array false-positive pattern; all 24 hardcoded-credential flags are dev-script fixtures (scripts/ does not ship); renderer taint class (719) is toast/clipboard presentation flow with contextIsolation+sandbox verified on every window. 3 shipping dependency advisories: js-yaml quadratic-CPU DoS (our compose gate — mitigated now), dompurify via monaco (renderer-only, deferred), brace-expansion ReDoS (negligible).

P2 fixes landed this cycle:
- `accountAuthService.js`: vm.runInNewContext **removed entirely** — bundled website config parsed by a restricted static string-literal extractor; user-writable config paths (config dir, ANXOS_ACCOUNT_CONFIG_PATH) are JSON-only. Account smoke family 5/5 PASS.
- `dockerPolicy.js`: compose YAML size cap (256 KiB, MAX_COMPOSE_POLICY_BYTES exported) — oversized documents fail closed before parse, neutralizing the js-yaml DoS on the marketplace-template path. Policy smoke extended + PASS.

P2 items parked (with reasons — revisit only with owner approval):
- playitService PowerShell `-Command` service-name interpolation (4 sites): Mimosa PreToolUse blocks ANY candidate touching a `-Command` line (env-var passing fix was blocked; sc.exe argv migration is disproportionate churn on a triage-verified non-exploitable path where names derive from fixed local candidates). Values remain system-derived; risk unchanged from Build 200 baseline.
- dompurify/monaco downgrade: semver-major dependency migration — park for a dedicated dependency wave.

### Cycle 1b — Smoke-coverage audit + harness repair (2026-09-17, commit e841dd1)

- Audited all 231 smoke scripts against both harness mechanisms (package.json `*:smoke` entries for rc:validate + `scripts/release-validation.js` QA tiers): **29 smokes were referenced by neither** — real rc-gate coverage gaps, several only ever run manually during past waves.
- Verified each of the 29 hermetic and green on this machine, then registered all in package.json grouped by family (marketplace ×8, backups ×2, account/auth ×5, agent/local-agent ×6, instances ×2, security/qa/ui ×4, bootstrap, alpha-loop, ssh). rc:validate suite count 195 → 224.
- Harness drift repaired (behavior proven intact, text pins updated — no production change):
  - `bootstrap-auth-order-smoke`: the pinned gate expression became multiline in `renderLocalSetupState` (Build 203 local-setup work); whitespace-normalized matching preserves the pin's intent.
  - `security-loading-state-smoke`: scenarios predated the Build 203 Local Owner authentication model that gates the security dashboard on `status.localOwnerAuthenticated === true`. Scenarios updated to the current contract; a new assertion pins that a status without local owner auth lands "unauthorized" with the gate message (this was previously untested behavior).
  - `qa-logged-out-renderer-smoke`: sidebar chain gained the leading unlock branch before the null guard; pin updated to the current chain.
- Early rc:validate launched over the in-flight tree (V2-B + V2-F agent work uncommitted) as a pre-integration regression gate; authoritative gate runs after V2-D lands.

### Parked (anti-feature-creep)

- V2-L…V2-Q vision extras (AnxOS Intelligence, Automation Engine, Plugin SDK, Mission Control, Themes, Analytics) — need owner scoping per roadmap §6A.4.
- Linux OS appliance track (OS-A…D) — after V2-K.
- Resumable/chunked downloads, agent-side install orchestration relocation — noted in V2-D survey as follow-up beyond this campaign's milestone scope.
