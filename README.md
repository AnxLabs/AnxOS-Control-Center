# AnxOS Control Center

AnxOS Control Center is a private, lightweight local desktop dashboard for a homelab server. It uses Electron to open the existing static HTML/CSS/JS interface in a desktop window and reads local system metrics through a narrow Electron IPC service.

Official website: https://anxoscontrolcenter.org

This project intentionally does not include secrets, tokens, API keys, credentials, or backend service controls.

## Private Alpha Status

Current public app metadata comes from `release.json`:

```json
{
  "version": "1.7",
  "build": 142,
  "channel": "Private Alpha"
}
```

Private Alpha means AnxOS Control Center is intended for a small group of trusted testers on known Windows and Debian machines. It is not a public beta and it is not a v1.0 release.

Start here:

- [New User Guide](docs/NEW_USER_GUIDE.md)
- [Onboarding Validation](docs/ONBOARDING_VALIDATION.md)
- [Private Alpha Tester Guide](docs/PRIVATE_ALPHA_TESTER_GUIDE.md)
- [Known Limitations](docs/KNOWN_LIMITATIONS.md)
- [Real-Machine Validation](docs/REAL_MACHINE_VALIDATION.md)
- [Tester Commands](docs/TEST_COMMANDS.md)
- [Private Alpha Readiness Audit](docs/PRIVATE_ALPHA_READINESS_AUDIT.md)
- [Private Alpha Final Release Gate](docs/PRIVATE_ALPHA_RELEASE_GATE.md)

Do not paste tokens, passwords, pairing codes, private URLs, exported config files, or unredacted logs into bug reports. Use Diagnostics export or copied summaries only after confirming redaction.

## Files

```text
AnxOS-Control-Center/
├── README.md
├── app.js
├── anxhub.desktop
├── index.html
├── main.js
├── package.json
├── package-lock.json
├── preload.js
├── src
│   ├── api
│   ├── amp
│   ├── assets
│   ├── backups
│   ├── components
│   ├── docker
│   ├── ipc
│   │   └── systemIpc.js
│   ├── minecraft
│   ├── pages
│   ├── playit
│   ├── services
│   │   └── systemService.js
│   ├── ssh
│   ├── system
│   └── utils
├── start-anxhub.sh
└── styles.css
```

## Current Dashboard Features

The desktop application includes workspaces for:

- Dashboard metrics for the local desktop and selected Agent node
- Nodes and Node Details
- Agent Control and Diagnostics
- Marketplace installs and dependency checks
- Instances, console logs, files, backups, and operations
- Public Access provider status
- Docker resources when Docker is available on the selected node
- Owner and security workflows

Long-running renderer actions preserve resource identity. Reload, download,
update, and failure state are represented as operation overlays on stable
instance/download IDs; polling or a transient read failure does not remove an
existing resource from the UI. See `docs/OPERATION_FRAMEWORK.md` for the
backend and renderer lifecycle contracts.

Instance CPU, memory, and runtime telemetry is also resource-owned. Opening
the Instances page discovers every running instance and loads its metrics
through one bounded, node-scoped scheduler; selecting an instance only changes
the expanded UI and does not activate monitoring.

Game server configuration is edited in place per instance. The shared
configuration workspace covers Minecraft `server.properties`, Palworld
`PalWorldSettings.ini`, and FiveM `server.cfg` (hostname, slots, bind
endpoints, resources, and the Cfx.re license key). Sensitive values are never
returned to the renderer; untouched secrets keep their saved values on save,
saves that change runtime settings offer a restart, and every save writes a
backup of the previous file. Paths are confined to the instance directory.

Missing platform data is shown as unavailable, unknown, or not tested instead of using fake values.

## AMP API Integration For Source Development

AnxOS Control Center can connect to a local AMP API using `@cubecoders/ampapi`. In a source-development checkout, credentials are loaded from `.env` with `dotenv`; `.env` is ignored by git and must not be committed. Packaged normal-user workflows should use the in-app setup surfaces instead of editing environment files.

Create your local environment file:

```bash
cd /home/anx/Projects/AnxOS-Control-Center
cp .env.example .env
```

Edit `.env` with your local AMP details:

```text
AMP_URL=http://192.168.1.134:8080
AMP_USERNAME=your_amp_username
AMP_PASSWORD=your_amp_password
```

The dashboard reports AMP connection status, instances, server state, player count, TPS, CPU usage, and RAM usage when those values are exposed by the AMP API. Missing or unavailable AMP data is shown as unavailable without crashing the app.

## Architecture

- `main.js` creates the Electron desktop window and blocks in-app navigation to external URLs.
- `preload.js` exposes a small `window.anxhub` API to the browser context.
- `src/ipc/systemIpc.js` registers the system metrics IPC route.
- `src/ipc/ampIpc.js` registers the AMP IPC route.
- `src/services/systemService.js` reads local OS metrics with Node APIs and platform commands.
- `src/services/ampService.js` authenticates with AMP and normalizes available instance metrics.
- Empty domain folders under `src/` reserve clean module boundaries for Minecraft, AMP, playit.gg, SSH, Docker, backups, pages, and shared UI as those integrations are implemented.

The renderer still uses plain HTML/CSS/JavaScript. Node integration remains disabled in the browser window.

## Run From Source For Development

This section is for developers running the repository checkout. Normal users should install a packaged build and use the in-app setup workflows.

Install dependencies once:

```bash
cd /home/anx/Projects/AnxOS-Control-Center
npm install
```

Start AnxOS Control Center:

```bash
npm start
```

This opens AnxOS Control Center as a local desktop window. The app loads `index.html` from disk and does not start a public web server.

## Pair An Agent

Normal users should pair Agents from the app, without npm commands, shell commands, environment-variable editing, or manual token synchronization.

Recommended workflow:

1. Install and open AnxOS Agent on the machine you want to manage.
2. Open Agent Setup and select Generate Pairing Code.
3. Open AnxOS Control Center.
4. Select Add Node.
5. Select Pair with Code.
6. Paste the temporary pairing code.
7. Select Pair Agent.

Pairing codes expire, can be used only once, and are not the permanent Agent credential. After pairing succeeds, Control Center and the Agent automatically establish a permanent credential. The permanent credential is stored securely, is not written to normal node metadata, and is not displayed again.

Manual URL/token setup remains available under Advanced Setup for development, recovery, and older Agents. The in-app token generator can create a strong token, copy only the unsaved visible value, and store the saved credential through protected storage.

Developer and headless recovery helpers such as token status, token rotation, and source-checkout pairing scripts remain available from `package.json`, but they are not the normal setup path.

### One-Click Development Launcher

For local source development, use the AnxDev launcher instead of typing npm commands.

Linux:

```bash
./AnxDev.sh
```

You can also double-click `AnxDev.sh` from a file manager if your desktop environment allows launching executable scripts.

Windows:

```text
Double-click AnxDev.cmd
```

The launcher menu can:

- Launch AnxOS Development with `npm run start`
- Launch AnxOS Development with DevTools
- Run `npm run owner:smoke`
- Run `npm run marketplace:smoke`

AnxDev sets only trusted source-development flags supported by the app:

- `NODE_ENV=development`
- `ANXOS_TRUSTED_DEVELOPMENT_MODE=1`
- `ANXOS_OPEN_DEVTOOLS=1` only for the DevTools option

The development owner fallback password is available only in an unpackaged Electron run with trusted development mode enabled. Packaged releases continue to reject the development fallback and weak production setup passwords. The app shows a subtle `Development Mode` badge only when the main process confirms trusted unpackaged development mode.

Troubleshooting:

- If Node.js is missing, install the current LTS from https://nodejs.org/ and reopen the launcher.
- If npm is missing, repair/reinstall Node.js because npm ships with the standard Node installer.
- If dependency installation fails, delete an incomplete `node_modules` folder and run the launcher again, or run `npm install` manually to see the full npm error.
- If Windows blocks PowerShell scripts, use `AnxDev.cmd`; it runs PowerShell with `-ExecutionPolicy Bypass` for this local script only.

## Build Desktop Packages

The standard build command remains:

```bash
npm run dist
```

On Windows, this keeps the existing Windows installer workflow and produces the NSIS `.exe` installer.

On Debian/Linux, the build produces Linux release artifacts:

- `AnxOS-Control-Center-<version>-build<build>.deb`
- `AnxOS-Control-Center-<version>-build<build>.AppImage`

The `.deb` package is the recommended Linux installer for Debian-based AnxOS systems. The AppImage remains available as a fallback for systems where installing a package is not desired.

Windows release builds support Authenticode code signing when Anx signing secrets are configured. See [Windows Code Signing](docs/windows-code-signing.md). Unsigned local Windows builds are dev-only and may show `Unknown Publisher`.

### AppImage

```bash
chmod +x AnxOS-Control-Center.AppImage
./AnxOS-Control-Center.AppImage
```

No installation is required. You can keep the AppImage anywhere in your home directory or applications folder.

### Debian Package

```bash
sudo dpkg -i AnxOS-Control-Center-*.deb
```

If dependencies are missing:

```bash
sudo apt install -f
```

The Debian package installs a desktop entry so `AnxOS Control Center` appears in the application launcher. The package uses the generated Linux PNG icon set under `assets/icons/png`.

## Release Artifacts

Public release metadata lives in `release.json`:

```json
{
  "version": "1.7",
  "build": 142,
  "channel": "Private Alpha"
}
```

`package.json` keeps a SemVer-compatible internal package version for npm and Electron tooling only. User-facing app, updater, diagnostics, installer, and website metadata use `release.json`.

Useful versioning commands:

```bash
npm run build:increment
npm run version:set 1.8
npm run channel:set beta
```

For a local updater-ready release, run:

```bash
npm run release:update -- --message "fix: describe the change"
```

That command increments the release build, runs the Marketplace smoke checks, builds the Windows installer plus Linux packages, refreshes `dist/update-manifest.json` and website metadata, commits, tags, and pushes. Add `--version 1.8` for a meaningful product version milestone, `--channel beta` for channel changes, and `--github-release` when GitHub CLI is authenticated and you want the built artifacts uploaded to the latest GitHub Release source used by Check for update.

Recommended GitHub Releases layout:

```text
Windows
- AnxOS-Control-Center-Setup-<version>-build<build>.exe
- AnxOS-Control-Center-<version>-build<build>-portable.exe

Linux
- AnxOS-Control-Center-<version>-build<build>.deb
- AnxOS-Control-Center-<version>-build<build>.AppImage

Future
- macOS DMG
```

Validation checklist before publishing a release:

- Windows installer still builds with `npm run dist:win`.
- Signed Windows releases verify with `signtool verify /pa dist\AnxOS-Control-Center-Setup-<version>-build<build>.exe` when Anx signing secrets are configured.
- Linux AppImage and `.deb` build on Debian with `npm run dist:linux`.
- AppImage launches with `./AnxOS-Control-Center.AppImage`.
- `.deb` installs with `sudo dpkg -i AnxOS-Control-Center-*.deb`.
- Desktop launcher appears and opens the app.
- App icons display correctly in the launcher and package metadata.
- Auto-updater behavior remains unchanged if an updater is added or enabled later.

## Discord Bot Docker Deployment

The repository includes a production Docker setup for a Node.js Discord bot. Secrets are loaded from `.env`; never commit real Discord tokens.

The Docker setup assumes it is placed beside the Discord bot's own `package.json` and that `npm start` is the bot start command. If the bot code lives in a subdirectory, update `docker-compose.yml` `build.context` to that directory or move the Docker files beside the bot package.

Create the environment file:

```bash
cp .env.example .env
```

Edit `.env` and set:

```text
DISCORD_TOKEN=your_real_discord_bot_token
CLIENT_ID=your_discord_application_client_id
GUILD_ID=your_development_guild_id_if_needed
```

Deploy on Debian:

```bash
docker compose up -d --build
```

Follow logs:

```bash
docker compose logs -f
```

Restart:

```bash
docker compose restart
```

Stop and remove the container:

```bash
docker compose down
```

The container uses Node.js LTS, installs dependencies with `npm ci` when `package-lock.json` exists, and starts with `npm start` from `package.json`. Docker named volumes persist `/app/data`, `/app/logs`, and `/app/config` for bots that store JSON, SQLite, logs, or local config.

## Debian Agent: Playit Metadata Permissions

The Debian agent can report Playit installed/running state from normal service checks. Tunnel metadata such as the Playit domain, local target, protocol, and tunnel id requires access to the Playit daemon IPC socket, normally:

```text
/run/playit/playitd.sock
```

### Advanced Playit Service Recovery

The app provides in-app dependency and service repair actions for normal users. The following commands are retained only for advanced headless recovery when the graphical repair flow is unavailable.

Check the current Playit permissions on the Debian host:

```bash
stat -c '%F %a %U %G %n' /run/playit /run/playit/playitd.sock /usr/lib/systemd/system/playit.service
getent passwd playit
getent group playit
id <agent-user>
```

A healthy least-privilege setup gives the AnxOS Agent process read/write access to the socket and search access to `/run/playit`, without running the whole agent as root. Prefer one of these approaches:

```bash
# If the socket group is playit, add the agent service user to that group.
sudo usermod -aG playit <agent-user>
sudo systemctl restart anxos-agent
```

If Playit creates the socket with a group that is not shared with the agent, use a dedicated group and a systemd override for Playit:

```bash
sudo groupadd --system anxos-playit
sudo usermod -aG anxos-playit playit
sudo usermod -aG anxos-playit <agent-user>
sudo systemctl edit playit
```

Use this override:

```ini
[Service]
Group=anxos-playit
RuntimeDirectoryMode=0750
UMask=0007
```

Then restart Playit and the agent:

```bash
sudo systemctl daemon-reload
sudo systemctl restart playit
sudo systemctl restart anxos-agent
stat -c '%F %a %U %G %n' /run/playit /run/playit/playitd.sock
```

Do not use `chmod 777` on the Playit socket and do not run the entire AnxOS Agent as root. If socket access is still denied, `/api/v1/playit/snapshot` will keep `installed` and `running` detection but will leave tunnel metadata null and include a `diagnostics.playitIpcAccess` permission message.

## Add to the Debian App Launcher For Source Development

After `npm install` in a source checkout, developers can copy or symlink the desktop entry into a local applications folder:

```bash
mkdir -p ~/.local/share/applications
cp /home/anx/Projects/AnxOS-Control-Center/anxhub.desktop ~/.local/share/applications/
chmod +x /home/anx/Projects/AnxOS-Control-Center/start-anxhub.sh
```

Then look for `AnxOS Control Center` in your desktop app launcher. You can also double-click `anxhub.desktop` from a file manager if your desktop environment allows trusted launchers.

## Run as a Static Web Page

From the project directory:

```bash
cd /home/anx/Projects/AnxOS-Control-Center
python3 -m http.server 8088
```

Open:

```text
http://127.0.0.1:8088
```

From another device on the same LAN, replace `127.0.0.1` with the Debian server IP address:

```text
http://192.168.1.134:8088
```

## Static Hosting on Debian

Because AnxOS Control Center is static, it can be served by any local web server, including Apache, nginx, Caddy, or Python's built-in server.

For a simple local-only setup, keep it bound to your LAN or localhost. Do not expose it publicly until you add proper hardening such as HTTPS, authentication, firewall rules, and reverse proxy access controls.

## Quick Links Included

- AMP panel: `http://192.168.1.134:8080`
- Minecraft address: `coolpals.playit.fan`

## Private Alpha Notes

- Keep the release channel as Private Alpha until the real-machine release gates pass.
- The Debian Agent and Windows desktop must stay on compatible commits during testing.
- Docker, Public Access, AMP, and some Marketplace templates depend on host-specific services and may be unavailable on a tester machine.
- If a workspace is empty, use the page guidance first: connect an Agent, check dependencies, create an instance, or run diagnostics.
- See [Known Limitations](docs/KNOWN_LIMITATIONS.md) before filing issues for intentionally unsupported capabilities.
