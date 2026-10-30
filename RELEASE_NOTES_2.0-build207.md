# AnxOS Control Center v2.0 — Build 207

**DRAFT — NOT PUBLISHED.** These are the Build 207 release notes for the release candidate built from `dev`. No Build 207 release has been published. Publication follows the approval-gated steps in the AnxOS Development Protocol.

Build 207 makes AnxOS behave like a proper server app across several machines: nodes stay reachable through SSH tunnels and Tailscale fallbacks, connection blips no longer flash nodes offline, Playit is set up by linking an account instead of pasting an address, and the desktop app is reorganized, animated and lighter on the GPU.

## Added

- **App-managed SSH tunnels for nodes.** A node whose Agent listens only on the node itself (for example `127.0.0.1` on a VPS) can be reached through an SSH tunnel that Control Center opens, watches and reconnects with backoff. Tunnels use key authentication and a host key you have already approved; they never prompt or accept an unknown key.
- **Route fallback with Tailscale suggestions.** A node can have up to four extra addresses. Control Center uses the first one whose Agent proves the paired device identity, so a different machine answering on an address is never trusted. "Find Tailscale route" suggests the node's tailnet address from `tailscale status` (read only).
- **Routes panel and live status.** The Nodes page shows the route in use, its latency and any tunnel problem on each card, and a Routes panel manages addresses and the tunnel.
- **Connection blip tolerance and safe credential repair.** A single failed check right after a success shows "Reconnecting" instead of Offline. A rejected credential is repaired automatically only when the node proves it; otherwise the node asks to be re-paired.
- **Playit account linking.** Public Access guides Install → Start → Link Account → View Tunnels → Manage, using Playit's browser-based linking. Control Center never stores Playit passwords and never shows the link secret. The manual address remains under Settings → Advanced.
- **Network workspace.** Endpoint registry, connectivity diagnostics, provider integrations, telemetry sampling and operational notifications.
- **Read-only infrastructure inventory (AIM-1)** and **backup verification through the Agent**.
- **Interface.** The sidebar is grouped into collapsible sections; Instances is compact; page headers, summary tiles and buttons are consistent; cards rise in when a page opens, the sidebar animates, and every animation is off when the system asks for reduced motion.

## Fixed

- Node credential status probes could send the global Agent token to a node; only the node's own credential is sent now.
- Playit was detected by command-line text; it is now detected by its process image.
- Instances auto-refresh no longer reloads the page or wipes edits; the Network page can no longer stay stuck loading.
- Connectivity diagnostics never show cached health for an edited or deleted endpoint and never TCP-probe a UDP endpoint.
- Nested error causes are redacted before IPC and logging.
- Status pulses and loading shimmers animate with transforms only, so they no longer repaint every frame.

## Upgrade

An in-place upgrade keeps all settings, nodes, credentials and data. Existing nodes keep using their main address until you add a route or tunnel in the Routes panel.

## QA

Recorded in the release-candidate report: repository validation tiers, the signed CI build, its Authenticode signature and SHA-256, and the in-place upgrade and acceptance test.
