# V1 Acceptance Record

Dated acceptance evidence for the V1 milestones defined in `docs/MASTER_ROADMAP.md` Section 5.
This record is evidence-linked per the B0 rules in `docs/B0_BASELINE.md`: automated smoke
results and live operator acceptance are separate claims, and neither is claimed without a
dated execution record.

## V1-B — Bounded Alpha and Beta usability (recorded 2026-09-04)

Environment: real machine (Windows_NT 10.0.26200 desktop), packaged v1.9 build 196
(Private Alpha), remote Debian 13 agent node "Anxlab" connected (API v1, Protocol 1,
compatible). Checkout head: `734d450`.

| # | Checklist item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Define the V1 feature set and label experimental/unsupported features in the UI | Partially met | `docs/KNOWN_LIMITATIONS.md`, `docs/PRIVATE_ALPHA_TESTER_GUIDE.md`; `onboarding:smoke`. No dated doc names the explicit V1 feature set and its UI labeling matrix. |
| 2 | Installation, first-run configuration, connection diagnostics, prerequisites | Met | `docs/NEW_USER_GUIDE.md`, `docs/PRIVATE_ALPHA_TESTER_GUIDE.md`, `docs/ONBOARDING_VALIDATION.md`, `docs/LOCAL_AGENT_WINDOWS_SETUP.md`; smokes `onboarding:smoke`, `node:connection-workflow:smoke`, `diagnostics:smoke`; live: working packaged install on 2026-09-04. |
| 3 | Consistent loading/empty/error/stale/offline/recovery states | Partially met | `ui:polish:smoke`, `renderer-safety:smoke`, `docs/ERROR_CONTRACT.md`, per-feature `*:ipc-error-contract:smoke`, `node:stale-response:smoke`. No consolidated live pass across all six states per page. |
| 4 | Local authentication, session handling, bounded file access, credential protection, basic action audit records | Partially met | `docs/SECURITY_BOUNDARIES.md` (IPC authorization, fail-closed sessions, Agent permission map); smokes `local-owner-auth:smoke`, `secure-session-store:smoke`, `persistent-session-store:smoke`, `files:ipc-authorization:smoke`, `agent:files-root:smoke`, `redaction:smoke`. Gap: no queryable action audit trail; `docs/OPERATION_FRAMEWORK.md` operation records are transient, not an audit log. |
| 5 | Persistence across restart, configuration backup/restore, documented repair steps | Partially met | `docs/RECOVERY_MODEL.md`, `docs/CONFIG_MIGRATIONS.md` (schema-versioned stores, atomic writes, corrupt-store repair); smokes `instances:shutdown:smoke`, `instances:config-migration:smoke`, `backups:transfer-safety:smoke`. Live 2026-09-04: real in-place upgrade 194→196 preserved all data and sessions (direct restart-persistence evidence). Gap: no dated live backup→restore round trip. |
| 6 | Historical SSH browser confirmation-dialog smoke failure | Met (resolved) | Root cause was the browser `confirm()` assertion in `scripts/ui-polish-smoke.js`; re-executed 2026-09-03 with exit 0. Live 2026-09-04: SSH page verified with a live connected session to the Debian agent. |
| 7 | Alpha feedback cycles and Beta regression across the support matrix | Not met (evidence pending) | Matrix and tester instructions exist (`docs/PRIVATE_ALPHA_TESTER_GUIDE.md`, `docs/TEST_MATRIX.md`, `docs/QA_AUTOMATION.md`). 2026-09-04 live acceptance is single-machine validation, not a tester feedback cycle or multi-environment Beta regression (concurrent ops, reconnect, backup/restore, upgrade trials). |

### V1-B gate position

The "clean supported installation reaches a functioning reference server using only shipped
instructions" gate is **partially met**: onboarding documentation is complete and a packaged
install was verified working on 2026-09-04, but item 1's explicit feature-set record and the
item 7 Beta trials are not yet documented.

### Remaining V1-B work, smallest first

1. Record the V1 feature set and where experimental/unsupported labeling appears in the UI.
2. Perform and record a live backup→restore round trip for one reference workload.
3. Decide and record the action-audit-trail approach (or explicitly defer audit records with
   rationale), closing item 4.
4. Run a consolidated live state-consistency pass (loading/empty/error/stale/offline/recovery).
5. Collect dated Alpha feedback from at least one additional tester/machine before claiming
   the item 7 gate.

## V1-A — Core operation and state reliability (live drill)

Status: **partially met (live drill executed 2026-09-04).** Environment: packaged v1.9
build 196 (Private Alpha), remote Debian 13 agent node "Anxlab" (192.168.1.134, Agent 0.1.0,
API v1, Protocol 1, connected).

Drill performed via the Instances page UI:

1. Started **Terraria TShock** (`terraria-tshock`, custom command, 192.168.1.134:7777) and
   **Better MC [FORGE] BMC4** (`better-mc-forge-bmc4`, java app, 192.168.1.134:24454) from
   the Instances page while both were STOPPED.
2. Both reached **RUNNING** simultaneously. Header counters updated to `RUNNING 2`,
   `TOTAL INSTANCES 4`, with live `TOTAL RAM` (752 MB → 1.1 GB) and `TOTAL CPU`
   (25.9% → 19.0% → 29.6%) aggregate values.
3. Per-instance metrics populated independently per row and updated live across polls:
   Better MC CPU 0.0% / RAM 3.4 MB / uptime 1m–2m; Terraria CPU 25.0% → 19.0% / RAM
   748 MB → 1.1 GB / uptime 1m. No metric cross-contamination between rows (the
   selection-independence invariant).
4. Console tab for Terraria rendered live server output ("Backing up world file",
   "127.0.0.1:61390 is connecting...", "Saving world data", "Validating world data").
5. Stopped Terraria via the row Stop control: a stop confirmation dialog appeared
   ("may disconnect active players or services"), and after confirming, the console showed
   the shutdown sequence (Saving world data → Validating world save → Backing up world
   file) and status returned to **STOPPED** with Start re-enabled.
6. Stopped Better MC the same way: confirmation dialog, console recorded
   `Stopping Better MC [FORGE] BMC4 with code=null signal=SIGTERM`, status **STOPPED**,
   Start re-enabled (recoverable state).

Not yet covered by this drill: restart path and Expose/Share during the drill, failure-path
(start failure mid-drill), and a second agent node (single-node drill only). Existing
automated coverage: `resource-operation-lifecycle-smoke`, `instance-metrics-lifecycle-smoke`,
`instance-health-summary-smoke`, `instance-health-state-smoke`, `instance-runtime-smoke`,
`node:switch:smoke`, `operations:framework:smoke` (all passing as of the 2026-09-04
`rc:validate` 181/181 run).

---
*Evidence rule: this file only records checks that were actually executed, with dates. Roadmap
checkboxes in `docs/MASTER_ROADMAP.md` are updated only when their stated outcomes have this
evidence.*
