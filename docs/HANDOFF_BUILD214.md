# Build 214 handoff

**Status (2026-11-17): in development. Nothing is pushed, tagged, released or
deployed. No real installation has been run yet.**

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
| 214-F Real installation acceptance | Not started: blocked on a running Docker engine |
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
tag lookups only). The settings come from each image's published
documentation as I know it; they are **not yet proven by a real install**.

Still unavailable, and the cards now say why: Immich (needs Compose),
Jellyfin (needs a media folder), Java application (needs own-application
import).

Renderer: the "Save this password" dialog; completion text and navigation
point Docker services at the Docker page; the template details show "What
this is" (service, not a game server) and "Kept data".

## Tests run

All mocked: the Agent client is faked and the network blocked. None of this
is real installation acceptance.

| Test | Result |
| --- | --- |
| `node scripts/marketplace-docker-service-smoke.js` (new, S1–S8) | Passed |
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

- **Real installs need a Docker engine.** Docker Desktop is installed on the
  development PC but was not running, and the Ubuntu WSL distribution has no
  Docker. Starting Docker Desktop needs the owner's go-ahead. Anxlab and the
  VPS were not touched.
- This worktree has no `node_modules`. Tests ran with `NODE_PATH` pointing at
  the `anxos-control-center-simplify-8080f1` worktree (same `dev` commit).

## Next steps

1. **214-F for the Docker services (first, before more cards).** With a
   Docker engine and a disposable Agent: install each of the nine services
   under a throwaway name, sign in or connect with the generated password,
   restart the container and confirm the data is kept, then test a busy
   port, a same-name reinstall and removal. Fix whatever the real images
   disagree with.
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
