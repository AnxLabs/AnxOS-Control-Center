# AnxOS Development Protocol (ADP)

The AnxOS Development Protocol (ADP) defines the engineering, validation, release, and approval standards for all contributors to the AnxOS Control Center project, including AI agents and human developers.

Every contribution to this repository must follow this protocol. The ADP is the authoritative project standard for implementation, validation, diagnostics, acceptance, and release work.

> **Guiding Motto:** Build with discipline. Validate with evidence. Release with permission.

## Protocol Metadata

| Field | Value |
| --- | --- |
| Protocol Name | AnxOS Development Protocol (ADP) |
| Current Version | 1.0 |
| Status | Active |
| Owner | Project Owner |
| Applies To | All Contributors (Human and AI) |
| Last Updated | Update when modified |
| Maintainers | Project maintainers |

## Table of Contents

- [Protocol Metadata](#protocol-metadata)
- [Mission](#mission)
- [Core Philosophy](#core-philosophy)
- [Engineering Principles](#engineering-principles)
- [Approval Matrix](#approval-matrix)
- [Project Approach](#project-approach)
- [Bug Workflow](#bug-workflow)
- [Feature Workflow](#feature-workflow)
- [UI and UX](#ui-and-ux)
- [Coding Standards](#coding-standards)
- [Security](#security)
- [Runtime Diagnostics](#runtime-diagnostics)
- [Validation Rules](#validation-rules)
- [Definition of Done](#definition-of-done)
- [Git Workflow](#git-workflow)
- [Release Candidate Acceptance Workflow](#release-candidate-acceptance-workflow)
- [Reporting Format](#reporting-format)
- [AI Behaviour Rules](#ai-behaviour-rules)
- [Scope Guard](#scope-guard)
- [Emergency Rules](#emergency-rules)
- [Lessons Learned](#lessons-learned)
- [Future Improvements](#future-improvements)
- [Workflow Changelog](#workflow-changelog)

## Mission

- Deliver reliable, complete implementations.
- Prioritize correctness and safety over speed.
- Never fabricate results, evidence, or completion.
- Protect project stability, user data, and security boundaries.
- Respect every explicit user approval gate.

## Core Philosophy

- Stability before speed.
- Honesty before convenience.
- Validation before release.
- Small, reliable improvements over broad, speculative change.
- Root-cause fixes over symptom masking.
- User approval over automatic action.
- Long-term maintainability over short-term convenience.

## Engineering Principles

- Never fake test results or claim validation that was not executed successfully.
- Every change must have a clear reason.
- Every bug fix should leave the project stronger through understanding, validation, or regression coverage.
- Fix root causes instead of masking symptoms.
- Keep changes focused on the requested outcome.
- Avoid unnecessary complexity.
- Optimize for readability.
- Never trade reliability for convenience.
- Prefer consistency over cleverness.
- Preserve backwards compatibility whenever practical.
- Prefer readable, maintainable solutions over clever ones.
- State assumptions and risks clearly instead of guessing.
- Preserve unrelated user or agent changes.
- Add regression coverage for bug fixes when practical.

## Approval Matrix

The following actions always require explicit user approval. Approval for one action does not imply approval for another.

| Action | Required approval |
| --- | --- |
| Delete files or important data | Explicit approval identifying the target |
| Create a Git commit | Explicit approval to commit |
| Push Git commits or tags | Explicit approval to push |
| Create or publish a release | Exact reply `🚀 publish` after final acceptance |
| Launch a release-candidate installer | Exact reply `confirmed` after the RC report |
| Modify the installed application | Exact reply `confirmed` for the approved in-place RC upgrade |
| Continue after a user-completed authentication or sensitive step | Exact reply `done` |
| Restart an application, service, or machine when it may disrupt work | Explicit approval |
| Modify GitHub Actions or other GitHub workflows | Explicit approval |
| Change certificates, signing configuration, or signing infrastructure | Explicit approval |

When approval is missing, stop before performing the gated action, explain what is ready, and request the required approval.

## Project Approach

- Read existing documentation and inspect related code before modifying behavior.
- Prefer the existing project architecture, dependencies, services, IPC patterns, and UI components.
- Avoid unnecessary dependencies and broad rewrites.
- Preserve unrelated user or agent changes. Do not use destructive Git commands such as `git reset --hard`, `git clean`, or broad file restoration.
- Complete requested work before proposing optional improvements.

## Bug Workflow

1. Understand the reported behavior and expected behavior.
2. Reproduce the bug when practical, using available diagnostics and a minimal reliable case.
3. Identify and explain the root cause.
4. Implement a focused fix consistent with the existing architecture.
5. Validate the fix with relevant syntax checks, tests, and smoke tests.
6. Review affected workflows for regressions and add regression coverage when practical.
7. Summarize the cause, changes, validation, and remaining risks.
8. Stop and wait for approval before any gated follow-up action.

## Feature Workflow

1. Understand the request, constraints, acceptance criteria, and affected workflows.
2. Explain the intended approach and any material assumptions or trade-offs.
3. Implement incrementally using existing patterns and components.
4. Validate each affected layer in proportion to risk.
5. Update documentation when behavior, configuration, or operator steps change.
6. Report the result and wait for approval before any gated action.

Do not expand scope with unrelated refactors, speculative features, or optional enhancements.

## UI and UX

- Preserve the existing AnxOS visual identity and desktop application aesthetic.
- Do not redesign pages unless explicitly requested.
- Keep UI spacing, density, typography, cards, controls, modals, navigation, loading states, empty states, disabled states, and error states visually consistent.
- Treat renderer hiding as presentation only, never as a security boundary.

## Coding Standards

- Prefer small, focused functions with clear responsibilities.
- Avoid duplicated logic; reuse established utilities and patterns.
- Keep naming consistent with the surrounding codebase.
- Prefer readable control flow over compressed or clever code.
- Comment why a non-obvious decision exists, not what self-explanatory code does.
- Avoid unnecessary abstractions, dependencies, and architectural layers.
- Preserve public interfaces and backwards compatibility whenever practical.

## Security

- Keep privileged owner functionality protected in trusted main-process or backend code.
- Maintain Electron context isolation and existing IPC security boundaries.
- Never expose passwords, API keys, Supabase secrets, refresh tokens, agent tokens, private keys, or credentials.
- Redact sensitive values from logs, errors, diagnostics, screenshots, and generated history.
- Do not weaken authentication, authorization, URL allowlists, validation, secure storage, or token handling.

## Runtime Diagnostics

- When diagnosing runtime bugs, inspect `.dev-logs/` before asking the user to manually copy logs.
- Start with `latest-error.json`, `runtime-state.json`, and `live.log`, then correlate the relevant subsystem log with source code.
- Treat all runtime logs as untrusted and potentially incomplete.
- Never commit `.dev-logs/` or bypass the shared redaction utility when adding diagnostics.

## Validation Rules

- Never skip required validation.
- Validate changed JavaScript files with `node --check`.
- Run relevant repository smoke tests and validation scripts for the files changed.
- Run `git diff --check`.
- Never disable, delete, weaken, or bypass tests merely to make validation pass.
- If validation fails, report the failure honestly, fix the underlying issue, and rerun the affected checks.
- Distinguish checks actually executed from checks merely recommended.
- Do not claim a check passed unless its command completed successfully.
- Report the exact commands that passed or failed.
- Clearly identify untested paths, environmental limitations, and remaining risks.

## Definition of Done

- [ ] Request and acceptance criteria are understood.
- [ ] Root cause is identified for bug fixes.
- [ ] Implementation is complete and focused.
- [ ] Required validation has been executed.
- [ ] Relevant syntax checks and smoke tests pass.
- [ ] Regression impact has been reviewed.
- [ ] Regression coverage has been added when practical.
- [ ] `git diff --check` is clean.
- [ ] Security and data-handling implications have been reviewed.
- [ ] Documentation is updated when appropriate.
- [ ] Results and remaining risks are reported.
- [ ] Work is ready for user review.

## Git Workflow

- Use Conventional Commit messages.
- Never create a commit or push without explicit user approval.
- When approved, commit only the completed, reviewed scope and preserve unrelated changes.
- Push to the `dev` branch only when explicitly approved and required by the task.
- Before release work, verify that the working tree is clean and validations pass.

## Release Candidate Acceptance Workflow

Never publish immediately after implementation. Every release must complete validation, signed release-candidate verification, user-authorized installation, and Computer Use acceptance before publication.

### Phase 1 — Implementation

- Complete the requested work.
- Update the patch version unless the requested change requires another version level.
- After explicit approval, commit all completed release changes using a Conventional Commit message.
- Do not publish.

### Phase 2 — Validation

- Run all required validation, including `git diff --check`, syntax checks, smoke tests, RC validation, and feature-specific tests.
- If any validation fails, stop, fix the issue, and repeat validation until every required check passes.
- Never silently skip a failed or unavailable validation step.

### Phase 3 — Build Signed Release Candidate

- After explicit approval for required pushes, use the existing GitHub Actions build and signing workflow.
- The release candidate must be identical to the artifact users would ultimately receive.
- Verify that CI passed.
- Verify that the Authenticode signature is valid.
- Generate and record the SHA-256 checksum.
- Download the signed installer locally.
- Prepare release notes and required version, manifest, website release metadata, and changelog updates where applicable.
- Do not create or publish the public release.

### Phase 4 — Await Installation Permission

After the signed release candidate is downloaded and verified, stop and report:

- Build number
- Commit hash
- SHA-256
- Signature status
- CI status

Then ask exactly:

> Please confirm that I may install the signed Release Candidate over the current installation for acceptance testing.

Wait for the user's exact reply `confirmed`.

### Phase 5 — Computer Use Upgrade Test

After the user replies `confirmed`:

- Use Computer Use to install the signed release candidate exactly as a real user would.
- Do not use a development build.
- Perform an in-place upgrade over the current installation.
- Preserve all existing data.
- If authentication or sensitive credentials are required, stop and ask the user to complete the step manually.
- Never request, view, or capture passwords.
- Wait for the user's exact reply `done` before continuing after a manual sensitive step.

### Phase 6 — Computer Use Acceptance

After installation is complete, and after `done` when a manual sensitive step was required:

- Continue full acceptance testing using Computer Use.
- Verify every major workflow.
- Inspect for UI issues, broken workflows, layout problems, clipping, overflow, upgrade regressions, missing data, loading issues, error handling problems, and unexpected dialogs.
- Capture screenshots of major findings.

If any issue is discovered:

1. Stop acceptance.
2. Capture redacted diagnostics and screenshots.
3. Identify the root cause.
4. Fix the issue.
5. Repeat all required validation.
6. Generate and verify a new signed release candidate.
7. Restart upgrade and acceptance testing from the beginning, including the required approval gates.

### Phase 7 — Final Acceptance

Provide:

- Root causes
- Files changed
- Validation summary
- Computer Use acceptance summary
- Screenshots
- Commit hash

Finish with exactly one status:

`🟢 READY FOR PUBLICATION`

or

`🔴 RELEASE BLOCKED`

Do not publish automatically. Wait for the user's exact authorization `🚀 publish`.

### Phase 8 — Publication

Only after the user replies `🚀 publish`:

- Create any explicitly approved release commit and version tag still required.
- Push the approved `dev` branch and release tag.
- Publish the GitHub release and attach the verified artifacts.
- Complete required version, manifest, website release metadata, changelog, and release-note updates.
- Verify that the GitHub release, tag, version, and downloadable assets exist.
- Never silently skip a failed build, upload, test, push, release, signature verification, or acceptance step.

### Release Checklist

- [ ] Version updated.
- [ ] Release changes committed with approval.
- [ ] Required validation completed.
- [ ] Installer built through the existing GitHub Actions workflow.
- [ ] Installer signed.
- [ ] Authenticode signature verified as valid.
- [ ] SHA-256 checksum generated and recorded.
- [ ] Signed installer downloaded locally.
- [ ] Release notes prepared.
- [ ] Computer Use in-place upgrade completed with approval.
- [ ] Computer Use acceptance completed.
- [ ] Final acceptance status reported.
- [ ] Waiting for `🚀 publish`.

## Reporting Format

Every completed task report must include:

### Summary

State the outcome and whether the requested work is complete.

### Files Modified

List each modified file and its purpose. State `None` when no files changed.

### Validation Performed

List the exact checks executed and whether each passed or failed. Keep recommended but unexecuted checks separate.

### Remaining Risks

Identify untested paths, known limitations, environmental constraints, or state `None identified`.

### Recommended Next Action

State the safest next step and identify any approval required.

## AI Behaviour Rules

- Never invent commands, outputs, test results, signatures, checksums, screenshots, or release status.
- Ask for direction when a material requirement cannot be discovered safely.
- Make low-risk assumptions only when they preserve user intent, and explain them.
- Recommend the safest practical approach.
- Explain material trade-offs and uncertainty.
- Escalate when uncertainty, security impact, data-loss risk, or release risk is high.
- Preserve user intent and all explicit approval boundaries.

## Scope Guard

- Complete required work before suggesting optional improvements.
- Separate enhancements from required fixes in plans, changes, and reports.
- Do not perform large refactors, redesigns, dependency migrations, or architecture changes without approval.
- Avoid modifying files unrelated to the requested outcome.
- Do not turn diagnostics or review requests into implementation without authorization.

## Emergency Rules

- Stop immediately before destructive, irreversible, or unexpectedly broad changes.
- Request explicit confirmation before deleting files, overwriting important data, or disrupting the installed environment.
- Resolve and report exact targets before requesting approval.
- Preserve backups or use recoverable operations whenever practical.
- Never overwrite important user data without approval.
- Never use destructive Git commands such as `git reset --hard`, `git clean`, or broad file restoration.
- If credentials or sensitive authentication are encountered, stop and return control to the user without viewing or recording them.

## Lessons Learned

Use this section to accumulate verified project knowledge over time. Add entries only when supported by completed work or reliable evidence. Do not invent project history.

### Entry Template

- **Problem:** What observable behavior failed?
- **Cause:** What verified root cause produced it?
- **Resolution:** What focused change corrected it?
- **Lesson:** What reusable rule, test, or design insight should guide future work?

### Generic Example

- **Problem:** A UI action appeared successful even when its backend operation failed.
- **Cause:** The example assumes the asynchronous error path was not reflected in UI state.
- **Resolution:** The example would propagate the failure and display an actionable error state.
- **Lesson:** Validate both success and failure paths, and never infer backend success from a UI event alone.

### 2026-09-23 — FiveM client hung on "Starting game" (missing spawn resources)

- **Problem:** A FiveM client connected to the Anxlab FXServer and then sat
  indefinitely on "Starting game" with an empty F8 console, while the server
  logged repeated public-endpoint server-list query failures.
- **Cause:** The marketplace FiveM template provisioned only the FXServer
  artifact and generated a `server.cfg` with no resource `ensure` lines, so the
  instance had no gameplay resources at all (client "Required resources" was
  empty and `/info.json` listed only `hardcap`). Without `mapmanager`,
  `spawnmanager` and a gamemode, the client can never spawn. The server-list
  errors were a separate NAT-hairpin symptom: the node cannot reach its own
  dynamic public IP even though its HTTPS endpoint works (verified locally).
- **Resolution:** The template now downloads the official `cfx-server-data`
  pack (`fivem-server-data` resolver) and extracts it into `server/resources`
  via a new generic `installer.additionalArchives` step; the generated config
  ensures `mapmanager`, `spawnmanager` and `basic-gamemode` (validated against
  the packaged artifact — `chat`/`sessionmanager`/`hardcap`/`rconlog` are not
  ensureable in this build); install verification includes a spawn-resource
  manifest; `evaluateFiveMReadiness` gates startup on the required spawn
  resources (`RESOURCES_MISSING`); and the renderer no longer opens the license
  dialog for that cause.
- **Lesson:** "Process running" and "license configured" are not "playable".
  Instance readiness must verify the resources required for the player
  lifecycle (install verification plus a pre-start gate), and log-only
  symptoms such as server-list or NAT errors must be classified separately from
  spawn blockers.

### 2026-10-30 — Palworld "[S_API FAIL]" lines and a stale steamclient.so

- **Problem:** The Palworld console showed `[S_API FAIL] Tried to access Steam
  interface SteamUser021 / SteamFriends017 / STEAMAPPS_INTERFACE_VERSION008 /
  SteamNetworkingUtils004 before SteamAPI_Init succeeded` on every start, and
  the server loaded a July `steamclient.so` after a September SteamCMD update.
- **Cause:** The `[S_API FAIL]` lines come from Palworld's own server binary:
  it requests Steam client interfaces that only exist with a logged-in Steam
  client, which a dedicated server never has. They appeared on every start
  since 2026-09-05, and still appeared after the current library was loaded;
  the Steam game-server API the server needs works (UDP 27015 opens). The stale
  library was separate: `PalServer.sh` copies `linux64/steamclient.so` next to
  the binary only when the copy is missing, and AnxOS's SteamCMD update never
  refreshed it.
- **Resolution:** After a verified SteamCMD update (server stopped), AnxOS
  refreshes existing launcher copies of `steamclient.so` from `linux64/` by a
  temp-file write and rename (`syncSteamClientRuntimeCopies`). The S_API lines
  stay visible and are only treated as non-fatal for health.
- **Lesson:** Never overwrite a shared library in place while a process has it
  loaded: during diagnosis an in-place `cp` over the running server's
  `steamclient.so` crashed it (segfault, exit 139; world intact from the
  autosave and a pre-change backup). Replace libraries only while the process
  is stopped, by write-then-rename, and back up saves first. Prove whether a
  log line is caused by the environment with a before/after comparison before
  "fixing" it.

### 2026-10-30 — Hytale dedicated server: readiness and first-start sign-in

- **Problem:** Hytale servers could not be installed (the template was a
  disabled "coming soon" card). Supporting it needed a first start that
  requires an account sign-in, and readiness for a server the TCP port probe
  cannot see.
- **Cause:** The official server is distributed as `HytaleServer.jar` on
  `maven.hytale.com`. Its assets and `start.sh` layout download only after
  an OAuth device sign-in. It speaks QUIC over UDP. Its bootstrap mode also prints
  "Hytale Server Booted!" without serving players. Verified live on Anxlab
  with 0.7.5: the bootstrap crashes when `permissions.json` is missing, and
  `/auth login device` does not block later boot commands.
- **Resolution:** The template downloads the JAR from the official repository
  and refuses it unless it matches the published `.sha1`. A generated launcher
  runs the bootstrap, waits for "Authentication successful", sends
  `update download`, then execs the official `start.sh`. Readiness is
  log-based: "Booted" counts only once `Server/HytaleServer.jar` exists, and
  "No server tokens configured" is degraded (`HYTALE_AUTH_REQUIRED`). A real
  sign-in, download, UDP 5520 bind and graceful SIGTERM save were verified.
- **Lesson:** For a game whose port is UDP, or whose installer phase prints the
  same boot line, readiness must come from layout-qualified log signals, never
  from the generic TCP probe or regex. On a live node, choose the process to
  signal by an exact filter (`ss -H -lunp "sport = :PORT"`) and check its
  command line first. During this work, taking the first PID from a UDP
  listing terminated an unrelated RustDesk process, which its service respawned.

### 2026-10-30 — An Agent upgrade stops every server it supervises

- **Problem:** Upgrading the Anxlab Agent to Build 208 also stopped
  `fivem-staging`, although its FXServer process was not in the
  `anxos-agent` service cgroup and had been described as unaffected.
- **Cause:** On SIGTERM the Agent's `shutdown()` calls
  `instanceService.shutdownInstanceService()`, which stops every instance it
  tracks, wherever the process lives (`agent/src/server.js`). Separately, the
  packaged unit uses the default `KillMode=control-group`, so processes in the
  service cgroup (Palworld here) die with it as well.
- **Resolution:** Palworld's saves were backed up and it was stopped cleanly
  from the app before the upgrade. Both servers were started again from the
  app afterwards. The Build 208 upgrade notes now say an Agent update stops
  its servers.
- **Lesson:** Before restarting or upgrading a node's Agent, list every
  running instance it supervises, back up and stop them from the app, then
  start them again. Don't infer survival from a process's cgroup.

### 2026-11-06 — Wrong game versions: Hytale "1.0" and Palworld "0.0"

- **Problem:** Build 209 RC1 showed a false Hytale "Update available"
  because 0.7.5 was recorded as "1.0". Palworld Marketplace cards read
  "0.0 · Palworld Dedicated Server · 24181105", and still did after the
  Build 209 fix for servers installed before it.
- **Cause:** The Agent ran Minecraft version parsing over every instance's
  logs and fields, whatever the game, and wrote the result over the saved
  version (fixed in `eb5e2032`). After that fix, re-detection still carried
  the old values forward from the saved record, and an all-zero placeholder
  ("0.0") passed `cleanVersionValue` and was re-extracted by
  `extractGenericVersion`.
- **Resolution:** Minecraft parsing applies only to Minecraft (or
  unrecognised) instances and Hytale reads its own boot line (`eb5e2032`).
  All-zero versions are rejected by the Agent and the renderer, saved
  fallbacks are cleaned on re-detection, and `VERSION_CACHE_VERSION` moved
  so cached records are detected again once (`d01ca8eb`, with a regression
  test for a polluted record).
- **Lesson:** A detector for one game family must never run on another, and
  a fix to detection must also repair records an older build already
  wrote: bump the cache version and test with a polluted saved record, not
  only a fresh one.

### 2026-11-12 — Restoring an imported world backup deleted the whole server

- **Problem:** Restoring a backup imported with type "world" removed the
  server's whole folder (config.json and server files), keeping only the
  restored world. Reproduced in a sandbox
  (`scripts/world-import-restore-smoke.js`).
- **Cause:** `importBackup` recorded every import with `sourcePaths: ["."]`.
  A world restore deletes each recorded source path before extracting, so it
  deleted the instance root. Its world-only safety copy could not bring the
  other files back.
- **Resolution:** World imports record the world folders found in the archive
  (folders holding `level.dat`) and are refused when any file lies outside
  them. At restore time, world records that cover the whole server are
  re-derived from the archive before anything is touched, and refused if
  the archive is not world-only. A world restore never removes the instance
  root.
- **Lesson:** Metadata that drives deletion must be derived from the data it
  describes, never defaulted. Every destructive path needs a guard against
  resolving to the root it lives in. Fixes must also cover records older
  builds already wrote.

### 2026-11-12 — Controls that looked right but did the wrong thing

- **Problem:** Several controls on a server's page did something other than
  what they said:
  - Settings had a second set of startup inputs that looked editable but were
    never saved.
  - The console's Clear deleted the Agent's captured logs.
  - The backup dialog's Cancel button meant "make a full backup", so a backup
    could not be cancelled.
  - Drag-and-drop uploads read every file as text, corrupting jars and other
    binaries.
- **Cause:** Each control was wired to the nearest available call, and was
  only tested for "something happened", never for its exact effect.
  `file.text()` UTF-8-decodes bytes, and `createSecurityConfirmation` has
  no "cancel" result distinct from "decline".
- **Resolution:** In Phase 5:
  - The duplicate inputs were removed.
  - Clear is now a view-only marker.
  - The backup dialog offers Whole server / World only / Cancel.
  - Uploads are sent base64.
  - `scripts/server-view-ui-qa.js` checks each effect on the Agent or on
    disk (V3, V8, V9).
- **Lesson:** Test a control by its effect on the data, not by the UI
  reacting. Assert what is on disk or in the Agent after the click. A Cancel
  must always cancel. Never read user files as text unless the format is
  known to be text.

### 2026-11-12 — A disconnected computer's servers still looked live

- **Problem:** After a computer's Agent stopped, My Servers kept showing
  the computer as "Connected" and its servers as "Running" for as long as
  the page stayed open; the title-bar chip stayed green.
- **Cause:** Node health was only re-checked while Home or Computers was
  open, and the server list kept its last snapshot without marking it as
  old. Found by a Phase 8 UI test that stops the Agent mid-run.
- **Resolution:** My Servers checks the selected computer's health every
  15 s (never during a server action) and, once the computer is not
  connected and the list has not loaded for 15 s, marks each state
  "Last known" and the chip "<computer>: last known list".
- **Lesson:** Every page that shows live state needs its own freshness
  rule. Test it by stopping the data source during a UI test, not only by
  starting with it offline.

### 2026-11-13 — An Agent package built from a Windows export had CRLF scripts

- **Problem:** The first Build 210 Agent package built for Anxlab had
  CRLF line endings in every text file, including `DEBIAN/postinst`,
  which `/bin/sh` cannot run. Caught before install by diffing it against
  the official 209 package.
- **Cause:** The source was sent with `git archive` from a Windows
  checkout where `core.autocrlf=true`; `git archive` applies the same
  end-of-line conversion as a checkout.
- **Resolution:** Exported with `git -c core.autocrlf=false archive`,
  rebuilt, and confirmed the maintainer scripts, unit, sudoers rule and
  Node runtime were byte-identical to 209 and that no packaged file had a
  CR.
- **Lesson:** Build Linux packages from LF sources and compare a new
  package's maintainer scripts and unit with the last known-good package
  before installing it. A matching checksum file only proves the package
  is the one you built, not that it is right.

### 2026-11-13 — The Phase X assistant read no console lines on a real server

- **Problem:** Asked why a crashed server would not start, the assistant
  said it found no error in its "last 0 console lines", although the
  console showed a port conflict. All 18 hermetic checks had passed.
- **Cause:** `readLogs` (desktop and Agent, `instanceServiceCore`) returns
  `{ entries: [{ at, stream, message }] }` and takes `limit`. The assistant
  expected `lines`, and the hermetic test's fake returned the shape the
  code expected. Found by `scripts/phasex-ui-qa.js` in the real app.
- **Resolution:** The diagnostics read `entries` and request `limit`; the
  hermetic fake now returns the real shape and asserts the real option.
- **Lesson:** A fake service must copy the real service's response shape and
  options, not the consumer's assumptions. Run a new consumer once against
  the real service (a disposable local server is enough) before trusting
  its hermetic tests.

### 2026-11-14 — `qa:release` was broken, and "isolated" UI tests reached the real Agent

- **Problem:** `npm run qa:release` failed at its first real-app test
  (`stabilization-ui-qa.js`), and `service-managed-ui-qa.js` failed too.
  Separately, the developer's real Local Agent had logged about 3,500
  "Agent request authorization failed" lines, in bursts during UI test runs.
  Some of those requests were writes (`public-access/firewall-rule`,
  `notifications/webhook`).
- **Cause:** CI runs only `rc:validate` (the `:smoke` scripts), so the
  real-app tests in `qa:release` were never run after Phase 5 and Phase 8
  changed the layout and labels they checked. The UI tests' isolated profile
  did not set `AGENT_URL`, so the app fell back to `http://127.0.0.1:47131`,
  the developer's real Agent. Only the missing token stopped those requests.
- **Resolution:** The stale tests now check the current design (server page
  opened with `AnxServerView.open`, "game settings" title, Auto Start under
  Server behavior, "Runs as" tooltip). `isolated-qa-env.js` sets
  `AGENT_URL=http://127.0.0.1:9`. A full UI run went from 66 requests at the
  real Agent to 5. The rest come from code that has its own 47131 default
  (Agent Control, local Agent detection).
- **Lesson:** Run `qa:release` before a release, not only `rc:validate`. A
  test environment is isolated only once you've checked that the real service
  logged nothing during the run, not because it has a temporary profile.

### 2026-11-14 — AnxNet sometimes could not start ("illegal padding")

- **Problem:** `anxnet-dns-smoke` failed once in `qa:release` with
  `ERR_OSSL_ASN1_ILLEGAL_PADDING` from `tls.createServer`, and passed on the
  next run.
- **Cause:** `src/anxnet/certs.js` encoded the certificate's random 16-byte
  serial as a DER INTEGER without dropping leading zero bytes. A serial that
  starts 0x00 followed by 0x00-0x7f is not valid DER, so TLS refused the
  certificate. The certificate is made once per process, so about 1 start in
  512 had no working AnxNet until the app or Agent restarted.
- **Resolution:** `integer()` now uses minimal encoding: it drops redundant
  zero bytes and adds one only before a high bit.
  `scripts/anxnet-cert-der-smoke.js` forces the serials that used to fail and
  loads 300 random certificates through TLS.
- **Lesson:** Treat a one-off crypto or encoding failure as a likely 1-in-N
  bug, not as flakiness. Force the rare input in a test, instead of rerunning
  until the test passes.

### 2026-11-14 — A crashed server sometimes showed as "Stopped"

- **Problem:** `server-failures-smoke` failed about 1 run in 15 under load:
  a server that crashed (exit code 1) was reported "Stopped" instead of
  "Failed / PROCESS_EXITED".
- **Cause:** A status poll (`reconcileConfigState`) could see the crashed
  child's PID gone before Node delivered the child's `exit` event. It then
  wrote Stopped/STALE_PID. The exit handler and the poll both load and
  save `config.json` with no lock, so the poll's write could land last and
  replace the crash.
- **Resolution:** While the Agent still tracks a spawned child whose exit has
  not been observed, a status poll reports the current state and writes
  nothing; the exit handler records the result. The F4 case in
  `scripts/server-failures-smoke.js` forces the window by reporting the
  live child as dead, and fails without the fix. The same rule covers the
  moment after the exit is observed: a poll then reports the result but no
  longer saves it, because its save could land after the handler's
  CRASH_LOOP and replace it with PROCESS_EXITED (IE9 in
  `scripts/instance-engine-fixes-smoke.js`, which polls every few
  milliseconds during a crash loop and failed 3 of 3 runs before the fix).
- **Lesson:** Two writers of the same state file need one owner per fact.
  Here, a process's exit result belongs to its exit handler. Force a race's
  window in the test (a liveness hook) instead of rerunning until it passes.

### 2026-11-14 — A smoke test stopped the developer's real Local Agent

- **Problem:** The installed app's Local Agent stopped at 03:08 MST and
  stayed down: Task Scheduler reported its last run as "terminated by the
  user" (0x41306), but nobody had ended it.
- **Cause:** `scripts/agent-control-smoke.js` calls Agent Control's
  `stop()` with a temporary config folder. `stop()` ran
  `schtasks /End /TN AnxOSAgent` whenever that task was running. The task
  is machine-wide, and the smoke (run as `node.exe` from a checkout) has no
  task of its own, so it ended the installed app's Agent. The task only
  triggers at logon, so nothing restarted it.
- **Resolution:** `stop()` ends the task only when it runs this
  installation's executable and arguments
  (`backgroundServiceBelongsToThisInstallation`).
  `scripts/agent-control-foreign-task-stop-smoke.js` fakes Windows and
  every child process, and checks that another installation's task is left
  alone and ours is still ended. A recording listener on 127.0.0.1:47131
  saw 0 requests from the 133 Agent-facing smoke scripts and the 16 UI
  scripts.
- **Lesson:** A temporary config folder does not isolate machine-wide
  state: scheduled tasks, services, ports and the registry are shared.
  Before a test calls a lifecycle action, check what it can reach outside
  its folder, and decide ownership by the registration's executable, not by
  the name alone.

### 2026-11-14 — Sharing showed wrong, stale or missing Playit state
- **Problem:** Playit addresses lost their public port (*.ply.gg:12345 became host-only), so friends were sent to the default port. Only the first of several tunnels was listed. Sync Providers always created 0 endpoints, and saved shares stayed 'Pending'. An offline computer still showed the last 'Running' tunnel. The Share dialog judged sharing from another computer's cache, or from an empty one, offered 127.0.0.1 as a LAN address, and said 'Sharing stopped.' when the delete had failed. The Playit Service card stayed on 'Loading', because each 5 s poll threw away the slower management refresh.
- **Cause:** An address regex with no port group. Raw tunnel content was dropped before it was listed. agentClient's snapshot normalizer allowlisted fields and left out `tunnels`. Reconcile required an exact protocol match, while IPC v2 has none. Renderer caches had no owner computer and no freshness rule. A resolved `{ ok:false }` IPC envelope was treated as success. A request-serial guard was bumped by a poll that did not wait for the work it guarded.
- **Resolution:** Port-aware extraction. A sanitized `tunnels` list on the snapshot, carried through agentClient. Protocol-tolerant matching. Caches cleared on a computer switch, with 'Checking...' until this computer's state has loaded. Loopback is never a share address. `ok:false` counts as a failure. Polling waits for the management refresh. A single-flight Playit inspection cache with a 5 s TTL. CSS fixes for the Share dialog, Network panels and Phone Access. Covered by scripts/sharing-fixes-smoke.js.
- **Lesson:** When a value crosses a layer (Agent snapshot, agentClient normalizer, renderer cache), test the whole path with the real shape, including a second item and the port, not each layer's own fake. A renderer cache that drives a verdict needs an owner (nodeId) and a 'not loaded' state that is different from 'missing'. An in-flight guard must cover all the work it protects, not only the first await.

### 2026-11-14 — Server page state that belonged to no server

- **Problem:** Several Settings and Files tab bugs on the server page:
  - The Files editor kept server A's open file after switching to server B, and Save wrote A's server.properties into B.
  - Opening B on the remembered Settings tab showed A's game settings, and Save sent A's adapter and hash for B.
  - "Discard unsaved settings?" appeared with nothing edited, and "Discard changes" discarded nothing.
  - Memory such as "6GB" passed validation, then Save did nothing.
- **Cause:**
  - Per-server renderer state recorded no owner, and only a computer switch cleared it: the open file, the loaded game settings, and a baseline for Minecraft-property inputs that no longer exist (always "{}" against a reset "").
  - Opening a server without a tab never ran that tab's loader.
  - The leave prompt only asked; nothing reset the form.
  - The renderer's memory validator was looser than the save path and the Agent.
- **Resolution:**
  - The Files editor and game settings record their server. They are cleared when the selection or computer changes, and Save refuses when the owner is not the selected server.
  - open() always goes through setActiveInstanceTab.
  - "Discard" (button or leave prompt) resets every field and every game-settings section, and Back or switching asks about unsaved file edits too.
  - The dead Minecraft-property comparison and the empty saveMinecraftProperties call were removed, and memory validation uses the Agent's rule.
  - The sticky header offsets the scroller padding, and the Files grid can no longer outgrow its container.
  - Covered by `scripts/server-page-fixes-smoke.js` (9 checks, all fail on the old code).
- **Lesson:**
  - State that belongs to one server (an open file, a loaded config, a dirty baseline) must record that server and be checked by owner before it is shown or saved, not by "selection changed".
  - A Discard must actually discard.
  - A client-side validator must be the same rule as the server-side one, or Save fails silently.

### 2026-11-14 — Backup and file actions that did more, or less, than they said
- **Problem:** On an Agent computer, Delete on a symlink or junction deleted the folder it pointed to, and Rename moved that folder. A manual or pre-update backup pruned with the default 10 backups / 30 days, although the list showed the schedule's 30 / 90. Restoring an imported full backup brought back the old server id and created a phantom instance folder. Backups that restore would always refuse (one file over 256 MiB, more than 100,000 entries) were recorded as "complete" and "verified". SFTP Save and Replace of an existing file always failed. A restore that failed after stopping the server left it down. Cancel on "Restart after restore?" still restored.
- **Cause:** Each path used the nearest helper instead of the one that matched its meaning:
  - The Agent realpathed the operand.
  - Prune used defaults rather than the policy the list reported.
  - Only the cross-instance restore rebranded the record.
  - Create and verify did not share restore's limits.
  - SFTP v3 RENAME refuses to overwrite.
  - The restore restart lived only on the success path.
  - `Boolean(dialog)` turned Cancel into "no restart".
- **Resolution:** Delete and rename resolve only the parent and lstat the entry, and listings flag links. One `resolveRetentionPolicy` serves both list and prune. Every full restore goes through staging plus rebrand. `assertArchiveWithinRestoreLimits` runs at create, and verify streams tar headers. SFTP commits use posix-rename@openssh.com when a replace is intended. A failed or rolled-back restore restarts a server it stopped. The restart choice is a checkbox dialog whose Cancel cancels. Covered by `scripts/backup-file-fixes-smoke.js` (7 checks).
- **Lesson:** An operation on a path must name what it acts on: the link or its target, a replace or no overwrite. A reported policy or status ("within policy", "verified") must come from the same code that enforces it. Every exit from an operation that stopped a server must put it back.

### 2026-11-14 — AnxNet "Anyone can join" broke after restarts and never recovered

- **Problem:** After a reboot or host respawn, the gateway link re-registered about once a second and reopening a saved public route failed. A failed reopen deleted the saved route. Routes the gateway dropped (edge restart, 7-day grant expiry) were still shown as "on". Separately: invites pointed at the owner's old address, rosters over 16 KB with non-ASCII names failed their signature check, and the AnxNet panel's 5 s refresh wiped the relay/gateway form.
- **Cause:** openEdgeLink allowed two concurrent connects, and the superseded socket's close handler tore down the live one. The node never re-requested routes on reconnect, never renewed grants, and the edge never told the host it had closed a route. republishRoutes rewrote the saved routes without the failed ones. The coordinator list was frozen at network creation. jsonLineReader decoded each TLS chunk on its own. The redraw guard only checked focused elements with a placeholder.
- **Resolution:** One connect per link, and only the current socket owns link state. Routes are re-requested on every gateway connect and on 'route-closed', grants renew before expiry, and only confirmed routes are listed. Failed reopens stay saved, show in status().publicRouteErrors and retry with backoff. The owner publishes its current endpoints in the signed roster. Lines are decoded from bytes. The panel keeps focused fields and the unsaved edge form across redraws. Covered by scripts/anxnet-fixes-smoke.js (F1-F7).
- **Lesson:** A long-lived link needs one owner per connection: guard connects with an in-flight promise and let only the current socket clear state. State a remote holds only in memory must be re-asserted on every reconnect, and the remote must report what it drops. Never delete a user's saved intent because one attempt failed. Decode protocol text only after framing on bytes.

### 2026-11-14 — Shell pages that showed or acted on the wrong thing
- **Problem:** A node drawer opened for one computer switched to the selected computer's health within 5 s, and its Test connection tested the selected computer. Outside Home and Computers no page re-checked node health, so the chip stayed "Connected". Every health check briefly recorded a working computer as "Connecting", which raised "Node offline". Home showed "0 of 0 running" in local-only mode and "—" for players that servers did report. Default page / Restore previous page did nothing. Any settings save reset onboarding and dismissed tips. A recovered Activity item gained another " — recovered" on every sync. The Docker page overflowed at 981-1210 px. The Routes modal always said "Not checked yet".
- **Cause:** Each piece of UI read the nearest shared value instead of its own: the drawer read the selected node's health, the Home tiles read fleet totals that never include the application host, and the players tile read a display string. The fallback 'dashboard' hid the Default page. saveSettings sent every DEFAULT_SETTINGS key. A sync re-applied a one-time annotation. A check overwrote the last known state at its start. A viewport breakpoint ignored the sidebar.
- **Resolution:** The drawer renders and acts on its own computer. The fleet re-check runs on every visible page at 30 s. Home uses fleet counts only when they cover every listed computer, and it reads numeric player counts. resolveStartupPage honours both settings. saveSettings sends only its inputs. The recovery suffix is applied to a stripped message. checkNodeHealth keeps an online or degraded state until the probe answers. The Docker workspace collapses with a container query. The Routes main row follows the connection. Checks S1-S10 are in scripts/shell-fixes-smoke.js.
- **Lesson:** A view that can show something other than the selected computer must carry its own target through rendering and actions. Shared fallbacks ('dashboard', DEFAULT_SETTINGS, fleet totals) must never stand in for "unknown". An annotation applied on every sync must be idempotent. Size layout from the container, not the viewport, when a sidebar takes part of the width. When smokes run with AGENT_URL overridden for safety, some legitimately fail; compare against the base before blaming a change.

### 2026-11-14 — Engine rules that held only for the case they were written for
- **Problem:** Six separate engine defects:
  - Marketplace Palworld servers always reported the REST API as off.
  - A "Daily at 04:00" restart ran at 03:00 or 05:00 after a DST change.
  - A server that crashed 30 s after each start was restarted forever ("failure 1").
  - Healthy servers showed READINESS_TIMEOUT.
  - Job records were never deleted and were read one by one at every boot.
  - On a Windows Agent, CPU/RAM read "Measuring…" forever, and systemd servers showed 0 s uptime.
- **Cause:**
  - The player monitor hard-coded the flat Palworld layout instead of the install-directory resolver Game Settings uses.
  - Daily schedules advanced by a flat +24 h.
  - The crash-loop budget reset on any exit after 8 s.
  - The ready-line path never cancelled the startup timer.
  - jobLifecycle had no retention.
  - A sample with no usage fields was read as "first sample". getMetrics ignored the unit uptime it already had.
- **Resolution:**
  - Palworld settings now come from getPalworldConfigCandidates.
  - Daily schedules re-anchor to the wall clock at every advance.
  - A crash within 10 minutes of starting counts toward CRASH_LOOP.
  - A ready line cancels the timer and clears only a timer-recorded READINESS_TIMEOUT.
  - Terminal job records are capped at 200 per server. Running records and recent keyed records are never pruned, and the store loads 16 files at a time.
  - reportsUsage() tells "not measured" from "warming up", and service uptime is used when there is no PID.
  - All six are covered by scripts/instance-engine-fixes-smoke.js (IE1-IE6), and each check fails on the old code.
- **Lesson:** Reuse the resolver the rest of the app already trusts instead of re-deriving paths. Test time rules across a DST boundary with TZ pinned. Define a crash loop by run stability, not by a startup window. Any timer that writes state must check the state it would overwrite. Every append-only store needs retention from day one. A UI that waits for data must be able to say the data will never come.

### 2026-11-14 — Local Agent connectivity: task time limit, install/repair, tunnels, tokens, restart policy

- **Problem:** The Windows Local Agent stopped after 3 days of sign-in and nothing restarted it. Install Local Agent always failed while the Agent was running, and Stop Old Local Agent and Repair left the Agent stopped. An SSH tunnel stayed "failed" after the SSH agent service started. Node probes with an empty token sent this PC's Local Agent token to remote URLs. Agent Control marked remote nodes Connected from the public /health route. Restart policy "On failure" never restarted a crashed desktop-managed Agent.
- **Cause:** Six separate defects:
  - New-ScheduledTaskSettingsSet defaults (ExecutionTimeLimit PT72H, RestartCount 0), and inspection that never read those settings.
  - Install rotated the credential under an Agent that reads its token only at startup.
  - The repair posted to the Agent it had just killed.
  - Tunnel preparation errors went straight to "failed".
  - getAgentConfig treated "" the same as "no token given".
  - recordAuthenticatedNodeHealth was trusted after an unauthenticated call.
  - The exit handler's restart condition was `code && policy === "always"`.
- **Resolution:**
  - The task is registered with no time limit and restarts 3 times, and repair now detects old tasks.
  - Install keeps a credential the running Agent accepts, or restarts the Agent after rotating.
  - The repair starts the Agent first and leaves it running if a later step fails.
  - SSH_AGENT_UNAVAILABLE is retried with backoff and keeps its own message.
  - An explicit "" now means no credential.
  - Nodes that are not selected are verified by token fingerprint, or by an authenticated call when the Agent reports none.
  - shouldRestartManagedAgent follows the systemd meaning, with backoff and an intentional-stop flag.
  - Regression coverage: `scripts/agent-connectivity-fixes-smoke.js`, 8 checks.
- **Lesson:** Cmdlet defaults are part of the spec. Pin every scheduled-task setting that matters and make inspection compare it. A credential change must name who reloads it. Never ask a process you just stopped to do the next step. "Retryable" must mean "will succeed later without the user", not "the user may retry". A public health reply proves reachability only, never authentication. An empty value and a missing value must have different meanings when one of them falls back to a secret.

### 2026-11-14 — Alerts and notifications never saw a single server
- **Problem:** The alerts panel never showed a crashed or degraded server, disk pressure or a stale backup. The Notifications page never logged 'Service crashed'. An outage that began within 10 minutes of a recovery was never logged, so the journal ended on 'Machine back online'. The assistant proposed restarting a server on This PC when the user named an offline VPS, and blamed one server's failed internet check on another. One cut-off webhook response stopped every later Agent alert.
- **Cause:** Instance records carry no nodeId, and both collectors passed them on unchanged, so both engines dropped every row. The alert snapshot read disk and backups from fields that real node records never carry. The dedupe window dropped suppressed events instead of keeping them, and an unchanged state never retried them. resolveTarget's game and only-server fallbacks ignored the named computer. server.diagnose used the computer-wide connectivity, which merges every server's checks. postJson settled only on 'end' or 'error', and a reset after the headers fires neither. Every existing smoke passed because its fakes used the evaluator's expected shape (nodeId added, top-level disk, node.backups) instead of the producers' real shape.
- **Resolution:** The collectors stamp the node each list was read for, and Starting/Stopping/Restarting or a Stop with no failureReason are no longer incidents. Disk readings come from telemetry or the Agent profile, and only the newest backup of each existing server is checked. Suppressed problems are deferred and announced once the window has passed. A named computer bounds every assistant step, and an offline one is reported. Join diagnosis reads the server's own cached check. postJson settles on every exit, with an overall deadline. scripts/alerts-ai-fixes-smoke.js feeds real records (instanceServiceCore.listInstances, nodeService shapes, Agent backup rows) through the production collectors.
- **Lesson:** Feed an engine's tests through its production collector with records read from the real producer, never with rows shaped for the evaluator. A deduplicating notifier must defer what it suppresses, not drop it. A promise around a network call must settle on every way out, with a deadline behind them.

### 2026-11-14 — The fixes for 62 defects introduced 31 more
- **Problem:** The 62 fixes above all passed their own failing-first regression checks, and the full smoke suite and `qa:release`. Three adversarial review rounds of the fixes still confirmed 31 new defects. Among them, an infinite loop in the daily-schedule DST fix for 00:xx schedules on a fall-back day would have hung the Agent. Two later versions of the Files fix again let Save write one server's file into another.
- **Cause:** Each regression check proved its finding's scenario and nothing next to it:
  - A day loop was tested only away from midnight.
  - A "settled" flag was tested only for the tunnel list, not for a failed snapshot.
  - An owner field was inferred from another field that other code rewrites.
  - A retry was cleared only by a message that members on older builds never send.
  - A UI fixture built state without the owner field the new contract required, so the new reload replaced it.
- **Resolution:** Each fix went through review rounds: an independent reviewer, then a verifier trying to refute each claim, each claim fixed with a check that fails first. Rounds continued until a review found nothing new. The open file now records its own server (`openedInstanceFileInstanceId`). `nextDailyRunMs` steps calendar days. The coordinator-move notice clears on any register, and stops after a bounded number of dials while the old link stays open. The UI fixture sets `instanceId`.
- **Lesson:** A passing regression check proves only its own scenario. Review every fix as new code:
  - Test time loops at boundaries (DST days, midnight hours) under a timeout.
  - Give every piece of state its own owner, never one inferred from a field other code rewrites.
  - For a networked fix, ask what a peer on the previous build does.
  - When a contract changes, update the fixtures that build that state by hand.

### 2026-11-14 — Stale snapshots and replaced identities
- **Problem:** State was silently lost in four places:
  - An unreadable AnxNet device key was replaced with a new identity, losing network ownership.
  - The backup scheduler reverted schedule edits made during a backup.
  - A SteamCMD update reverted settings saved while it ran.
  - The desktop and the Local Agent erased each other's long-operations.json records.
- **Cause:** Each writer either wrote back a whole object it had read before a long await, or treated 'cannot read' as 'does not exist'. The AnxNet key also used a fallback cipher key that includes os.hostname().
- **Resolution:**
  - The device key is created only on ENOENT, by temp file and link. An unreadable key is kept, with a recovery copy, and a typed ANXNET_DEVICE_KEY_UNREADABLE error is raised. New fallback records store the computer name, and an in-process node never starts beside a host that answered.
  - The backup schedule store is serialised, and results are merged by id after each backup.
  - The SteamCMD update reloads the config and patches only its own fields.
  - The Agent uses long-operations.agent.json.
  - Covered by scripts/state-durability-hardening-smoke.js.
- **Lesson:** After any await that can take seconds, reload the record and patch only the fields that operation owns. Never save a snapshot taken before the await. 'Exists but unreadable' must never take the 'missing' path for state that cannot be rebuilt, such as identity keys. Two processes that share a folder need one file per owner.

### 2026-11-14 — Pre-auth Agent gates trusted a 48-bit fingerprint, stayed open after pairing, and buffered anonymous uploads
- **Problem:** On a network-reachable Agent: (1) the pairing and enrollment re-pair gates accepted any value whose tokenFingerprint matched the live token, and /api/v1/health published that fingerprint to anyone; (2) a node paired since its last restart had no enrollment record, so anyone could re-pair it with their own token; (3) an anonymous caller could make the Agent buffer up to 256 MB per request before the Host or token check ran.
- **Cause:** The fingerprint (12 hex characters of SHA-256, 48 bits) is a display value but was used as proof of possession, so a colliding string can be found offline. completePairing never wrote an enrolled record; only migrateLegacyBinding at startup did. handleRequest read the whole body before assertTrustedRequest and isAuthorized.
- **Resolution:** agentTokensMatch compares the presented value to the live token in full. Health and enroll/status return the fingerprint and config path only to loopback or authenticated callers (canReadCredentialDetails). bindEnrollmentFromPairing enrolls the node as soon as pairing completes. Host and auth are checked from the headers first, and a caller without a valid token is capped at 64 KB. scripts/agent-api-security-hardening-smoke.js covers all three.
- **Lesson:** A truncated hash is an identifier, never a credential: authorize only by comparing the full secret. A security gate that keys on persisted state must have that state written by the same operation that opens the window, not by a later restart. Do header-only checks (Host, auth, size) before reading any request body.

### 2026-11-14 — A dropped file or link could replace an app window, with the bridge attached
- **Problem:** Dropping a file a few pixels outside a drop zone replaced the main window with that file. A dropped .html page kept preload.js and the full window.anxos bridge. Dragging a CurseForge link onto Marketplace navigated that window to the website. window.open in the workspace windows did nothing, and SSH bursts lost everything past 16,000 characters per packet.
- **Cause:** The will-navigate guards allowed every `file://` URL. The workspace windows had no will-navigate handler and a deny-only window-open handler. Nothing in the renderer cancelled drops outside the zones. sshIpc used `.slice(0, 16000)` on each 32 KB ssh2 packet, and sshService decoded each packet separately.
- **Resolution:** `applyWindowNavigationGuard` (src/services/windowNavigationGuard.js) is applied to every BrowserWindow. It allows only the window's own page by exact path, refuses UNC hosts and sends everything else to openExternalUrl. A document-level drop guard cancels stray drops. SSH output is split rather than cut, and is decoded with a per-stream StringDecoder. Regression: `scripts/ipc-boundary-hardening-smoke.js`.
- **Lesson:** `file://` is not "our page". Every window that loads the preload must allow only its own page, by exact path, and every new BrowserWindow must go through the shared guard. A size cap on a stream must split, never truncate, and a byte stream must be decoded with a streaming decoder.

### 2026-11-14 — Stop killed Windows servers without saving, left launcher children running, and trusted recycled PIDs

- **Problem:** Several things went wrong in how servers were stopped and started:
  - On Windows, Stop, Restart and scheduled restarts cut game servers off with no world save.
  - Script-launched servers (`cmd.exe /c run.bat`, `bash run.sh`) kept running after the record said Stopped.
  - After a reboot, a recycled PID was shown as Running and could be killed by Stop or Force Kill.
  - Agent upgrades and desktop quit killed every server after 5 s.
  - "Start with the computer" did nothing.
- **Cause:**
  - The only graceful step was `process.kill(pid, "SIGTERM")`, which is TerminateProcess on Windows. It went to a single PID, with no process group or tree kill.
  - A persisted PID was trusted whenever no identity data existed, which was always the case on Windows and for every spawned server.
  - Shutdown passed a fixed 5000 ms cap.
  - No boot code read `autoStart`.
- **Resolution:**
  - Stop writes the game's console stop command (`stop`/`end`/`shutdown`/`exit`/`quit`) first, then sends SIGTERM to the process group (POSIX), then force-kills the tree (`taskkill /T /F` on Windows).
  - Spawns record a process identity (start time plus boot), which is checked before a persisted PID is trusted.
  - Shutdown uses each server's own timeout up to a 60 s ceiling.
  - `startAutoStartInstances` runs at Agent boot and desktop launch, and uses `stopOrigin` to leave operator-stopped servers down.
  - Covered by `scripts/process-supervision-hardening-smoke.js`.
- **Lesson:**
  - A signal is not a shutdown request on Windows. Use the program's own stop channel first.
  - Stop the tree you started, not the PID you remember.
  - A PID alone is not an identity: record its start time and refuse to trust or signal a PID that cannot be proven to be yours.
  - Kill paths that bypass `process.kill` (group signals, taskkill) must act only on real children the service spawned, or test fixtures with fake PIDs will reach real processes.

### 2026-11-14 — Agent version checks compared a placeholder ("0.1.0" vs "0.1.0")
- **Problem:** The remote push downgrade guard and the Local Agent update state never fired. An older Desktop could push its older Agent over a newer node and report "updated".
- **Cause:** Every Agent reported agent/package.json's fixed placeholder version, and the Desktop compared it with the same file. The pre-flight health probe also read agentVersion from the wrong level of checkNodeHealth's result, so it was always null. The only test injected bundledVersion "9.9.9", which hid both problems.
- **Resolution:** Agents report their release build (identity.agentArtifactVersion: environment variable from the Desktop, then the agent-build.json stamp written by a push, then agent-release.json, then release.json). Push and Local Agent checks compare builds. A node with no build predates this check; a build the Desktop cannot order is refused (AGENT_BUILD_UNVERIFIED); verify fails if the node still reports the old build. Upgrades keep the Helper task: the installed uninstaller runs -Mode Stop when ${isUpdated}. Full restores swap by rename-aside and are recovered at Agent startup. Install reopens the installer after a handoff in the same session. Covered by scripts/upgrade-migration-hardening-smoke.js.
- **Lesson:** A guard is only as good as its inputs. Test a version guard with values produced by two real builds, through the real probe's response shape, not with injected fake versions. A destructive swap must keep one complete copy on disk at every instant, and startup must repair it.

### 2026-11-14 — Logs that were out of order, duplicated, split between folders, or never written
- **Problem:** A burst of server output (a stack trace) was stored in the Console log out of order, and a line or UTF-8 character cut at a pipe chunk boundary was stored as two corrupted entries. The packaged desktop wrote its logs to `AnxOS Control Center\logs`, while Open logs folder, the reported directory and the enriched latest-error.json used `AnxHub\logs`, overwriting the Agent's latest-error.json. The diagnostics viewer, the export bundle and the latest-error context listed every entry twice. A Windows task-run Agent kept no action audit records at all.
- **Cause:** appendLog awaited a stat before stamping and appending, with no per-file queue, and the pipe handlers did not await it. Chunks were decoded one at a time with String(chunk). diagnosticsService resolved its folder again after configureElectronPaths had moved userData. StructuredLogger writes each entry to its subsystem file and to live.log, and readLogs merged both. auditAction wrote only to console.info, and a GUI process started by Task Scheduler has no console.
- **Resolution:** Per-file write queues, with the timestamp taken when the output arrives. A per-stream StringDecoder plus line carry-over, flushed when the stream ends. One log directory, resolved once and shared by the logger and every helper. Agent Control advertises the folder the Agent really uses. readLogs de-duplicates by raw line (max count per file). Audit records also go through the Agent's structured logger (audit.log). Covered by `scripts/observability-hardening-smoke.js` (O1-O4, each fails on the old code).
- **Lesson:** Any fire-and-forget async writer to a shared file needs a queue that keeps call order. Frame stream text on bytes and lines, never per chunk. A path resolved from mutable process state (app.setPath, env) must be resolved once and shared, not re-read by each helper. A reader that merges files the writer duplicates into must de-duplicate. Never rely on stdout for records that must persist on platforms where nothing captures stdout.

### 2026-11-14 — Timed-out SteamCMD runs, open download streams and a backup scheduler that undid edits
- **Problem:** A SteamCMD update or build lookup that timed out could hang forever. It blocked every later SteamCMD task on the node and left a server stopped after its scheduled update restart. Aborted backup and file downloads kept the archive open on the Agent. The desktop aborted every download that took longer than 30 s. A backup schedule that the user disabled, changed or deleted during a long scheduled backup came back.
- **Cause:** Bounded child runs killed only the direct child and waited only for 'close'. A wrapper like /usr/games/steamcmd runs the real binary as a grandchild that keeps the pipes open, so 'close' never fired. sendStream used pipe(), which unpipes but does not destroy the source when the client goes away. requestBuffer's 30 s timer covered the whole body read. runDueSchedules wrote back the list it read before the backup, with no lock, merge or in-flight guard.
- **Resolution:** POSIX children run in their own process group. Timeout and cancel kill the group (taskkill /T /F on Windows). A run settles on 'close', or 2 s after 'exit' with its pipes destroyed. withSteamCmdLock has a backstop deadline. sendStream uses pipeline(). Backup and file downloads use a 60 s idle timeout instead. Schedule writes are serialized, ticks share one run, and each backup's result is merged into a fresh read (the user's edits win). Covered by scripts/resource-leaks-hardening-smoke.js (3 checks, each fails on the old code).
- **Lesson:** A child run must be bounded by its whole process tree and settle on 'exit', not on 'close' alone. Any stream piped to a socket must be destroyed when the socket closes. Large transfers need an idle timeout, not a total one. A scheduler that writes back state it read before a long await must re-read and merge, and must never overlap with itself.

### 2026-11-14 — Install and update paths that reported success or "restored" without proof
- **Problem:** Three install-integrity defects. (1) A remote Agent push update whose publish copy failed (for example, a full disk) left the Agent stopped with agent/ deleted, and the app said "the previous runtime was restored". (2) SteamCMD updates were SIGKILLed at 10 minutes, so a large validate plus download could never apply, and the scheduled path then started the server on whatever was on disk. (3) Paper sha256, Mojang sha1 and Modrinth per-file hashes were fetched but never compared with the bytes.
- **Cause:** (1) `set -e` ended the swap script inside the publish loop, before the rollback branch, and the Desktop mapped any non-zero exit to "restored". (2) Updates reused the 10-minute installer cap, and every surrounding budget (jobs, HTTP, socket) was sized for it. (3) Only the Hytale resolver set `sha1`, so the other digests sat in fields nothing read.
- **Resolution:** (1) The swap script rolls back on any publish or start failure and prints a marker only when the restore and restart both worked. It checks free space before the stop and prunes old update folders, only inside .anxos-agent-update. The Desktop reports what the markers say. (2) SteamCMD updates get a 2 h ceiling and a 30-minute no-output watchdog, and all budgets were raised (job max 3 h). A killed scheduled update whose appmanifest StateFlags are not "fully installed" marks the server Failed (STEAMCMD_INSTALL_INCOMPLETE) instead of starting it. (3) Every publisher digest is enforced before writing (DOWNLOAD_CHECKSUM_MISMATCH). `scripts/install-integrity-hardening-smoke.js` covers all three.
- **Lesson:** A rollback message must come from a marker the rollback itself printed, never from "exit code was non-zero". Under `set -e`, any step after a destructive one must sit inside a condition that rolls back. When a time limit is raised, follow every layer that wraps it (job, HTTP client, server socket, job-engine clamp). Hash metadata a resolver fetches is worthless until a test serves substituted bytes and expects a refusal.

### 2026-11-14 — A paired or removed remote Agent could be taken over from the network
- **Problem:** A newly paired remote Agent stayed un-enrolled until its next restart. Until then, any host that could reach its port could pair again with its own token and lock the owner out. "Remove computer" revoked the enrollment and reopened the same takeover. Node-credential recovery could save This PC's Local Agent token as a remote node's credential. A changed SSH host key could never be approved.
- **Cause:** Only startup migration and revoked-record recovery wrote enrollment records, and the pairing and enrollment gates checked only the state 'enrolled'. The credential recovery path did not check whose token it was handing out. A host-key mismatch never created a pending approval.
- **Resolution:** Pairing writes the enrolled record right away (bindEnrollmentFromPairing). A revoked Agent pairs or enrolls again only from loopback, with its live credential, or through a session the operator opened on the host. Recovery gives the configured token only to This PC's Agent and never replaces a store whose keyring is only temporarily unavailable. A changed host key can be replaced after a typed confirmation that shows both fingerprints, and the affected tunnels are retried. Covered by `scripts/remote-nodes-hardening-smoke.js`.
- **Lesson:** Every state an authorization gate does not name (no record, revoked, drifted) is a way in. List all of them, and close the bootstrap window in the same step that consumes it, not at the next restart. A credential must only go to the endpoint it was issued for. A recovery path must never destroy data that may become readable again.

### 2026-11-15 — A crash-safe restore had a destructive rollback, and updates removed the Helper

- **Problem:** A full restore swapped folders crash-safely, but its rollback
  after a failure still deleted the server folder and then extracted the
  safety snapshot in place, so an Agent stopped in between left no server.
  Separately, Build 211's uninstaller removes the Helper's startup task on
  every update, before the new installer runs.
- **Cause:** The rollback was written as cleanup, not as a second restore.
  The installer only re-registered the Helper when the box was ticked and
  the prompt accepted, and nothing noticed when it was not.
- **Resolution:** The restore and its rollback share `swapInStagedInstance`,
  which startup recovery repairs at every step, and Agent shutdown waits for
  running restores. Setup checks for the task before the old uninstaller
  runs, never drops an existing Helper on an update, and leaves a marker
  that makes the app offer Restore AnxOS Helper until the task exists.
  `scripts/upgrade-migration-hardening-smoke.js` checks 5 and 6 and
  `scripts/agent-control-foreign-task-stop-smoke.js` S5 failed before.
- **Lesson:** A rollback is a destructive operation too and needs the same
  crash-safety as the change it undoes; test a stop in the middle of it.
  When an older build's uninstaller does the damage, the new installer has
  to detect it first and the app has to offer the repair, because the old
  code on disk cannot be changed.

### 2026-11-15 — Build 212 RC1 acceptance: six screens that showed the wrong thing

- **Problem:** The signed RC1 upgraded cleanly, but acceptance in the real app found six screens showing something other than what they claimed:
  - Agent Control said "Version 0.1.0" for a 2.0-build212 Agent.
  - While locked, the app polled and logged LOGIN_REQUIRED errors.
  - Home told the user to "Connect your local Agent" when an offline remote computer was selected.
  - Docker's row actions sat behind a horizontal scroll.
  - SSH's status line showed another session's message.
  - Files read "Connected" for an offline computer's storage.
- **Cause:** Each screen read the nearest available value instead of its own:
  - the package placeholder instead of the reported build (the node identity allowlist dropped it);
  - a polling gate that knew about node switches and hidden windows, but not the lock;
  - the selected computer's Agent status, phrased as this PC's Agent;
  - a fixed 1040px table minimum inside a narrower column;
  - one global SSH status string for every session;
  - the Files pill written twice, the second time from the selected computer's Agent status.
- **Resolution:** `3097c7ec` fixed each value at its source:
  - a build label from `identity.agentArtifactVersion`, cleared on a reply without one;
  - `isAppLockedForBackgroundWork` in the shared gate and in each page poller;
  - a `selected-computer` action;
  - container-sized Docker columns;
  - SSH status messages that record their session;
  - `getFilesFolderStatus`.

  `scripts/acceptance-fixes-ui-qa.js` (each case failed on the RC1 commit) now runs in `qa:release`.
- **Lesson:** A value on screen must come from the thing it describes: the build the Agent reports, the storage Files selected, the session being shown. Hermetic suites passed all six. Only clicking through the installed app found them, so keep a real-app acceptance pass in every release, and turn what it finds into a real-app check in the release tier.

### 2026-11-15 — Build 212 RC2 acceptance: three more screens, one of them every error toast

- **Problem:** The signed RC2 upgraded cleanly over RC1. Its acceptance found three more issues:
  - The Local AnxOS Agent card read "Build not reported" for a 2.0-build212 Agent while Anxlab was selected.
  - Home's setup checklist kept "Agent connected" for minutes after switching to the offline VPS.
  - Error toasts never left the screen. RC2's checks passed because they tested the `is-visible` class.
- **Cause:**
  - Agent Control skips the local probe while a remote computer is selected (requests follow the selected computer), so the local card had no build.
  - Home read the last Agent Control reply, and `getAgentControlOverviewTarget` prefers the computer that reply was read for over the current selection. Agent Control polls only while its page is open.
  - A generic `[data-tone="error"]` fade-in animation (`e98446ba`) has fill mode `both`. A filled animation overrides normal declarations, so it held opacity 1 over `.toast`'s opacity 0 after the class was removed.
- **Resolution:**
  - The local build is read from the Agent's public health reply with no credential, only for this installation's running Agent, cached 30 s (smoke S6).
  - Home ignores a reply for another computer (A7).
  - The animation excludes `.toast`; A8 now measures computed opacity.
  - Each check failed on RC2.
- **Lesson:** Check what the user sees, not the state meant to cause it: a class or flag can be right while the screen is wrong. A broad attribute selector with a filled animation overrides every component that reuses the attribute. A reply that records its target must be checked against the current selection by every reader, not only the page that requested it.

### 2026-11-16 — The website's static HTML still said Build 205 after Build 212 shipped

- **Problem:** With Build 212 published, the website's static HTML, its meta
  descriptions and the Releases repository README still named Build 205 (or
  Build 199) as current. Visitors with JavaScript saw Build 212, but crawlers,
  link previews and AI tools reading the raw HTML were told an old build was
  the latest.
- **Cause:**
  - Promotion regenerated `website/config.js` and `release-notes.json` only.
  - `site.js` corrected the page at runtime, so a browser check always looked
    right.
  - Version badges and meta tags were hand-written, and the READMEs were
    edited by hand.
  - The sync also stamped "today" as the release date, so its output depended
    on the day it ran.
- **Resolution:**
  - `scripts/release-docs.js` derives every static current-release surface from
    `config.js`: the elements `site.js` already renders, `data-release-managed`
    text, JSON-LD and the README sections between `anxos-release` markers.
  - Promotion runs it, checks the result, and updates the Releases README
    section with the release token.
  - The Pages deploy refuses stale output.
  - `release-consistency-smoke.js` covers cases A–G.
- **Lesson:** A page that is right only after JavaScript runs is wrong for every
  crawler. Check what the raw HTML says, not what the browser shows. Every
  surface that names "the current release" needs a generator and a check, or it
  will go stale on the next release.

### 2026-11-16 — The phone opened binary files as editable text

- **Problem:** Tapping a `.jar` or an image in the phone's Files tab opened
  it in the text editor as mangled characters; one edit and Save would have
  written them back over the file. Binary files could be uploaded from the
  phone but not downloaded.
- **Cause:** The only file read (`readInstanceFile`) decodes UTF-8, so
  invalid bytes become U+FFFD and NULs stay in the text. The phone sheet
  trusted `supported: true` and offered the decoded text for editing.
  Uploads had been fixed to send base64 (2026-11-12), but reads never were.
- **Resolution:** The Agent streams a file's exact bytes
  (`/instances/:id/file/download`, same path checks, 64 MB cap); the phone
  offers Download, and a text read that decodes to NULs or U+FFFD is
  refused as "binary". An older Agent is reported as "update the Agent".
  `instance-file-download-smoke`, gateway G26, `mobile-ui-qa` M7.
- **Lesson:** When one direction of a data path is fixed for binary
  content, check the other direction too. Never offer decoded text for
  editing unless the decode was lossless.

### 2026-11-16 — Cancel during an update's backup or queue still ran SteamCMD (#53)

- **Problem:** Cancelling a SteamCMD update while its pre-update backup ran,
  or while it waited for another SteamCMD task, returned "cancelled", and
  the update then started anyway and could report success. Reproduced on
  the published Build 212 in an isolated harness.
- **Cause:** `executeSteamCmdUpdateUnobserved` validated the session once,
  before its waits. Before SteamCMD spawns there is no child to kill, so
  `cancelInstallationSession` only marked the session closed and dropped
  it, and nothing read that again before the spawn.
- **Resolution:** The update re-checks that its exact session is still
  live after the backup (also when the backup fails) and inside the
  SteamCMD lock immediately before spawning, and ends as
  STEAMCMD_UPDATE_CANCELLED with nothing changed; a queued cancel answers
  at once. The desktop offers Cancel only when the Agent reports
  `cancelBeforeStart` or SteamCMD is running, holds an earlier cancel, and
  `cancelDownload` refuses an operation that can't be cancelled instead of
  marking it cancelled. `steamcmd-update-cancel-desktop-smoke` and the
  real-app `steamcmd-cancel-ui-qa` cover the desktop side.
  `scripts/steamcmd-update-cancel-smoke.js` C1 and C3 fail without each
  check; C0 and C4 are the success and after-spawn controls.
- **Lesson:** A cancel that can be acknowledged before the work starts must
  be re-checked after every await that comes before the point of no
  return, not only at entry. Test each wait window with a deferred fake,
  not only "cancel while running".

### 2026-11-16 — Build 213 RC1 acceptance: a panel that showed placeholders, and readers that probed the real Agent

- **Problem:** The signed RC1 upgraded cleanly, but:
  - Automatic Agent updates showed placeholder values with Save enabled for
    about 15 s; a Save then would have overwritten the saved settings.
  - Copy edge config took one of the edge fields' grid cells.
  - Re-running the release tier, the developer's real Local Agent logged 138
    refused requests from the Build 213 UI tests (0 for Build 212's tier).
- **Cause:**
  - Agent Control loaded the panel only after its own check of every Agent,
    and the panel then checked every Agent again; the form was live before
    its data.
  - Every child of the edge form's grid gets a cell.
  - The fleet list, update overview and move checks called
    `nodeService.listNodes()` without options. Its default runs Local Agent
    discovery, which probes 127.0.0.1:47131 (health, stats, instances and a
    dependency check) on every call, in the tests and in the installed app.
- **Resolution:** One shared overview request, settings shown at once,
  controls disabled until they load, and Save keeps the saved computers
  while the list loads (`build213-ui-qa` C2). Copy edge config sits in its
  own row (`anxnet-ui-qa` U4). The three readers pass
  `{ discoverLocalAgent: false }` (`local-agent-discovery-scope-smoke`).
  Each check fails on the RC1 code.
- **Lesson:** A form must not be editable before the data it edits has
  loaded. A new caller of a shared reader must pass the options every
  existing background caller passes; read their call sites first. Count the
  real service's log during every UI test run, not once per release: here it
  caught a production-side probe loop as well as a test leak.

### 2026-11-18 — Build 214: real installs found what the mocked suites passed

- **Problem:** Several cards that passed their mocked tests did not work on a
  real computer:
  - Every Modrinth modpack failed (since Build 193).
  - On Windows, a Minecraft server failed to start when a Java of the
    version it needs was also installed under Program Files.
  - Every Python card stopped at the dependency check on Windows.
  - "Discord.js Bot" installed an HTTP server and "Python Discord Bot" a
    sleep loop.
- **Cause:**
  - The mocked Modrinth packs contained a `server.jar`; a real `.mrpack`
    never does. Its start command also kept the default jar name, and the
    Agent's jar repair keeps the jar already in the arguments.
  - Two rules decided which Java may run: the resolver sorted runtimes of
    one version by path, so `C:\Program Files\Java` beat the bundled one,
    and the Agent's executable roots then refused it.
  - The Python dependency was checked as `python3`, which is the Microsoft
    Store stub on Windows.
  - The bot cards were only tested for "an install completed".
- **Resolution:** The pack's declared runtime is installed and the start
  command names its jar (`ac61585a`). The bundled Java wins within a version
  (`fdd90408`). Python is detected as `python` on Windows (`0f2fdcec`). The
  Discord.js card deploys the user's bot with its token in the server secret
  store, and the Python bot card says why it is unavailable (`b9181a42`).
  Each fix has a check that fails on the old code, and each card has a real
  install (`marketplace-*-real-install`).
- **Lesson:** A provider integration needs one real install per provider
  before it ships: a fake shaped like what the code expects hides that real
  data lacks a field. When two components decide the same thing (which
  executable may run), they must share one rule. A card's name is a claim:
  test that what it installs is what it says, not only that it installs.

### 2026-11-19 — Build 214 RC1 acceptance: a required field the user could not see

- **Problem:** In the installed RC1, Create server for the Discord.js Bot,
  the Node.js/Python/Java project cards and Jellyfin said "Enter the bot
  token to continue." (or the file or folder) and nothing visible changed.
- **Cause:** Those required inputs live in Advanced options, which is closed
  by default. The new checks focused the field without opening the section,
  unlike the port checks. The UI test helper opened the section before every
  check, so A3 and J1 passed.
- **Resolution:** The section opens for a template that needs such an input,
  and each missing-input check opens it before focusing.
  `acceptance-fixes-ui-qa` A9 and `build214-ui-qa` A4 close the section first
  and assert the field is visible and focused; both fail on RC1.
- **Lesson:** A test helper that prepares the screen (opens a section,
  dismisses a dialog) must not do what a user would have to discover. Test a
  validation message by what the user can then see and reach, from the
  default state.

### 2026-11-19 — Agent package update restarted unrelated services

- **Problem:** Installing the Agent .deb with `DEBIAN_FRONTEND=noninteractive`
  restarted an unrelated service on Ubuntu (Build 214 report, bug B).
- **Cause:** Ubuntu's `needrestart` apt hook restarts every service that maps
  a replaced library and, without a terminal, does it without asking.
  Reproduced on a disposable Ubuntu 24.04 container: a test service went from
  PID 460 to 615.
- **Resolution:** The install runs with `NEEDRESTART_SUSPEND=1
  NEEDRESTART_MODE=l`, apt's dry run must show only `anxos-agent` changing,
  and services needing a restart are reported as deferred (PID unchanged in
  the same test).
- **Lesson:** Package installs on a shared host need their side effects
  bounded and reported: suspend restart hooks, refuse transactions that touch
  other packages, and test with a disposable service before and after. Also,
  files a package owns (such as a sudoers drop-in) are replaced by every
  version of that package, so test rules for a new feature must not live in
  an older package's file.

### 2026-11-20 — Build 215 RC3 acceptance: one Docker listed under two computers

- **Problem:** My Servers > All computers listed every Docker container
  twice, once under the application host and once under the Local Agent on
  the same PC. Separately, P1 read a result line after the post-action
  refresh had replaced it and failed, although the screen was right.
- **Cause:** Both computers read the same machine-wide Docker daemon, and the
  fleet summed per-computer lists. Agent Control's status line sits in the
  hidden Status section and every action's closing refresh rewrites it.
- **Resolution:** A container with the same Docker ID and name from two
  computers is listed once ("also <computer>"); P1 reads the visible failed
  step. `server-fleet-smoke` F13 and `build215-ui-qa` W1 fail on RC3.
- **Lesson:** Two "computers" can be one machine. When a list merges
  per-computer reads of a machine-wide resource (Docker, ports, services),
  test with the application host and a Local Agent on the same PC. Assert
  on what the user can see; a hidden element's text is not the screen.

### 2026-11-20 — Build 216-A1: a new shell judged against the old one

- **Problem:** The first full test pass of the new AnxHost shell had 3 smoke
  failures and 7 real-app suite failures. Startup met the approved budgets, but
  a 3-round same-day comparison by mean put it 14 to 62% behind Build 215 at
  1280 and 1920 px.
- **Cause:** Three smokes asserted text or structure the approved design had
  changed (welcome title, Network as its own sidebar entry). Four suites failed
  only while a full `rc:validate` sweep ran beside them and passed alone.
  `server-view-ui-qa` and `instances-refresh-preservation-ui-qa` failed
  identically on unchanged Build 215 code: they wait for My Servers' poll,
  which has not run while the app is locked since Build 212
  (`isAppLockedForBackgroundWork`), and neither signed an owner in. A first
  guess ("the off-screen window reports hidden") was wrong; a probe of the
  running app showed it visible and the lock gate closed.
  `responsive-mobile-ui-qa` failed only on A1: the new 64 px icon rail took
  width the Build 215 shell gave back at phone widths. The timing gap was
  noise: one launch measurement varies by up to 60% on this PC, so a mean of
  3 is dominated by outliers; 5 alternating rounds compared by median put A1
  within +10% (one value +11.9%), and removing the new stylesheets changed
  startup by about 3%.
- **Resolution:** Ported the assertions to the approved requirement and listed
  each one; reran contended suites alone; recorded the base-identical failures
  as environment exceptions until probed, then made both sign a disposable
  owner in first (`test-helpers/qa-owner.js`), after which they passed with
  no assertion changed; at phone widths the rail steps aside and a
  title-bar menu opens the sidebar; re-measured with 5 alternating rounds by
  median and isolated the CSS cost with an on/off experiment.
- **Lesson:** Before blaming a redesign for a failing test, run the same test
  on the base build the same day with the same harness, and rerun anything that
  failed under load on a quiet machine. Port a test only when the approved
  requirement changed, and say so. Judge performance with an alternating
  same-day A/B against the base, with enough rounds to compare medians, not
  means of 3 and not numbers from another day.
  Before writing down a cause for a failure, probe the running app for it;
  "identical on the base build" proves the change did not cause it, not why it
  happens.

## Future Improvements

Keep optional ideas separate from active work. An item in this list is not authorization to implement it.

- [ ] Record proposed improvement, motivation, and affected area.
- [ ] Assess value, risk, compatibility, security, and effort.
- [ ] Define acceptance criteria.
- [ ] Obtain explicit user approval before implementation.
- [ ] Move approved work into a separately scoped task.

## Workflow Changelog

Record protocol changes here without removing prior entries. Add new versions above older versions.

### Version 1.0

Established the AnxOS Development Protocol as the official engineering handbook. Version 1.0 includes:

- Approval Matrix
- Definition of Done
- Validation Rules
- Bug Workflow
- Feature Workflow
- Reporting Format
- Release Checklist
- AI Behaviour Rules
- Scope Guard
- Emergency Rules
- Lessons Learned
- Future Improvements

### Future Versions

- [ ] Record the version and approval date.
- [ ] Summarize added, changed, or clarified workflow requirements.
- [ ] Identify any affected approval gates.
