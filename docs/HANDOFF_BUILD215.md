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
  Waiting for the owner's `confirmed` before installing.
