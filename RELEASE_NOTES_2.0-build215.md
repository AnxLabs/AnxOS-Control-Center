# AnxOS Control Center v2.0 — Build 215

Build 215 makes the servers and services you already run easier and safer to look after: one list for everything on every computer, Docker updates that keep your data, Agent updates without typing a password, and a clear answer to "will it run on this computer?".

## Added

- **One list for everything.** My Servers › All computers now shows Docker services next to game servers on every paired computer: type (installed by AnxOS, Compose project or existing container), computer, status and health, ports, kept data and Compose dependencies. Start, stop and restart work across both; Open and Logs go to the Docker page on the right computer. The Docker page keeps every container tool.
- **Docker service updates that keep your data.** Update on a service AnxOS installed downloads the newest image for the same tag and recreates the container with the same ports, settings and volumes. The old container is kept until the new one stays up, and comes back if it doesn't. AnxOS says plainly that this rolls back the image, not data changes the new version made.
- **Key sign-in for SSH.** On the SSH page, Set up key sign-in turns a password profile into an Ed25519 key profile: the key is created on this PC (readable only by your Windows account, optional passphrase through the Windows SSH agent), added to that account on the server over a one-time password connection to the server you already approved, and tested before it is saved. Your password profile stays as a fallback and the server's SSH settings are not changed.
- **Agent updates without a sudo password.** Build 215 Agents ship a small update helper that members of the new `anxos-update` group may run without a password, and nothing else: it accepts only a build number, downloads the official package itself, checks it against the release's checksums, refuses downgrades and other packages, and logs every call. Nobody is added to the group automatically.
- **Live update progress.** Agent updates (one computer, Update all and automatic) show each step as it runs.
- **"Will it run on this computer?"** Create Server tells you, without opening anything, whether the chosen computer is connected, runs a supported operating system, and has the memory and disk the server needs, in plain words.

## Fixed

- **SSH profiles after a locked start.** Unlocking AnxOS now reloads SSH profiles and Agent Control, so Verify Access and Update work without visiting Files first.
- **Agent updates no longer restart unrelated services.** On Ubuntu, `needrestart` restarted other services after the Agent package was installed; it is now suspended for the Agent install, and services that still use replaced libraries are listed for you instead. An update that would change any package other than the Agent is refused.
- **Stale update panel.** After an update, Agent Control no longer shows the old "Pending" line or "Not connected"; the history shows the build the Agent reports. Unsaved changes in the automatic-update settings are kept.
- **"Agent 0.1.0"** no longer appears in update steps or history; builds are shown.
- **The Update button** describes the update method the computer really uses (release package or runtime push).
- **The update confirmation** has a proper title layout and lists the computer, current and new build, method, what keeps running and what happens if it fails.
- **Agent Control buttons** are disabled until the selected computer has loaded, instead of doing nothing when clicked.
- **Docker volume names** are no longer cut off ("app-dat…").
- **All computers loads faster** with Docker services: about 0.2 s instead of 2 s per computer on Docker Desktop.

## Known limitations

- Passwordless Agent updates need a Build 215 Agent on the node, so the move from 214 to 215 still needs one manual `sudo apt-get install` (or passwordless sudo).
- Docker image update is for services AnxOS installed from the catalog; Compose projects and existing containers are refused.
- The fit check uses the server's memory setting; game file sizes are not measured.
- See `docs/KNOWN_LIMITATIONS.md` for the full list.

## QA

- Agent updates were tested for real on disposable Ubuntu 24.04 systemd containers with the official Build 213 and 214 packages: key sign-in against real OpenSSH, password-sudo handling, refusal while a server runs, a rollback drill, a real 213 → 214 update through the helper, Update all over two computers and an automatic maintenance window (9/9). The helper resisted command injection, extra arguments, downgrades, environment injection, an unsafe configuration file and concurrent runs. A disposable service kept running through the update.
- The real app (isolated profile) passed the Build 215 checks (9/9): locked start, key sign-in, Verify Access, the confirmation dialog, live progress through a real update, the refreshed history, Create Server's fit check, Docker services in All computers and a Docker service update with its data kept.
- Docker service update was also run on Docker Desktop with the catalog Nginx service: older image to current in 28 s, same port, data kept.
