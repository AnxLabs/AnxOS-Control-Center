# AnxOS Control Center

AnxOS Control Center is a private, local-first desktop control center for homelab
servers, built as an Electron desktop app for Windows and Linux. It manages remote
AnxOS Agent nodes over a narrow, token-authenticated REST API: nodes, instances,
marketplace installs, files, backups, SSH, Docker resources, diagnostics, and
updates — from a single desktop window.

Official website: https://anxoscontrolcenter.org

This project intentionally does not include secrets, tokens, API keys, credentials, or backend service controls.

## Current Status

Current public app metadata comes from `release.json`:

```json
{
  "version": "2.0",
  "build": 203,
  "channel": "Private Alpha"
}
```

AnxOS Control Center is intended for a small group of trusted testers on known
Windows and Debian machines. It is not a public beta.

Start here:

- [New User Guide](docs/NEW_USER_GUIDE.md)
- [Private Alpha Tester Guide](docs/PRIVATE_ALPHA_TESTER_GUIDE.md)
- [Known Limitations](docs/KNOWN_LIMITATIONS.md)
- [Test Commands](docs/TEST_COMMANDS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Documentation Index](docs/DOCUMENTATION_INDEX.md)

Do not paste tokens, passwords, pairing codes, private URLs, exported config files, or unredacted logs into bug reports. Use Diagnostics export or copied summaries only after confirming redaction.

## Current Capabilities

The desktop application includes workspaces for:

- Dashboard metrics for the local desktop and selected Agent node
- Nodes and Node Details
- Agent Control and Diagnostics
- Marketplace installs and dependency checks, including CurseForge integration
- Instances, console logs, files, backups, and long-running operations
- Game server configuration editing (Minecraft, Palworld, FiveM)
- Public Access provider status
- Docker resources when Docker is available on the selected node
- SSH terminal access to managed nodes
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

## Repository Layout

```text
AnxOS-Control-Center/
├── main.js               Electron main process
├── preload.js            Context-isolated renderer bridge (window.anx, window.anxhub)
├── app.js                Renderer application logic
├── index.html            Renderer UI markup
├── styles.css            Renderer styles
├── release.json          Source of truth for public version/build/channel
├── src/
│   ├── assets/           App runtime assets (logo, startup sound)
│   ├── ipc/              Electron IPC route registration
│   ├── services/         Application services (instances, marketplace, SSH, ...)
│   └── shared/           Logic shared between main process, renderer, and Agent
├── agent/                AnxOS Agent (standalone Node service for managed nodes)
├── backend/              Account device-authorization handlers (shared reference)
├── config/               Shipped example/runtime config templates
├── windows/              Windows installer assets and scheduled-task scripts
├── assets/               App icons and branding
├── scripts/              Smoke tests, QA harnesses, release/build tooling
├── docs/                 Product, architecture, QA, and release documentation
│   └── releases/         Historical per-build release notes
├── website/              Public website deployed to Cloudflare Pages
├── supabase/             Supabase Edge Functions and migrations (account system)
├── functions/            Cloudflare Pages download functions
├── tools/                Windows hardware telemetry helper (C#)
└── .github/              CI workflows (Desktop Release, Cloudflare Pages deploy)
```

The renderer uses plain HTML/CSS/JavaScript. Node integration remains disabled in the browser window, and navigation to external URLs is blocked in the main process.

## Run From Source For Development

This section is for developers running the repository checkout. Normal users should install a packaged build and use the in-app setup workflows.

Install dependencies once:

```bash
npm install
```

Start AnxOS Control Center:

```bash
npm start
```

This opens AnxOS Control Center as a local desktop window. The app loads `index.html` from disk and does not start a public web server.

For a guided launcher, use `AnxDev.cmd` (Windows) or `./AnxDev.sh` (Linux). The
launcher installs dependencies when needed, sets the trusted-development
environment flags, and offers DevTools and smoke-test menu entries. See
`AnxDev.ps1` for the exact environment it sets.

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

## AMP API Integration For Source Development

AnxOS Control Center can connect to a local AMP API using `@cubecoders/ampapi`. In a source-development checkout, credentials are loaded from `.env` with `dotenv`; `.env` is ignored by git and must not be committed. Packaged normal-user workflows should use the in-app setup surfaces instead of editing environment files.

Create your local environment file:

```bash
cp .env.example .env
```

Edit `.env` with your local AMP details:

```text
AMP_URL=http://your-amp-host:8080
AMP_USERNAME=your_amp_username
AMP_PASSWORD=your_amp_password
```

The dashboard reports AMP connection status, instances, server state, player count, TPS, CPU usage, and RAM usage when those values are exposed by the AMP API. Missing or unavailable AMP data is shown as unavailable without crashing the app.

## Testing

Validation is tiered; each tier is a set of smoke-test scripts (no test framework):

```bash
npm run qa:fast       # fast tier: syntax checks, versioning, redaction, core contracts
npm run qa:feature    # feature tier: adds domain smoke suites
npm run qa:release    # release tier: full RC validation command set
npm run rc:validate   # runs every registered *:smoke suite as subprocesses
npm run qa:dirty-check  # verifies the working tree is clean
```

See [QA Automation](docs/QA_AUTOMATION.md) and [Test Commands](docs/TEST_COMMANDS.md) for the full picture.

## Build Desktop Packages

The standard build command is:

```bash
npm run dist
```

On Windows, this produces the NSIS `.exe` installer and portable build.

On Debian/Linux, use:

```bash
npm run dist:linux
```

to produce Linux release artifacts:

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
  "version": "2.0",
  "build": 203,
  "channel": "Private Alpha"
}
```

`package.json` keeps a SemVer-compatible internal package version for npm and Electron tooling only. User-facing app, updater, diagnostics, installer, and website metadata use `release.json`.

Per-build release notes live at the repository root as `RELEASE_NOTES_<version>-build<build>.md` for the current candidate, with historical notes archived under `docs/releases/`. The Desktop Release workflow attaches the matching notes file to the GitHub release.

Useful versioning commands:

```bash
npm run build:increment
npm run version:set 1.9
npm run channel:set beta
```

For a local updater-ready release, run:

```bash
npm run release:update -- --message "fix: describe the change"
```

That command increments the release build, runs the Marketplace smoke checks, builds the Windows installer plus Linux packages, refreshes `dist/update-manifest.json` and website metadata, commits, tags, and pushes. Add `--version 1.9` for a meaningful product version milestone, `--channel beta` for channel changes, and `--github-release` when GitHub CLI is authenticated and you want the built artifacts uploaded to the latest GitHub Release source used by Check for update.

Recommended GitHub Releases layout:

```text
Windows
- AnxOS-Control-Center-Setup-<version>-build<build>.exe
- AnxOS-Control-Center-<version>-build<build>-portable.exe

Linux
- AnxOS-Control-Center-<version>-build<build>.deb
- AnxOS-Control-Center-<version>-build<build>.AppImage
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

## Troubleshooting

- If Node.js is missing, install the current LTS from https://nodejs.org/ and reopen the launcher.
- If npm is missing, repair/reinstall Node.js because npm ships with the standard Node installer.
- If dependency installation fails, delete an incomplete `node_modules` folder and run the launcher again, or run `npm install` manually to see the full npm error.
- If Windows blocks PowerShell scripts, use `AnxDev.cmd`; it runs PowerShell with `-ExecutionPolicy Bypass` for this local script only.
- See [Local Agent Troubleshooting](docs/LOCAL_AGENT_TROUBLESHOOTING.md) for agent-side issues.
- See [Known Limitations](docs/KNOWN_LIMITATIONS.md) before filing issues for intentionally unsupported capabilities.

## Private Alpha Notes

- Keep the release channel as Private Alpha until the real-machine release gates pass.
- The Debian Agent and Windows desktop must stay on compatible commits during testing.
- Docker, Public Access, AMP, and some Marketplace templates depend on host-specific services and may be unavailable on a tester machine.
- If a workspace is empty, use the page guidance first: connect an Agent, check dependencies, create an instance, or run diagnostics.
- See [Known Limitations](docs/KNOWN_LIMITATIONS.md) before filing issues for intentionally unsupported capabilities.
