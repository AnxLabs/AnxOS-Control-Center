# Build 214 handoff

**Status (2026-11-18, round 5): implementation complete, at the release
approval gate. Nothing is pushed, tagged, released or deployed. Every card
that says it installs passed a real install on the development PC (Docker
Desktop, Windows, or WSL Ubuntu); nothing has been installed on Anxlab or
the VPS. Release validation results are in "Round 5: final gate" below.**

Build 214 turns the Add a Server catalog into a working installation
marketplace. Work is on branch `claude/exciting-chebyshev-a94fba` (this
worktree), which contains `claude/anxos-build-214-marketplace-1e6322` and is
based on `dev` at `ae21937a` (the Build 213 close). The website
search-indexing fix went to `dev` separately (`623ad5ac`) and is not on this
branch; merge or rebase onto `dev` before the RC keeps both.

## Milestones

| Milestone | State |
| --- | --- |
| 214-A Catalog and installer audit | Done (below) |
| 214-B Shared installation foundation | Docker service adapter, one read-only host folder, Compose projects (Immich), and deploying your own Java (.jar), Node.js and Python (.zip) applications done |
| 214-C Applications, databases and media | All 11 "coming soon" cards installable and real-tested; IT-Tools and Stirling PDF added. The only unavailable card is the Python Discord bot, which was a fake (a sleep loop) and now says why (round 5) |
| 214-D Game-server expansion | Bedrock fixed; V Rising, Enshrouded, Unturned, Satisfactory, Don't Starve Together, 7 Days to Die, Garry's Mod, Project Zomboid (server secret store), ARK: Survival Evolved, ARK: Survival Ascended, Space Engineers and Core Keeper added and real-installed on Windows; Factorio on Linux; Unturned, Valheim and Palworld also on Linux. Modrinth modpacks fixed and real-installed (round 5) |
| 214-E Marketplace and lifecycle improvements | Search, category filters, favourites and the Modpacks browser already existed. Not done: Docker services listed with the other servers, one place for update and uninstall with keep-or-delete-data (Build 215 candidates) |
| 214-F Real installation acceptance | Docker services on Docker Desktop (Windows), games and imported applications on Windows, a Modrinth modpack, the real app (`build214-ui-qa`), and Unturned, Valheim and Palworld on Linux (WSL Ubuntu 24.04) pass. Docker on a Linux host and a CurseForge modpack: not done |
| 214-G Stabilization and release preparation | Release validation run (round 5, below); RC not started (needs approval) |

## 214-A audit: what the catalog really did

The catalog (`config/marketplace-templates.json`) had 33 templates. One
lifecycle engine installs them all (`executeInstallTemplate` in
`src/services/marketplaceService.js`); the installer type comes from
`src/services/marketplaceInstallerRegistry.js`.

| Adapter | Templates at the start of Build 214 | State found |
| --- | --- | --- |
| `java-runtime` | Minecraft Vanilla, Paper, Purpur, Fabric, Forge, NeoForge | Working |
| `direct-download` | Velocity, Waterfall, BungeeCord, Hytale (Linux only) | Working |
| `archive-download` | Terraria TShock, FiveM | Working |
| `steamcmd-native` | Valheim, Rust, CS2, Palworld | Working; anonymous login only (`login: "required"` is refused by the registry) |
| `docker-image` | Nginx, Minecraft Bedrock | Partly working, see findings |
| `local-import` | Node.js app, Python app, discord.js bot, Python Discord bot | Generates a starter project; cannot import the user's own code |
| `no-install` | Jellyfin, Immich, Nextcloud, Gitea, Uptime Kuma, Grafana, Prometheus, PostgreSQL, MariaDB, Redis, Java application | Decorative "coming soon" cards |

Findings:

1. **The Docker adapter could not install a real image.** It called
   `docker create` directly, which runs under the 8-second Docker command
   limit, so any image not already on the computer timed out. It also sent no
   volumes, environment or labels, so a database had no password and lost its
   data when the container was removed. Fixed in 214-B.
2. **Minecraft Bedrock (Docker) was broken as shipped.** The
   `itzg/minecraft-bedrock-server` image exits unless `EULA=TRUE` is set, and
   the template set no environment and no volume. Fixed in 214-D (below).
3. **Docker Compose exists in the Agent but not in the Marketplace.** The
   Agent can run, stop, pull and remove Compose projects and checks them
   against the Docker policy (`src/shared/dockerService.js`,
   `assertComposePolicy`). No template can use it, and nothing writes a
   Compose file to a computer. Needed for Immich.
4. **Host folders are refused by policy without an explicit grant.** Jellyfin
   needs the user's media folder. That needs a folder field in the wizard and
   a deliberate `hostMount` grant for that one path.
5. **Docker services are managed on the Docker page, not under My Servers.**
   The install result said "Find it under My Servers" for containers. Copy
   fixed; unifying the two views is 214-E.
6. **Docker templates declare Linux only.** Docker Desktop on Windows was not
   tested, so the claim is unchanged.
7. **Template `configNotes` were never shown in the app.** Now shown for
   services.

## 214-B: Docker service adapter (done in code)

- `src/shared/marketplaceDockerTemplate.js` (new): a template's `docker`
  block may only hold `image` (with a tag or digest), `ports`, named
  `volumes`, `environment`, generated `secrets`, `restartPolicy` and
  `command`. `privileged`, `network`, `binds`, `mounts`, `devices`,
  `entrypoint`, `user`, capabilities and any unknown key make the manifest
  invalid, so the card shows as unavailable. Community templates go through
  the same check. The Agent's Docker policy gate still applies on top.
- Install flow (`installDockerTemplate`): check the computer (Agent
  preflight: name, image, policy, busy ports) → refuse if a data volume of
  the same name exists → download the image (10-minute limit) → create the
  container with volumes, settings and labels (`anxos.managed`,
  `anxos.template`) → confirm it stays running.
- Failure handling: a busy port or earlier data stops the install before any
  download. A container that exits at once fails the install with its last
  (redacted) log lines; the container and the volumes this install created
  are removed, and the message says what was left.
- Passwords: generated per install (24 letters and digits), passed to the
  container as environment values, returned once and shown once in a "Save
  this password" dialog. AnxOS keeps no copy. Saved job records and
  diagnostics redact them. They remain readable on the computer itself
  through `docker inspect`, like any container environment value.
- Works with Build 213 Agents: it uses only existing Agent routes
  (`preflight/container`, `volumes`, `images/pull`, `containers`,
  `containers/:id/inspect`). No Agent change.

## 214-C: services now installable (in code)

| Card | Image | Port | Kept data | Sign-in |
| --- | --- | --- | --- | --- |
| PostgreSQL | `postgres:17-alpine` | 5432 | `<name>-data` | user and database `anxos`, generated password |
| MariaDB | `mariadb:11.4` | 3306 | `<name>-data` | user `anxos` and `root`, generated passwords |
| Redis | `redis:7-alpine` | 6379 | `<name>-data` (append-only file) | generated password |
| Grafana | `grafana/grafana:latest` | 3000 | `<name>-data` | `admin`, generated password |
| Prometheus | `prom/prometheus:latest` | 9090 | `<name>-data`, `<name>-config` | none (keep it on the local network) |
| Uptime Kuma | `louislam/uptime-kuma:2` | 3001 | `<name>-data` | account created on first visit |
| Gitea | `gitea/gitea:1` | 3000 web, 2222 SSH | `<name>-data` | first registered account is the administrator |
| Nextcloud | `nextcloud:stable-apache` | 8080 | `<name>-data` | setup in the browser, SQLite |
| Nginx | `nginx:stable-alpine` | 8080 | `<name>-site` (new) | none |

Every image tag was confirmed to exist on Docker Hub on 2026-11-17 (public
tag lookups only), and each service passed a real install (next section).

Still unavailable, and the cards now say why: Immich (needs Compose),
Jellyfin (needs a media folder), Java application (needs own-application
import).

Renderer: the "Save this password" dialog; completion text and navigation
point Docker services at the Docker page; the template details show "What
this is" (service, not a game server) and "Kept data".

## 214-F: real installs of the Docker services (2026-11-17)

`node scripts/marketplace-docker-real-install.js` (new; not part of release
validation, needs a Docker engine and internet). It starts a disposable Agent
on a free loopback port with temp folders, installs through the real
`installTemplate` path, and removes everything it made (`anx214-*` containers
and volumes, and images that were not on the PC before). Docker Desktop
4.99.0, engine 29.9.3 (linux/amd64) on Windows 11. The installed app, the real
Local Agent, Anxlab and the VPS were not used.

| Service | Install time | Proven |
| --- | --- | --- |
| PostgreSQL | 22 s | Generated password works through the published port from a second container; a wrong password is refused; a table written before a restart is read after it |
| MariaDB | 20 s | User and administrator passwords work; a wrong password is refused; table kept after restart |
| Redis | 14 s | Password works; no password is refused (`NOAUTH`); key kept after restart |
| Grafana | 40 s | `admin` signs in with the generated password; the default `admin` password is refused; a folder created before a restart is there after it |
| Prometheus | 19 s | Ready endpoint answers; the settings volume holds the default `prometheus.yml`; data volume kept after restart |
| Uptime Kuma | 59 s | Web interface answers; data volume kept after restart |
| Gitea | 19 s | Web interface answers on the chosen port; data volume kept after restart |
| Nextcloud | 49 s | `status.php` answers and reports "not installed yet" (setup is finished in the browser); data volume kept after restart |
| Nginx | 15 s | Serves its page; a file written to the site volume is served after a restart |
| Refusals | | A second install on a busy port is refused before any container or volume is created; a same-name reinstall over earlier data is refused and the data is untouched |

Install times include the image download on a home connection and are from
one run each: indicative, not a benchmark. Eight services and the refusals
passed in one full run; PostgreSQL passed in a run of its own after its
check was corrected (the image trusts connections made inside its own
container, so the password has to be tested from outside).

**Bugs the real engine found (all fixed, none visible to the mocked tests):**

1. **A busy port was never detected.** The Agent's pre-install check read
   published ports only in the Engine API's object form; the Docker CLI
   prints text ("0.0.0.0:8080->80/tcp"). The Docker page's own create check
   had the same blind spot. Fixed in `readPublishedHostPorts`
   (`src/shared/dockerService.js`); Agents older than Build 214 keep the
   blind spot, so the install also turns Docker's "port is already
   allocated" into the same clear message and removes the volume that failed
   create left behind.
2. **The volume list took longer than the app's 12-second limit** on a PC
   with about ten containers, because it inspected every container and
   volume with a separate command. This affects the Docker page's Volumes
   list too. `listVolumes` now uses one inspect command for all containers
   and one for all volumes, and the install looks up only its own volume
   names.
3. **A free volume name was reported as "Docker command failed: []"**,
   because `docker inspect` prints `[]` before its error. The message now
   skips that line; the install also accepts the old form from older Agents.
4. The install's "is it still running?" check gave up on the first slow
   answer; it now retries.

Not covered by the real run: a container that exits right after starting,
a failed image download, and cancelling (mocked only); Docker on a Linux
computer; anything seen in the app's own windows; removal and updates from
the Docker page; first-run setup of Nextcloud, Gitea and Uptime Kuma in a
browser.

## 214-D batch 1: game servers (2026-11-17)

**Minecraft Bedrock (Docker).** The wizard now shows the Minecraft EULA tick
box for it (`requiresEula: "minecraft"`), and the main process refuses the
install without it (`EULA_REQUIRED`) before anything is checked or
downloaded. The container gets `EULA=TRUE` and keeps `/data` (world and
`server.properties`) in a volume. Real install: refused without the EULA,
installed in 27 s, logged "Server started.", world and settings in the
volume, data kept after a restart.

**New SteamCMD games.** How each was verified before it was added:

| Game | Steam app | Source of the start command and ports | Computers |
| --- | --- | --- | --- |
| V Rising | 1829350 (anonymous) | Stunlock's official instructions (GitHub `StunlockStudios/vrising-dedicated-server-instructions`, 1.1.x PC) and the `start_server_example.bat` and default `ServerHostSettings.json` the server ships | Windows only (Steam lists Windows only; no Linux build) |
| Enshrouded | 2278520 (anonymous) | The `enshrouded_server_readme.txt` the server ships, and the settings file it writes on first start | Windows only (Steam lists Windows only) |
| Unturned | 1110390 (anonymous) | The `ServerHelper.bat`/`.sh` and `ExampleServer.bat` the server ships | Windows and Linux (Linux start not yet run) |

Real installs on this PC (Windows 11), through the real Marketplace install
path with a disposable Agent and ports chosen at run time
(`node scripts/marketplace-steamcmd-real-install.js <game>`). Each game was
downloaded by SteamCMD, verified, started, then checked: the game's own
process holds the chosen UDP port, AnxOS reports it **Running / ready**, the
server uses the settings AnxOS wrote, and Stop ends it and frees the port.
Everything was deleted afterwards.

| Game | Install and start | Settings check |
| --- | --- | --- |
| Enshrouded | 123 s | `enshrouded_server.json` kept the name and port AnxOS wrote |
| V Rising | 57 s | Saves under `save-data`; the log shows the chosen name |
| Unturned | 125 s | Server files created next to the `Commands.dat` AnxOS wrote |

Times are from the last run, partly from SteamCMD's cache; first downloads
took 2-8 minutes (Enshrouded is about 8 GB).

**Bugs the real runs found (all fixed):**

1. **Windows could not start any server named without a folder.** Windows
   does not search a new process's working directory, so `VRisingServer.exe`
   (and the existing Windows variants of Valheim, Rust and Palworld) failed
   with "not found". The Agent now starts a program that is a file inside
   the server folder by its full path (`resolveSpawnExecutable`); anything
   else is left to the system. `windows-spawn-executable-smoke` W5 shows the
   real spawn failing before and working after. Agent change: reaches a
   computer with a Build 214 Agent.
2. **UDP-only game servers never became "ready".** Readiness was a TCP
   port check or a known log line, so V Rising, Enshrouded and Unturned (and
   very likely Valheim, Palworld and CS2 today) stayed "Starting" until the
   startup timeout marked them degraded. The Agent now also treats the
   server's port as ready once it cannot be bound over UDP while the
   server's process runs (`checkUdpPortHeld`). Agent change.
3. **Config file paths were not filled in.** Unturned's settings were
   written to a literal `Servers/{id}/` folder that the server never reads.
   `{id}` (a slug) is now filled in for paths; any other placeholder in a
   path is refused, so a server name can never become part of a path.
4. **A native server with no start arguments was refused** as "startup
   command could not be configured". Only launchers (java, bash, cmd, node,
   python and similar) now need arguments.

**Not done in this batch:** a Linux run of Unturned; players actually
joining; updates and the SteamCMD update path for the new games; the rest of
the candidate list.

**Candidates checked against Steam's own app data (anonymous download is
possible for all of these; not yet added):** Project Zomboid 380870
(Windows, Linux), 7 Days to Die 294420 (Windows, Linux), Satisfactory
1690800 (Windows, Linux), Don't Starve Together 343050 (Windows, Linux; needs
a Klei cluster token for players to join), Core Keeper 1963720 (anonymous
install failed here with "Missing configuration"; needs investigation),
ARK: Survival Evolved 376030 (Windows, Linux), ARK: Survival Ascended
2430930 (Windows only), Space Engineers 298740 (Windows only), DayZ 223350
and Arma 3 233780 (both need a Steam account that owns the game, which the
current installer refuses), Garry's Mod 4020. Factorio and Terraria are
distributed outside SteamCMD (Factorio's headless server from factorio.com;
Terraria is already covered by TShock).

## Build 214 round 2 (2026-11-18)

**Jellyfin (214-C).** A Docker template may now ask for one folder from the
computer (`docker.hostFolder`): the user names it in the wizard ("Media
folder"), it is always mounted read-only, and it carries the single Docker
policy grant (`hostMount`) it needs. Whole drives, system folders, whole
user profiles or home folders, AnxOS's own data, and paths with `..`, commas
or quotes are refused before anything is sent. Docker Desktop creates a
missing folder instead of refusing it, so the install looks inside the
container and warns when the media folder is empty.

**Every Docker service passed Stop and Start** (added to the real run) as
well as a restart: PostgreSQL, MariaDB, Redis, Grafana, Prometheus, Uptime
Kuma, Gitea, Nextcloud, Minecraft Bedrock, Jellyfin, Nginx, plus the
busy-port and earlier-data refusals. Uptime Kuma and Nextcloud passed in a
second run after the timeout fixes below.

**Games (214-D batch 2), real installs on Windows** through the Marketplace
path and a disposable Agent: each bound its chosen port, AnxOS reported it
Running / ready, it used the settings AnxOS wrote, and Stop freed the port.

| Game | Install | Evidence for the settings |
| --- | --- | --- |
| Satisfactory (1690800) | 233 s | Direct run: `-Port` binds UDP and TCP (server API), `-ReliablePort` binds TCP |
| Don't Starve Together (343050) | 112 s | Shipped launch script; the server's own log: LAN servers must use ports 10998-11018 |
| 7 Days to Die (294420) | 415 s | Shipped `serverconfig.xml`; direct run with AnxOS's small settings file |
| Valheim (existing) | 108 s | Confirms the Windows start and UDP readiness fixes |
| Palworld (existing) | 469 s | Confirms the same fixes |

New games are Windows only for now; their Linux variants say "not tested by
AnxOS yet". Don't Starve Together runs as a LAN server; internet play needs
a cluster token from the owner's Klei account (the card says how to add
it). 7 Days to Die's remote console (telnet) is switched off because the
shipped default has no password.

**Not added:**
- **Project Zomboid**: its first start asks for an administrator password
  on the console. Passing it as `-adminpassword` would store it in the start
  command and print it in the "Launch command" log line (arguments are
  redacted one at a time). Needs a way to hand a generated password to a
  SteamCMD server without putting it in the command.
- **Immich**: several linked containers (server, machine learning, Redis,
  PostgreSQL with vector search). Needs a Compose installer type: write a
  validated Compose file and `.env` to the target computer, run it through
  the Agent's existing Compose routes and `assertComposePolicy`, use named
  volumes rather than the official file's host folders, and manage it as one
  Compose project.
- **Java application**: needs importing the user's own `.jar`.

**Bugs found by the real runs (all fixed, with regression checks):**

1. **Slow image downloads failed as "Agent unavailable".** The Agent cut
   every request off at its default 2 minutes; image pulls and Compose
   pull/up/recreate now get 11 minutes (build 21). Affects the Docker page
   too.
2. **Container create and start used the 8-second limit for quick Docker
   commands**, and the desktop waited only 30 s, so a slow start was
   abandoned while the Agent went on to create the container. Now a minute
   each, and the desktop waits four.
3. **Valheim never became ready**: it holds its port as an IPv6 socket,
   invisible to an IPv4 bind test. The UDP check now tries IPv4,
   dual-stack IPv6 and IPv6-only.
4. **Settings values were not escaped.** A quote in a server name could add
   settings to a game's XML (in 7 Days to Die, switch the password-less
   remote console back on) or break Enshrouded's JSON. Values are escaped
   for XML and JSON, and line breaks never pass.
5. **SteamCMD "Success" without the files** got no second attempt; a
   missing result now gets the same single retry as a failure.
6. **A freshly downloaded executable was reported missing**
   (`7DaysToDieServer.exe`) although it was on disk: reading it can fail
   while Windows briefly holds it. A file now also counts when its folder
   lists it.

Agent-side changes (1, 2, 3) reach a computer only with a Build 214 Agent.

**Note for the operator:** SteamCMD runs started outside AnxOS on the same
computer at the same time made two AnxOS installs fail inside SteamCMD
(exit codes 5 and 8); they passed when re-run alone. AnxOS already queues
its own SteamCMD runs.

## Build 214 round 3 (2026-11-18)

**Utilities (owner request).** IT-Tools (`corentinth/it-tools:2024.10.22-7ca5933`)
and Stirling PDF (`stirlingtools/stirling-pdf:3.3.0`), both published on
127.0.0.1 only (private to the computer by default). Stirling PDF's first
account is `admin` with a generated password set through its documented
`SECURITY_INITIALLOGIN_*` settings. Real installs: IT-Tools served after
restart and Stop/Start; Stirling PDF healthy, the generated password signs
in, the well-known default and a wrong password are refused, the password is
not in its logs, settings kept after restart and Stop/Start.

**Real-app acceptance** (`node scripts/build214-ui-qa.js`, new: real
Electron app, isolated profile, real disposable Agent, real Docker and
SteamCMD). All six checks pass:
L1 catalog labels; J1 Jellyfin media folder (empty and system folder
refused, read-only mount); J2 empty-folder warning shown; P1 Stirling PDF
password dialog shows the container's password and the app keeps no copy;
F1 a port held by another program fails in the window and leaves nothing;
S1 Unturned installed from the window, Running/ready in My Servers, stopped.
Screenshots: `BUILD214_QA_SHOTS=<dir>`.

**Linux certification** in WSL Ubuntu 24.04 (kernel 6.18 WSL2), with
Node.js v24.22.3 and SteamCMD installed in the user's home folder (no sudo),
running the same `marketplace-steamcmd-real-install.js`:
Unturned 140 s, Valheim 140 s, Palworld 142 s: each installed, bound its UDP
port, was reported Running/ready (UDP readiness via `ss`), used AnxOS's
settings and stopped cleanly. Docker on a Linux host was **not** tested:
WSL has no Docker engine of its own (the only engine is Docker Desktop).

**Immich** (`installerType: "docker-compose"`). Immich's official v3.4.1
Compose file is shipped in `config/compose/immich/` with documented changes
(no fixed container names; named volumes for photos and database; no host
clock mount; only the web app published). The Agent gains
`POST /api/v1/docker/compose/managed` and `/managed/remove`
(`agent/src/services/managedComposeProjects.js`): they write exactly
`docker-compose.yml` and `.env` into `<instance root>/../anxos-compose-projects/<name>/`
after the existing Compose policy check, never over an existing project.
The existing Compose routes pull, start, report status and remove. Real
install: healthy in 91 s, four containers with only the web app published,
administrator sign-up and sign-in over Immich's API, account kept after a
restart and after Stop/Start, everything removed afterwards.

**Bugs found and fixed this round:**
1. A Docker service installed "successfully" on a port another program
   was listening on (Docker Desktop publishes over it; the wizard's port
   list has no listener data on Windows). The Agent's container check now
   binds each published port on both addresses (Agent change).
2. Valheim's Linux start command lacked `LD_LIBRARY_PATH=./linux64` (its
   bundled Steam library), so its network failed and it exited. Fixed as
   Valheim's own `start_server.sh` does; existing servers keep their saved
   command.
3. SteamCMD's "Missing configuration" (stale app information) failed the
   Linux installs; it is now retried once like other transient errors (in
   `5a6497f1`).
4. Immich reads `IMMICH_PORT` from `.env` as its own listening port; the
   first Compose file used that name for the host port and the web app
   became unreachable while reporting healthy. Renamed `ANXOS_IMMICH_PORT`,
   with a comment and a smoke assertion.

**Java application import** (`1a3c7cd1`). "Choose .jar…" uses the native
dialog; the file stays in the main process under a 30-minute token. It must
be a ZIP with a manifest Main-Class, at most 150 MB, and is copied as
`app.jar` (existing base64 file write). It runs as the existing `java-app`
instance: `java -Xmx<memory> -jar app.jar <arguments>`, no shell; Java
runtime options typed as program arguments are refused. New instance
`readinessMode: "process"`: an app without a port is ready once it keeps
running through its startup window. Real runs found and fixed three ways
a generic Java app was treated as Minecraft ("nogui" appended over the
user's arguments, start skipped waiting for a download, version detection
parsing it as Minecraft so the Java rules demanded Java 8); imported apps
now have their own family `java-application`.
Evidence: `node scripts/marketplace-java-app-real-install.js <test.jar>
<not-a-jar>` A1-A4 pass (ready without a port; quoted arguments and the
256 MB limit reach the app; data kept across Stop/Start and Restart; ready
on its port; a crash fails the install with exit code 3 and its output in
the logs; refusals create nothing). `build214-ui-qa` A1 (real app, the
test answers the native file dialog) passes.

**Known, not fixed:**
- The Create Server window says "No computer is connected yet" for its
  first second while it is still reading the computer's status. Wording
  issue only; the install proceeds once loaded.
- Valheim's template still starts with a fixed join password
  (`changeme123`, existing behaviour; the card says to change it).

## Build 214 round 4 (2026-11-18)

**Server secret store and Project Zomboid** (`80acf941`). Design and threat
model: `docs/SERVER_SECRET_STORE.md`. A write-only, per-server store for
passwords a game server needs at start; the rule that a server's ordinary
environment may not hold secrets (`SECRET_ENVIRONMENT_NOT_ALLOWED`) is
unchanged.
- AES-256-GCM with a per-computer random key in its own 0600 file (or the
  operator's `AGENT_SERVER_SECRET_KEY_FILE`), recorded only by
  fingerprint; each value is bound to its server and setting name as
  authenticated data. Kept beside the instances folder
  (`anxos-server-secrets/`), never inside a server's folder, so file
  browsing, backups, moves and support bundles never contain it.
- `secretEnvironment` on create and update is write-only; `config.json` and
  the app see names only. Values are decrypted only when the server process
  starts (never for an installer run), and scrubbed from its output and
  crash tail. A missing or unreadable value refuses the start
  (`SERVER_SECRET_UNAVAILABLE`); the key can be rotated; deleting a server
  deletes its values.
- Project Zomboid generates an administrator password, shows it once, and
  names it in its start command as `%ANXOS_PZ_ADMIN_PASSWORD%`. An Agent
  older than Build 214 would ignore the secret, so the install removes the
  server it created and asks for an Agent update
  (`AGENT_SECRET_STORE_REQUIRED`).
- Evidence: `server-secret-store-smoke` K1-K8 (real store, real engine, a
  real child process). Real install on Windows: 493 s, account created with
  the generated password, Running/ready on the chosen UDP port, the
  password in no plain-text file under the Agent's folders.

**Factorio** (`cdb2fb61`). The Linux headless server from factorio.com (a
public download, no sign-in) as an archive install; the first start creates
a world, then runs it on the chosen UDP port with AnxOS's server settings
(LAN-visible; public listing needs a factorio.com account). Real install on
Linux (WSL Ubuntu 24.04): 12 s, world created, ready, Stop freed the port.
The first run was refused because Linux archive installs always demanded
unzip, tar and xz; Linux now requires what its archives use (tar always,
unzip for .zip, xz for .tar.xz), as Windows already did.

**Harness** (`1a706493`): `portsFor` (games whose second port is not the
next one up) and `readyTimeoutMs` (slow first starts). Known leak, not
fixed: each SteamCMD harness run sends 3 read requests (`stats`,
`instances`, `dependencies/check`) to this computer's real Local Agent on
127.0.0.1:47131 before the disposable Agent is selected; its token refuses
them. Setting `AGENT_URL=http://127.0.0.1:9` changed the selected URL but
not these requests (they come from a path with its own 47131 default), so
that change was not kept.

**ARK: Survival Evolved (not certified yet, not in the catalog).** Steam
376030, anonymous, build 21241282, about 21 GB on disk. Template draft:
executable `ShooterGameServer.exe` with working directory
`data/server/ShooterGame/Binaries/Win64` (the Agent refuses a relative path
with slashes, `INVALID_EXECUTABLE`; a bare name in the working directory is
started by full path), one `?`-separated map argument with
`SessionName={id}` (a `?` in a free-text name would add options),
`-server -log -NoBattlEye`, `startupTimeoutMs` 900000, Linux labelled
untested. Three real runs on Windows:
1. Refused with `INVALID_EXECUTABLE` (relative executable path); fixed as
   above.
2. 1079 s: installed, Running/ready, `ShooterGameServer` bound both chosen
   UDP ports (game and query). The harness check failed because ARK writes
   `ShooterGame.log` and its session settings only on a clean exit (the log
   was 0 bytes). A direct start of that install then answered a Steam
   A2S_INFO query on the chosen query port with `anx214-probe - (v361.7)`
   81 s after starting, so the session name argument works.
3. 1220 s: installed, Running/ready on both chosen UDP ports again; the new
   A2S check ran the moment the port opened and got no answer (ARK answers
   about a minute later). The check now retries for up to 5 minutes; that
   version has not run yet.
Stop on Windows ends ARK without a final save: it has no stdin console
(`getConsoleStopCommand` returns null), like the other Windows SteamCMD
games, so the world is kept as of its last autosave; the draft card says
so. To finish: regenerate the catalog with the generator (kept outside the
repo, see How to continue), run
`node scripts/marketplace-steamcmd-real-install.js ark-survival-evolved`
(about 20 minutes, 21 GB in the temp folder, removed afterwards), and add
the catalog entry and a certification row only if it passes.

## Build 214 round 5 (2026-11-18)

**Games (214-D), real installs on Windows** through the Marketplace path and a
disposable Agent (`marketplace-steamcmd-real-install`): each bound its chosen
UDP port, AnxOS reported it Running / ready, it used the settings AnxOS
wrote, and Stop freed the port. Everything was deleted afterwards.

| Game | Steam app | Install, size | Evidence for the settings |
| --- | --- | --- | --- |
| ARK: Survival Evolved | 376030 | 1539 s, 21 GB | Its Steam query port advertised the session AnxOS named |
| ARK: Survival Ascended | 2430930 | 243 s, 12 GB | Its log: `Server: "<id>" has successfully started!` (ASA answers no Steam query) |
| Space Engineers | 298740 | 214 s, 8.4 GB | Its log binds the chosen port; the world is saved under the server id; a direct second start loaded the saved world |
| Core Keeper | 1963720 | 47 s, 0.5 GB | GameInfo.txt reports the chosen port; ServerConfig.json holds the name AnxOS gave it |

All four are Windows only (ASA and Space Engineers publish no Linux server;
the others are labelled untested on Linux). None of them can be asked to save
before Stop on Windows (no console), so Stop keeps the last autosave; each
card says so. Core Keeper writes its generated join password to GameInfo.txt
and its console (the card says to share it only with players). Space
Engineers needs a settings file (without one it stops with "Premade world not
found"), which is XML with a .cfg name: config files can now declare
`format: "xml"` so a server name is escaped (a `<` could have switched its
remote API on).

**Modpacks.** A real Modrinth install (new
`scripts/marketplace-modpack-real-install.js`, Cobblemon for Fabric 1.21.1)
found two bugs that made every real Modrinth pack fail since Build 193:
1. A .mrpack holds mods only, but provider packs waited for the pack to bring
   its server runtime (`SERVER_PACK_RUNTIME_UNRESOLVED`). The runtime the pack
   declares in modrinth.index.json is now installed through the same
   resolvers and installer as the plain Minecraft servers (`ac61585a`).
2. The start command still named `server.jar`, and the Agent's start-time
   jar repair keeps the jar already in the arguments, so the server
   crash-looped; activation now sets the arguments (`ac61585a`).
A third bug was Windows-wide: the Java resolver sorted a JDK under
`C:\Program Files` before AnxOS's bundled Java of the same version, and the
Windows Agent refused it (`EXECUTABLE_NOT_ALLOWED`); the bundled runtime now
wins (`fdd90408`). After the fixes: installed in 138 s, 34 server mods, Java
on the chosen port, Running / ready, the server list answers 1.21.1, Stop
frees the port, Start reuses the same world. CurseForge packs were not
real-tested (they need CurseForge API access).

**Your own Node.js and Python applications** (`0f2fdcec`). Two Development
cards deploy a zipped project folder, checked in the main process before
anything is created (.zip only, 100 MB, 5000 files, 300 MB unpacked; no
absolute paths, `..`, backslashes, links or case-only duplicates) and copied
file by file through the Agent's existing file route into `data/app`. AnxOS
runs neither npm nor pip: Node.js projects with dependencies must include
node_modules, and a requirements.txt that lists packages is refused with a
message. The real install also found that Python was never detected on
Windows (`python3` is the Store stub there), so every Python card stopped at
the dependency check; it is now detected with `python` (detection only).
Evidence: `app-project-import-smoke` P1-P6, `marketplace-app-project-real-install`
N1-N3, `build214-ui-qa` A2.

**Bots** (`b9181a42`). The two Bots cards were not bots ("Discord.js Bot"
generated an HTTP server, "Python Discord Bot" a sleep loop). Discord.js Bot
now deploys the user's zipped bot and takes the bot token in a password
field: the token is removed from the install request before anything reads
it, only names the card declares are accepted (`userSecrets`), and it goes
to the Agent only as write-only `secretEnvironment` (DISCORD_TOKEN at start,
scrubbed from the console, never returned; older Agents are refused). Python
Discord Bot is unavailable and says why. Evidence: P6, N4 (the token is in no
plain-text file under the Agent's or the app's folders), A3 and L1. No
sign-in to Discord was tested (needs a real bot token).

**Test isolation** (`4bf9f6d9`). The known leak from round 4 is fixed: every
real-install harness run made the real Local Agent log 3 "authorization
failed" lines (39 today). `nodeService.saveNode` runs Local Agent discovery,
which probes port 47131 when the config folder has no agent-runtime.json.
`pinAgentRoots(..., { isolateLocalAgent: true })` points it at a closed port;
a full harness run then sent nothing to 47131 (traced with a request
blocker) and the real Agent's count stayed at 4495.

**Catalog at the end of Build 214:** 50 templates, 49 installable, 1
unavailable with its reason (Python Discord Bot). By category: Game Servers
21, Minecraft 6, Development 6, Applications 5, Networking 4, Databases 3,
Bots 2, Utilities 2, Media 1, plus the Modrinth and CurseForge modpack
browser. Certification matrix: 41 Supported, 8 Experimental (imports and
starters, where the user's own code decides the rest), 1 Disabled.

### Round 5: final gate (2026-11-18)

Run on the development PC (Windows 11, Docker Desktop 29.9.3), with this
worktree's own `node_modules` (`npm ci`; the junction to another worktree
made `agent:package:smoke` fail correctly, because the Agent's dependencies
resolved outside the repository).

| Gate | Result |
| --- | --- |
| `npm run rc:validate` | **PASS, 416 of 416** (13:34-13:49) |
| `npm run qa:release` | **PASS, 136 checks** (13:50-14:01), real-app tests included |
| `node scripts/build214-ui-qa.js` with `BUILD214_QA_JAR` | **PASS, 9 of 9** (L1, J1, J2, P1, A1, A2, A3, F1, S1) |
| Real installs this round | ARK SE, ASA, Space Engineers, Core Keeper (SteamCMD harness); Modrinth Cobblemon (modpack harness); N1-N4 (application harness); A1-A4 Java application re-run after the Java change |
| Catalog checks | `marketplace-template-certification-smoke` (50 templates), metadata, game adapter contract, Docker service smoke S1-S14 |

The first full `rc:validate` of Build 214 found checks the earlier rounds
had left stale; each was fixed at its cause (`1db98759`, `2456e5eb`,
`4e1bde5d`):
- `marketplace:chooseApplicationFile` (round 3) had no row in the IPC
  permission matrix; it is now checked to be refused while locked.
- The archive-safety smoke pinned 6 shipped installers (now 19).
- The UI polish smoke looked for a notification title round 1 reworded.
- `marketplace-smoke`'s dependency-resume test never faked `updateInstance`,
  so every run sent 5 real PATCH requests to its node address,
  192.168.1.134:47131, which may be a real computer on the developer's
  network (refused by its token). Pre-existing since 66b5f415.
- IE8 (daily schedules on DST days) reported a hang that was the Windows file
  I/O of its scheduler integration run (7-20 s measured, sometimes over its
  30 s limit); that run now has 120 s, the sweep-only zones keep 30 s.

**Real Local Agent during the gates** (the developer's installed Agent,
`%APPDATA%\AnxHub\logs\live.log`, "authorization failed" lines):
`qa:release` 0 new, `build214-ui-qa` 0 new after `30be6700` (6 before), the
real-install harnesses 0 new after `4bf9f6d9`. `rc:validate` still adds
about 50 per run: Local Agent discovery probes (health answered, then
`stats`, `instances` and `dependencies/check` refused) from 8 smokes that
Build 214 did not change (`node-lifecycle`, `device-architecture`,
`workload-transfer`, `node-connection-workflow`, `multi-node-fleet`,
`security-backup`, `local-agent-pairing`, `agent-control-canonical-credential`).
They are read requests that the token refuses, so nothing changes; fixing
them (a closed discovery port in each smoke's temporary config) is a
follow-up.

**Known, not fixed (round 5):**
- About 4,980 leftover `anx*` folders (729 MB) in the user's Temp folder from
  many builds of smokes that do not remove their temp folders; not deleted
  (needs the owner's go-ahead).
- Rust and CS2 (existing cards) were not re-run in Build 214; CurseForge
  modpacks were not real-tested (they need CurseForge API access).
- None of the new games ran on Linux; their Linux variants say "not tested".
- Docker services are still managed on the Docker page, not with the other
  servers (214-E).

## Release candidate preparation (2026-11-18)

- Approved by the owner ("Start RC prep"). `origin/dev` (`623ad5ac`, website
  search indexing) merged into this branch (`983c222a`); `release.json` Build
  214, `RELEASE_NOTES_2.0-build214.md` and Known Limitations (`b9e96aec`).
  Nothing pushed, tagged or built yet.
- After the merge and bump: `rc:validate` **PASS, 417 of 417** (the website
  smoke came with the merge). `qa:release` **135 of 136**: `acceptance-fixes-ui-qa`
  A2 ("the dashboard polls again after the unlock", at least 2 snapshots in
  7 s) failed with 0, also when run alone, and also on `4e1bde5d`, where it
  had passed in the 13:50 release tier. Diagnosis: on this PC at that time a
  freshly started Agent took 7.3 s to answer its first `/stats` (later ones
  20-170 ms) and a Docker snapshot 5.4 s (Docker Desktop was answering CLI
  calls in 1-2.3 s with other workloads running). With a 20 s window the
  dashboard did poll (4 snapshots). Environment timing, not a Build 214
  change; re-run the release tier on a quieter machine (or in CI) before
  publication.
- Next (needs the owner's approval): push this branch to `dev` (a
  fast-forward from `623ad5ac`) and dispatch `windows-release.yml` on `dev`
  for the signed RC build, then verify CI, the Authenticode signature and
  SHA-256 before asking to install.

## Release candidate 1 (2026-11-19)

- Approved by the owner (push to `dev` and the signed RC1 build). `dev`
  pushed from `623ad5ac` to `7955b872`, then to `996067f8` (fast-forwards).
  Nothing is tagged or published.
- CI run 44453172690 on `7955b872` stopped at rc-validation 86/417 (Linux):
  `minecraft-java-runtime-smoke`'s new no-bundle case built a Windows path
  from `/tmp`, which sorts differently on Linux. Nothing was built. Fixed in
  the test (`996067f8`); the resolver is unchanged.
- `996067f8` also makes `acceptance-fixes-ui-qa` wait until its test Agent
  has answered `/stats` once before the app starts (the first sample took
  2.5-7.3 s on this PC and fell inside A2's 7 s post-unlock window); the A2
  threshold is unchanged. A2 passed 3 of 3 alone and the script 8 of 8.
- CI run 44454087333 on `996067f8`: static validation, rc-validation (417
  suites, Linux), Windows and Linux builds passed; publish skipped (no tag).
- Downloaded to `artifacts/build214-rc1/` in the main checkout (git-ignored):
  - Setup `AnxOS-Control-Center-Setup-2.0-build214.exe` (440,219,856 bytes):
    Authenticode Valid, Anjo ROSIMO, Microsoft timestamp. SHA-256
    `C5B50AE6B5C748F38F8477296C3E48A9537FEF639D3D3FC6003789D2093F6511`;
    `latest.yml` SHA-512 and size match.
  - Portable `AnxOS-Control-Center-2.0-build214-portable.exe`: Valid. SHA-256
    `61639FAF7CBC39F72B6FA16D22982F61400FADF8A724B61EEA0F52EECBDE3923`.
  - Agent package `AnxOS-Agent-2.0-build214.deb`: SHA-256
    `D8018B94AADAE56D53A403A0BE807A5DE7DBFA911AEA946C1C8508D4D73E8ED2`
    (matches its `.sha256`).
  - Linux app: `.deb` `84EC338C56BE40D0BF01E9EC180D99160EF5A8C6CEBBC8D0F6CCE28B2C99E6DC`,
    AppImage `CA3080CE2E7C27E0C3DB25FCB20BBB1A53E9E7E0422F790C280E5A8D4659C1EF`.
- Installed app before the upgrade: Build 213 (the Local Agent reports
  `2.0-build213`). Waiting for the owner's `confirmed` before installing.

- **In-place upgrade over Build 213** (owner replied `confirmed`). Backup
  first: `%APPDATA%\AnxHub\config-backup-pre-build214-rc1-20261118-220551`
  (`config`, `agent`, `instances`: 713 files) and a SHA-256 manifest of
  every file. No server ran under This PC's Agent, so nothing was stopped.
  The verified Setup was started by the assistant (hash and signature checked
  again first); Computer Use could not see the screen (every screenshot was
  solid gray, apparently masked by the screen-control driver's own window),
  so the owner clicked through Setup.
- **After the upgrade:** the installed exe is signed (Valid), the Local Agent
  reports `2.0-build214`, the AnxOSAgent task runs the installed exe with
  `--agent` (no time limit, 3 restarts), and no `helper-restore-needed.json`
  was left. 708 of 713 files are byte-identical, none missing or new; the 5
  that changed are runtime state (alerts, AnxNet session token, state and
  log, window recovery), as in Build 213's upgrade. The AnxNet device key and
  settings, `agent.json`, `nodes.json`, enrollment, endpoints, security,
  Local Agent and node credentials are unchanged.
- **Installed package checked:** `app.asar` holds the 50-card catalog (only
  Python Discord Bot unavailable), the Immich Compose file, the new shared
  modules, release.json Build 214 and the bundled-Java, Modrinth and bot-token
  code; the Local Agent runtime holds the secret store, managed Compose
  projects and the Python detection change.
- **Real app since the upgrade:** started locked; 18 sign-in-required errors
  in its first two seconds (one-time start-up reads), then none. The VPS
  (`127.0.0.1:47132`, the manual SSH tunnel) reads "Agent unavailable" while
  the tunnel is down. Anxlab answers on its unchanged `2.0-build213` Agent.
- **Remaining for acceptance:** the owner unlocks the app (a sign-in only the
  owner can do), then the Marketplace, existing servers, Docker and Agent
  pages are checked in the installed app.

## Tests run

These are mocked: the Agent client is faked and the network blocked. The real
installs are in the section above.

| Test | Result |
| --- | --- |
| `node scripts/marketplace-docker-service-smoke.js` (new, S1–S9) | Passed |
| `docker-smoke`, `docker-route-io`, `docker-job-lifecycle`, `docker-ipc-error-contract`, `agent-docker-actions`, `docker-capabilities`, `docker-hostile-input` smokes (after the Agent-side Docker fixes) | Passed |
| `node scripts/docker-marketplace-engine-smoke.js` (M2 updated for the new steps) | Passed |
| `node scripts/marketplace-smoke.js` (Docker fakes updated) | Passed |
| `node scripts/marketplace-template-certification-smoke.js` | Passed |
| `marketplace-template-metadata`, `marketplace-install-transaction`, `publisher-trust`, `docker-policy`, `marketplace-readiness`, `marketplace-server-capability-ux`, `game-adapter-contract`, `catalog-transfer`, `catalog-transfer-ipc-exposure`, `renderer-free-identifier`, `renderer-safety`, `versioning` smokes | Passed |
| `node scripts/windows-spawn-executable-smoke.js` (new: W1-W5, U1 incl. IPv6 holders) | Passed |
| Round 2: `marketplace-docker-service-smoke` (12 checks: Jellyfin S12, DST and escaping in S11, request limits in S9), `marketplace-smoke` (SteamCMD resume and locked-file cases), `docker-marketplace-engine`, `docker-smoke`, `docker-route-io`, `docker-job-lifecycle`, `docker-hostile-input`, `steamcmd-instance-update`, `instance-engine-fixes`, `marketplace-template-certification`, `renderer-free-identifier`, `renderer-safety` | Passed |
| 32 game and instance-engine smokes (`steamcmd-*`, `palworld-*`, `hytale-*`, `fivem-*`, `instance-*`, `server-page-*`, `game-adapter-*`, `marketplace-template-*`, `startup-selection`) after the Agent changes | Passed |
| `node --check` on every changed JavaScript file; `git diff --check` | Clean |

Rounds 1-4: `rc:validate` and `qa:release` were not run. Round 5 ran both
(see "Round 5: final gate" above).

The new smoke is registered in `package.json`
(`marketplace:docker-service:smoke`) and in both lists of
`scripts/release-validation.js`.

## Commits (local only, not pushed)

- `37f70869` feat(marketplace): install databases and apps as Docker services
- `fcbdb58f` fix(docker): real-engine fixes found by installing the nine services
- `2f21df86` fix(marketplace): Minecraft Bedrock installs and keeps its world
- `0c5c4960` feat(marketplace): V Rising, Enshrouded and Unturned servers
- `ec527517` feat(marketplace): Jellyfin with a read-only media folder
- `746109f3` feat(marketplace): Satisfactory and Don't Starve Together servers
- `84d72d78` fix(docker): slow image downloads and container starts no longer fail
- `46d491e6` fix(marketplace): escape settings values and resume stalled SteamCMD downloads
- `be95df57` feat(marketplace): 7 Days to Die server
- `68f80973` feat(marketplace): IT-Tools and Stirling PDF utilities
- `dede8396` fix(marketplace): real-app and Linux acceptance fixes
- `5a6497f1` feat(marketplace): Immich through the existing Docker Compose routes
- `af1d8b81` docs: record Build 214 round 3
- `1a3c7cd1` feat(marketplace): deploy your own Java application (.jar)
- `58b06326`, `67ffe599` docs: Java import and the Project Zomboid blocker
- `769b522c` feat(marketplace): Garry's Mod server (real install on Windows: 115 s, srcds on the chosen port and name, ready, stopped)
- `47741e77` docs: Build 214 handoff with Garry's Mod and how to continue
- `80acf941` feat(agent): server secret store; Project Zomboid with a safe admin password
- `cdb2fb61` feat(marketplace): Factorio server; archives need only their own tools
- `1a706493` test(marketplace): real-install harness supports custom port layouts and slow starts
- `24dd0fde` test(marketplace): ARK check by Steam query; record round 4
- `24290bda` feat(marketplace): ARK: Survival Evolved server
- `39e10e92` feat(marketplace): Space Engineers server
- `fdd90408` fix(agent): prefer AnxOS's bundled Java over another of the same version
- `ac61585a` fix(marketplace): Modrinth modpacks install the runtime they declare
- `7c080056` feat(marketplace): ARK: Survival Ascended server
- `0f2fdcec` feat(marketplace): deploy your own Node.js or Python project (.zip)
- `548fd843` feat(marketplace): Core Keeper server
- `b9181a42` fix(marketplace): real Discord.js bot deploys; no fake Python bot
- `4bf9f6d9` test(marketplace): real-install harnesses no longer reach the real Local Agent
- `1db98759` test: bring three release-validation checks up to date with Build 214
- `2456e5eb` test(marketplace): dependency-resume smoke no longer sends requests to a LAN address
- `4e1bde5d` test(instances): IE8 gives the scheduler integration run time for its file I/O
- `30be6700` test(marketplace): build214-ui-qa keeps Local Agent discovery off the real Agent
- Handoff commits on this branch.

## Blockers

- **No Linux Docker host was tested.** The owner approved starting Docker
  Desktop on the development PC (it updated itself to engine 29.9.3 during
  the session and was left running). The templates still declare Linux
  only; Docker Desktop on Windows worked here but is not yet offered.
  Anxlab and the VPS were not touched.
- The Agent-side fixes (busy port, volume list, error text) reach a computer
  only with a Build 214 Agent. The install works with Build 213 Agents
  through the fallbacks above, which are covered by mocked tests only.
- Worktrees have no `node_modules` of their own; link the
  `anxos-control-center-simplify-8080f1` worktree's (a junction, ignored by
  git) before running tests.

## Next steps

1. **Run the games on Linux and let a player join.** None of the new games'
   Linux variants has run (they are labelled untested); the UDP readiness
   check should also be confirmed on a disposable Linux node (not Anxlab's
   live servers).
2. **Project Zomboid on Linux and the secret store on a Build 214 Agent.**
   The Windows install passed; the Linux variant is labelled untested, and
   older Agents are refused by design.
3. **More games**: ARK: Survival Evolved, ARK: Survival Ascended, Space
   Engineers and Core Keeper are done (round 5). DayZ and Arma 3 need a
   Steam account that owns the game: documented only, not added (see item
   5). Rust and CS2 (existing cards) were not re-run in Build 214; the
   shared SteamCMD path they use was exercised by every new game.

**How to continue (for the next session or provider):**
- Real-install harnesses: `scripts/marketplace-docker-real-install.js
  [ids]` (Docker services and Immich), `scripts/marketplace-steamcmd-real-install.js
  <games>` (SteamCMD games; add a `GAMES` entry per game),
  `scripts/marketplace-java-app-real-install.js <jar> <not-a-jar>`, and the
  real app: `node scripts/build214-ui-qa.js` (set `BUILD214_QA_JAR` for A1).
  `KEEP=1` keeps files for inspection; delete them afterwards.
- Linux runs: WSL `Ubuntu-24.04` has Node and SteamCMD in `~/anx214`
  (no sudo). Run a harness there through a script file with
  `MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash <script>`
  (inline commands get rewritten by Git Bash). No Linux Docker engine.
- This worktree's `node_modules` is a junction to the
  `anxos-control-center-simplify-8080f1` worktree's (ignored by git).
- Read each game's shipped start script or settings before writing a
  template; add it to the catalog only after a real install passes.
- The SteamCMD game generator that writes the game templates (including the
  ARK draft) is kept outside the repo, in the Claude side-session notes
  folder `%LOCALAPPDATA%Claude-Dataclaude_pzs8sxrjxfjjcside-session-noteslocal_14d1e496-c63e-4efc-85f7-10d5bb82f70a`, as
  `build214-steamcmd-games-generator.js`; run
  `node <generator> config/marketplace-templates.json` (it replaces games by
  id and inserts new ones after the last SteamCMD game; check that the diff
  only adds what you meant).
3. **See the Docker services in the app.** Run the real app against a
   disposable Agent and check the wizard, the "Save this password" dialog,
   the completion text and the Docker page for one database and one web
   application; then decide whether Docker Desktop on Windows can be
   declared supported.
4. **214-B continued.** Importing a user's own Node.js, Python or Java
   application.
5. **Games that need an owned Steam account** (DayZ, Arma 3) need a sign-in
   flow the current installer refuses (`login: "required"`); that is a
   separate design, through Steam's own sign-in, never a stored password.
6. **214-E.** Show Docker services with the other workloads; update,
   uninstall and keep-or-delete-data choices from one place; search, filters
   and favourites; measured resource estimates (none are shown today because
   none were measured).

## Benchmark notes for Build 215

- Time from clicking Install to a running, signed-in service, per card.
- Steps a user must do outside AnxOS (today: none for the nine services
  beyond opening a browser or database client).
