# AnxOS Control Center v2.0 — Build 204

Build 204 is a Private Alpha channel release focused on first-run reliability, safer networking defaults, and stronger recovery safeguards. New installs are guided from download to first server, the Agent stays local to this computer unless you opt in, and the status you see matches what the app is actually doing.

## Added

- **First-run setup opens on a new install.** The welcome screen and the full setup wizard now appear as expected, so a fresh install is guided through choosing an owner, connecting an Agent, preparing the node, and creating a first server instead of stopping on a blank step.
- **The Agent is local-only by default.** The standalone Agent binds to this computer only. Connecting other machines is a deliberate opt-in with a clear startup message, and using a concrete address adds a stricter host check.
- **Remote and phone workflows.** Push the bundled Agent runtime to a remote node over SSH with a guard that refuses to downgrade a newer Agent, and pair a phone with a node through a QR code and a browser claim page.
- **Server provisioning reliability.** FiveM instances are created with the spawn resources they need, and Minecraft/SteamCMD server updates keep their integrity checks.

## Fixed

- **Clearer status everywhere.** The node health badge now matches the health card, the Agent status no longer sticks on "Loading", tunnel and service counters agree with the tunnel state, and the setup wizard no longer claims "Ready" when a node cannot be deployed.
- **No more dead ends.** Marketplace and Create Server explain the next step instead of stopping, and controls that have nothing to act on are visibly disabled.
- **Reliability under failure.** The Docker page recovers from transient failures instead of stalling, workspace refreshes only run for the page you are on, and polling pauses while the window is hidden.
- **Safer recovery.** Orphan backup archives are quarantined instead of deleted, irreversible migrations verify a recovery point before rewriting state, and a disposable restore drill now runs as part of the test suite.
- **Security hardening.** Installer archive and extraction paths are contained, requests that look like DNS-rebinding attacks are refused, remote Agent updates cannot silently downgrade, and the shipped dependency set has no known advisories.
- **Installer and update reliability.** The Windows packaging check now validates the real packaged contents, and the packaged Agent ships its full dependency set so the Agent starts reliably after install.

## Upgrade

An in-place upgrade from 1.9 build 203 and earlier keeps your servers, settings, credentials, and backups. Uninstalling removes the application only; your data is kept. The Windows installer is signed.

## Notes

Build 204 is a Private Alpha channel release for Windows 11 x64; see the system requirements page for details. For remote nodes, set `AGENT_HOST` to the node's concrete LAN or tailnet address so other machines can reach it — this is never required for local use. Linux remote Agents support Debian- and Ubuntu-compatible 64-bit distributions; other distributions remain untested.

## QA

Build 204 passed the full automated suite (292 checks), packaged-runtime verification, and a security triage with no release-blocking findings. The release also completed a restore drill and a real-host lifecycle acceptance covering install, in-place upgrade, repair, and uninstall.