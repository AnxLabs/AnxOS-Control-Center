# AnxOS Control Center v2.0 — Build 206

**DRAFT — NOT PUBLISHED.** This file is the Build 206 release notes for the candidate built from `dev` at `e84707b` (PR #1 `d01a269` plus PR #2 `e84707b`). No Build 206 release or tag has been published. Publication follows the approval-gated steps in the AnxOS Development Protocol.

Build 206 adds **service-managed instances**: the Agent can now observe and control an existing OS service (a systemd unit) without ever owning its process. The first use is adopting a production FiveM server that already runs as `anxrp-fxserver.service`, without any risk of the Agent launching a second copy.

## Temporary deployment notice (read before updating any Agent)

One production host (OVH) is **already running a locally built, unsigned `anxos-agent` 2.0-build206 package** that was built from commit `cc862de` of this branch before this Build existed as a release. It is a temporary deviation from the CI and signing path, approved for that single host:

- Package: `AnxOS-Agent-2.0-build206.deb`, SHA-256 `59842c83fd66d98084d991cd7d9769ef1e21f26d71dabd695049770394cb979f`, built on Linux from the LF-exact archive of `cc862de` with only `release.json` changed to build 206 in the build copy.
- The official Build 205 package (SHA-256 `7b9410c0433332d30ebb0d8a0b73aed36902f30063ec36d74403e20e60357acd`) is kept on that host as the rollback artifact.
- That host's Agent must **not** be self-updated or upgraded until an official release containing this change exists. The official Build 206 package supersedes it. It is **not** identical: it adds the service operations layer (PR #2: `serviceManagedOperations.js`, the operations routes, `safe-restart` on the lifecycle permission tier, `systemctl show --timestamp=unix`), carries official provenance, and no longer ships a stray `ssh2/lib/protocol/crypto/build/` directory that the temporary package picked up from the build host. Both share the dpkg version string `2.0-build206`, so move a host from one to the other with `dpkg -i` (a same-version reinstall); `apt` will report it as already installed. Either way only the Agent service restarts; a managed service such as FXServer is never restarted by the package.

## Added

- **Service-managed instances (`type: "systemd-service"`).** systemd stays the single owner of the process. The Agent runs only `[sudo -n] systemctl start|stop|restart <unit>` and `systemctl show`; it never spawns, signals or adopts the workload and holds no PID for it. Unreadable service state is shown as Unknown, never Stopped, and lifecycle actions refuse to act on it.
- **Operator-authored and allowlisted.** The record is written on disk by an operator and cannot be created or edited through the API. The unit must also be listed in `AGENT_SYSTEMD_UNIT_ALLOWLIST` in the root-owned Agent environment file, and control is limited to exact commands pinned by a sudoers drop-in. See `docs/SERVICE_MANAGED_INSTANCES.md`.
- **Desktop support.** Control Center shows these instances as "systemd service" / "Managed by systemd" with a notice naming the unit, a readable reason for Unknown and Failed states, and disables (with an explanation) everything the Agent refuses: console commands, force-kill, editing, renaming, duplicating, deleting, backups and scheduled restarts.
- **Capability report.** The Agent health response gains an additive `serviceManagedInstances` capability listing the allowed units.
- **Service operations layer (second Build 206 pass).** For a service-managed instance the Agent can now read, without owning anything: systemd's MainPID and uptime, AnxRP health (READY, version, boot id, sessions) from its status file, the connected player **count** from FXServer's loopback `/dynamic.json` and `/players.json` (names and identifiers are never stored or logged), the listening game ports from `/proc/net`, and an optional operator-written deployment manifest (unofficial-build flag, rollback artifact and backup status). New Agent environment variable: `AGENT_SERVICE_STATUS_ROOTS`.
- **Safe Restart.** One guarded action that automates the proven Phase 5 flow: verify the instance, unit and MainPID, systemd health, AnxRP READY (fresh) and 0 players, writable history; re-check players; issue **exactly one** `systemctl restart` (never retried); wait for a new MainPID, the listening ports, AnxRP READY with a **new boot id**, and a settle window with no automatic restart. Anything unknown, unreadable or ambiguous refuses or fails closed. Plain start, stop and restart are locked while it runs.
- **Restart history.** An append-only `service-history.jsonl` records every Safe Restart (started, then finished), every refusal and every plain start, stop and restart; interrupted operations are detected. A restart is refused if the history cannot be written.
- **Control Center.** A SYSTEMD MANAGED badge and operations panel (MainPID, uptime, AnxRP state and boot id, players, ports, preflight checklist, progress, result, history, unofficial-build warning, rollback artifact and backup status, read-only journal in the Console tab) and a specific reason on every disabled control.

## Fixed

- **Port-conflict check failed open.** The start preflight ignored listening sockets whose owner it could not identify (for example a server running as another user), counted a process owned by another user as dead, and swallowed errors from the check as "no conflict". Unknown owners and unreadable socket tables now block the start for every instance type.
- **Dependency pre-check on service-managed starts.** Starting a service-managed instance no longer runs the marketplace dependency check or auto-install, so a template's dependencies can never gate or trigger installs on a host whose runtime the Agent does not own.

## Release contents

Build 206 contains exactly two changes, both on the service-managed instance feature:

1. **PR #1 (`d01a269`)**: service-managed instances (native systemd adoption, no-spawn, allowlist and sudoers-pinned control), fail-closed port ownership, desktop support.
2. **PR #2 (`e84707b`)**: the operations layer (AnxRP health, players, listeners, deployment visibility, Safe Restart, restart history, desktop panel).

## Operator setup for the operations layer

Optional and per host. Without it, service-managed instances behave exactly as described above and Safe Restart is disabled with a stated reason.

- Add `AGENT_SERVICE_STATUS_ROOTS=<directory that holds the AnxRP status file>` to the root-owned `agent.env`, and restart the Agent.
- Add `serviceManager.operations` to the root-owned instance record (health file, loopback FXServer URL, listeners, timeout).
- Optionally create the root-owned `deployment.json` beside the record. See `docs/SERVICE_MANAGED_INSTANCES.md` for the formats.

## Upgrade

An in-place package upgrade keeps the Agent's data, token, identity and `agent.env`; the package restarts only the Agent service, never a service the Agent manages. Downgrading to the Build 205 package restores the Build 205 files exactly. Service-managed instances do nothing until an operator creates the record and allowlists the unit.

## Notes

- **Not in this build:** console commands for service-managed instances. Because there is no console channel, scheduled restarts (which warn players first) and backups (which would stop the service to archive an empty stub) are refused for them.
- Build the Agent `.deb` on Linux from LF sources (`git -c core.autocrlf=false archive`). A package built from a Windows checkout gets CR bytes in its maintainer scripts and `dpkg` fails to configure it.
- Pre-existing failures unrelated to this build, identical on the untouched Build 205 tag: `agent-cli-pairing-smoke` (`tokenOrigin=generated` assertion) and `stabilization-ui-qa` (First Experience welcome assertion).

## QA

- **Repository validation (feature and release tiers).** 39 of 41 scripts pass on commit `cc862de`; the two failures are the pre-existing ones above, with the identical assertion text on the untouched `v2.0-build205-rc3` baseline (34 of 36 there). No regressions.
- **New coverage.** Four smokes (`service-managed-runtime`, `service-managed-instance`, `port-ownership-fail-closed`, `service-managed-agent-routing`) and a real-Electron UI QA against a real Agent (`service-managed-ui-qa`, 12 consecutive passing runs). A mutation check removes 29 guards and requires a failing test for each, with 6 unmutated controls that must pass.
- **Real systemd.** End-to-end on Linux with the production Node 22.14.0: 55 of 55. A package-level migration rehearsal on a disposable VM (official Build 205 package, upgrade to a candidate, create the record, verify, roll back by downgrade): 55 of 55.
- **Production adoption (phases 0–4).** On the OVH host: preflight, backups, sudoers and environment preparation, package upgrade and read-only verification all passed with the managed service's `MainPID` and start time unchanged throughout. The Agent-driven restart of the live service (phase 5) was performed on 2026-10-08 with the server empty: one restart, new `MainPID` and boot id, AnxRP `READY` in about 6 seconds, and no new journal errors.
- **Operations layer (second pass).** Repository validation: 51 scripts, 49 pass; the 2 failures (`agent-cli-pairing-smoke`, `stabilization-ui-qa`) are the same pre-existing ones as on the merged baseline, with no regressions (the 2 new smokes pass). New coverage: `service-managed-operations-smoke` (20 tests, fake clock, every fail-closed branch), `service-managed-operations-agent-smoke` (real Agent HTTP, lock, audit, permission tiers) and a fourth real-Electron scenario (live evidence, refusals with players, one-click Safe Restart, history). The mutation check now runs 71 mutants (42 new) and all are killed, with 9 unmutated controls passing.
- **Real systemd (second pass).** The end-to-end script now also exercises the operations layer on the production Node 22.14.0 against a stand-in FXServer with an AnxRP-style status file and FXServer-style HTTP endpoints: 97 of 97, repeated 8 times. It verifies real `--timestamp=unix` parsing, real `/proc` listeners, exactly one systemd start event per Safe Restart, a new MainPID and boot id, refusals with players and with an unverifiable count, the restart lock, the audit file, and a Safe Restart that never reaches READY ending as a recorded timeout with no retry. It found one real bug (a manual `systemctl restart` resets `NRestarts`), fixed before this note.
- **Honest limits.** The UI QA runs in `--qa-mode` (no account sign-in); the real `anxrp-fxserver-console` wrapper and the real AnxRP status writer were not exercised by automated tests (the e2e uses stand-ins); macOS and ARM were not tested; no signed Build 206 artifact has been produced or verified.
