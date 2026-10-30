# AnxOS Control Center v2.0 — Build 207

Build 207 makes AnxOS behave like a proper server app across several machines:
- nodes stay reachable through SSH tunnels and Tailscale fallbacks;
- every node's Agent can be started, stopped and restarted from Control Center, and only on the machine AnxOS has verified;
- passphrase-protected SSH keys work for background tasks through the system SSH agent;
- connection blips no longer flash nodes offline;
- Playit is set up by linking an account instead of pasting an address;
- the desktop app is reorganized, animated and lighter on the GPU.

## Added

- **Agent Start, Stop and Restart for remote Linux nodes.** Agent Control now controls remote Agents, not only this PC's.
  - **With the node's SSH key profile:** Start, Stop and Restart all work. A desktop-installed user service uses `systemctl --user`; the packaged system service uses `sudo -n systemctl`.
  - **Without a profile:** Restart still works through the Agent itself, when systemd supervises it.
  - Every action is confirmed afterwards.
  - The Agent `.deb` now ships a narrow sudo rule: members of the `anxos-control` group may start, stop and restart `anxos-agent` and nothing else.
- **Verify Access before Agent control.** SSH Start, Stop, Restart and Agent Update stay disabled until a read-only access check passes for the node and its SSH profile. The check signs in, confirms the machine reached is that node, finds the Agent service and checks passwordless control.
- **Protection against controlling the wrong machine.** Every SSH Agent action and Agent Update first confirms that the machine reached is the node: its Agent's device ID, or its hostname when the Agent is stopped. If it isn't, nothing runs.
- **SSH keys with passphrases for background tasks.** A key profile can use the system SSH agent (on Windows, the OpenSSH Authentication Agent; load the key once with `ssh-add`).
  - Control Center then signs in without asking for the passphrase, and never stores it.
  - It offers only that profile's key, never another key loaded in the agent.
  - Key files stay encrypted.
- **App-managed SSH tunnels for nodes.** A node whose Agent listens only on the node itself (for example `127.0.0.1` on a VPS) can be reached through an SSH tunnel that Control Center opens, watches and reconnects with backoff. Tunnels use key authentication and a host key you have already approved; they never prompt or accept an unknown key.
- **Route fallback with Tailscale suggestions.** A node can have up to four extra addresses. Control Center uses the first one whose Agent proves the paired device identity, so a different machine answering on an address is never trusted. "Find Tailscale route" suggests the node's tailnet address from `tailscale status` (read only).
- **Routes panel and live status.** The Nodes page shows the route in use, its latency and any tunnel problem on each card, and a Routes panel manages addresses and the tunnel.
- **Connection blip tolerance and safe credential repair.** A single failed check right after a success shows "Reconnecting" instead of Offline. A rejected credential is repaired automatically only when the node proves it; otherwise the node asks to be re-paired.
- **Playit account linking.** Public Access guides Install → Start → Link Account → View Tunnels → Manage, using Playit's browser-based linking. Control Center never stores Playit passwords and never shows the link secret. The manual address remains under Settings → Advanced.
- **Network workspace.** Endpoint registry, connectivity diagnostics, provider integrations, telemetry sampling and operational notifications.
- **Read-only infrastructure inventory (AIM-1)** and **backup verification through the Agent**.
- **Interface.**
  - The sidebar is grouped into collapsible sections; Instances is compact.
  - Page headers, summary tiles and buttons are consistent.
  - Cards rise in when a page opens and the sidebar animates; every animation is off when the system asks for reduced motion.
- **Accessibility.** The window exposes its controls to screen readers and automation tools from startup.

## Fixed

- **SSH with an encrypted private key.** A missing passphrase showed a raw parse error, followed by a false "Connection timed out". The SSH page now asks for the key's passphrase separately from the account password and gives clear errors for parsing, authentication and timeouts.
- **Duplicate prompts in the SSH terminal.** Prompts were duplicated on connect, and the previous session's prompt could appear in front of the login banner.
- **Selecting this PC's node could jump back to a tunnelled VPS.** A tunnelled VPS on `127.0.0.1` was treated as this PC's Agent; a selection race was also fixed.
- **Restart Agent on Windows** could fail with `LOCAL_AGENT_PROCESS_UNVERIFIED` while the elevated Agent was still releasing its port.
- **Marketplace modpacks.** CurseForge and Modrinth modpacks loaded slowly or hit rate limits; card lookups are cached and throttled. Modpack logos were blocked by the content security policy.
- **Agent Control explains why a remote node can't be controlled**, and a disabled Start no longer looks clickable.
- **A running Windows OpenSSH agent was reported as not running.** Its pipe refuses `stat` while busy.
- **Credential leak.** Node credential status probes could send the global Agent token to a node; only the node's own credential is sent now.
- **Playit detection.** Playit was detected by command-line text; it is now detected by its process image.
- **Instances and Network pages.** Instances auto-refresh no longer reloads the page or wipes edits; the Network page can no longer stay stuck loading.
- **Connectivity diagnostics** never show cached health for an edited or deleted endpoint and never TCP-probe a UDP endpoint.
- **Error redaction.** Nested error causes are redacted before IPC and logging.
- **Rendering.** Status pulses and loading shimmers animate with transforms only, so they no longer repaint every frame.

## Upgrade

An in-place upgrade keeps all settings, nodes, credentials and data. Existing nodes keep using their main address until you add a route or tunnel in the Routes panel.

**Agents:**
- **Packaged Agent nodes:** upgrade with the Build 207 Agent `.deb` (`sudo apt-get install ./AnxOS-Agent-2.0-build207.deb`). Identity, enrollment and data are kept, and the service restarts once. Add the SSH user to the `anxos-control` group for passwordless Start, Stop and Restart.
- **Nodes whose Agent runs from a desktop-installed user service:** keep using Update Agent.

**SSH:**
- To use a passphrase-protected key for background tasks, start the system SSH agent and run `ssh-add` once.
- Then tick **Use SSH agent for this key** on the SSH page, and use **Verify Access** in Agent Control.

## QA

Accepted on the signed release candidate built from commit `7f3f68a4`:
- **Repository validation:** 351 of 351 suites passed.
- **Signed CI build:** Authenticode signature valid, SHA-256 recorded, update manifest matched.
- **Real nodes:** in-place upgrade and acceptance on Windows, a LAN Debian node and an OVH VPS, including Verify Access and a Restart from the UI. A separately managed game server was left untouched.
