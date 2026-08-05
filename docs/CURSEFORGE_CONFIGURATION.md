# CurseForge Configuration

CurseForge access must be configured in trusted code. Do not put the private CurseForge API key in renderer JavaScript, frontend bundles, public config, screenshots, logs, diagnostics, or tester instructions.

## Resolution Precedence

1. Hosted/proxy configuration (explicit owner override):
   - `ANXOS_CURSEFORGE_PROXY_URL`
   - `ANXHUB_CURSEFORGE_PROXY_URL`
   - `CURSEFORGE_PROXY_URL`
2. Agent-held configuration:
   - Agent environment: `CURSEFORGE_API_KEY`, `CF_API_KEY`, or `ANXHUB_CURSEFORGE_API_KEY`
   - Agent key file: `CURSEFORGE_API_KEY_FILE`, `CF_API_KEY_FILE`, or `ANXHUB_CURSEFORGE_API_KEY_FILE`
3. Owner-only local development/private-alpha configuration:
   - Desktop user-data marketplace config
   - Local development `.env`
   - Local development key file
4. AnxOS-hosted Marketplace proxy (bundled default): when none of the above are configured,
   the desktop app automatically uses the AnxOS-controlled CurseForge Marketplace proxy bundled
   with every build (`website/marketplace-config.js`). This is what lets ordinary end users
   browse, search, and install CurseForge modpacks without ever configuring anything. See
   [CURSEFORGE_MARKETPLACE_PROXY_DEPLOYMENT.md](./CURSEFORGE_MARKETPLACE_PROXY_DEPLOYMENT.md) for
   how the owner deploys and configures this backend.
5. Unavailable (only if the bundled proxy is explicitly disabled and no other tier applies).

Ordinary testers must not be asked to create or paste their own CurseForge developer API key.
A locally saved legacy key is also automatically removed the first time a hosted/Agent proxy is
available (see "Legacy Local Key Migration" below).

## Legacy Local Key Migration

On startup, if a hosted proxy (explicit or bundled default) or Agent proxy is available, any
previously saved local `curseForgeApiKey` in `config/marketplace.json` is deleted automatically,
since it is no longer used for normal requests. This runs once per startup in
`migrateAwayFromLegacyLocalApiKey()` (`src/services/providers/curseforgeProvider.js`) and can be
disabled for local development with `ANXHUB_DISABLE_CURSEFORGE_KEY_MIGRATION=1`.


## Packaged Private Alpha

For packaged builds, prefer one of these options:

- Configure a hosted AnxOS CurseForge proxy and set `ANXOS_CURSEFORGE_PROXY_URL` before launching the packaged app.
- Configure the AnxOS Agent with the CurseForge key in its protected runtime environment, then set the desktop backend mode to Agent.

The Agent exposes authenticated desktop-only routes under:

- `GET /api/v1/marketplace/curseforge/status`
- `GET /api/v1/marketplace/curseforge/api`
- `GET /api/v1/marketplace/curseforge/download`

Those routes return CurseForge data or file bytes, never the raw API key.

## Local Development

For local development only, the desktop still supports ignored local secret sources so the owner can test without a hosted proxy:

- `.env`
- `agent/.env`
- `config/marketplace.json`
- key-file environment variables

This compatibility path is temporary private-alpha support. It must remain owner-only, masked in UI/diagnostics, and excluded from release artifacts.

## Debian Agent Setup

For a one-off manual Agent run:

```bash
cd ~/Projects/AnxOS-Control-Center/agent
export CURSEFORGE_API_KEY='REPLACE_WITH_REAL_KEY'
npm start
```

For persistent Debian Agent configuration, place the key in a protected user environment file outside the repository:

```bash
mkdir -p ~/.config/anxos-control-center
chmod 700 ~/.config/anxos-control-center
touch ~/.config/anxos-control-center/agent.env
chmod 600 ~/.config/anxos-control-center/agent.env
```

File contents:

```bash
CURSEFORGE_API_KEY=REPLACE_WITH_REAL_KEY
```

The Agent loads this file by default from:

```text
~/.config/anxos-control-center/agent.env
```

When launching through the repository helper, run:

```bash
cd ~/Projects/AnxOS-Control-Center
./AnxAgent.sh
```

The helper exports `ANXOS_AGENT_ENV_PATH` to the protected file if it is not already set. If you use a custom service manager or user systemd unit, add:

```ini
Environment=ANXOS_AGENT_ENV_PATH=%h/.config/anxos-control-center/agent.env
WorkingDirectory=%h/Projects/AnxOS-Control-Center
ExecStart=%h/Projects/AnxOS-Control-Center/AnxAgent.sh
```

Then restart the Agent service after editing `agent.env`.

Never place the CurseForge key in:

- repository `.env`
- Electron build configuration
- GitHub release assets
- frontend source
- `config/nodes.json`
- `config/application-host.json`
- `config/marketplace.json`
- screenshots, logs, diagnostics, or exported settings

## Secret Handling

Diagnostics may report only:

- whether configuration exists
- source category
- non-reversible fingerprint
- proxy/Agent reachability
- request class that failed

Diagnostics must never include the API key, signed URLs, authorization headers, or full secret-bearing response data.
