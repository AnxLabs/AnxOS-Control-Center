# V2 Campaign Queues

**Maintained by the orchestrator; updated every cycle (heartbeat in `V2_CAMPAIGN_LOG.md`).**
**Priority order:** critical regression/security/reliability → broken harness/gate → dependency blockers → current milestone completion → review findings → next implementation → docs/release cleanup → final audit.
**Rules:** regressions outrank features; no implementation leaves review unresolved; "queue empty" must be proven; evidence beats claims.

Last full-rebuild: cycle 6 in flight (HEAD dc1fcb8).

### Cycle-6 queue deltas

- **V2-G wave 3 (offline job policy): LANDED (86432ee)** — jobLifecycle expiresAt opt-in, lazy expiry on getJob/listJobs/recovery, key release without replay, TTL excluding destructive types, zero-change default. instances:job-expiry:smoke registered; job family green. I2 CLOSED.
- **V2-F wave 4 (restore targeting + preview): LANDED (21a27cc)** — read-only preview (byte-proven), same-node targetInstanceId with cross-instance restore + config rebranding, target-aware conflict refusal, safety-scope fallback. **Product bug fixed by the implementer: in-restore failures were masked as RESTORE_ROLLBACK_FAILED (rollbackRestoreFromSafetySnapshot required a path field live metadata never carried) — every real in-restore failure had skipped rollback. Now resolves from the snapshot id; covered by forced mid-mutation rollback test.** restore:targeting:smoke registered; backup family green. I3 CLOSED.
- **I4 workload transfer: DISPATCHED** (desktop orchestration: download → import → targeted restore with preview-first + confirm; extends the drill harness transfer leg). R4 reviewer dispatched over 86432ee/21a27cc.
- **Residue tripwire caught implementer development-run residue again** (both new smokes verified clean in isolation; cleaned + gate rerun).
- **V2-H/I/J survey COMPLETE** (agent_f54328a7): three bullet tables + wave plans. Sequencing decision: V2-I W1 (actor×resource×action permission-matrix harness) BEFORE V2-H exposure waves. Deferrals recorded: reverse-proxy/certs (owner decision), container trust levels (re-scope candidate), fleet update orchestration (may ride V2-G batch). NEW queue item: write docs/v2/SECURITY_TRIAGE_RECORD.md (Mimosa evidence must be in-repo for the V2-I gate) — S1 updated.
- Suite count 234 → 238 (job-expiry + restore-targeting + fleet + multi-node smokes registered).

### Cycle-5→6 queue deltas

- **R3 reviewer verdict: NOTHING ABOVE P1** on the fleet/drill wave (batch confirm gate verified service-side on the sole path; runWithConcurrency race-free; drill hermetic with real leak detection; marker fix sound). All four findings fixed + pushed (dc1fcb8): fleet-summary wording honesty, failed-batch refresh, delete-toast attempted-false wording, (ungrouped) sentinel collision (NUL-prefixed sentinel). Recorded: commit-split drift in 2748170 (message says review-fixes, content includes the wave-2 feature — mid-session git add -A sweep; unfixable without history rewrite, recorded here as the attribution of record).
- **V2-H/I/J survey COMPLETE**: three bullet tables + wave plans + drill decompositions + deferral candidates (reverse-proxy/certs → defer with owner decision; container trust levels → possibly re-scope; fleet update orchestration → may ride V2-G batch). Key campaign-artifact gap flagged: the Mimosa triage evidence must be recorded in-repo (S1 now includes "write docs/v2/SECURITY_TRIAGE_RECORD.md"). Waves queued in the implementation queue after I2/I3: V2-I W1 (actor×resource×action matrix harness) first — it hardens everything before V2-H's exposure work.
- **Cycle 6 in flight:** I2 offline job policy (jobLifecycle expiresAt), I3 restore targeting + preview (backupService), R3 findings fixed (dc1fcb8).
- **Sequencing note:** V2-I W1 (permission matrix harness) prioritized ahead of V2-H waves — hardening before exposure, per the roadmap's own ordering ("public exposure also requires V2-I security gates").

### Cycle-5 queue deltas

- **I1 fleet aggregation + batch: LANDED (bbf4d90)** — fleetService, batch start/stop with max-3 concurrency + per-node results + destructive confirm, fleet strip UI. Review R3 dispatched.
- **T2 drill harness: LANDED (bbf4d90)** — multi-node:fleet:smoke (two spawned agents, interrupt/isolation/revocation/JOB_INTERRUPTED-recovery legs; transfer/per-OS legs documented for later). Found a real product bug: stale removal markers silently deleted re-paired nodes (fixed in nodeService, regression-covered by node:local-removal smoke).
- **Implementation queue:** I2 (offline job policy) and I3 (restore targeting) now READY; I4 still blocked on I3; I7 (V2-H/I/J surveys) dispatches next cycle.
- **Review queue:** R3 (bbf4d90) dispatched (agent running); R2's fix-commit 1b04536 covered by R3's scope extension.
- **Test queue:** T2 partial → drill live (transfer/per-OS legs appended when I3/I5 land). Suite count 232 → 234.
- **Reliability:** the harness caught a REAL reliability bug pre-land: stale removal markers deleting re-paired nodes (fixed, regression smoke node:local-removal still green).
- **Clean tree at bbf4d90**; full gate + R3 reviewer dispatched at close.

---

## 1. IMPLEMENTATION QUEUE

| # | Item | Milestone | Size | Dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| I1 | V2-G wave 2: fleet aggregation (per-node health/job roll-up) + cross-node batch actions with per-node results and bounded concurrency | V2-G | M-L | wave 1 ✓ (landed 91f31ef) | **READY** |
| I2 | V2-G wave 3: offline job policy — expiresAt/renewed-approval in jobLifecycle; enqueued-but-untransferred jobs expire, never replay | V2-G | S-M | wave 1 ✓ | **READY** |
| I3 | V2-F wave 4: restore targeting + preview (targetInstanceId, dry-run, conflict=refuse unless confirm) | V2-F | M-L | waves 1+2 ✓ | **READY** |
| I4 | V2-G wave 4: workload transfer via backup → import → restore to another node | V2-G | M | I1 (per-node scoping), I3 (target restore) | BLOCKED on I3 |
| I5 | V2-G wave 5 + V2-F wave 5: per-OS agent upgrade paths; remote/encrypted backup destinations | V2-G/F | L | waves 2-4 | QUEUED |
| I6 | V2-E remainder (optional): roster editing (whitelist/ops) — only if the acceptance drill needs it | V2-E | S | player rosters ✓ | PARKED (view-only satisfies bullet; revisit at drill) |
| I7 | V2-H/I/J scoping surveys | V2-H/I/J | — | V2-E/F/G substantially landed | QUEUED (dispatch when V2-G waves 1-3 land) |

## 2. REVIEW QUEUE

| # | Item | Implementer | Reviewer | Status |
| --- | --- | --- | --- | --- |
| R1 | Cycle-4 combined commit 91f31ef: backup consistency option + node lifecycle (revocation credential model, async deleteNode, manualDisconnect health gating, renderer regions) | agent ×2 | NEW reviewer required | **READY** |
| R2 | Cycle-3 workstreams (f59e608/28f66e4/1eb7f88) | agents ×3 | reviewer done (agent_f9e1773b); findings fixed in 1b04536; fix-commit itself not yet independently reviewed | PARTIAL — fold R1 reviewer over 1b04536 too |

## 3. REGRESSION QUEUE

| # | Finding | Source | Evidence | Status |
| --- | --- | --- | --- | --- |
| X1 | Residue leaks into repo root (two caught by tripwire; fixed 760e493 + smoke pins) | tripwire | instances/jobs residue | FIXED; tripwire guards recurrence |
| X2 | Hollow-green smoke exit (transaction smoke steps 5-8 never ran) | reviewer execution proof | fixed in c97cae4 + gate guard | FIXED |
| — | No open regressions | | | verified at cycle-4 close (all families green) |

## 4. TEST QUEUE

| # | Item | Type | Status |
| --- | --- | --- | --- |
| T1 | rc:validate full gate after every cycle | gate | CONTINUOUS (232→235 suites as smokes land) |
| T2 | One-machine two-node drill harness (scripts/multi-node-fleet-smoke.js per V2-G survey decomposition: enroll both, interrupt, restart desktop, per-node isolation, revoke 410, transfer, per-OS legs) | integration/recovery | **READY — build with I1/I2** |
| T3 | Failure-injection: interrupted backup mid-write (covered by interrupted-recovery smoke ✓), corrupt store mid-tick (covered ✓), restore conflict paths (needs I3) | failure-injection | PARTIAL |
| T4 | Restart/recovery: desktop restart mid-install (transaction smoke ✓), mid-restart-schedule (covered ✓), mid-restore (rollback covered ✓) | restart/recovery | MOSTLY COVERED |

## 5. HARNESS QUEUE

| # | Item | Source | Status |
| --- | --- | --- | --- |
| H1 | ssh-session-timeout margins (25ms race vs 60/110ms waits) — widen or fake clock | harness audit | PARKED (passing smoke; churn risk) |
| H2 | Source-pin smokes re-tier (50 vacuous-ish; keep as cheap regression tripwires but not blocking) | harness audit | PARKED (ordering churn; tripwire value real) |
| H3 | bootstrap:auth-order vm-extraction rework | harness audit | PARKED (whitespace-normalized pins work) |
| H4 | device-architecture 12s cap + Windows rm retries robustness | harness audit | PARKED |
| H5 | website:smoke chain split into 4 explicit suites | harness audit | PARKED (cosmetic) |
| H6 | dependency-smoke agent-token write to user config on fresh machines | pin-guard implementer risk note | **READY (S)** — rides the next harness pass |
| H7 | listBackups read-path legacy-schema write tolerance (read-only API writing on read) | reviewer P2-5 | PARKED (caught + reported via scheduleStoreErrorCode today) |

## 6. SECURITY QUEUE

| # | Item | Source | Status |
| --- | --- | --- | --- |
| S1 | Mimosa scan: ZERO P0/P1 verdict standing; re-scan after campaign code volume (841 → expect drift) | security triage | **READY — run at campaign end (final audit)** |
| S2 | playitService -Command interpolation hardening (4 sites) | triage P2 | PARKED (scanner blocks candidate; non-exploitable FP path; sc.exe migration disproportionate) |
| S3 | Client-supplied runtime-pin identity is a soft bypass (dependencies:write holders can claim another workload's id) — document in operator docs + API contract | reviewer P2-3 | **READY (S)** — rides docs queue |
| S4 | Renderer sinks: verified textContent-only in all new UI (player rosters, app cards, node groups) — keep verifying each wave | triage + reviewers | CONTINUOUS ✓ |
| S5 | js-yaml DoS cap + vm removal + SHA-512 preference landed | triage P2 | DONE (6d2e7e5, eb13b83) |

## 7. RELIABILITY QUEUE

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Y1 | Restart-scheduler tick-vs-CRUD lost-update (re-read + merge before final write) | reviewer P2-4 | PARKED (matches backupService precedent; single-writer ticks) |
| Y2 | Scheduled restart vs in-flight durable job on the target (check open instance jobs before restarting) | reviewer P2-5 | **READY (S)** — next reliability pass |
| Y3 | At-least-once restart after agent crash between execution and store write (benign double-restart) — accepted, documented | reviewer observation | ACCEPTED |
| Y4 | Verify-then-extract TOCTOU on archive digest (hash during extract instead) | reviewer P2-7 | PARKED (local trust domain) |

## 8. ROADMAP GAP QUEUE

| # | Gap | Evidence | Acceptance criteria | Status |
| --- | --- | --- | --- | --- |
| G1 | V2-D: install plan preview has no renderer UI (API-only; getTemplateInstallPlanPreview + getInstallDiskPreflight done, unreviewed functionally) | reviewer P2-8 | plan visible before install (renderer) | PARTIAL — API done; UI deferred to polish |
| G2 | V2-D: publisher-trust warning for third-party executable content | roadmap bullet | trust warning shown for non-catalog sources | MISSING — fold into I5 or docs disclosure |
| G3 | V2-C: image update rollback (rollbackSupported:false) — build or roadmap-scope the deferral | roadmap bullet | controlled rollback where data compat allows | **DECISION NEEDED (owner)** — recommend deferral note |
| G4 | V2-D: catalog export/import + offline installation limits documented | roadmap bullet | export/import + documented limits | MISSING — fold into docs wave |
| G5 | V2-A/B: responsive/browser workflows beyond the agent-served read-only page | roadmap bullets | accessible browser workflows | DEFERRED (browser surface Option A shipped; full parity = later) |
| G6 | Docker engine live acceptance (V2-C gate) | roadmap gate | single+multi container app, bad image, occupied port, missing volume, failed update | **QUEUED — sandbox session** |
| G7 | Two-node live drill (V2-A/V2-G gate) | roadmap gate | interrupted connection, restart, revocation effective | **QUEUED — needs I1/I2** |
| G8 | Operator walkthrough (V2-B gate) + stale-status agreement live check | roadmap gate | install→open→config→recover via UI | **QUEUED — sandbox session** |
| G9 | Clean-host Debian 12 install (V2-D gate + V2-A Linux evidence) | roadmap gate | reproducible install + support-matrix sign-off | **QUEUED — sandbox session** |

## 9. DOCS / STATUS QUEUE

| # | Item | Status |
| --- | --- | --- |
| D1 | Campaign log heartbeat per cycle | CONTINUOUS ✓ |
| D2 | DOCUMENTATION_INDEX: add docs/v2/ records (V2_WAVE1/2 records, campaign log, queues) | **READY (S)** |
| D3 | Runtime-pins operator note + S3 soft-bypass documentation | **READY (S)** — rides next docs commit |
| D4 | New-user guide / operator docs updates for: compose policy grants, node groups/disconnect/revoke, backup consistency + retention verdicts | **READY (M)** — after V2-G wave 2 lands |
| D5 | API/IPC contract docs: runtime-pins + restart-schedules + node lifecycle endpoints | **READY (M)** |

## 10. RELEASE QUEUE

| # | Item | Status |
| --- | --- | --- |
| RL1 | No release actions this campaign: next release = v2.0-build204, gated on ADP RC workflow + 🚀 publish | STANDING |
| RL2 | Build 199 + V1 history immutable | STANDING ✓ (untouched) |
| RL3 | Release-readiness chain deferred until campaign code waves complete (changelog → version bump → RC → sandbox acceptance → gates) | QUEUED |
| RL4 | Release tooling: promote workflow unproven end-to-end (dc6cd56 fix); exercise on next RC | QUEUED |

## 11. CLEANUP QUEUE

| # | Item | Status |
| --- | --- | --- |
| C1 | TODO/FIXME sweep across V2-touched files | **READY — at campaign end** |
| C2 | Temporary logging/debug hooks audit (dev-*.js files removed as created ✓) | CONTINUOUS ✓ |
| C3 | Dead code from superseded implementations (watch: chooseBackupType old callers) | **READY — with R1 reviewer** |
| C4 | package.json script ordering consolidation (cosmetic) | PARKED |

## 12. FINAL AUDIT QUEUE

Opens only when queues 1-8 are empty or explicitly deferred. Plan: independent multi-agent audit — roadmap reconstruction from repo vs campaign log, TODO/skipped/flaky sweep, lifecycle/shutdown/migration edge cases, security re-scan (S1), release-readiness chain, git state verification, protected-history check.

---

## AGENT POOL STATE (cycle 4 close)

- Completed: player mgmt, backup waves 1+2, pin guard, consistency, node lifecycle (5 implementers) + reviewers (2) + auditors (3) + security triage (1) this campaign.
- Running: none (all integrated).
- Next dispatch: R1 reviewer; I1/I2 implementers; T2 drill harness.
