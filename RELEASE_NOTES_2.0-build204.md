# AnxOS Control Center 2.0 — Build 204

Build 204 is a Private Alpha channel release focused on first-run reliability, safer networking defaults, and stronger recovery safeguards. New installs show the welcome and guided setup, the Agent stays local unless you opt in, and status reporting matches what the app is actually doing.

## Highlights

- **First-run setup opens on a new install.** The welcome screen and the full setup wizard now appear as expected, so a fresh install is guided from download to first server instead of stopping on a blank step.
- **The Agent is local-only by default.** The standalone Agent binds to this computer only, and connecting other machines is a deliberate opt-in with a clear startup message.
- **Clearer status everywhere.** The node health badge matches the health card, the Agent status no longer sticks on "Loading", tunnel and service counters agree with the tunnel state, and the setup wizard no longer claims "Ready" when a node cannot be deployed.
- **Safer recovery.** Orphan backup archives are quarantined instead of deleted, irreversible migrations verify a recovery point first, and a disposable restore drill now runs as part of the test suite.
- **Security hardening.** Installer paths are contained, requests that look like DNS-rebinding attacks are refused, and the shipped dependency set has no known advisories.
- **Remote and phone workflows.** Push the bundled Agent runtime to a remote node over SSH with a downgrade guard, and pair a phone with a node through a QR code and a claim page.
- **Reliability fixes.** The Docker page recovers from transient failures instead of stalling, Marketplace and Create Server no longer dead-end, FiveM instances are provisioned with the spawn resources they need, and workspace refresh and visibility-aware polling are smoother.

## Upgrade

An in-place upgrade from 1.9 build 203 and earlier keeps your servers, settings, credentials, and backups. Uninstalling removes the application only; your data is kept. The Windows installer is signed.

## Notes

Build 204 is a Private Alpha channel release for Windows 11 x64; see the system requirements page for details. For remote nodes, set `AGENT_HOST` to the node's concrete LAN or tailnet address so other machines can reach it — this is never required for local use. Linux remote Agents are supported on Debian- and Ubuntu-compatible 64-bit distributions; other distributions remain untested.

## Verification

Build 204 passed the full automated suite (292 checks), packaged-runtime verification, and a security triage with no release-blocking findings. The release also completed a restore drill and a real-host lifecycle acceptance covering install, in-place upgrade, repair, and uninstall.
