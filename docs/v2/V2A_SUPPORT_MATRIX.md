# V2-A Support Matrix — Windows/Linux roles and capabilities

**Milestone:** V2-A — Shared platform, identity and agent foundation
**Wave:** 1 (design review artifact)
**Author:** Design/Research
**Date:** 2026-09-16
**Status:** Proposal — pending owner review
**Approved:** 2026-09-16 — all owner decisions accepted.

This matrix records what the V2-A foundation actually supports on each
platform, grounded in the shipped source. It deliberately **does not imply
identical host features on every platform** (per `docs/MASTER_ROADMAP.md`
V2-A checklist). Status legend: **Tested** (covered by an executed
smoke/live gate in build 202), **Partial** (implemented with gaps), **Absent**
(no implementation), **Experimental** (implemented, not covered by an
acceptance gate).

---

## 1. Platform scope

| Platform | Launcher / artifact evidence | Status |
| --- | --- | --- |
| Windows 10/11 x64 (primary packaged target) | `start-agent-mode.ps1`; Windows installer in build 202 (signed); bundled runtimes for win-x64 | **Tested** (Windows was the packaged acceptance target for build 200/202 RC gates) |
| Linux/macOS (dev launcher) | `AnxAgent.sh` (repo root) — bash launcher requiring Node.js + npm; config via `XDG_CONFIG_HOME`/`~/.config/anxos-control-center/agent.env`; the Linux Agent also installs and manages a systemd **user** unit at runtime (`src/services/agentControlService.js:524`, reported as type `systemd-user` at `agentControlService.js:455`) | **Experimental** (launcher plus runtime systemd user unit management; no Debian packaging found in repo, and no live V2-A Linux acceptance recorded) |
| Linux packaged artifacts (historical) | `docs/LINUX_ARTIFACT_REPORT_1.7-build143.md` — AppImage ~143 MiB, deb ~112 MiB, `latest-linux.yml`; build-202 CI produces `.AppImage` + `.deb` | **Partial** (artifact exists; no live V2 acceptance on a Linux host recorded) |
| Attested distro targets | Debian / Ubuntu / Fedora / Raspberry Pi (roadmap §6A and Linux artifact report) | **Untested for V2-A** — no live V2-A evidence on these hosts |

## 2. Capability matrix

| Capability | Windows (packaged) | Linux (launcher/dev) | Evidence |
| --- | --- | --- | --- |
| Agent REST server (port 47131) | **Tested** | **Tested** (same shared `agent/src/server.js` code) | `agent/src/config.js:9-10` |
| Enrollment handshake (start/complete/status, nonce-protected) | **Tested** | **Tested** (shared API) | `agent/src/routes/enroll.js:20` |
| Revoke / rotate tiering (owner revoke, admin rotate) | **Tested** (API level) | **Tested** (API level) | `agent/src/routes/enroll.js:64`; `agent/src/server.js:200-203,236-237` |
| Fail-closed permission profiles (`local-owner` / `restricted`) | **Tested** | **Tested** | `agent/src/permissions.js:11,61` |
| Roles: owner / admin / operator / viewer / service | **Tested** (security-service role map, CI authority smokes) | **Tested** (same backend) | `src/services/securityService.js`; `scripts/authority-permissions-smoke.js` |
| Device identity + spawn contract (`ANXHUB_CONFIG_DIR`) | **Tested** (build 200/202 sandbox acceptance) | **Partial** (spawn contract present; standalone-launch diagnostic path not live-tested on Linux) | `src/services/agentControlService.js:108,113,118` |
| Durable job lifecycle + idempotency + re-observation | **Tested** (CI: `instance-job-lifecycle-smoke.js`, `instance-job-reobservation-smoke.js`) | **Tested** (same shared code) | `src/shared/instances/jobLifecycle.js`; `instanceServiceCore.js:5501,5510` |
| Native instance operations (start/stop/restart/config) | **Tested** (Windows; V1 + V2-A gates) | **Partial** (Linux native process runtime not live-accepted) | `src/ipc/instancesIpc.js` |
| Docker / compose operations | **Partial** (route-served via agent; `docker:read/write` permission mapping) | **Partial** (same; requires Docker engine which is a prerequisite, not bundled) | `agent/src/routes/docker.js:67-70`; `src/shared/dockerService.js`; `src/services/serviceRouter.js:205-224` |
| Marketplace templates + installs | **Tested** (Windows marketplace flows; build-201 dependency fixes) | **Partial** (same backend; Linux host acceptance outstanding) | `src/services/marketplaceService.js:27-28,554` |
| Dependency checks + bundled runtimes | **Partial on Windows** (bundled java/dotnet/steamcmd resolved for win32 only); **Absent on Linux** (no bundled runtime tree; system runtime detection only) | | `src/shared/bundledRuntimePaths.js` (executable candidates gated on `win32`); `config/windows-runtime-bundle.json` |
| Public health endpoint | **Tested** | **Tested** | `agent/src/auth.js:24` (`/api/v1/health` public) |
| Browser management surface | **Partial** (session-gated read-only management page shipped) | **Partial** (same shared `agent/src/routes/ui.js` code) | `agent/src/routes/ui.js`; `agent/src/public/bootstrap.html`, `agent/src/public/management.html`; `agent:ui-session:smoke` |

## 3. Explicit platform caveats

- **Identical host features must not be implied.** Windows differs from Linux
  in: bundled runtimes (win-x64 only), PowerShell vs bash launchers, and the
  packaged service ownership model. A capability marked Tested on Windows is
  not automatically Tested on Linux.
- **Docker is a host prerequisite on both platforms** — never bundled; the
  matrix above is for the control-plane surface, not the engine itself.
- **Persistent service ownership** (management surviving without the desktop
  client) is now implemented on both platforms. Windows registers a startup
  scheduled task through the elevated Agent; Linux installs and manages an
  `anxos-agent.service` systemd **user** unit at runtime
  (`src/services/agentControlService.js:524`) and reports its state
  (`agentControlService.js:455`, type `systemd-user`). The Linux Agent
  self-update path depends on that unit and refuses with
  `LINUX_AGENT_UNIT_NOT_INSTALLED` when it is missing (see
  `docs/OPERATOR_NOTES_V2.md` §8). What remains outstanding is **live Linux
  acceptance** of this ownership on a real host, not the ownership code itself.

---

# Owner decisions required — V2-A support matrix

1. **Decision:** accept this matrix as the V2-A support statement
   (recommended: yes), including the "Untested for V2-A" status for
   Debian/Ubuntu/Fedora/Raspberry Pi.
2. **Decision:** select the Linux acceptance target for the V2-B wave
   (recommended: Debian 12 x64 — the existing remote-agent deployment target),
   or defer formal Linux V2-A acceptance until the browser surface lands.