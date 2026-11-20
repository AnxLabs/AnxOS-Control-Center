# Build 215 handoff

**Status (2026-11-19): development complete, at the release-candidate
approval gate. Nothing is pushed, tagged, released or deployed. Anxlab and
the VPS were not touched; all real tests ran on disposable containers and on
the development PC.**

Branch `claude/anxos-build-215-44f9f8` (worktree
`anxnet-orbit-relay-f3a366`), fast-forwarded from `origin/dev` at
`2c45c729` (Build 214 published). There is no `isolation-test-environments`
branch, so work continued from `dev`. Version is `release.json` Build 215.

## Milestones

| Milestone | State |
| --- | --- |
| 215-A Audit | Done (this document) |
| 215-B Agent update security | Bugs A–F fixed; needrestart safeguards; restricted update helper; SSH key sign-in; real acceptance on disposable nodes |
| 215-C Docker and unified workloads | Docker services in My Servers › All computers; safe image update for catalog services; untruncated volume names |
| 215-D Game-server hosting | "Will it run on this computer?" in Create Server |
| 215-E Security, performance, usability | Security review of Build 215 surfaces; container list 2.07 s → 0.21 s for All computers; dead Agent Control buttons fixed |
| 215-F Acceptance and comparison | Real acceptance passed (below); AMP comparison planned, not run (`docs/BUILD215_AMP_COMPARISON.md`) |
| 215-G Stabilization | Release notes, known limitations, validation (below) |

## Build 214 updater bugs

| Bug | Cause | Fix |
| --- | --- | --- |
| A: SSH profiles not reloaded after unlock | `refreshProtectedStateAfterLocalOwnerAuthentication` reloaded nodes, settings, instances, Docker and backups, but not SSH profiles or storage connections; Agent Control was not redrawn | Unlock reloads both and Agent Control's own state; Agent Control redraws when profiles load. Agent Control buttons are disabled until a target has loaded (they used to look usable and throw on click). |
| B: unrelated service restarts | Ubuntu's `needrestart` apt hook restarts services using replaced libraries; with `DEBIAN_FRONTEND=noninteractive` it does so unasked. Reproduced: a disposable service went PID 460 → 615 with Build 214's command | `NEEDRESTART_SUSPEND=1 NEEDRESTART_MODE=l`, `--no-install-recommends`, `--force-confold`; an apt dry run must show only `anxos-agent` changing; services needing a restart are listed as deferred. Same test: PID 615 → 615, reported as deferred. |
| C: stale automatic-update panel | A single Update refreshed nodes but never re-read the overview; the panel drew its pending line from the overview before the new one arrived and never redrew it | After any update: health-checked node refresh, overview and history re-read; pending line redrawn with each overview; computer notes refreshed without touching unsaved choices; out-of-order responses discarded |
| D: "Agent 0.1.0" | Step messages used `agentVersion`, `agent/package.json`'s fixed placeholder | Builds only; history records the verified build |
| E: outdated tooltip | Hard-coded bundled-runtime text | Text follows the method Verify Access found (system unit = package) |
| F: update dialog | The shared `.app-modal__header` is a horizontal flex row, so eyebrow, title and text sat side by side under the close button | Stacked header; the Update confirmation lists computer, SSH profile, current and new build, method, services, failure behaviour; "Update Agent"/"Cancel"; live step progress |

## New pieces

- `packaging/agent-deb/update-helper` → `/usr/lib/anxos-agent/update-helper`
  (root, 0755); sudoers rule for the new `anxos-update` group in
  `/etc/sudoers.d/anxos-agent`; postinst creates the group with no members.
  State in `/var/lib/anxos-agent-update` (root, 0700), audit log
  `/var/log/anxos-agent-update.log`. Optional root-owned
  `/etc/anxos-agent/update-helper.conf` may set an HTTPS mirror (or loopback
  HTTP for tests).
- Desktop update order: helper (if the SSH user may run it) → passwordless
  sudo → stop with the manual command and the `anxos-update` hint.
- `SshService.setUpKeyAuthentication` and `ssh:setUpKeyAuthentication`
  (owner-only, rate-limited, audited without secrets).
- `src/services/dockerServiceUpdateService.js`, `docker:updateService`.
- `assessComputerFit` in `src/shared/createServerDefaults.js`.
- `listServersAcrossComputers` returns `services` (Docker) besides `servers`;
  fleet actions accept `containerId` targets.

## Real acceptance (all passed)

| Run | Environment | Result |
| --- | --- | --- |
| `scripts/build215-agent-update-acceptance.js` | Two disposable Ubuntu 24.04 systemd containers (`anx215-a`, `anx215-b`) with the official 2.0-build213 package, OpenSSH, password sudo, needrestart; the helper and its rule copied in as a 215 package installs them | 9/9 in 105 s: key sign-in against real OpenSSH (host key pinned), password sudo without `anxos-update` stops with the command and hint, refusal with a server in the Agent's cgroup, rollback drill (helper installs real 214, verification forced to fail, real helper rollback, healthy on 213, 22 s), real 213 → 214 through the helper in 13 s with a disposable service keeping its PID, Update all over both in 17 s, maintenance window (outside: nothing; notify: recorded only; apply: only the chosen computer), audit log |
| Helper escalation tests | `anx215-a`, user `anx` with password sudo plus `anxos-update` | Refused: other commands via sudo, `"2.0-build214; id"`, extra arguments, a path as build, rollback without a record, downgrade, `APT_CONFIG=` (sudo refuses), unknown action, `/bin/sh`, unreleased build, world-writable config, http mirror, server under the Agent, concurrent run. All logged. |
| Packaged layout | Deb built from this branch (Windows stage, LF restored as an LF checkout gives) installed on a fresh container | Group created with no members, sudoers parses, helper root 0755; before joining the group "password required", after joining `status` works, general sudo still needs a password |
| `scripts/build215-docker-update-real.js` | Docker Desktop (engine 29.9.3), catalog `docker-nginx` on nginx 1.26 under the template tag | Updated in 28 s to the current image, same port, file in the volume kept, previous container removed, volume kept; second run "already newest" |
| `scripts/build215-ui-qa.js` | Real Electron app, isolated profile and home, `anx215-a` plus a disposable local Agent | 9/9 (D1 in a separate run): locked start → unlock loads profiles; key sign-in from the SSH page; Verify Access; package tooltip; confirmation dialog; live progress through a real 213 → 214 update; no stale pending line, "(verified)" in history, no 0.1.0; fit check visible and following the memory field; Docker services in All computers; Docker update from the window with data kept |

Screenshots of the UI run are in the session scratchpad (`ui215`); rerun
the harness with `BUILD215_QA_SHOTS=<dir>` to regenerate them.

Test-environment notes: the official 213/214 packages own
`/etc/sudoers.d/anxos-agent`, so for transitions between them the test rule
lives in `/etc/sudoers.d/anxos-agent-update-test` (a first run with the rule
in the package file lost it when 214 was installed, and the Desktop
correctly reported the rollback as unconfirmed). A helper rollback to a
pre-215 build removes the helper. Containers `anx215-a` and `anx215-b` are
still running (`docker rm -f anx215-a anx215-b` removes them; the image is
`anx215-node:test`).

## Measurements

- `getDockerContainers` on Docker Desktop, 8 containers, 7 runs: before
  median 2.07 s (max 4.8 s); after, with stats (Docker page) 2.04 s and four
  fewer docker processes; without stats (All computers) 0.21 s.
- Single docker CLI calls on this PC: about 0.5 s each; `docker stats
  --no-stream` 2.7 s.

## Security review (Build 215 surfaces)

- SSH: key setup refuses an unapproved host and pins the approved
  fingerprint on every connection; the password is used once, never stored,
  logged or echoed in errors (smoke K5); the key file's Windows ACL is
  current-user only, verified with icacls (K9); IPC is owner-only and
  rate-limited.
- Helper: see the escalation tests above. Trust anchor is the HTTPS release
  SHA256SUMS, as for the existing package update; the Desktop also compares
  the digest the helper reports with its own copy.
- Docker: the update carries only template-defined settings, refuses
  unexplained mounts, never deletes volumes; container lists carry only
  AnxOS and Compose labels (other label values may hold secrets); the
  create job record holds only the name.
- Not changed: no new credential store, Anx-Creds untouched, no production
  SSH or sudo change.

## Tests run

- New smokes: `agent-update-ux` (9), `ssh-key-setup` (9, real ssh2 server
  and bash), `docker-service-update` (8). Extended: `package-agent-update`
  (19), `server-fleet` (12), `create-server-defaults` (5),
  `agent-package-closure` (helper and sudoers checks).
- Affected suites after each change: SSH (15 files), update, Docker,
  marketplace, renderer safety, and the smokes extracting changed `app.js`
  functions. `agent-package-closure` passes with a real `node_modules` copy
  (it fails with the junctioned one, as before).
- `node --check` on every changed JavaScript file; `git diff --check` clean.
- Release validation: see "Final gate" below.

## Final gate (2026-11-19)

- `npm run rc:validate`: first run stopped at 95/420 on
  `permission-matrix:smoke` (the two new IPC channels had no matrix rows);
  rows and a probe were added (`ssh-key-setup` family, `docker:updateService`
  in `docker-write`). Second run: **420/420 PASS**.
- `npm run qa:release`: **136 passed, 1 failed**, the last started:
  `acceptance-fixes-ui-qa` A2 ("the dashboard polls again after the unlock",
  0-1 snapshot reads in 7 s; its other 8 checks passed, A1 shows "2.0 Build
  215"). A2 fails the same way on the Build 214 baseline (`2c45c729`, two
  runs in a temporary worktree: 0 snapshots, and once a 30 s reload
  timeout), so it is not a Build 215 regression; the PC was loaded (1.5 GB
  of 48 GB free, the test Agent took 7-8 s to answer its first request).
  It needs a rerun on a quieter machine or in CI before the RC.
- The tier stops at its first failure, so the three steps after A2 were run
  directly: `build213-ui-qa` failed B1 first because it read the Computer
  column by position and Build 215 added the Type column; the check was
  updated (column index, and Open on a game-server row) and passed **4/4**;
  `steamcmd-cancel-ui-qa` **2/2**; `git diff --check` clean.

## Not done

- No AMP comparison run (no AMP environment); plan and AnxOS numbers in
  `docs/BUILD215_AMP_COMPARISON.md`.
- Docker image rollback after a successful update (the previous image id is
  recorded on the container as `anxos.previous-image`, no button yet).
- Backup/restore and crash-recovery workflows were not changed or
  re-measured; console behaviour unchanged.
- Docker on a Linux host and Docker services listed for Windows computers:
  unchanged from Build 214.
- 214 → 215 on Anxlab and the VPS: not done (needs approval). Anxlab's
  profile can move to key sign-in from the SSH page; key shell access with
  the `anxlab` alias already exists on this PC.

## Next steps (approval needed)

1. RC: push `dev`, build and sign through CI, verify, then the installer
   approval gate (`confirmed`).
2. To make Anxlab updates one-click after 215 is installed there:
   `sudo usermod -aG anxos-update anx` on Anxlab (owner action), then Set up
   key sign-in for its profile. Password SSH stays enabled.

## RC1 preparation (2026-11-19)

Requested by the owner: resolve A2, clean up, review the helper's privilege
boundaries, prepare RC1. No new features, no Anxlab or production change.

### A2 diagnosis (conclusive: environment timing, no code change)

A temporary copy of `acceptance-fixes-ui-qa.js` (deleted afterwards) logged
every IPC request in A2's window. After the unlock the dashboard's first
`system:getSnapshot` starts about 0.9 s after Home is shown and repeats every
2 s; while a read is in flight the next tick is skipped
(`systemRequestInFlight`). A2 needs 2 completed reads in 7 s.

| Runs | Test Agent's first `/stats` | A2 |
| --- | --- | --- |
| Failing: Build 215 x3, Build 214 baseline x1 (machine loaded) | 6.9-8.3 s | 0-1 reads |
| Passing now: Build 215 x4 | 2.3-2.7 s | 2-3 reads (first 1.6-2.1 s, then about 0.1 s) |

The Agent's first hardware sample is what takes seconds on a loaded PC (the
same finding as Build 214's RC prep, which added the warm-up in
`996067f8`). Polling resumes after the unlock in every run; the threshold and
timeouts were not changed. The full `acceptance-fixes-ui-qa` then passed
**9/9**, so with `rc:validate` 420/420 and the rest of the release tier
(136 + `build213-ui-qa` 4/4 + `steamcmd-cancel-ui-qa` 2/2 + `git diff
--check`), every release-tier step has passed.

### Cleanup

- Removed: containers `anx215-a`, `anx215-b`; images `anx215-node:test`,
  `nginx:stable-alpine` and the untagged newer nginx the update tests pulled;
  47 temp folders and a report this session's harnesses created; this
  worktree's `dist/` and `resources/agent-runtime-node-modules` (rebuilt by
  every build); the scratchpad's Linux Node copy, stage and deb output.
- Not touched: the owner's `anx-forge*`/`anx-cortex*` containers and volumes,
  `~/.ssh/anxos_ovh` (no test key was ever written to `~/.ssh`), and 247
  older QA temp folders (2026-11-15 to 11-18, from earlier sessions'
  harnesses that do not clean up; test configs and screenshots only).
- Kept: `artifacts/qa/` (release-tier reports, git-ignored) and the
  git-ignored `node_modules` copy needed for validation. No stray worktree or
  process.
- The disposable node's Dockerfile is in the repo
  (`test-helpers/disposable-node/Dockerfile`) so RC acceptance can rebuild
  it: `docker build -t anx215-node:test test-helpers/disposable-node`, then
  run with `--privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock`
  and ports `127.0.0.1:2221:22`, `127.0.0.1:47191:47131` (node A) and
  2222/47192 (node B); from Git Bash set `MSYS_NO_PATHCONV=1`.

### Update helper security review

No automatic privilege: the package creates the `anxos-update` group with no
members, and no code path in the Desktop, the Agent or the package adds
anyone to it (only messages tell the owner the command). Its sudoers rule
allows exactly `update-helper status|install *|rollback *`; the helper
accepts one build string matching `^[0-9]{1,4}\.[0-9]{1,4}-build[0-9]{1,6}$`.
Automatic Agent updates stay off unless the owner turns them on and chooses
computers. A group member can at most install a newer official build, or
return to the build the helper replaced, while no server runs under the
Agent.

Two hardening gaps were found and fixed in this review:

1. **curl configuration injection.** curl reads `~/.curlrc` (and
   `$XDG_CONFIG_HOME/.curlrc`). The helper relied on sudo resetting `HOME`;
   on a host whose sudoers keeps `HOME`, a group member's `.curlrc` could
   route the release download through a proxy or turn off TLS checks.
   Proven on this PC (a `.curlrc` proxy redirected curl; `-q` ignored it).
   Fix: `curl -q`, `HOME=/root`, and `XDG_CONFIG_HOME`, `TAR_OPTIONS`,
   `GZIP`, `CURL_CA_BUNDLE` cleared.
2. **Lock in a world-writable folder.** `/run/lock` let another user
   pre-create the lock (blocking updates), with symlink safety resting on
   kernel defaults. Fix: the lock is `/var/lib/anxos-agent-update/lock`
   (root, 0700 folder), taken after the folder is checked.

Re-tested on a fresh disposable node (official 2.0-build213 package, the
changed helper, `Defaults env_keep += "HOME"`, and an attacker `.curlrc` with
a dead proxy and `insecure`): injected build, extra argument, downgrade,
other command and a concurrent run refused; the real install of 2.0-build214
downloaded straight from GitHub (SHA-256 `33fc97a7...`, the published Build
214 Agent package) despite the `.curlrc`; real rollback to 213; a second
rollback refused; all logged. `agent-package-closure` and
`package-agent-update` smokes pass. Node and image removed afterwards.

Residual (documented, unchanged): the trust anchor is the HTTPS release's
`SHA256SUMS` on GitHub, as for every package update so far; a compromised
release repository is out of scope. sudo's default `env_delete` removes
`BASH_ENV` and exported functions; a host that explicitly keeps them is
misconfigured for any sudo rule.

### RC limitation to know before acceptance

The RC app's Desktop build is 2.0-build215. Its in-app Agent update
downloads `v2.0-build215`'s `SHA256SUMS`, which exists only once Build 215 is
published, so an in-app 214 -> 215 Agent update cannot be accepted on the RC
(it stops with "release unavailable"; nothing is installed). The package path
was accepted with real 213 -> 214 packages; the 215 Agent package itself is
checked from the RC artifacts (step 4 below).

### RC1 promotion steps

1. **Approval: push.** Fast-forward `origin/dev` from `2c45c729` to this
   branch's head: `git push origin HEAD:dev` (never the `anxlab` remote,
   never a tag).
2. **Signed build.** `gh workflow run windows-release.yml --ref dev` (no tag,
   so publish is skipped); static validation, rc-validation (Linux), Windows
   and Linux builds must pass. A failure stops here: fix, validate, push
   again with approval.
3. **Download** the run's artifacts to `artifacts/build215-rc1/`
   (git-ignored): Setup and portable exe, `latest.yml`, Agent `.deb` and
   `.sha256`, Linux `.deb` and AppImage.
4. **Verify:** Authenticode Valid (signer and timestamp) for Setup and
   portable; SHA-256 recorded; `latest.yml` SHA-512 and size match Setup; the
   Agent `.deb` matches its `.sha256`, is version 2.0-build215, and
   `dpkg-deb -c` lists `./usr/lib/anxos-agent/update-helper` (root, 0755)
   and `./etc/sudoers.d/anxos-agent` with the `%anxos-update` rule; installed
   on a fresh disposable node it creates an empty `anxos-update` group and
   passes `visudo -c`.
5. **Report** build, commit, SHA-256, signature and CI status, then ask
   exactly: "Please confirm that I may install the signed Release Candidate
   over the current installation for acceptance testing." Wait for
   `confirmed`.
6. **Upgrade** (after `confirmed`): back up `%APPDATA%\AnxHub` (config,
   agent, instances) with a SHA-256 manifest; check no server runs under This
   PC's Agent; start the verified Setup; the owner clicks through (Computer
   Use screenshots are blank on this PC). Verify the installed exe's
   signature, Local Agent `2.0-build215`, the AnxOSAgent task, and that
   unchanged files are byte-identical.
7. **Acceptance in the installed RC:** the installed exe under Playwright
   with an isolated profile (the Build 214 method), plus the Build 215 checks
   from `scripts/build215-ui-qa.js` against a rebuilt disposable node: locked
   start, key sign-in, Verify Access, update confirmation and progress
   (213 -> 214 package), All computers with Docker services, Docker service
   update, Create Server fit check.
8. **Final status** READY FOR PUBLICATION or RELEASE BLOCKED; publication
   only after the owner's exact `🚀 publish`.

## Release candidate 1 (2026-11-19)

- Approved by the owner ("Push and build RC1"). `origin/dev` fast-forwarded
  `2c45c729..d3183249`. No tag, nothing published.
- CI run 44603113617 (`windows-release.yml`, workflow_dispatch on `dev`,
  commit `d3183249`): static-validation, rc-validation (420/420 on Linux),
  windows and linux passed; publish skipped (no tag).
- Downloaded to `artifacts/build215-rc1/` in this worktree (git-ignored):
  - Setup `AnxOS-Control-Center-Setup-2.0-build215.exe` (440,253,992 bytes):
    Authenticode Valid, Anjo ROSIMO, Microsoft timestamp. SHA-256
    `BD55FB35CC1BC6599E14A9069ABA600059176A644EED617349B751932698072F`;
    `latest.yml` SHA-512 and size match (its `version: 2.0.0` is the app's
    package version).
  - Portable `AnxOS-Control-Center-2.0-build215-portable.exe`: Valid.
    SHA-256 `5ED5BFD887EB4A98FC0067A37E5CF2B9F89EA10BFDD8DC59ADBB2312C9FCB252`.
  - Agent package `AnxOS-Agent-2.0-build215.deb`: SHA-256
    `862EEAF823981092FAD5134F46FC46FCCA1E5A42315ECBE727DB37EC5F923CC8`
    (matches its `.sha256`).
  - Linux app: `.deb` `FFA93A1C47A71834475D71F9661398F400EDE7C478A83FBE18EB378F9D5AB27F`,
    AppImage `95C010E55ACA843E6FCEB8389874B78DD8E4B00FA2650790FB82367EB8F549A9`.
- Agent package checked on a fresh disposable node (removed afterwards):
  `anxos-agent 2.0-build215`, embedded artifactVersion 2.0-build215; lists
  `./usr/lib/anxos-agent/update-helper` root 0755 (byte-identical to the
  hardened helper, `curl -q`) and `./etc/sudoers.d/anxos-agent` root 0440;
  installs cleanly (no CR in postinst, sudoers or helper); creates
  `anxos-update` with no members; `visudo -c` parses; before joining the
  group the helper needs a password, after joining `status` answers and
  general sudo still needs a password; the Agent runs and reports
  2.0-build215.
- Installed app before the upgrade: signed AnxOS Control Center (Valid),
  AnxOSAgent task running; the Build 214 RC2 install per Build 214's record.

- **In-place upgrade over Build 214** (owner replied `confirmed`). Backup:
  `%APPDATA%\AnxHub\config-backup-pre-build215-rc1-20261119-203247`
  (`config`, `agent`, `instances`: 715 files) with a SHA-256 manifest. This
  PC's Agent ran no server (Minecraft Vanilla stopped). Setup re-verified
  (hash, signature) and started by the assistant; the owner clicked through
  and replied `done`.
- **After the upgrade:** installed exe Authenticode Valid; AnxOSAgent task
  runs it with `--agent` (no time limit, 3 restarts); no
  `helper-restore-needed.json`; Local Agent reports `2.0-build215`; installed
  `app.asar` has release.json Build 215 and the Build 215 code (fleet Docker
  services, Docker service update, needrestart safeguard, `--no-trunc`, key
  sign-in, fit check). Data: 706 of 715 files byte-identical, none missing;
  9 changed are runtime state (health-check timestamps in `nodes.json`,
  last-seen in `security.json`, telemetry samples, alerts, AnxNet token/state
  /log, audit log, window recovery); new: `agent-auto-update.json`
  (`enabled: true`, notify only, no computers chosen), saved by an explicit
  `node.agent-auto-update.set` at 03:49:58 UTC while Agent Control was open
  in the installed app; no harness touched that profile. Inert (no computers
  chosen); left as saved.
- **Acceptance in the installed RC1** (installed exe under Playwright with an
  isolated profile, disposable Agent from the installed
  `local-agent-runtime`, local Agent lifecycle IPC refused, rebuilt
  disposable node `anx215-a` on 2.0-build213): `build215-ui-qa` 9/9 passed
  (U1, K1, E1, F1, P1 refused at the download check for the unpublished
  2.0-build215 release with the node unchanged, C1, D1, W1, W2).
- **Two defects found in the screenshots** (acceptance stopped):
  1. After the refusal, "Download and verify the release package" stayed
     *in progress*: `updatePackageManagedAgent` threw from a running step
     without marking it, and the failure event carried that state.
  2. The error toast said "The Agent is not responding. Check that the Agent
     is running": the friendly-error matcher's "agent unreachable" pattern
     `/agent.*(unavailable|...)/i` matched the code
     `AGENT_PACKAGE_RELEASE_UNAVAILABLE`.
- **Fixes:** `fail()` in `remoteAgentUpdateService` marks any running step
  failed with the reason and reports it (every update path); specific error
  codes are no longer relabelled by the broad text patterns (only generic
  `*_REQUEST_FAILED`/`*_OPERATION_FAILED`/no code; listed codes still map),
  and the agent pattern uses word boundaries. Regression: package smoke P20,
  UX smoke U10 (fails on RC1's `app.js`), `build215-ui-qa` P1 now asserts no
  step in progress, the download step failed and no "Agent is not
  responding" toast. On the fixed code: P1 and C1 pass in the real app (dev),
  smokes for notifications, onboarding, renderer safety, update services and
  local-owner auth pass. `build215-ui-qa` also learned to read its target
  build from `release.json` and to wait for a history row, not the pending
  line.
- **RC1 status: RELEASE BLOCKED** (the two defects). Next: RC2 from the fix
  commit, with the same gates (push approval, signed build and checks,
  `confirmed`, acceptance from the beginning). The disposable node
  `anx215-a` is kept running for RC2 acceptance.

## Release candidate 2 (2026-11-19)

- Approved by the owner ("Push and build RC2"). `origin/dev` fast-forwarded
  `d3183249..9bb648dc`. No tag, nothing published.
- CI run 44672491869 (`windows-release.yml` on `dev`, commit `9bb648dc`):
  static-validation, rc-validation (420/420 on Linux), windows and linux
  passed; publish skipped.
- Downloaded to `artifacts/build215-rc2/` (git-ignored):
  - Setup `AnxOS-Control-Center-Setup-2.0-build215.exe` (440,250,152 bytes):
    Authenticode Valid, Anjo ROSIMO, Microsoft timestamp. SHA-256
    `16767E3E1902B920D98433F8BDA9CBBF7B2C1EA2EDFE5562FB6CA02F5BB73A5B`;
    `latest.yml` SHA-512 and size match.
  - Portable: Valid. SHA-256
    `A0A8CCDE93EABF14C44110739C664239378268C48C6F338C97CAC2F03DD6A102`.
  - Agent package `AnxOS-Agent-2.0-build215.deb`: SHA-256
    `5F4D711173762984319FB27A0037F0B9EAE6B581A0F8DD413C1CD75720E95C3C`
    (matches its `.sha256`).
  - Linux app: `.deb` `52DCB26578896D7DF7F3C035FCDBFFCB29B74C34333A88AD1DE5A29FCA531CA8`,
    AppImage `DFB902560D0AD3C109DE3973E2DD69EFB920E142D5C70ABE2DCE09C500062FC2`.
- Agent package on a fresh disposable node (removed afterwards): version and
  embedded identity 2.0-build215; helper byte-identical to the hardened one;
  clean install (no CR); empty `anxos-update` group; `visudo -c` parses;
  helper only after joining the group, general sudo still needs a password;
  Agent active, reports 2.0-build215.
- Installed app before the upgrade: RC1 (`d3183249`).

- **In-place upgrade over RC1** (owner replied `confirmed`, then `done` after
  clicking through Setup). Backup
  `%APPDATA%\AnxHub\config-backup-pre-build215-rc2-20261119-214033` (716
  files) with a SHA-256 manifest; This PC's Agent ran no server. After: exe
  Valid, AnxOSAgent task running the installed exe with `--agent`, Local
  Agent `2.0-build215`, installed `app.asar` contains both RC1 fixes; data
  707 of 716 byte-identical, none missing or new, the 9 changed are runtime
  fields only (health-check times, latency, last-seen, telemetry, AnxNet
  token/state/log, audit, alerts, window recovery).
- **Acceptance in the installed RC2:** `build215-ui-qa` 9/9 passed, including
  P1's new assertions (no step left in progress, download step failed, no
  "Agent is not responding" toast).
- **Defect found in the screenshots:** My Servers > All computers at 1440 px:
  the Actions header was cut off and the Open/Logs labels broke over two lines
  ("Ope" / "n"). Cause: the fleet table inherits `.docker-table`'s
  `min-width: 1040px`, and ten columns with long unbreakable volume and image
  names pushed it past its panel. W1 now measures what the user sees (every
  Actions button and the header inside the panel's visible edge, no label
  with more than one line box) at 1100, 1440 and 1920 px: on the installed
  RC2 it fails (1440 px: header cut, 18 labels wrapped).
- **Fix:** the fleet table has its own class (no minimum width, long names
  wrap, Actions cell never wraps a label, buttons stacked) and CPU and RAM
  share one column. On the fixed code W1 passes at all three widths;
  `server-fleet`, renderer and UI-polish smokes and `build213-ui-qa` (4/4)
  pass.
- **Second defect, from the remaining RC2 screenshots:** the key sign-in
  result was laid out in the form's two-column grid, and the key fingerprint
  ran into the other column over its text. Fix: the result has its own
  one-column layout, long text wraps, and the fingerprint is on its own line.
  K1 now checks one column and no paragraph wider than its box: it fails on
  the installed RC2 (2 columns, 1 overflowing) and passes on the fix.
  Renderer, SSH key setup and modal smokes pass. All other RC2 screenshots
  (Update confirmation, refusal and history, fit check, Docker update
  confirmation) were reviewed with no further finding.
- **RC2 status: RELEASE BLOCKED** (the two layout defects). Next: RC3 with
  the same gates.

## Release candidate 3 (2026-11-19)

- Approved by the owner ("Push and build RC3"). `origin/dev` fast-forwarded
  `9bb648dc..5bd60b1e`. No tag, nothing published.
- CI run 44678616114 (`windows-release.yml` on `dev`, commit `5bd60b1e`):
  static-validation, rc-validation (420/420 on Linux), linux and windows
  passed; publish skipped.
- Downloaded to `artifacts/build215-rc3/` (git-ignored):
  - Setup `AnxOS-Control-Center-Setup-2.0-build215.exe` (440,254,288 bytes):
    Authenticode Valid, Anjo ROSIMO, Microsoft timestamp. SHA-256
    `4633E5981BD97A5A0A63979B3E19641734638C7A77DF0BF9294FF6E183E67C19`;
    `latest.yml` SHA-512 and size match.
  - Portable: Valid. SHA-256
    `9F10BC9571D54D352A1037A1625349A7B29B67C5E6DE1EDCFC2241AA6261B1AD`.
  - Agent package `AnxOS-Agent-2.0-build215.deb`: SHA-256
    `F0F3C14B90E64A7F8E3DD892A234BF650E2BC122A26BD140C2582076CF6EAFFC`
    (matches its `.sha256`).
  - Linux app: `.deb` `788C780D90EF2106C49EBF0496A67C1D3F4409399F1E30366F6DB7741A8F1D95`,
    AppImage `5C6EAF9B9B1EC338151950F8A4BCA74C504AC401995BB31FCAE1C1FCD73D78F2`.
- Agent package on a fresh disposable node (removed afterwards): version and
  identity 2.0-build215; helper byte-identical to the hardened one; clean
  install (no CR); empty `anxos-update` group; `visudo -c` parses; helper
  only after joining the group, general sudo still needs a password; Agent
  active, reports 2.0-build215.
- Installed app before the upgrade: RC2 (`9bb648dc`).

- **In-place upgrade over RC2** (owner replied `CONFIRMED`, then `done` after
  clicking through Setup). Backup
  `%APPDATA%\AnxHub\config-backup-pre-build215-rc3-20261120-015341` (716
  files) with a SHA-256 manifest; This PC's Agent ran no server. After: exe
  Valid, AnxOSAgent task running the installed exe with `--agent` (no time
  limit, 3 restarts), no Helper restore marker, Local Agent `2.0-build215`,
  installed `app.asar` contains both RC1 and both RC2 fixes; data 707 of 716
  byte-identical, none missing or new, the 9 changed are runtime fields only
  (in `nodes.json` and `security.json` only health-check, latency and
  last-seen times).
- **Acceptance in the installed RC3:** first run 8/9. P1 failed on its last
  read of `[data-agent-control-message]`: "An authenticated Agent endpoint
  responded successfully." The screenshot showed the correct result (download
  step failed with the HTTP 404 reason, specific toast, node still 213).
  Cause: that line lives in the Status section, hidden while Updates is open,
  and the refresh every Agent Control action ends with (unchanged since
  Build 214) rewrites it with the connection status; RC1 and RC2 read it
  before that refresh landed. Not an app regression: P1 now reads the visible
  failed step's own message and checks it is visible. Rerun: 9/9.
- **Defect found in the screenshots:** My Servers > All computers listed every
  Docker container twice ("Windows Desktop: 8 Docker services · Lab PC: 8
  Docker services", 34 action buttons for 8 containers + 1 server). Cause:
  the application host and a Local Agent on the same PC saved as a computer
  (which the app does, `localAgent: true`) read the same Docker daemon, and
  the fleet listed each computer's containers separately. It affects anyone
  with a Local Agent saved as a computer (the owner's profile has none).
- **Fix:** `mergeSharedDockerServices` lists a container once when the same
  Docker ID (12-64 hex) and name come from two computers, under the first
  computer that reads it live, with "also <computer>" in the Computer cell;
  the other computer's summary says "same Docker as <computer>, listed
  there". A container known only by its name is never merged. Regression:
  `server-fleet-smoke` F13 (real `docker ps --no-trunc` rows through the
  production normalizer; fails on the RC3 code) and `build215-ui-qa` W1
  (each container listed once: on the installed RC3 "listed 2 times", on
  the fix 17 buttons and "Windows Desktop also Lab PC").
- **RC3 status: RELEASE BLOCKED** (duplicate Docker rows). Next: RC4 with the
  same gates.

## Release candidate 4 (2026-11-20)

- Approved by the owner ("approved": commit the fix, push `dev`, build RC4).
  Fix `9f1cac8c` and RC3 record `0f975cd1` committed; `origin/dev`
  fast-forwarded `5bd60b1e..0f975cd1`. No tag, nothing published.
- Local validation before the push: `rc:validate` 420/420
  (`RC_FAIL_FAST=0`, default limits; two earlier runs stopped on load
  timing in `agent-control:smoke` and `resource-leaks-hardening` check 3,
  which pass alone: 82 s, and 5 of 5), `server-fleet-smoke` 13/13,
  `build215-ui-qa` W1/W2, `build213-ui-qa` 4/4, release consistency.
- CI run 44720106371 (`windows-release.yml` on `dev`, commit `0f975cd1`):
  static-validation, rc-validation (420/420 on Linux), linux and windows
  passed; publish skipped.
- Downloaded to `artifacts/build215-rc4/` (git-ignored):
  - Setup `AnxOS-Control-Center-Setup-2.0-build215.exe` (440,255,784 bytes):
    Authenticode Valid, Anjo ROSIMO, Microsoft timestamp. SHA-256
    `4071DCFA677F905F5B03D8B7C137DE3B80DB3B2EF0C3E37ED21CC6ECF2295317`;
    `latest.yml` SHA-512 and size match.
  - Portable: Valid. SHA-256
    `714F4D36F9B272074C1A90E021F14FFD008EC4E3EC4C4351981318042310BDF0`.
  - Agent package `AnxOS-Agent-2.0-build215.deb`: SHA-256
    `B14601AEF575EE28A4A7D3C27F7F10BFC8C9F064596B0DFF9D39E40395B96BA6`
    (matches its `.sha256`).
  - Linux app: `.deb` `6AF577E72568A591D5F107BA5030420AB40D3AD1BBDE8699824DE7C358806747`,
    AppImage `CBCD3C3A9D99D224E5038BE0286B219F6D6A4E2B53B4EB90C8A57BFED78510D6`.
- Agent package on a fresh disposable node (removed afterwards): version and
  identity 2.0-build215; helper byte-identical to the repository's (root,
  0755); no packaged file with a CR; empty `anxos-update` group; `visudo -c`
  parses; helper refused before joining the group and allowed after; general
  sudo still needs a password; Agent active, reports 2.0-build215.
- Installed app before the upgrade: RC3 (`5bd60b1e`). Waiting for the owner's
  `confirmed` before installing RC4.
