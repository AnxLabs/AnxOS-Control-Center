# Build 214 handoff

**Status (2026-11-18): in development. Nothing is pushed, tagged, released or
deployed. The nine Docker services passed real installs on the development
PC's Docker Desktop; nothing has been installed on Anxlab, the VPS or a Linux
computer.**

Build 214 turns the Add a Server catalog into a working installation
marketplace. Work is on branch `claude/anxos-build-214-marketplace-1e6322`,
fast-forwarded from `dev` at `ae21937a` (the Build 213 close, which already
carries `cf319694` and `5ca69374`).

## Milestones

| Milestone | State |
| --- | --- |
| 214-A Catalog and installer audit | Done (below) |
| 214-B Shared installation foundation | Docker service adapter and one read-only host folder done; Compose and own-application import not started |
| 214-C Applications, databases and media | 9 of 11 "coming soon" cards installable and real-tested (Jellyfin added); Immich and Java application still unavailable |
| 214-D Game-server expansion | Batches 1-2 done: Bedrock fixed; V Rising, Enshrouded, Unturned, Satisfactory, Don't Starve Together, 7 Days to Die added; all passed real installs on Windows. Project Zomboid deferred |
| 214-E Marketplace and lifecycle improvements | Not started (two small renderer changes made, see below) |
| 214-F Real installation acceptance | Docker services: passed on Docker Desktop (Windows). Linux computer and the app's own screens: not done |
| 214-G Stabilization and release preparation | Not started |

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

Not run: `npm run rc:validate`, `npm run qa:release`, any real-app UI test.
The new dialog and completion text have not been seen in the running app.

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
- This worktree has no `node_modules`. Tests ran with `NODE_PATH` pointing at
  the `anxos-control-center-simplify-8080f1` worktree (same `dev` commit).

## Next steps

1. **Run the games on Linux and let a player join.** None of the new games'
   Linux variants has run (they are labelled untested); the UDP readiness
   check should also be confirmed on a disposable Linux node (not Anxlab's
   live servers).
2. **Immich through a Compose installer type** (design above), then Project
   Zomboid once a SteamCMD server can be given a generated password safely,
   then the ARK servers.
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
