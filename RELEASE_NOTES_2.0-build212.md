# AnxOS Control Center v2.0 — Build 212

Build 212 is a stability and security release. It fixes 143 defects found in a full review of the app, the Agent, Sharing and AnxNet. The only additions are recovery controls for problems it now detects.

## Added

- **Restore AnxOS Helper.** If an update could not set the Helper up again (for example, the administrator prompt was declined), the app says so and restores it with one click.
- **Approve a changed SSH host key** from the app instead of the connection staying blocked.
- **AnxNet shows when its identity is locked** (its key could not be read) instead of silently creating a new one.

## Changed

- **Crash-loop protection** stops restarting a server that keeps crashing within ten minutes of starting, after three tries.
- **Servers that are running but not ready** now raise a degraded alert.
- **Stop on Windows** asks the server to shut down and save before forcing it.

## Fixed

### Security

- **Remote Agents can no longer be taken over from the network.** Pairing and enrollment accept only the full Agent credential, not a short fingerprint of it. A freshly paired computer is protected at once instead of after its next restart. A computer you removed can only be paired again from that computer itself.
- **The Agent limits what an unauthenticated caller can make it do** (request sizes are capped).
- **This PC's Agent credential is never sent to another computer**, and node-credential recovery can no longer save it as a remote computer's credential.
- **A file dropped on the window can no longer replace the app.**

### Your servers and data

- **An interrupted restore never leaves a server deleted.** A full restore, and the rollback after a failed one, build the restored copy beside the server and swap it in. If the Agent stops in the middle (an update, a restart, a crash), it puts the server back when it starts again. Agent shutdown also waits for a running restore.
- **Updating AnxOS keeps the AnxOS Helper.** If Setup cannot set it up again (for example, the administrator prompt is declined), the app offers **Restore AnxOS Helper**.
- **Stopping a server lets it save.** On Windows, Stop asks the server to shut down before forcing it, stops the whole process tree, and never trusts a process ID that Windows has reused.
- **"Start this server when the computer starts" works.**
- **Deleting a link in Files deletes the link**, not the folder it points to.
- **Backups follow your schedule's retention**, and backups that could never be restored are no longer marked verified.
- **Your AnxNet identity is kept** when its key cannot be read (for example, after renaming the computer). AnxNet reports that it is locked instead of creating a new identity.
- **Settings you change during a backup or SteamCMD update are no longer undone.**
- **The Files editor can no longer save one server's file into another server.**

### Sharing and AnxNet

- Playit addresses keep their port, every tunnel is listed, and an offline computer no longer shows an old "Running" state.
- The Share dialog no longer offers 127.0.0.1 as a network address and reports when stopping sharing fails.
- "Anyone can join" survives restarts: routes the gateway drops are reopened, and a failed reopen keeps your saved route.
- Invites and members follow the owner's address when it changes.

### Reliability

- Daily restarts keep their time across daylight-saving changes.
- SteamCMD updates are no longer killed after ten minutes while they are still downloading, and a stuck SteamCMD no longer blocks later updates.
- Downloads are checked against the checksums Paper, Mojang, Modrinth and CurseForge publish.
- A failed remote Agent update puts the previous Agent back and restarts it.
- The Windows Local Agent is no longer stopped by Task Scheduler after three days, and restarts if it fails.
- Alerts for crashed servers, low disk space and old backups now fire.
- Console logs are written in order, and diagnostics live in one folder.

## Known limitations

- **Updating from Build 211 can show two administrator prompts** (Build 211's uninstaller stops the Helper, then Setup sets it up again). Declining the second one is safe: the app offers **Restore AnxOS Helper**. Updates from Build 212 onwards keep the Helper's startup task.
- **A server that crashes between 8 seconds and 10 minutes after starting** now stops being restarted after three tries (Crash Loop). Start it manually after fixing the cause.
- **Servers that are running but not ready** now show a degraded alert.
- **An interrupted world-only restore** can leave that world partly replaced; the safety backup taken before the restore is listed and can be restored.
- **New downloads may show a SmartScreen prompt** until this release builds reputation. Choose **More info › Run anyway** only if the publisher is Anjo ROSIMO.
- See [Known Limitations](docs/KNOWN_LIMITATIONS.md) for the full list.

## QA

- 21 new regression suites (144 checks); each check failed before its fix.
- Repository validation: all 417 smoke suites and the release tier (119 checks, including the real-app UI tests) passed on the campaign tree. The restore and Helper fixes made after that run were checked with focused suites: backups and restore (22 suites), security, pairing and permissions (60), IPC exposure (7), and Agent Control and installer suites.
- The changed installer script was compiled with NSIS (unsigned local build, discarded).
- The signed release candidate, its in-place upgrade from Build 211 and acceptance testing follow before publication.
