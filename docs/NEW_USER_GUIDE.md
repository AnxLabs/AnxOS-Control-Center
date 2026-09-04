# AnxOS Control Center New User Guide

This guide is for trusted Private Alpha testers opening AnxOS Control Center for the first time.

## Install and Open

Use the installer or development launcher supplied by the project owner. In a source checkout, run:

```bash
npm install
npm start
```

Do not share tokens, pairing codes, `.env` files, exported config, or unredacted logs.

## First Launch

On a clean profile, AnxOS shows **Welcome to AnxOS Control Center**.

- **Set Up AnxOS** opens the guided setup.
- **Explore on My Own** skips the wizard but keeps lightweight tips enabled.
- Settings can restart the setup guide later from **Help and Learning**.

Guided Mode is enabled for new users. It adds explanations and stronger confirmations for destructive actions without removing advanced features.

## What AnxOS Does

AnxOS helps manage:

- this computer through the desktop application host
- local or remote AnxOS Agents
- server instances
- files
- Docker containers
- backups
- Public Access providers
- diagnostics and health checks

An **Agent** is the service that lets AnxOS manage a Windows or Linux system. A **System / Node** is a managed computer. An **Instance** is an installed server managed by AnxOS.

## Local and Remote Systems

The desktop app always represents this computer as the local application host. Remote systems require an AnxOS Agent and a valid pairing token.

To add a remote system:

1. Open **Agent Control** on the Agent machine or run `npm run agent:pair`.
2. Copy the generated pairing code.
3. In the desktop app, open **Agent Control -> Agent Connection**.
4. Paste the pairing code.
5. Click **Pair Agent**, then **Test Connection**.

## Guided Setup

The setup guide walks through:

1. what AnxOS manages
2. what you want to use
3. this computer
4. local Agent state
5. dependencies and tools
6. optional remote systems
7. setup summary

Statuses come from real runtime, Agent, dependency, node, and service data. Optional features should not appear as critical failures.

## Dependencies

AnxOS checks tools such as Git, Node.js, npm, PowerShell, Bash, Java, .NET, SteamCMD, Docker, Docker Compose, Tailscale, Cloudflare Tunnel, and Playit.

Missing supported dependencies can be installed through AnxOS when the selected node supports in-app dependency jobs. Technical output is available in details; the primary status stays beginner-friendly.

## Create Your First Server

Open **Dashboard -> Create a Server** or **Marketplace -> Create Your First Server**.

The guided entry point offers:

- Minecraft Server
- Game Server
- Start from Marketplace

It uses the existing Marketplace installer, dependency preflight, selected node, and Download Manager. Installed servers appear under **Instances**.

## Start and Manage a Server

After installation:

1. Open **Instances**.
2. Select the server.
3. Use **Start**, **Stop**, **Restart**, **Console**, **Files**, and **Backups** as available.

Some templates require setup before start. For example, FiveM can install successfully but show **Setup Required** until a license key is configured.

## Files

Open **Files** to browse supported local, Agent, and storage profiles. Each profile keeps its own remembered path. Remote Linux profiles should start from the Agent-reported home or authorized root, not a Windows path.

## Docker

Open **Docker** to manage containers, images, networks, volumes, Compose projects, and cleanup actions when Docker is available on the selected node. If Docker is unavailable, AnxOS shows the reason and recovery actions where supported.

## Public Access

Open **Public Access** to review or create access services.

- Playit can expose supported services to the public internet when provider capabilities support it.
- Tailscale provides private tailnet access.
- Cloudflare Tunnel is for compatible HTTP and HTTPS services.
- AnxOS Relay is reserved for a future build.

Never expose a service publicly unless you understand the provider and port being shared.

## Backups

Open **Backups** before making major server changes. Backups can protect instance files and provide restore points where the selected node supports the backup service.

## Diagnostics

Open **Agent Control** for beginner summaries, local/remote Agent state, diagnostics, logs, and support bundle previews. Use **Copy Summary** or **Export Bundle** instead of pasting raw logs.

## After Restarting AnxOS

After you close and reopen AnxOS (or after an upgrade restart), saved node credentials start locked again. The app remembers who you are signed in as online, but privileged local credentials are only released after you unlock the local owner account on this device.

Until you unlock:

- Docker, Files, Public Access, and other agent-based pages may show errors such as "Unlock AnxOS to access saved node credentials."
- The Notifications page may show repeated credential errors for these features while they retry in the background. This stops once you unlock.

To unlock, open the **Security** page and sign in with the local owner account you created on this device (the same form shown as "Unlock AnxOS"). If you chose **Stay signed in** previously, AnxOS may unlock automatically; otherwise the unlock is required after every restart. Docker and the other agent features start working again immediately after unlock.

## Troubleshooting

- Agent unreachable: open **Agent Control**, refresh, and verify the Agent is running.
- Authentication mismatch: pair the Agent again or rotate the token from Owner/Security workflows.
- Missing dependency: use **Prepare Node** or Marketplace dependency actions.
- Docker unavailable: check Docker installation and daemon state on the selected node.
- File permission error: verify the selected profile, Agent filesystem root, and requested path.
- Marketplace setup required: open the instance details or setup action instead of reinstalling.

## Modes

- **Guided Mode**: extra explanations, recommendations, and confirmations.
- **Advanced Mode**: technical details and advanced controls are more prominent.

Both modes use the same backend systems and do not create separate application behavior.
