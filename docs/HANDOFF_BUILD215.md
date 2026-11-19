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
