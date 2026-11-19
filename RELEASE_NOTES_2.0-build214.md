# AnxOS Control Center v2.0 — Build 214

Build 214 makes Add a Server a real installation marketplace. Every card that says it installs was installed for real on a test PC before it shipped, and the ones that can't work yet say why instead of pretending.

## Added

- **13 more game servers**, each installed and started for real on Windows: ARK: Survival Evolved, ARK: Survival Ascended, Space Engineers, Core Keeper, V Rising, Enshrouded, Unturned, Satisfactory, Don't Starve Together, 7 Days to Die, Garry's Mod, Project Zomboid and Factorio (Factorio on Linux). Cards name the operating systems they were tested on; untested ones say so.
- **Databases, apps and media as Docker services:** PostgreSQL, MariaDB, Redis, Grafana, Prometheus, Uptime Kuma, Gitea, Nextcloud, Nginx, Jellyfin (with a read-only media folder), Immich (as one Compose project), IT-Tools and Stirling PDF. Passwords are generated per install and shown once; AnxOS keeps no copy. Utilities are published on this computer only by default.
- **Deploy your own application:** a Java .jar, or a zipped Node.js or Python project, runs as a managed app with start, stop, logs and resource use. The archive is checked before anything is created. AnxOS does not install npm or pip packages yet: bring node_modules with a Node.js project; a Python project that lists packages is refused with a message.
- **Discord.js Bot** deploys your own zipped bot. Its bot token is stored encrypted by the AnxOS Agent and given to the bot as DISCORD_TOKEN when it starts; it is never saved in the bot's files or shown again.
- **Server secret store.** Passwords a server needs at start (Project Zomboid's administrator, a bot token) are stored encrypted by the Agent, separately from the server's settings, files and backups, and removed from its console output.

## Fixed

- **Modrinth modpacks install and run.** Every Modrinth pack failed with "server-pack runtime could not be resolved" since Build 193; AnxOS now installs the Minecraft and loader version the pack declares.
- **Minecraft servers on Windows PCs that have their own Java installed** could fail to start ("executable is outside approved paths"); AnxOS's bundled Java is now chosen.
- **Python apps on Windows** were never detected (the "python3" command there is the Microsoft Store shortcut).
- **Windows game servers started by name** ("not found") and **UDP-only servers stuck on Starting**, including Valheim, Palworld and V Rising, now start and report ready.
- **Minecraft Bedrock (Docker)** installs again; it needs the Minecraft EULA, which the wizard now asks for, and keeps its world.
- **Settings files are escaped:** a quote or angle bracket in a server name can no longer add settings to a game's settings file.
- **Docker:** busy ports are detected before anything is created, slow image downloads and container starts no longer fail as "Agent unavailable", and the volume list loads on computers with many containers.
- **Running service-managed servers (such as systemd services) no longer block an Agent update**, because an Agent restart doesn't stop them.
- **The two Bots cards weren't bots** (one was an HTTP server, one a loop that did nothing). Discord.js Bot now deploys your bot; Python Discord Bot is marked unavailable until AnxOS can install Python packages.

## Known limitations

- **New game servers are Windows-only for now** apart from Factorio (Linux), Unturned, Valheim and Palworld (both). ARK: Survival Ascended and Space Engineers publish no Linux server.
- **Stop on Windows can't ask ARK, Space Engineers or Core Keeper to save first** (they have no console); the world is kept as of its last autosave.
- **Docker services were tested on Docker Desktop for Windows**; the cards still declare Linux computers until a Linux Docker host has been tested. They are managed on the Docker page, not with your other servers.
- **CurseForge modpacks** were not installed for real in this build (they need CurseForge API access); Rust and CS2 were not re-tested.
- **The server secret store needs a Build 214 Agent.** Project Zomboid and Discord.js Bot refuse older Agents and ask you to update them.
- **No npm or pip installs:** see "Deploy your own application" above.
- **A Discord sign-in was not tested** (it needs a real bot token); the token delivery to the bot was.

## QA

- Real installs on a test PC through the same install path the app uses, with a disposable Agent: every new game (bound its port, reported ready, used AnxOS's settings, stopped cleanly), every Docker service (sign-in with the generated password, data kept across restarts), a Modrinth modpack, and Java, Node.js, Python and Discord.js apps. Each bug they found has a regression check that fails on the old code.
- Repository validation: all 416 smoke suites and the release tier (136 checks, including the real-app UI tests) passed, and the Build 214 real-app checks (9) passed. The test runs were checked to send nothing to the PC's own Local Agent except known read-only probes.
- The signed release candidate is tested by installing it over Build 213 and checking the new cards in the installed app.
