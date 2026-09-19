# V2 Campaign Queues

**Maintained by the orchestrator; updated every cycle (heartbeat in `V2_CAMPAIGN_LOG.md`).**
**Priority order:** critical regression/security/reliability → broken harness/gate → dependency blockers → current milestone completion → review findings → next implementation → docs/release cleanup → final audit.
**Rules:** regressions outrank features; no implementation leaves review unresolved; "queue empty" must be proven; evidence beats claims.

Last full-rebuild: cycle 10 close (HEAD f1b07f1).

### Cycle-16 queue deltas (Wave A: closing the absent V2-H/D/I/J items)

- **AGENT-DISCIPLINE queue — NEW RULE, learned the hard way: dependency state is a shared resource and only the orchestrator may mutate it.** During Wave A a lane ran a targeted `npm install <pkg> --no-save --no-package-lock`, which **pruned `node_modules` to zero** and broke the tree for every other lane for a window (it was already partial at 103 entries before that). The lane self-reported the action unprompted, repaired it with `npm ci`, and verified recovery (230 packages, Electron binary present, manifests untouched) — which is the behaviour that made this diagnosable rather than mysterious. **Rules adopted:** no lane may run `npm install`/`npm ci`/`npm uninstall` or otherwise change dependency state; a lane that hits a genuinely missing module reports it and stops. Only the orchestrator restores the environment, and only after every lane has stopped.
- **HARNESS queue — two full-gate failures in that window are UNATTRIBUTED, not "flaky suites".** `agent-control:smoke` failed at 244/254 with `Cannot find module '@electron/get'` from Electron's postinstall path, and `fleet:aggregation:smoke` failed at 97/254; both pass standalone. The first is explained by the dependency window. The second is **not attributed** — it may be the same window or load-related, and guessing would be worse than saying so. Integration gates are now run only on a quiet tree with all lanes stopped; if either suite fails there, it gets root-caused like the earlier environmental flakes.
- **Process note:** the orchestrator's own first response to the dependency report was wrong — it checked the post-repair state and generalised backwards, telling two lanes their environment observation was a working-directory artifact. **A verification performed after someone else fixed the problem does not retroactively invalidate their observation.** Check the timeline before ruling a peer's finding wrong.

### Cycle-15 queue deltas (re-freeze at 3f7c16e, delta re-audit)

- **Frozen candidate MOVED to `3f7c16e`** (from `4749e56`). Gate at that SHA: **254/254 PASS**. Security delta verdict: **ACCEPTABLE WITH DOCUMENTED GAPS — no new P0/P1/P2**; both hardening fixes PROVEN BLOCKED under adversarial probing, the three accepted gaps confirmed unchanged, and neither fix widened the attack surface.
- **SECURITY queue: the Mimosa scan at `3f7c16e` is INCOMPLETE evidence, not a pass.** completeness `partial`, runStatus `inconclusive`, seal `sha256:90caaead…`, 955 findings, gap = call graph partially incomplete (dynamic reachability may be incomplete; source coverage itself was complete at 495/495). **No security claim attaches to it.** Its 7 delta-relevant findings were triaged: 2 ACCEPTED PATTERN (`vm` on repo-owned source in dev-only smokes) + 5 FALSE POSITIVE (`showToast` textContent taint, a loopback fixture `fetch`), 0 exploitable.
- **DURABLE RULE recorded for `vm.runInContext` in tests:** acceptable only when the executed string is a repo-owned artifact read from a module-load-fixed path, with no byte from argv/env/network/node/user, and the sandbox grants no real capability. It becomes unacceptable as soon as an externally influenced byte reaches the code string, the context gets real capability, or the file ships in the packaged app.
- **TEST queue OPEN (new, from the delta audit's coverage statement):** `scripts/amp-panel-url-gate-smoke.js` does NOT cover tab/newline-encoded schemes, protocol-relative `//host`, `https:`/`https:/` normalisation, control/unicode characters, a host-trust assertion (any http/https host is allowed by design), or the two sibling `href` sinks. The gate itself survived all of those under probing; the smoke should be extended so a regression in any of them fails the build.
- **REGRESSION queue OPEN (routed, pre-existing, UNPROVEN):** `app.js` assigns `href` from `instance.connectionHost`, which is length-capped but not scheme/host-validated (`http://` is pinned, so no script execution; needs `instance:write` plus the same actor clicking). Route to the renderer lane.
- **DOCS/CONTRACT queue OPEN (routed):** `instances:jobs:list` accepts `nodeId` but always queries the local job store — the comment in the preload/renderer says jobs are owned by the selected node. Not an authorization bypass, but the contract and the comment disagree. Route to `api-contract-guardian`.
- **HARNESS queue OPEN:** the scanner's sealed-scan CLI (`payload/dist/cli.js security-scan run --deep`) is the path to use when the MCP tools are unavailable after a restart; record scanId + sealDigest + completeness in the campaign log each time, and never treat `partial` as a pass.

### Cycle-14 queue deltas (frozen-commit audit of 4749e56)

- **HARNESS queue — a TIMING CLASS, closed. Three instances, one root cause: a fixture margin so tight it doubles as an environmental test.** (1) `node:independent-health:smoke` asserted classification with a 1000 ms HTTP budget across seven concurrent fixtures (failed 152/252 under load). (2) Nine Agent-readiness loops used 6–12 s budgets that failed under load and reported "did not become ready" whether the Agent was booting or dead — they now share `scripts/test-helpers/agent-readiness.js` with a generous budget, child-exit fast-fail (exit code/signal + stderr tail) and the last probe error. (3) `instances:job-expiry:smoke` minted an 80 ms deadline that had already passed by validation time (failed 74/254 with `INVALID_JOB_EXPIRES_AT`); its assertions are about ordering, so margins became 1500 ms and the already-expired fixture states a past timestamp directly. Proven under artificial load on two suites; the rest inherit the helper and were verified to pass normally — stated as inherited, not claimed as individually load-tested. Gate after: 254/254.
- **LESSON ADOPTED (extends the cycle-12c rule):** a fixture's timing margin is part of its contract. If a budget can fail because the machine is busy, the gate is testing the machine. Tight budgets are legitimate ONLY where the tightness is the assertion — and those must be commented as such.

- **SECURITY queue: Mimosa COMPLETE against the frozen SHA** (scanId `scan-2026-09-18T18-30-03.134Z-0db48aa4ad76`, seal `sha256:a546e102…`), 948 findings triaged onto campaign lines: **40 on added lines → 39 false positive, 1 accepted pattern, 0 exploitable.** Static-only evidence boundary; no runtime execution claimed. **CLOSED for this SHA.** Open sub-item: the 4 offline dependency advisories are **UNPROVEN** — the scanner persisted counts but no identifiers, so nothing can be assessed until a re-run with identifiers enabled.
- **SECURITY queue: three P3 hardening items from the adversarial lane.** N1 (`%`-truncation validation/use mismatch) and N2 (duplicate `Host` refusal was a dead branch) **CLOSED** with mutation-proven pins in `agent:host-trust:smoke`. N3 (AMP panel `href` accepted an unvalidated agent-supplied URL, so a malicious node could return `javascript:`) **delegated to the renderer lane** — UNPROVEN exploitability, real risk, hardening fix.
- **REGRESSION queue: the gate itself was the first defect found.** `node:independent-health:smoke` was flaky — a 1000 ms budget for real HTTP round trips across seven concurrent fixtures, so machine load produced false failures (failed at 152/252 in the audit run, passed in isolation). **CLOSED:** success-expecting budgets widened with a comment explaining that the assertions are about classification, not latency; the deliberately-tight closed-port leg is kept and commented. Fail-without proven under artificial CPU load (exit 1, multiple `AGENT_TIMEOUT`), pass-with under the same load (exit 0).
- **RELEASE queue: the website advertised a release that does not exist.** `website/config.js` named tag `v2.0-build203` and `2.0-build203` asset names — six 404 URLs — because the sync derives URLs from `release.json` while build 203's artifacts were published as `1.9-build203` under `v1.9-build203-rc2`. **CLOSED (data + guard):** config corrected, and `verify-website-config-vs-stable.js` now compares the tag and every configured asset file name against the actual stable release instead of only the numeric build. Proven both directions against the live release.
- **RELEASE queue OPEN, OWNER-GATED (needs explicit approval — a workflow change):** the publish job uploads the raw `rc-validate.log` as a permanent public release asset (it contains CI runner paths and a fixture IP; no credentials), and `validate-release-artifacts.js` does not scan `.log`. Also owner-gated: no RC exists for this commit, signing-secret provisioning, and the ADP install/acceptance gates. Recorded, not touched.
- **ROADMAP queue: 10 registered channels unreachable (HIGH).** `alerts:list|acknowledge` (the operator cannot see or acknowledge an alert, so V2-J bullet 3 was hollow), `instances:jobs:list|get|cancel`, and five `backups:*Destination` channels. **Alerts + jobs lane DISPATCHED**; the destination channels are recorded as a documented deferral (API_SURFACE_V2.md already said "no renderer control yet").
- **DOCS queue: four contradictions corrected** (operator notes §5/§7/§9, support matrix, API surface omissions) plus a new operator section on the downgrade limitation (schema-2 instances are unreadable in a pre-Build-200 build — data preserved, functionality degraded), and the `MASTER_ROADMAP.md` §6 status pass: 47 bullets flipped to `[x]` **only** where code plus a registered hermetic smoke exist, with every acceptance gate left NOT VERIFIED and the genuinely absent items (publisher-trust warning, catalog export/import, adapter contract, reverse-proxy/certificate lifecycle, alert surfacing) left open. Also corrected: `docs/KNOWN_LIMITATIONS.md` still claimed the install-plan preview was API-only.
- **Standing lesson reinforced:** the frozen audit's most valuable outputs came from lanes attacking the *evidence* rather than the code — a flaky gate, a guard that compared the wrong field, a "missing feature" that was a coverage gap, and a roadmap that understated rather than overstated. Keep auditing the auditors.


### Cycle-13b queue deltas

- **SECURITY queue: F4 CLOSED (Host trust + cross-origin), with one accepted gap.** The Agent now validates `Host` on every route before authentication (`HOST_NOT_ALLOWED`, 421, fail-closed, hostile host never echoed or logged) and refuses state-changing cross-origin requests (`CROSS_ORIGIN_DENIED`, 403). The pairing `agentUrl` no longer echoes a caller-controlled host, and the request URL is parsed against a fixed internal base. Covered by `agent:host-trust:smoke` with fail-without evidence, and the browser UI's own bootstrap → session → page flow was verified end to end against a real spawned Agent rather than by asserting a header's absence.
- **ACCEPTED GAP (must not be forgotten): a wildcard bind (`AGENT_HOST=0.0.0.0`/`::`) is not strict** — any syntactically valid `Host` is accepted there, because deciding whether a name resolves to a local address needs a request-path DNS lookup. On a wildcard bind a rebinding page's `pairing/start` would still succeed; its `agentUrl` no longer reflects the hostile host, and the cycle-12 pairing gate still applies to an enrolled node. The strict allowlist requires a concrete bind. **Follow-up option recorded, NOT implemented: an operator-configured allowed-host list** (the desktop already stores an unused `allowedOrigins` setting) — this is the only remaining way to make a wildcard bind strict without a DNS lookup, and it needs an owner decision.
- **SECURITY queue OPEN (low, recorded):** loopback trust remains absolute, so an on-host reverse proxy in front of the agent port defeats both the pairing gate and the Host allowlist; same-origin is compared host+port only, so a scheme mismatch behind a TLS-terminating proxy is not detected (a mismatched-origin page still cannot read responses or change state).
- **SECURITY queue OPEN (recorded limitation):** a remote Agent reachable only through a DNS name must have that name in its `agent.json` `agentUrl` or requests to it are refused. A remote Agent reached by IP needs no configuration. Documented for operators.
- **UNPROVEN and staying that way for now:** whether a real browser could ever complete the DNS-rebinding read, and whether this change defeats it in-browser rather than at the socket. No browser was driven; a browser-based probe would need a lane with a real Chrome and a rebinding harness.

### Cycle-13 queue deltas

- **HARNESS queue: H7b CLOSED (correctly scoped this time).** It was recorded as "listBackups read-path legacy-schema tolerance" — a suspected missing feature. The tolerance already existed, so the real gap was coverage; writing that coverage found a **second site of the same race** in the schedule-store migration (`readSchedules`), which had the identical stat-then-copy pair and could take the schedule store down when two reads raced. Both sites now use the atomic `COPYFILE_EXCL` form with EEXIST tolerated, and `backup-metadata-migration-smoke` covers both with deterministic lost-race legs and PROVEN teeth (reverting either site fails the smoke — the metadata leg with its own invariant message, the schedule leg with the raw EEXIST).
- **Lesson recorded for the queue:** a "missing feature" queue item can be a coverage gap, and verifying it can surface a real defect the item never mentioned. Verify the premise of a queued item before implementing it — and if the premise is wrong, say so and re-scope rather than building the thing that was asked for.
- **Tooling constraint recorded:** Mimosa's path-traversal rule blocks edits to files that already contain an unvalidated `path.join(root, variable)` pattern (this includes the existing backup smokes, so they can no longer be extended). The workaround used is a containment-checked path helper in the new file — never a scanner change.

### Cycle-12c queue deltas

- **TEST queue — LESSON ADOPTED AS STANDARD: static string pins are decoration, not coverage.** The UI reviewer independently verified the six fixes made in response to its findings (6 of 7 PROVEN-FIXED) and then MUTATION-TESTED the new pins in `ui-polish-smoke.js`. Result: **a future edit that stops honouring the typed confirmation (`if (!confirmed)` → `if (false)`) passes all seven pins**, as do a second destructive path written as `api.workload.transfer(`, a phrase derived from raw input instead of the preview-resolved id, and a neutered re-check with its toast string kept. Only the consistency-disclosure and anchor pins have real teeth. **Rule for the rest of the campaign: a guard invariant is only covered by executing the flow and asserting on observed calls — never by asserting that a string appears in a file.** A `transfer-gate-behavior-smoke` lane is dispatched to build exactly that (declined confirmation ⇒ transfer never called; accepted ⇒ transfer called with the RESOLVED id; preview failure ⇒ no confirmation; node switch ⇒ result not swallowed; a second call site ⇒ smoke fails), with the three evasions as its acceptance criteria.
- **Closed this cycle:** the transfer button now mirrors its disabled reason into `aria-description` like the install-plan button (the reviewer's one PARTIALLY-FIXED item: the button is disabled in most states and Chromium does not show a `title` tooltip on a disabled control). Two nits left as-is and recorded rather than churned: the confirmation message has no separator between the last step and the closing sentence, and an unprobed node reads "— Connecting" rather than "— Offline" (pre-existing fallback, errs toward annotating).
- **Re-verified, no new defects:** the reviewer found no regression from the six fixes (no second destructive path, guard ordering intact, single call site still 1, no new DOM sink — `renderer-safety:smoke` and the injection harness re-run clean over the current tree, network inventory untouched).
- **Process note for future requests:** `npm run node-switch:smoke` does not exist — the script is `node:switch:smoke`. A missing-script invocation exits 1 with no output, which reads like a regression; check the name with `npm run` before treating a silent failure as a finding.

### Cycle-12 queue deltas

- **SECURITY queue: F1 / F1b / F2 / F3 CLOSED (43aeef7).** The pairing surface now authorizes on an enrolled node — loopback origin or a credential the agent trusts, else `PAIRING_REQUIRES_EXISTING_CREDENTIAL` (403) — evaluated before any mutation, with first pairing and post-revocation recovery unchanged. Covered by the new `agent:pairing-credential-gate:smoke` (6 legs, teeth proven by disabling the gate), and the permission-matrix contract row for the pairing status route was updated with added teeth. **Lesson recorded: the enrollment-gate-only fix this campaign was about to make would have closed nothing**, because the record self-heals to the live credential; the authorization rule belongs on the surface that installs the credential.
- **REGRESSION queue: one PRODUCT REGRESSION introduced by the security fix, disclosed and being fixed.** The desktop's own remote repair does not present the credential it holds (`agentControlService.startPairingSession` posts no header; `nodeService.postPairingComplete` posts only code+token), so remote re-pair of an enrolled node fails even when the desktop HAS a valid credential. No smoke catches it (`node:remote-pairing-target:smoke` runs its own mock server; `multi-node:fleet:smoke` re-pairs over loopback only). **Follow-up lane DISPATCHED** to attach the stored node credential to both calls. The unrecoverable case (remote node whose credential is LOST) stays an on-host action by design and must be documented for operators.
- **SECURITY queue OPEN (new, not yet scoped): F4 — Host header trust + no CORS.** The agent builds the returned `agentUrl` from `request.headers.host` and sends no `Access-Control-Allow-*` headers. The DNS-rebinding precondition is proven; whether a real browser can complete the attack is UNPROVEN. Candidate fix: a Host allowlist (loopback + configured agentUrl) and explicit CORS denial. Needs a lane; low urgency until proven browser-reachable.
- **SECURITY queue OPEN (recorded limitation):** loopback trust is absolute, so an on-host reverse proxy in front of the agent port would make remote callers appear loopback. A corrupt `enrollment.json` now fails the pairing routes closed (500) instead of allowing pairing — intended, but untested.

### Cycle-11 queue deltas

- **SECURITY queue: one P1 OPENED, PROVEN, and deliberately NOT closed** — now REFINED by a read-only security lane, which found the exploit is CHEAPER and the fix surface WIDER than first recorded. Severity depends entirely on reachability:
  - **F1** — `pairing/start` is pre-auth and returns the code to the same caller; `pairing/complete` sets the live `config.token` to a caller-chosen value; that token then authenticates. Reproduced: control refused 403; `start` 200 with a code; `complete` 200; `GET /instances` with the installed token 200; enrollment record rebound with caller-chosen scopes.
  - **F1b (NEW, changes the fix surface)** — the enrollment record **self-heals** to the live fingerprint on the next authenticated request (`enrollmentService.js` ~546-563, deliberate rotation tolerance). So `/enroll/complete` is NOT required: the minimum exploit is three requests and it never touches `assertRepairAuthorization`. **Any fix confined to the enrollment gate is ineffective**, and the earlier "pair-then-enroll is required" framing was understated.
  - **F2 (NEW)** — `GET /api/v1/pairing/status` returns the live pairing code pre-auth.
  - **F3 (NEW)** — `POST /api/v1/pairing/cancel` is pre-auth; an unauthenticated caller can destroy the operator's pending session (single module-global slot).
  - **F4 (NEW, precondition proven / browser step unproven)** — the Host header is trusted when building the returned `agentUrl` and the agent sends no CORS headers, so a DNS-rebinding origin could be treated as same-origin. Whether a real browser can complete this is UNPROVEN.
  - **Reachability verdict (decides severity):** a default desktop-spawned agent binds `127.0.0.1` and AnxOS ships NO inbound firewall rule for the agent port, so a default install is **not** remotely reachable → local-process attacker only (P2). A STANDALONE agent defaults to `0.0.0.0` (`agent/src/config.js`), and remote nodes over LAN/Tailscale are a documented, smoke-supported flow → **P0** in that topology.
  - **Fix lane DISPATCHED (Option B):** for an ENROLLED node the pairing routes (`start`, `complete`, `status`, `cancel`) require either a loopback origin or presentation of the credential the agent already trusts, with a new `PAIRING_REQUIRES_EXISTING_CREDENTIAL` (403); first pairing (no record) and post-revocation stay open. Accepted loss, to be documented: remote re-pair with a LOST credential becomes an on-host action (the product already supports this via `npm run agent:pair` / `scripts/agent-pair-export.js`). Options A (loopback only), C (on-host code generation) and D (refuse re-pair of an enrolled node) are recorded in the lane's report with their blast radius; C is the correct long-term shape but requires redesigning the remote "Generate pairing code" action and rewriting `node:remote-pairing-target:smoke`.
  - **NOT to be re-litigated:** the live-credential acceptance in `assertRepairAuthorization` stays — the legitimate repair flow pairs a node (rotating the shared token) and then enrolls with the rotated credential while the record fingerprint is stale, and `multi-node:fleet:smoke` fails 403 where it asserts 200 against a record-bound gate.
- **REGRESSION queue:** the P2 workload-log misattribution is CLOSED (an operation scope leaked onto a run's long-lived pipes; the run now owns its id and both pipes stamp it explicitly, smoke-pinned). Backup metadata migration race CLOSED (atomic `COPYFILE_EXCL`). UI review P1 (source-backup consistency undisclosed at the destructive gate) + P2s (offline target labelling, install-plan node staleness) + P3s (guard re-check after await, unguarded success-path refresh, misleading comment) CLOSED with pins.
- **REVIEW queue: R9 (UI) and R10 (correlation + enrollment) CLOSED.** R10's recommended tightening was implemented and then **DISPROVED BY EVIDENCE** — `multi-node:fleet:smoke` failed 403 where it asserts 200, because the legitimate repair flow pairs a node and then enrolls with the rotated credential while the record fingerprint is still stale. Reverted; the acceptance is now pinned in `agent:enroll:smoke` so a future tightening cannot land silently. Recorded so the next reviewer does not re-litigate it.
- **HARNESS queue:** H7 ("listBackups read-path legacy-schema tolerance") **CLOSED AS STALE** — the tolerance already existed (v0→v1 migration with a byte-stable `.schema-v0.backup`); the real gap found while verifying is *coverage*. Replaced by H7b: pin legacy backup metadata migration (migrated on read, backup byte-stable and written once, idempotent across list+restore, and a future schemaVersion refused with `BACKUP_METADATA_SCHEMA_UNSUPPORTED`).
- **TEST queue (new):** denied Agent actions carry no correlation id — deliberate (adopting a header id pre-auth would let an unauthenticated caller choose a log field), so it needs a documented decision rather than a fix; `normalizeJoinKey` accepts token-shaped values (hardening, no untrusted caller today); the correlation smoke's wiring phase is still partly grep-based; auto-restart / version-refresh timers can still inherit an operation scope.
- **DOCS/STATUS queue:** cycle-11 heartbeat written; the ~950 new renderer lines have no runtime evidence and are flagged as such in the log and the live-acceptance queue.
- **FINAL AUDIT queue:** Mimosa's pre-commit scan returned `scanner_enobufs` (incomplete) twice this cycle — **no security claim is made for cycle 11**, and the full re-audit at a frozen commit remains owed.

### Cycle-10 queue deltas

- **Implementation queue: 4 waves CLOSED** — V2-H wave 2 (firewall lifecycle), V2-I wave 2 (scoped agent tokens enforced), V2-F wave 5 (backup destinations: local + SFTP + AES-256-GCM + restore-from-remote), V2-J wave 1 (alert engine + IPC). Cycle 11 lanes dispatched: **UI reachability** (the 3 unreachable surfaces), **enrollment re-pair hardening** (security), **V2-J correlation IDs**.
- **Regression queue: the P0 is the headline.** A declined transfer preview deleted a pre-existing target instance (adversarial audit reproduced it; the docs curator found it independently while verifying behavior). Fixed + smoke-pinned. Also fixed: remote path traversal (backslash separators), job-store temp collision, restore verify-then-extract TOCTOU, matrix indirect-registration hole, renderer attribute injection, dead-code restart, alert engine dead feature, destination temp collision, firewall rule identity.
- **Review queue: R8 CLOSED** (three P1s addressed; two recorded for owner-scoped contract decisions below).
- **Harness queue: H1/H4/H6 CLOSED** with proven tripwires. Remaining: H2 (source-pin re-tiering), H3 (bootstrap vm-extraction), H5 (website:smoke split), H7 (listBackups read-path legacy-schema tolerance).
- **Security queue: S1 still open** — the sealed triage covers the baseline; the campaign's new surfaces were individually audited by the security lane this cycle (zero P0/P1 there) but a re-scan at a frozen commit is still owed for the final audit. **NEW S6 (recorded, owner-scoped):** the enrollment completion flow accepts a re-pair with only the nonce + a self-chosen token, so scopes can be dropped without the existing credential — pre-existing V2-A design that makes the scoped-token guarantee non-binding against a caller who can reach the agent port. Cycle 11 lane dispatched to harden it. **NEW S7:** the firewall elevated-confirmation/rollback guard is desktop-only; a direct agent caller can create an access-affecting rule with no guard (needs the api-contract lane).
- **Reliability queue: Y1/Y2 CLOSED** (scheduler CRUD merge; busy-job skip with fail-closed query handling). Remaining: the runner-up items recorded by the reviewers (alert id fallback, UTC quiet hours, local lockout probe limits).
- **Release queue: two latent P2s recorded, deliberately NOT hand-fixed** (editing published release metadata would create a worse mismatch): (1) website release metadata points at a tag that does not exist for the published build — the version/build bump to 2.0 happened after the published tag was created, so the sync-derived tag drifts; the build-204 sync must derive from the ACTUAL tag and the deploy guard should catch a mismatch (currently it only compares buildNumber); (2) the local build helper hardcodes a Desktop path while the repo lives under Documents. Both belong to the build-204 release lane.
- **Docs queue: D2-D5 CLOSED** (index, operator notes, API surface, limitations, guides). Remaining: roadmap checkbox sync (MASTER_ROADMAP §6 still shows every V2 bullet unchecked while the log records them complete — the roadmap file itself needs the status pass).
- **Test queue:** suite count 246; drill harness has the transfer leg implementable but not yet appended (needs the UI lane's transfer wiring to exercise it end-to-end).
- **Adversarial lane is a permanent periodic lane**, not final-only — it produced the cycle's only P0 this round.

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

### Cycle-9 queue deltas

- **V2-G wave 5 (Linux agent self-update + capability report): LANDED (98e15f7)** — systemd-run transient swap with staging temp+rename, backup-before-swap + rollback, pure-sh post-exit script with observable result markers; agentUpdate capability report; honest Windows parity (desktop-driven task lifecycle, never in-place swap). agent:self-update:smoke registered. Wave 5 partial: remote-agent push upgrades remain future (needs a runtime-download authority).
- **V2-H wave 1 (network inventory): LANDED (fe4ddb2)** — interfaces/listeners/conflicts/checkPort, agent REST route (system:read), full desktop chain, matrix rows. network-inventory:smoke registered.
- **R7 verdict: no P0, 3×P1 — ALL FIXED (396ae08):**
  1. swap-script rollback masking (`|| true` on the restore mv made the orchestrator claim success with neither runtime in place) → new failed-rollback-failed marker, rolledBack reported honestly.
  2. failed Linux update left the agent stopped → catch path best-effort restarts on the previous runtime, restartAttempted/agentRestarted reported.
  3. Windows netstat parser locale failure (non-English state words yielded silently empty TCP inventories) → state-agnostic listener selection via the foreign wildcard-port-0 shape + parse telemetry surfacing shape failures.
- **P2 ledger added:** capability honesty for unitless Linux hosts; self-copy staging note (live drill must validate genuine version-delta swap); UDP wildcard+specific false positives; alias-teeth scope; preview getStatus self-heal caveat.
- Suite count 240 → 242. Tree clean at 396ae08; gate rerunning at close.
