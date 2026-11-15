# Handoff: Build 212 (2026-11-15)

## State

- Branch `claude/anxos-control-center-simplify-8080f1`, local commits only. Nothing is pushed, tagged, merged or published.
- `release.json` is Build 212. Release notes: `RELEASE_NOTES_2.0-build212.md`. Build 211's notes moved to `docs/releases/`.
- `origin/dev` has one commit this branch does not: `a72473f0` (website: promote Build 211 to public stable; `website/config.js`, `website/release-notes.json`). It merges cleanly.

## Commits on top of `a919e41d`

| Commit | What |
|---|---|
| `bc9f0db3` | Improvement campaign: 136 verified defects fixed (Sharing, server page, backups, AnxNet, shell, instance engine, Agent connectivity and security, alerts, installs, observability, leaks), 21 regression suites, AGENTS.md lessons |
| `ca68dd07` | An interrupted restore never leaves a server deleted: the restore and its rollback share one crash-safe swap; Agent shutdown waits for running restores |
| `89718695` | An update keeps or restores the AnxOS Helper: Setup re-registers an existing Helper, leaves a marker if it cannot, and the app offers Restore AnxOS Helper |
| (release commit) | Build 212 version, release notes, this handoff |

Earlier campaign commits already on this branch: `0e7e7904`, `a919e41d`.

## Evidence

- Full run on the campaign tree (`bc9f0db3` content): 417 smoke suites and `qa:release` (119 checks, real-app UI tests) passed. The installed Local Agent logged no authorization failures and kept running.
- After that, focused suites only: upgrade-migration (6 checks, including the interrupted rollback and the installer), foreign-task (5, including Helper restore), 22 backup/restore suites, 60 security/pairing/permission suites, 7 IPC exposure suites, release metadata suites.
- `windows/installer.nsh` compiled with NSIS 3.0.4 in an unsigned local build (moved out of `dist/`, not an artifact).

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

1. Approve push: merge `origin/dev` into this branch (website-only, clean), push to `dev`.
2. Run the Desktop Release workflow (`windows-release.yml`, manual dispatch on `dev`) for the signed release candidate. Confirm CI, Authenticode signature, SHA-256; download the installer.
3. Report build, commit, SHA-256, signature and CI status, then wait for `confirmed`.
4. In-place upgrade over the installed Build 211 with Computer Use; keep all servers, containers, credentials, AnxNet identities and data. Check the Helper is kept or restored.
5. Acceptance across major workflows; any issue restarts from validation.
6. Final acceptance report; wait for `🚀 publish`.
7. Tag `v2.0-build212` (the tag push builds the release), publish the GitHub release, update `website/release-notes.json`.
