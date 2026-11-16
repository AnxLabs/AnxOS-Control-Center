# Handoff: Build 212 (2026-11-15)

## State

- Branch `claude/anxos-control-center-simplify-8080f1`. `dev` was pushed at `1c103483` for RC1 and at `b6f293a4` for RC2. The RC2 acceptance fixes are local until the RC3 push. Nothing is tagged or published, and Build 212 has no tag on the remote.
- `release.json` is Build 212. Release notes: `RELEASE_NOTES_2.0-build212.md`. Build 211's notes moved to `docs/releases/`.
- `origin/dev`'s website commit `a72473f0` was merged as `217104ee`.

## Commits on top of `a919e41d`

| Commit | What |
|---|---|
| `bc9f0db3` | Improvement campaign: 136 verified defects fixed (Sharing, server page, backups, AnxNet, shell, instance engine, Agent connectivity and security, alerts, installs, observability, leaks), 21 regression suites, AGENTS.md lessons |
| `ca68dd07` | An interrupted restore never leaves a server deleted: the restore and its rollback share one crash-safe swap; Agent shutdown waits for running restores |
| `89718695` | An update keeps or restores the AnxOS Helper: Setup re-registers an existing Helper, leaves a marker if it cannot, and the app offers Restore AnxOS Helper |
| `e7e8f03e` | Build 212 version, release notes, this handoff |
| `b6770673` | Runtime-state writes for one server run one at a time, so a status poll can no longer replace CRASH_LOOP with STALE_PID (caught by `qa:release`) |

Earlier campaign commits already on this branch: `0e7e7904`, `a919e41d`.

## Release candidate 1 (2026-11-15)

- **Test-only CI fixes:** `499ada2d`, `619e1feb`, `e6eb572e` and `1c103483` made RC validation pass on Linux (no Windows environment variables, Node 22 timezone data, default executable roots).
- **CI run:** Desktop Release run 43709008295 on `1c103483` passed all four jobs. Publishing was skipped.
- **Installer:** SHA-256 `012740D4…49CCB`, signature Valid (Anjo ROSIMO). Superseded by RC2.
- **In-place upgrade over Build 211, with Computer Use:**
  - Setup kept the existing Helper and showed no administrator prompt.
  - The Local Agent came back on its scheduled task, reporting `2.0-build212` with the same identity.
  - Config, servers, containers and AnxNet were intact.
  - Backup: `%APPDATA%\AnxHub\config-backup-pre-build212-20261115-130232`.
- **Acceptance:** six screen issues found, none touching data. They are fixed in `3097c7ec`:
  - Agent version showed the 0.1.0 placeholder
  - polling while locked
  - Home advice for an offline remote computer
  - Docker row actions behind a horizontal scroll
  - SSH status line showing another session's messages
  - Files "Connected" badge for an offline computer's storage
- **RC2 checks:**
  - `scripts/acceptance-fixes-ui-qa.js` (real app, A1-A6, each fails on `1c103483`) is in `qa:release`.
  - `scripts/agent-build-display-smoke.js` covers B1-B4.
  - The release tier passed with 129 checks, and the installed Agent logged 0 authorization failures during the run.

## Release candidate 2 (2026-11-15)

- **CI run:** Desktop Release run 43764970091 on `b6f293a4` passed all four jobs. Publishing was skipped.
- **Installer:** SHA-256 `D058DA14…09AF89`, signature Valid (Anjo ROSIMO). Superseded by RC3.
- **In-place upgrade over RC1, with Computer Use:**
  - Setup kept the Helper and showed no administrator prompt; the Local Agent came back on its task reporting `2.0-build212`.
  - nodes, enrollment, credentials and the AnxNet key were byte-identical afterwards.
  - Backup: `%APPDATA%\AnxHub\config-backup-pre-build212-rc2-20261115-231107`.
- **Acceptance:** fixes 2-6 held in the installed app (Docker on Anxlab's 19 containers; real SSH sessions to Anxlab and the VPS). Three new findings, none touching data:
  - The Local AnxOS Agent card read "Build not reported" while Anxlab was selected: Agent Control skips the local probe when a remote computer is selected (since `0bd19488`).
  - Home's setup checklist kept "Agent connected" after switching to the offline VPS: it read the last Agent Control reply, which records the computer it was read for.
  - Error toasts never left the screen: the generic `[data-tone="error"]` animation (`e98446ba`) has fill mode `both`, which holds opacity 1 over `.toast`'s opacity 0.
- **Fixes (RC3):** a credential-free public health read of this installation's own Local Agent (30 s cache); Home ignores an Agent Control reply for another computer; the animation excludes `.toast`.
- **Checks:** `acceptance-fixes-ui-qa.js` A7 and A8 (A8 measures computed opacity) and `agent-control-foreign-task-stop-smoke.js` S6 each fail on `b6f293a4`. The release tier passed with 129 checks; the installed Agent logged 0 authorization failures.
- **Also seen:** DevTools opens in the packaged app (Ctrl+Shift+I). Not changed in this build.

## Release candidate 3 (2026-11-16)

- **CI run:** Desktop Release run 43819768503 on `daa548ad` passed all four jobs. Publishing was skipped.
- **Installer:** SHA-256 `8A14A5D3…62765E3`, signature Valid (Anjo ROSIMO).
- **In-place upgrade over RC2, with Computer Use:**
  - Setup kept the Helper and showed no administrator prompt. It left no `helper-restore-needed.json`.
  - The AnxOSAgent task runs the installed exe with `--agent`, with no time limit and 3 restarts, and the Local Agent reports `2.0-build212`.
  - Agent, enrollment, credentials, endpoints and the AnxNet key and settings were byte-identical afterwards. In `nodes.json`, only health fields changed.
  - Backup: `%APPDATA%\AnxHub\config-backup-pre-build212-rc3-20261116-002906`.
- **Acceptance:** all nine fixes held in the installed app.
  - The Local AnxOS Agent card reads "Version 2.0 Build 212" while Anxlab is selected.
  - Home's checklist reads "vps-7360e3ad's Agent: Offline" with the VPS selected.
  - An error toast left the screen by itself.
  - Fixes 1-6 held again:
    - Anxlab's own Agent truly reports no build, and the app shows no placeholder.
    - No locked-state polling after startup.
    - Home's advice names the VPS.
    - Docker's row actions are visible.
    - Two real SSH sessions keep their own status.
    - Files reads "Unavailable" for the VPS storage.
- **Also checked:**
  - AnxNet `anx-delta35`: owned, and Anxlab is connected directly.
  - Playit tunnel online.
  - Anxlab's 7 servers and its containers are listed and were not touched.
  - The desktop logged no server, container, AnxNet or Agent write during the run, and the installed Agent logged 0 authorization failures.
- **Note:** Anxlab's servers are all stopped. Palworld was stopped from this desktop at 2026-11-15 20:22:36Z, during RC1 acceptance, while the acceptance session was only reading code (not by an acceptance click). Start it again from the app if it should be running.

## Published (2026-11-16)

- `v2.0-build212` tagged on `6ef7c403`. Release run 43850139683 passed all five jobs. The published Setup has SHA-256 `38A7CCDE…DCAFCB9F9`, signature Valid, and matches `SHA256SUMS` and `latest.yml`.
- Promoted to GitHub Latest by run 43853876941. The website commit `99ec6518` is on `dev`, and Pages deploy 43853917545 succeeded. The live site serves Build 212.

## Website and release documentation (2026-11-16, local, not deployed)

- Static HTML, JSON-LD and both README release sections are now generated from `website/config.js` by `scripts/release-docs.js` and checked by `scripts/release-consistency-check.js`. See `docs/RELEASE_DOCUMENTATION.md`.
- **Published 2026-11-16:** the generator, canonical/link fixes and the plain-language README are on `dev` and live (Pages deploy 43863040231); the Releases README carries the managed markers; release tags in both repositories and the Releases `main` are protected by safety-only rulesets (see `docs/RELEASE_DOCUMENTATION.md`).
- **Shared systems:**
  - SAUS: blocked (no release catalog).
  - Release Fabric: opt-in `release-fabric.checks.yml` (validated, plan-only).
  - ALSP: proposed.
  - AMDP: untouched.
  - Deployment policy component: missing.
  - Sona ISTU: not reusable here.

## Evidence

- Full run on the campaign tree (`bc9f0db3` content): 417 smoke suites and `qa:release` (119 checks, real-app UI tests) passed. The installed Local Agent logged no authorization failures and kept running.
- After that, focused suites only: upgrade-migration (6 checks, including the interrupted rollback and the installer), foreign-task (5, including Helper restore), 22 backup/restore suites, 60 security/pairing/permission suites, 7 IPC exposure suites, release metadata suites.
- `windows/installer.nsh` compiled with NSIS 3.0.4 in an unsigned local build (moved out of `dist/`, not an artifact).
- Final tree (`b6770673`): `qa:release` passed, 128 checks including the real-app UI tests; the installed Agent logged no authorization failures and stayed running. IE9 passed 16 of 16 runs with eight in parallel.

## Test isolation (your installed Agent)

- Agent Control `stop()` and status act only on this installation's AnxOSAgent task (executable and arguments must match).
- `restoreHelperTask()` refuses unless the process is the installed `AnxOS Control Center.exe`.
- Smokes fake Windows, child processes and the network; process kills in scripts target only PIDs the script spawned.
- UI tests use `AGENT_URL=http://127.0.0.1:9`.
- To prove a run stayed isolated: if 47131 is free, run the suite behind a recording listener on 127.0.0.1:47131; if the Agent is running, compare the authorization-failure lines in `%APPDATA%\AnxOS Control Center\logs\{agent,auth,live}.log` before and after.

## Not verified yet (needs the signed release candidate)

- A real in-place upgrade from Build 211 as a standard user with UAC on (two prompts expected; declining the second must lead to Restore AnxOS Helper).
- The Windows graceful stop, SFTP replace and SSH host-key approval against real systems.
- AnxNet across two real machines; the AnxNet key handling on a Linux desktop without a keyring.
- Layout fixes were checked with CSS and static harnesses, not by clicking through every page.

## Known flake

- `agent-api-authorization-smoke` failed once while a local installer build loaded the machine (`/api/v1/stats` on a fresh test Agent). It passed 3 of 3 runs idle. The auth assertions around it passed.

## Next: Build 212 release

Follow `AGENTS.md` › Release Candidate Acceptance Workflow. Each gate needs the owner's approval:

1-5. Done for RC3 (`daa548ad`, run 43819768503): pushed, built, signed, installed in place and accepted with no findings.
6. Final acceptance report given; waiting for `🚀 publish`.
7. Tag `v2.0-build212` (the tag push builds the release), publish the GitHub release, update `website/release-notes.json`.
