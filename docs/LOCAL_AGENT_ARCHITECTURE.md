# Local Agent Architecture

The Local Agent path lets AnxOS Control Center manage the user's own Windows PC. It reuses the existing Agent API, node registry, Marketplace, Files, Backups, Public Access, dependency, diagnostics, and Agent Control surfaces.

## Surfaces

One Agent runtime powers three surfaces. Pairing, identity, authentication, and lifecycle logic have one authoritative implementation in the Agent runtime; the surfaces present or transport that logic and do not reimplement it.

- **Control Center Agent Control GUI (desktop).** The page that installs, starts, stops, pairs, updates, and diagnoses the Local Agent and remote Agents.
- **`anxos-agent` CLI/TUI (headless).** The terminal surface for a Linux server with no desktop. `anxos-agent` opens the TUI; subcommands cover `status`, `pair`, `service status|start|stop|restart`, `logs`, `diagnostics`, `update --check`, `unpair`, `--help`, and `--version`.
- **Control Center protocol/API.** The authenticated HTTP API and node protocol used by the desktop client and by every Agent surface.

Packaging follows the same split: Windows builds embed the runtime outside `app.asar` (see **Runtime Packaging** below), and Linux ships the official `AnxOS-Agent-<version>.deb` package (Debian 11+/Ubuntu 22.04+ x64, glibc >= 2.28) with the `anxos-agent.service` systemd system unit, data in `/var/lib/anxos-agent`, and logs in `/var/log/anxos-agent`. Install and pairing steps are in `docs/HEADLESS_AGENT_INSTALL.md`.

The permission-profile contract stays unchanged: the desktop spawns its Local Agent with `ANXHUB_CONFIG_DIR`, which resolves the profile to `local-owner`; a standalone or remote Agent without that contract resolves to `restricted`, where every capability must come from explicit configuration or an explicit per-principal grant (fail-closed). Build 205 adds surfaces, not new trust: no authentication, authorization, loopback, or redaction check was weakened, and full tokens still never appear in the UI, logs, or diagnostics.

## Components

- Desktop app: Electron main process, preload bridge, renderer UI, secure storage, and node selection.
- Local Agent runtime: packaged under `resources/local-agent-runtime` in Windows builds and resolved by `src/services/localAgentRuntimeService.js`.
- Agent service control: implemented through `src/services/agentControlService.js`, including install, start, stop, restart, repair, update, diagnostics, and pairing actions.
- Node registry: `src/services/nodeService.js` discovers localhost, deduplicates `127.0.0.1` and `localhost`, and exposes the Local Agent as `This PC`.
- Shared capability model: local and remote nodes use a shared interface with capability flags for platform-specific behavior.
- Agent API: the same authenticated HTTP API serves local Windows, remote Windows, and remote Linux Agents.

## Discovery and Node Identity

The desktop probes both `127.0.0.1` and `localhost` using the configured Agent port. A healthy Local Agent is shown as a dedicated local node named `This PC`, with a stable local identity independent from the Windows hostname.

The Local Agent reports health, version, platform, operating system, architecture, hostname, uptime, CPU, RAM, disk, network interfaces, dependency readiness, service state, and instance count. It must not be rendered as a Linux node.

## Authentication

Local pairing is automatic and restricted to the local machine. Full tokens are never shown in the UI or logs. Diagnostics may show fingerprints only when needed for troubleshooting.

Remote Agent token workflows remain supported and separate from Local Agent pairing.

### Token provenance

The persisted `tokenOrigin` on the Agent credential decides whether a start may auto-migrate an existing credential into an enrollment record:

- `generated` — this Agent minted the credential for itself. A generated token never auto-enrolls; the node stays unenrolled across restarts and reboots until pairing or enrollment completes explicitly.
- `pairing`, `enrollment`, `desktop-rotation` — explicit pairing, enrollment, and desktop/operator rotation credentials keep the legacy migration behavior.
- Absent (pre-provenance installs) and environment-bootstrap credentials keep the legacy migration behavior as well. An environment bootstrap drops the key so those installs stay migratable.

Pairing completion persists `tokenOrigin: "pairing"`, which clears a previous `generated` marker, and enrollment persists `tokenOrigin: "enrollment"`.

### Revoked-enrollment recovery

`unpair` revokes the enrollment, and removing a node from Control Center attempts the same revocation. A revoked record makes authenticated routes answer `410 REVOKED` until the node is enrolled again. Completing a new pairing or enrollment against a revoked record restores it (`recoveredFromRevocation: true`) instead of leaving the node dead-ended, so re-pairing a revoked node is a supported recovery path. For any other record state the recovery step is a read-only no-op, and a recovery failure is logged with fingerprints and states only while the pairing result stays honest.

## Runtime Packaging

Windows builds package the Local Agent runtime outside `app.asar` under `resources/local-agent-runtime`. The package includes Agent files, shared runtime modules, configuration templates, Marketplace template metadata, and a runtime manifest. It excludes runtime config, logs, identity files, `.env`, repository metadata, and source maps.

Development builds use the repository tree. Packaged builds prefer `process.resourcesPath/local-agent-runtime`.

## Storage

The Local Agent keeps separate locations for program/runtime files, secure configuration, logs, instance data, backups, and temporary downloads. Instances and backups are not deleted by service repair or Agent updates.

## Updates and Repair

Local Agent updates are coordinated by the desktop: stop service, back up configuration and essential state, replace runtime files, run migrations where available, restart service, verify health, and reconnect. Diagnostics expose repair actions for service state, pairing, permissions, dependency scanning, reinstall, and update recovery.

## Compatibility

Remote Debian and remote Windows Agents remain first-class nodes. Local-only service controls are hidden for remote nodes, and unsupported actions are disabled with explanations.
