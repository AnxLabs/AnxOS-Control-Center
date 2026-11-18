# Build 214 handoff

**Status (2026-11-17): in development. Nothing is pushed, tagged, released or
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
| 214-B Shared installation foundation | Docker service adapter done; Compose, host folders and own-application import not started |
| 214-C Applications, databases and media | 8 of 11 "coming soon" cards installable in code; Immich, Jellyfin, Java application still unavailable |
| 214-D Game-server expansion | Not started |
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
2. **Minecraft Bedrock (Docker) is broken as shipped.** The
   `itzg/minecraft-bedrock-server` image exits unless `EULA=TRUE` is set, and
   the template sets no environment and no volume. The wizard only shows the
   EULA tick box for Java Minecraft. Not fixed yet: the install now fails
   honestly ("stopped right after starting") instead of reporting success.
   Fix in 214-D: EULA acceptance for this template, plus a `/data` volume.
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
| `node --check` on every changed JavaScript file; `git diff --check` | Clean |

Not run: `npm run rc:validate`, `npm run qa:release`, any real-app UI test.
The new dialog and completion text have not been seen in the running app.

The new smoke is registered in `package.json`
(`marketplace:docker-service:smoke`) and in both lists of
`scripts/release-validation.js`.

## Commits (local only, not pushed)

- `37f70869` feat(marketplace): install databases and apps as Docker services
- The handoff commits that follow it on this branch.

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

1. **See the Docker services in the app.** Run the real app against a
   disposable Agent and check the wizard, the "Save this password" dialog,
   the completion text and the Docker page for one database and one web
   application; then decide whether Docker Desktop on Windows can be
   declared supported.
2. **214-B continued.** Compose adapter for Immich (write a validated Compose
   file to the instance folder, reuse `assertComposePolicy`); a media-folder
   field with a single-path grant for Jellyfin; importing a user's own
   Node.js, Python or Java application.
3. **214-D.** Fix Minecraft Bedrock (EULA, `/data` volume). Then SteamCMD
   games in batches. For each candidate (Project Zomboid, 7 Days to Die,
   Satisfactory, Enshrouded, V Rising, Don't Starve Together, Garry's Mod,
   Unturned, ARK: Survival Evolved and Ascended, Core Keeper, Space
   Engineers, DayZ, Arma 3, Factorio, Terraria, tModLoader) confirm from the
   publisher's own documentation: the dedicated-server app ID, whether
   anonymous SteamCMD login is allowed, supported operating systems, the
   executable and its ports. Games that need a Steam account that owns the
   game cannot use the current adapter, which refuses `login: "required"`.
4. **214-E.** Show Docker services with the other workloads; update,
   uninstall and keep-or-delete-data choices from one place; search, filters
   and favourites; measured resource estimates (none are shown today because
   none were measured).

## Benchmark notes for Build 215

- Time from clicking Install to a running, signed-in service, per card.
- Steps a user must do outside AnxOS (today: none for the nine services
  beyond opening a browser or database client).
