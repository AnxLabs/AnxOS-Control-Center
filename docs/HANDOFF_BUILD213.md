# Build 213 handoff

Status on 2026-11-16: development milestones 213-A to 213-G are done as local
commits on `claude/anxos-control-center-simplify-8080f1`. Nothing after
`449fd1f5` is pushed. No version bump, tag, CI build, signature or release
has been made. The next step is the release-candidate workflow (ADP), which
starts only with your approval.

## What's new

| Milestone | What you get | Commit |
| --- | --- | --- |
| 213-B Server fleet | My Servers > All computers: every computer's servers in one list, with last-known state for offline computers, Open, and bulk Start / Stop / Restart (Stop and Restart ask first) | `b6d94005` |
| 213-C Agent updates | Settings > Updates > Automatic Agent updates: off by default; notify or apply; chosen computers, days and a time window; history of every update; never restarts an Agent while its servers run | `9b9d3900`, `57bd4eca` (and `449fd1f5`, already on dev) |
| 213-D Moves between computers | The move dialog runs checks first (target online, server stopped, platform, ports, memory, disk, size) and won't run while one blocks; the backup is verified before transfer and the download is checksummed; after a clean move it offers cutover | `f3f6a618` |
| Headless Agent | The Agent's terminal screen is in color (off for `NO_COLOR`, `TERM=dumb`, non-terminals) | `a07f6f11` |
| 213-E Modpacks | Servers installed from a Modrinth or CurseForge modpack say when a newer pack version exists for the same Minecraft version and loader (check only) | `cfbe5d7e` |
| 213-F Phone | Download any server file from the phone byte for byte; binary files are never opened as editable text | `87fe5343` |
| 213-G AnxNet Anywhere | The edge checks its config before listening (never publishes SSH, Agent or other management ports); Copy edge config in the AnxNet panel; a hardened systemd service template and a step-by-step deployment guide | `34cb5dd5` |
| Fix: update Cancel (issue 53) | A Cancel acknowledged while the pre-update backup runs or while the update waits for another SteamCMD task now stops it: SteamCMD never starts and nothing is recorded as updated | `2f09e404` |
| Test fixes | Renderer test waits past the deferred welcome; the website route check uses the final `/signin/` links; the release tier runs the Build 213 real-app checks | `28d1e17a`, `7529cd0e`, `b99a0233` |

## Evidence: what was tested, and how

Mocked = fake services in plain Node. Local = real processes on this PC.
Real app = the Electron app with an isolated profile and disposable Agents.
None of it used the installed app, the real Local Agent (47131), Anxlab or
the VPS.

| Area | Test | Kind | Result |
| --- | --- | --- | --- |
| Fleet list and actions | `server-fleet-smoke` F1–F8 | Mocked | Passed |
| Fleet view | `build213-ui-qa` B1 | Real app, Agents "lab" (online) and "vps" (offline) | Passed |
| Auto-update policy, scheduler, history | `agent-update-manager-smoke` (12) | Mocked | Passed |
| Auto-update toggle writes the real file; Turn off now; refused update in history | `build213-ui-qa` C1 | Real app | Passed |
| Package Agent update and rollback | `package-agent-update-smoke` P1–P10 | Mocked shell | Passed |
| Move checks | `migration-preflight-smoke` P1–P8 | Mocked | Passed |
| Move dialog blocks | `build213-ui-qa` D1 | Real app | Passed |
| Transfer with verify and checksum | `workload-transfer-smoke` | Local, two real Agent processes | Passed |
| Agent screen colors | `agent-tui-theme-smoke` T1–T4 | Local | Passed |
| Modpack update check | `modpack-update-check-smoke` K1–K6 | Mocked | Passed |
| Modpack check against Modrinth | One read-only lookup: Cobblemon pack at 1.6 reported 1.8.4 for 1.21.1 | Real internet, read-only | Passed |
| File download | `instance-file-download-smoke` D1–D4 | Local, real Agent route and client | Passed |
| Phone gateway | `mobile-gateway-smoke` 26/26 (new G26) | Mocked services, real TLS | Passed |
| Phone app | `mobile-ui-qa` 19/19 (M7 extended) | Real app, real Agent, Edge with phone emulation | Passed |
| Edge as a deployed process | `anxnet-edge-deploy-smoke` E1–E5 | Local, loopback | Passed |
| AnxNet in the app | `anxnet-ui-qa` 8/8 (U4 uses Copy edge config) | Real app, loopback edge | Passed |
| AnxNet regressions | `anxnet-smoke` 13/13, `anxnet-fixes-smoke` 14/14 | Local | Passed |
| Edge service unit | `systemd-analyze verify` | WSL Ubuntu 24.04 | No problems reported |
| Update Cancel before SteamCMD starts | `steamcmd-update-cancel-smoke` C0–C4 (C1 and C3 fail on the old code; a queued cancel is answered at once) plus 9 SteamCMD/update smokes | Local, real instance service, fake SteamCMD | Passed |
| Update Cancel in the app with older Agents | `steamcmd-update-cancel-desktop-smoke` D1–D5 (D1 fails on the old app code) | Mocked Agent replies | Passed |
| Cancel clicked in the real app | `steamcmd-cancel-ui-qa` S1–S2 (now in `qa:release`) | Real app, two disposable Agents, fake SteamCMD | Passed |
| Full smoke tier | `npm run rc:validate` (as CI runs it, fail-fast off) | Mixed | 408/408 passed |
| Release tier | `npm run qa:release` (now includes `build213-ui-qa`) | Mixed, real app | 130/130 passed |

## Not done, or not verified

These Build 213 completion requirements are open. None is claimed as done.

- **A version-changing Agent update on a test machine.** The package update
  and rollback logic is tested with a mocked shell only. A real test needs a
  disposable Debian machine (Docker Desktop is installed but not running;
  starting it needs your OK) and two Agent packages with different builds.
- **The fleet on your real computers.** Shown with disposable Agents. It
  will be seen with Anxlab and the VPS during acceptance of the installed
  release candidate.
- **A real move between two computers.** Done between two local Agent
  processes, not between two machines.
- **A real modpack install.** Only the update check was run against
  Modrinth. Installing one needs a disposable test server.
- **Modpack updates are detected, not applied.** The app says to back up
  and update from the pack's page.
- **Phones.** Edge with phone emulation only; no iPhone or Android device.
- **AnxNet over the internet.** The edge has never run on a public server.
  Deploying it on the VPS opens public ports (47700/tcp, and 30000-30099
  TCP/UDP for the gateway), so it needs your approval. Steps:
  `docs/ANXNET_EDGE_DEPLOYMENT.md`.
- **Agents older than Build 213** can't serve file downloads; the phone
  says to update the Agent. The edge config check also needs a Build 213
  Agent package on the server.
- **Older Agents and update Cancel (issue 53).** The fix is in the Agent.
  With a Build 212 Agent (Anxlab and the VPS today), the Build 213 app no
  longer offers Cancel until SteamCMD has started, and says why; a cancel
  that arrives sooner is held and sent once SteamCMD runs. Cancelling then
  stops SteamCMD mid-run, as before. Updating those Agents removes the wait.
  The Build 212 app on its own still has the bug.
- **A rare test flake:** `instance-engine-fixes` IE9 failed once in a full
  run (round 2: saved record keeps CRASH_LOOP) and passed 16 of 16 times
  on its own. Not investigated further.

## Release candidate (needs approval)

1. Bump to Build 213 (`release.json`, then `scripts/release-docs.js`).
2. Commit, then push `dev` (approval to push).
3. GitHub Actions builds and signs the installer and the Agent packages;
   check the signature and record the SHA-256.
4. Install it over the current app with Computer Use (reply `confirmed`).
5. Acceptance in the installed app, including the fleet on Anxlab and the
   VPS (read-only), Agent auto-update left off, and a phone download.
6. Publish only after `🚀 publish`.
