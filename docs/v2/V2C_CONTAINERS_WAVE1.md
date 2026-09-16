# V2-C Docker & Container Lifecycle — Design Brief (Wave 1)

**Milestone:** V2-C — Docker and container lifecycle
**Wave:** 1 (design brief only — no code changes, no commits, no pushes)
**Author:** Design/Research
**Date:** 2026-09-16
**Status:** Proposal — pending owner review
**Approved:** 2026-09-16 — all owner decisions accepted.

This brief designs the Wave-1 container slice for **V2-C "Docker and
container lifecycle"** per `docs/MASTER_ROADMAP.md` §6 (Milestone V2-C at
line 164). The roadmap keeps Podman/Kubernetes/Nomad future-ready architecture
only (§6 deferrals, line 298); this brief is Docker-first.

---

## 1. Goal & scope

Roadmap V2-C checklist item this brief serves (`docs/MASTER_ROADMAP.md:164`):

> Detect supported container engines and explain missing prerequisites;
> manage containers, images, volumes and networks with explicit ownership and
> target node; support reproducible multi-container application definitions,
> validated environment settings and secret references; preflight ports, disk
> capacity, required mounts and resource limits; show logs, health checks,
> resource usage, restart policy and execution failures; support controlled
> image updates, restart and rollback where data/schema compatibility allows;
> protect volumes on uninstall; preview cleanup and require explicit selection
> for data removal; gate privileged containers, host mounts and engine-socket
> access through policy and permissions.

Acceptance-gate sentence this brief supports (`MASTER_ROADMAP.md:177`):

> Install and operate one single-container and one multi-container reference
> app. Exercise bad image, occupied port, missing volume, restart and failed
> update. Cleanup preserves unselected user data and leaves no unexplained
> managed resources.

### In scope (Wave 1 design)

- Engine detection + prerequisite diagnostics; container/volume/image/network
  lifecycle mapped onto the V2-A job lifecycle; compose v2 support; volume
  protection on uninstall; preflight checks; policy gating (privileged
  containers, host mounts, socket access) per the V2-I boundary.

### Out of scope (this Wave)

- Podman/Kubernetes/Nomad engines (future-ready architecture only).
- Container-driven application detail page UX — that lives in V2-B.
- Public exposure of container ports (V2-H).

---

## 2. Current-state fidelity notes (verified file:line)

All paths relative to repo root; verified against the working tree on
2026-09-16.

### 2.1 Docker surface already exists (more than expected)

- **Shared engine service:** `src/shared/dockerService.js` — full
  implementation (1,171 lines) with pattern validation, exec wrapper, timeouts
  (`COMMAND_TIMEOUT_MS=8000`, `LOG_TIMEOUT_MS=12000`), `DockerServiceError`.
  The desktop `src/services/dockerService.js` is a **4-line stub** that
  re-exports the shared implementation (`agent/src/services/dockerService.js`
  likewise 4 lines).
- **Agent route manifest:** `agent/src/routes/docker.js:67-70` —
  `DOCKER_ROUTE_MANIFEST` (e.g., `docker.capabilities`) with 35+ imported
  operations (create/delete/exec/start/stop/restart containers, compose
  project management, networks, volumes, images).
- **Legacy actions:** `agent/src/actions/dockerActions.js:7-11` —
  `docker.start|stop|restart` via execFile, registered in
  `agent/src/actions/actionRegistry.js:3-20` with `permission: "docker:write"`.
- **Permission mapping:** `agent/src/server.js:196` (GET → `docker:read`),
  `:259` (write mapping); `agent/src/permissions.js:1`
  (`DEFAULT_ACTION_PERMISSIONS = ["docker:write"]`), `:20-21` (normalize
  `docker`/`docker.write` → `docker:write`), `:38-39` (`docker:*` → both).
- **Desktop IPC:** `src/ipc/dockerIpc.js` (imports ~30 functions from
  `../services/serviceRouter`, enforces `docker:read` + node context);
  `main.js:9` registers it; `preload.js:203-218` exposes the docker API.
- **Node gating:** `src/services/nodeService.js:277` (`supportsDocker`),
  `:320-324` (`docker: false` default + "Docker workspace controls require an
  Agent node."), `:670` (`runtime: node.docker?.runtime || "docker"`),
  `:780` (dependency check includes `docker`).
- **Dispatch:** `src/services/serviceRouter.js:205-224` routes docker
  snapshot/create to local vs agent; gating helpers at `:108,132,144,281`.
- **Agent client:** `src/services/agentClient.js:1686-1725` (containers,
  snapshot, create, inspect, images, pull/delete); compose functions at
  `:1853-1857`; routed via `serviceRouter.js:349`.

### 2.2 Compose and templates (docker-backed installs already exist)

- **Compose UI:** `index.html:1377-1428` — project name/directory/compose.yaml
  editor with Discover/Validate/Start/Stop/Restart/Pull/Build buttons.
- **Compose agent ops:** `agent/src/routes/docker.js` imports
  `listComposeProjects`, `start|stop|restart|recreate|remove|pull|build
  ComposeProject`, `validateComposeConfig`.
- **Docker templates in the catalog:** `config/marketplace-templates.json:1280`
  (`docker-minecraft-bedrock`, image `itzg/minecraft-bedrock-server:latest`),
  `:1349` (`docker-nginx`, `nginx:stable-alpine`), `:1459-1465`
  (`startupType: "docker-compose"` + `type: "docker-compose"`); used via
  `src/services/marketplaceService.js:3819`
  (`agentClient.createDockerContainer`).

### 2.3 Absent / gaps

- **No `dockerode` SDK** — all Docker interaction is CLI (`execFile`); no
  `docker-compose` package dependency (all compose via CLI).
- **No dedicated container smoke tests** found; nearest coverage:
  `docs/REAL_MACHINE_VALIDATION.md:48,94,99` and `docs/TEST_COMMANDS.md:144`
  (Docker/Podman detection).
- **No instance/job-lifecycle mapping for containers yet** — no
  `instanceType: docker-*` handling in the job lifecycle persists container
  ops as durable jobs.

---

## 3. Proposed Wave-1 architecture

1. **Engine detection + diagnostics.** Wrap the existing
   `docker.capabilities` surface into an explicit "detect → explain
   prerequisite" step (mirroring the dependency-check UX pattern from
   `agent/src/services/dependencyService.js`).
2. **Container object model on V2 identities.** Represent containers,
   volumes, images, and networks under the shared identity/ownership model
   (node-scoped, named, owned) so V2-I grants can scope them later.
3. **Lifecycle on the V2-A job lifecycle.** Route create/start/stop/restart/
   pull/update through the durable job store
   (`instanceServiceCore.js:5501` + `jobLifecycle.js`) so restarting the
   client does not orphan container operations; destructive ops ride the
   non-replay idempotency rules.
4. **Preflight + volume protection.** Enforce port/disk/mount/resource-limit
   preflight before create; on uninstall, preview cleanup and require explicit
   selection before any volume data removal (per checklist).
5. **Policy gating.** Privileged containers, host mounts, and daemon-socket
   access default to **deny**, overcome only by an explicit grant in the
   permission profile (V2-I boundary applied early).

---

## 4. Owner decisions required

1. **Engine scope for Wave 1** — Docker CLI via `execFile` (no new SDK
   dependency) for both single-container and compose v2 (recommended: yes),
   vs. introducing `dockerode` now.
2. **Container state ownership** — desktop routes to local or agent engine
   through `serviceRouter` per node (recommended: yes — both paths already
   exist), vs. agent-only ownership.
3. **Compose support version** — support Compose v2 (`docker compose`) first
   with the v1 (`docker-compose`) legacy flag kept only as a fallback warning
   (recommended), vs. supporting both equally.
4. **Privileged-container policy default** — deny privileged/host-mount/
   socket access by default with explicit per-workload grants (recommended),
   vs. allow-by-default behind a warning.