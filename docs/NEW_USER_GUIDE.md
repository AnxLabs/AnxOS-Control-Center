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

1. On the machine running the Agent, allow this computer to reach it when the
   two machines are different computers:
   - Windows (the Agent is included with Control Center): open **Agent Control →
     Connect this computer** and turn on **Another computer will connect to this
     one**.
   - Headless Debian 11+/Ubuntu 22.04+ x64 server: run `sudo anxos-agent`, open
     **Pair**, and press **n** to allow network access for your network, or pin
     `AGENT_HOST` in `/etc/anxos-agent/agent.env` and restart the service. The
     install steps are in `docs/HEADLESS_AGENT_INSTALL.md`.
2. Generate the pairing code on that machine:
   - Windows: choose **Generate Pairing Code** in Agent Control and copy the
     full code.
   - Headless: choose **Pair** in the TUI, or run `anxos-agent pair`, and copy
     the full code. If the Agent is still loopback-only, `pair` prints a notice
     with this remedy before showing the code.
3. Copy the full pairing code (the long value, not only the short
   `ANX-XXXX-XXXX-XXXX` reference). It is one-time and valid for 10 minutes.
4. In the desktop app, open **Add Computer**.
5. Choose the matching path (**This computer** or **Connect a headless server**)
   and paste the code.
6. Confirm the Agent identity the app shows, then wait for the node to come
   online.

The packaged or standalone Agent on another machine listens on `127.0.0.1` only
until you opt in, and a code generated without that opt-in advertises
`127.0.0.1`, which a different computer cannot use. Prefer a concrete LAN or
tailnet address over `0.0.0.0`; a wildcard bind exposes the Agent on every
interface and loses the strict Host check. Pair promptly after enabling network
access: while the Agent is reachable and not yet paired, anyone who can reach it
could claim it.

Developer and source checkouts only: running the Agent from a repository
checkout is a development path, not normal use. There, `npm run agent:pair`
prints a temporary pairing code and `AGENT_HOST` in the environment sets the
bind. Normal use installs the official Agent package on Linux, or lets the
Control Center installer set up and manage the Agent on Windows.

Nodes can also be organized with an optional **group** label and filtered by it
in the node toolbar. Groups are labels only; they do not grant or restrict
access.

To stop AnxOS from monitoring a node without deleting it, use **Disconnect**. A
disconnected node stays offline until you **Reconnect** or re-pair it.

Removing an Agent node also attempts to revoke its enrollment on the Agent. The
Agent only allows an owner-tier credential to do this, so a restricted node may
refuse the revocation and the app will say so. This is expected: the node is
removed from this device either way, but a refused revocation is never shown as
a success.

Re-pairing is the recovery path for a revoked node. On a headless server,
`sudo anxos-agent unpair` revokes the enrollment and clears the stored
credential; pairing that node again with a fresh code restores its enrollment
instead of leaving it permanently rejected with `410 REVOKED`.


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

You can add a **scheduled restart** for an instance (a daily time or a repeating interval, with a warning minutes setting). Warnings are sent to a running server; a stopped instance is skipped, never started, and the restart uses the normal restart path rather than a forced kill.

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

A backup is crash-consistent by default: it is taken while the server keeps running. Where the option is available, you can request a **stopped-consistent** backup, which pauses the server through the normal stop path, archives it, and starts it again. An already-stopped server is never started just to take a backup, and a restart failure after a stopped backup is reported rather than hidden.

Backup cleanup never removes the newest recovery point of an instance, even if the age or count policy says it should. Older copies are trimmed per the retention policy (default: keep the last 10 or 30 days, whichever is more generous).

Where a node supports it, backups can also be pushed to a remote destination (SFTP). Remote copies are encrypted before they leave the host; keep the encryption key safe, because a lost key means those remote copies cannot be recovered.

## Further Reading

For the operator-facing details behind these features, including Docker policy
grants, runtime pins, network inventory, Linux Agent self-update, and workload
transfer between nodes, see `OPERATOR_NOTES_V2.md`. For endpoint and permission
details, see `API_SURFACE_V2.md`.

## Diagnostics

Open **Agent Control** for beginner summaries, local/remote Agent state, diagnostics, logs, and support bundle previews. Use **Copy Summary** or **Export Bundle** instead of pasting raw logs.

## Updating AnxOS

Control Center updates from inside the app; you do not need the repository or a
terminal.

1. Open **Settings -> Updates**, or use the **Update** badge that appears in the
   sidebar when a newer build is available.
2. Select **Check for Updates**. Updates are also checked automatically on
   startup.
3. When an update is available, review the version and release notes in the
   update window, then select **Download & Install**. The app verifies the
   download and restarts into the new build. **Later** postpones the update;
   **Skip This Version** hides that release until a newer one appears.
4. After the download finishes, a banner offers **Restart Now** to install it or
   **Later** to keep working on the current build.

The Local Agent updates separately, and only when its version does not match the
Desktop:

1. Open **Agent Control**.
2. If a compatibility banner appears, select **Update Agent** and confirm.
3. AnxOS backs up the Agent configuration, stops the Agent, repairs the bundled
   runtime, restarts it, and verifies health. Instances running on that node stop
   during the restart.

For a remote node, the same action uploads this Desktop's bundled Agent runtime
to the node and restarts it. If the node's Agent is newer than this Desktop,
install a newer Control Center first instead of downgrading the Agent.

On a headless server, `anxos-agent update --check` is read-only and reports
whether a newer package is published, or that this install has no package
identity (development or source install). It never suggests a downgrade;
install an offered update with the printed `apt` command.

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

## Uninstalling AnxOS

Removing the desktop application and deleting your server data are separate
actions. Uninstalling the app removes the application itself; it does not delete
managed server folders, instance files, or backups.

Windows:

1. Open **Settings -> Apps -> Installed apps**.
2. Find **AnxOS Control Center** and select **Uninstall**.

Linux `.deb` install:

```bash
sudo apt remove anxos-control-center
```

AppImage: delete the AppImage file.

To also remove the Local Agent's automatic startup on a Windows machine, open
**Agent Control** and use **Uninstall** (this removes the background service
registration; it does not delete server data).

On Linux, an Agent installed from the official package is removed separately:

```bash
sudo apt remove anxos-agent
```

That keeps servers, settings, and backups in `/var/lib/anxos-agent` (see
`docs/HEADLESS_AGENT_INSTALL.md`). If you installed the Agent from a source
checkout, remove its user unit through your normal service management instead.

After uninstalling, do not delete server folders or backups unless you are sure
the data is no longer needed.

## Modes

- **Guided Mode**: extra explanations, recommendations, and confirmations.
- **Advanced Mode**: technical details and advanced controls are more prominent.

Both modes use the same backend systems and do not create separate application behavior.
