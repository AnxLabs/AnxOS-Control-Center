# AnxOS Control Center v2.0 — Build 206

**DRAFT — NOT PUBLISHED.** This file is the Build 206 release-notes draft. No Build 206 signed release candidate, release, or tag exists. Publication follows the approval-gated steps in the AnxOS Development Protocol.

Build 206 adds **service-managed instances**: the Agent can now observe and control an existing OS service (a systemd unit) without ever owning its process. The first use is adopting a production FiveM server that already runs as `anxrp-fxserver.service`, without any risk of the Agent launching a second copy.

## Temporary deployment notice (read before updating any Agent)

One production host (OVH) is **already running a locally built, unsigned `anxos-agent` 2.0-build206 package** that was built from commit `cc862de` of this branch before this Build existed as a release. It is a temporary deviation from the CI and signing path, approved for that single host:

- Package: `AnxOS-Agent-2.0-build206.deb`, SHA-256 `59842c83fd66d98084d991cd7d9769ef1e21f26d71dabd695049770394cb979f`, built on Linux from the LF-exact archive of `cc862de` with only `release.json` changed to build 206 in the build copy.
- The official Build 205 package (SHA-256 `7b9410c0433332d30ebb0d8a0b73aed36902f30063ec36d74403e20e60357acd`) is kept on that host as the rollback artifact.
- That host's Agent must **not** be self-updated or upgraded until an official release containing this change exists. An official Build 206 release supersedes the temporary package; its contents are expected to be functionally identical to `cc862de` plus this version bump and notes.

## Added

- **Service-managed instances (`type: "systemd-service"`).** systemd stays the single owner of the process. The Agent runs only `[sudo -n] systemctl start|stop|restart <unit>` and `systemctl show`; it never spawns, signals or adopts the workload and holds no PID for it. Unreadable service state is shown as Unknown, never Stopped, and lifecycle actions refuse to act on it.
- **Operator-authored and allowlisted.** The record is written on disk by an operator and cannot be created or edited through the API. The unit must also be listed in `AGENT_SYSTEMD_UNIT_ALLOWLIST` in the root-owned Agent environment file, and control is limited to exact commands pinned by a sudoers drop-in. See `docs/SERVICE_MANAGED_INSTANCES.md`.
- **Desktop support.** Control Center shows these instances as "systemd service" / "Managed by systemd" with a notice naming the unit, a readable reason for Unknown and Failed states, and disables (with an explanation) everything the Agent refuses: console commands, force-kill, editing, renaming, duplicating, deleting, backups and scheduled restarts.
- **Capability report.** The Agent health response gains an additive `serviceManagedInstances` capability listing the allowed units.

## Fixed

- **Port-conflict check failed open.** The start preflight ignored listening sockets whose owner it could not identify (for example a server running as another user), counted a process owned by another user as dead, and swallowed errors from the check as "no conflict". Unknown owners and unreadable socket tables now block the start for every instance type.
- **Dependency pre-check on service-managed starts.** Starting a service-managed instance no longer runs the marketplace dependency check or auto-install, so a template's dependencies can never gate or trigger installs on a host whose runtime the Agent does not own.

## Upgrade

An in-place package upgrade keeps the Agent's data, token, identity and `agent.env`; the package restarts only the Agent service, never a service the Agent manages. Downgrading to the Build 205 package restores the Build 205 files exactly. Service-managed instances do nothing until an operator creates the record and allowlists the unit.

## Notes

- **Not in this build:** console commands and workload READY integration for service-managed instances. Because there is no console channel, scheduled restarts (which warn players first) and backups (which would stop the service to archive an empty stub) are refused for them.
- Build the Agent `.deb` on Linux from LF sources (`git -c core.autocrlf=false archive`). A package built from a Windows checkout gets CR bytes in its maintainer scripts and `dpkg` fails to configure it.
- Pre-existing failures unrelated to this build, identical on the untouched Build 205 tag: `agent-cli-pairing-smoke` (`tokenOrigin=generated` assertion) and `stabilization-ui-qa` (First Experience welcome assertion).

## QA

- **Repository validation (feature and release tiers).** 39 of 41 scripts pass on commit `cc862de`; the two failures are the pre-existing ones above, with the identical assertion text on the untouched `v2.0-build205-rc3` baseline (34 of 36 there). No regressions.
- **New coverage.** Four smokes (`service-managed-runtime`, `service-managed-instance`, `port-ownership-fail-closed`, `service-managed-agent-routing`) and a real-Electron UI QA against a real Agent (`service-managed-ui-qa`, 12 consecutive passing runs). A mutation check removes 29 guards and requires a failing test for each, with 6 unmutated controls that must pass.
- **Real systemd.** End-to-end on Linux with the production Node 22.14.0: 55 of 55. A package-level migration rehearsal on a disposable VM (official Build 205 package, upgrade to a candidate, create the record, verify, roll back by downgrade): 55 of 55.
- **Production adoption (phases 0–4).** On the OVH host: preflight, backups, sudoers and environment preparation, package upgrade and read-only verification all passed with the managed service's `MainPID` and start time unchanged throughout. The Agent-driven restart of the live service (phase 5) was performed on 2026-10-08 with the server empty: one restart, new `MainPID` and boot id, AnxRP `READY` in about 6 seconds, and no new journal errors.
- **Honest limits.** The UI QA runs in `--qa-mode` (no account sign-in); the real `anxrp-fxserver-console` wrapper was not exercised by automated tests; macOS and ARM were not tested; no signed Build 206 artifact has been produced or verified.
