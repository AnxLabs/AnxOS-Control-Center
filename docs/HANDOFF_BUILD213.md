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

## Release candidate 1

- Approved by the owner on 2026-11-16. `release.json` Build 213 (`cf9f98b0`), and
  the release notes QA section that `versioning:smoke` requires (`7327f03c`).
  `dev` pushed from `449fd1f5` to `7327f03c`. Nothing is tagged or published.
- CI run 43954101201 on `cf9f98b0` stopped at `versioning:smoke` (rc-validation
  372/410): the notes had no QA section. Nothing was built.
- CI run 43956401194 on `7327f03c`: static validation, rc-validation (410
  suites, Linux), Windows and Linux builds passed; publish skipped (no tag).
- Setup `AnxOS-Control-Center-Setup-2.0-build213.exe`: Authenticode Valid,
  Anjo ROSIMO, timestamped. SHA-256
  `A8ED4383DDEB00F861C3230090A932357164BF2DC80C2DD20CD74B2C4C2B9FA6`;
  `latest.yml` SHA-512 and size match.
- Portable `AnxOS-Control-Center-2.0-build213-portable.exe`: Valid. SHA-256
  `EDB7149A00B6608E9DE4E0CD9F73C93F615109427770FB5C1C8103DB454B73E5`.
- Agent package `AnxOS-Agent-2.0-build213.deb`: SHA-256
  `7189794139CEEBD8CEDE9005C4C02824F20BE6D60805CA241F0E4DB88589AE08`
  (matches its `.sha256`).
- Installed app before the upgrade: Build 212 (`daa548a`).
- **In-place upgrade over Build 212, with Computer Use** (owner replied
  `confirmed`): Setup found the per-user install, said the Helper "is already
  set up on this PC and is kept", showed no administrator prompt, and closed
  the running app with OK (no local server was running). Afterwards the
  installed app is `v2.0-build213` (`7327f03`), the AnxOSAgent task runs the
  installed exe with `--agent` (no time limit, 3 restarts), no
  `helper-restore-needed.json` was left, and the Local Agent reports
  `2.0-build213`. All 697 recorded config files are present; the AnxNet key
  and settings, security, credentials, enrollment, endpoints, Agent identity,
  `agent.json` and `nodes.json` are byte-identical. Only runtime state
  changed (alerts, AnxNet session token and state, window position). Backup:
  `%APPDATA%AnxHubconfig-backup-pre-build213-rc1-20261116-144723`.
- **Acceptance (after the owner unlocked AnxOS and replied `done`):**
  - All computers lists Windows Desktop 0, Anxlab 7 (stopped) and the VPS's
    running AnxRP, each with its computer. Windows Desktop's 0 matches the
    normal view: the Local Agent's own `minecraft-vanilla` is not listed by
    either (unchanged behaviour).
  - Older Agents: Anxlab reads "2.0 Build 212", Compatible with Control Center
    "Version 2.0 Build 213"; Updates lists Anxlab (SSH profile needs a key)
    and the VPS (212 → 213). Nothing was updated.
  - Automatic Agent updates: Off, defaults shown, no computer chosen.
  - Move dialog against the VPS: every check passed with 72 GB free; Run
    Preview not pressed.
  - AnxNet `anx-delta35` owned, Anxlab connected directly; relay and gateway
    None; Copy edge config present (not clicked: it writes the clipboard).
  - Home: Anxlab 0 of 7 running, VPS 1 of 1, "Build 213 Private Alpha".
- **Findings (RC1 is superseded):**
  1. The Automatic Agent updates panel showed placeholder values ("1 hour",
     no time, no days or computers) with Save enabled for about 15 s. A Save
     then would have written them, and an empty computer list, over the
     saved settings. Cause: Agent Control loaded the panel only after its own
     check of every Agent, and the panel then checked every Agent again.
  2. Copy edge config took one of the edge fields' grid cells.
- **Fixes:** the panel gets the same overview request and shows the saved
  settings at once; its controls stay disabled until they load; the computer
  list says "Checking computers…" and Save keeps the saved computers until
  it has loaded. Copy edge config sits in its own row with the explanation.
  `build213-ui-qa` C2 and `anxnet-ui-qa` U4 fail on RC1 and pass now.

## Release candidate (needs approval)

1. Bump to Build 213 (`release.json`, then `scripts/release-docs.js`).
2. Commit, then push `dev` (approval to push).
3. GitHub Actions builds and signs the installer and the Agent packages;
   check the signature and record the SHA-256.
4. Install it over the current app with Computer Use (reply `confirmed`).
5. Acceptance in the installed app, including the fleet on Anxlab and the
   VPS (read-only), Agent auto-update left off, and a phone download.
6. Publish only after `🚀 publish`.
