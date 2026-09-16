# V2-B Dashboard & Application Management — Design Brief (Wave 1)

**Milestone:** V2-B — Homelab dashboard and application management
**Wave:** 1 (design brief only — no code changes, no commits, no pushes)
**Author:** Design/Research
**Date:** 2026-09-16
**Status:** Proposal — pending owner review
**Approved:** 2026-09-16 — all owner decisions accepted.

This brief designs the Wave-1 slice of **V2-B "Homelab dashboard and
application management"** per `docs/MASTER_ROADMAP.md` §6 (Milestone V2-B at
line 150). It is grounded in the shipped V1/V2-A surfaces so the proposal
reuses what exists instead of building a parallel model.

---

## 1. Goal & scope

Roadmap V2-B checklist item this brief serves
(`docs/MASTER_ROADMAP.md:150`):

> Create a useful home dashboard with node health, storage pressure, running
> apps, game servers, failed jobs and actionable alerts; provide app cards,
> categories, search, favorites and launch links with real service status;
> guide users through installation requirements, target node, storage,
> resource limits, ports and access settings; support start/stop/restart,
> configuration, logs, update and uninstall from a coherent app detail page;
> distinguish AnxOS-managed, imported and external services; require explicit
> adoption before managing existing resources; keep node context and risky
> action targets visible.

Acceptance-gate sentence this brief supports (`MASTER_ROADMAP.md:162`):

> A first-time operator installs a reference self-hosted app, opens it,
> changes configuration and recovers a failed start through the UI. Dashboard
> status agrees with actual runtime state, including offline/stale cases.

The V2 Alpha slice line (`MASTER_ROADMAP.md:194`) additionally requires the
app lifecycle **install → configure → use → backup → update → restore →
uninstall**.

### In scope (Wave 1 design)

- An app-management slice that treats installed things as records on the
  existing V2-A instance/job-lifecycle foundation
  (`src/shared/instances/jobLifecycle.js`).
- Dashboard data sources + staleness policy; managed vs imported vs external
  service distinction with explicit adoption.
- Risky-action context persistence (target node visible throughout).

### Out of scope (this Wave)

- Container lifecycle itself (V2-C), package format/catalog 2.0 (V2-D) —
  only the *dependency surface* is referenced here.
- Browser workflows (they belong to the V2-A browser surface brief).

---

## 2. Current-state fidelity notes (verified file:line)

All paths relative to repo root; verified against the working tree on
2026-09-16.

### 2.1 Dashboard today

- Page element: `index.html:491` (`data-page="dashboard"`); header/welcome
  block `index.html:500-518` ("Everything running across your AnxOS network",
  context strip with system/status/metrics-updated placeholders).
- JS: `app.js:2148` `renderFriendlyDashboard()`, `app.js:1872`
  `setDashboardFriendlyField()`, `app.js:1947` default "Everything looks
  ready" next-action; state at `app.js:571-572`.
- **What exists is a friendly status strip + next-action guidance, not a
  discrete widget grid.** No app cards/categories/search/favorites yet.

### 2.2 Nodes, marketplace, instances pages

- Nodes page: `index.html:4061`; summary cards `index.html:4072-4079` (Total /
  Online / Offline Nodes, Docker Enabled, Connected Agent, Node Health, Health
  Issues); Add Node at `index.html:4068`.
- Marketplace page: `index.html:1488`; toolbar (search/categories/view)
  `index.html:1508+`; renderer state `app.js:831`
  (`marketplaceCatalog = { categories: [], templates: [] }`); render at
  `app.js:14247`/`14273`; refresh at `app.js:18141` → IPC
  `api.marketplace.listTemplates()` at `app.js:18155`.
- Instances page: `index.html:1712`; summary counts `index.html:1722-1750`;
  detail (address/ports/CPU/memory/disk/uptime) `index.html:1930-1946`;
  server presets `app.js:891` (`INSTANCE_SERVER_PRESETS` — minecraft variants,
  palworld), applied by `applyInstanceServerPreset()` at `app.js:18692`.

### 2.3 Backend surfaces

- `src/services/marketplaceService.js:27-28` — `TEMPLATE_PATH` →
  `config/marketplace-templates.json`, hardcoded `CATEGORIES` (9 categories);
  loader at line 554; `listTemplates()` at line 633; template normalization
  (screenshots/author/version/defaultPorts/configurationSchema/installScript)
  around lines 561-570.
- `src/ipc/marketplaceIpc.js` — wires list/install/import/versions/cancel/
  downloads/retry.
- Install execution: `src/services/marketplaceInstallService.js` (3,827
  lines) + `src/services/marketplaceInstallerRegistry.js` (188 lines).
- Core instance/job foundation: `src/shared/instances/instanceServiceCore.js`
  (6,399 lines) and `src/shared/instances/jobLifecycle.js` (730 lines);
  IPC: `src/ipc/instancesIpc.js` (251 lines), `src/ipc/nodesIpc.js` (85
  lines).
- V2-C gap: `src/services/dockerService.js` is a **4-line stub** on the
  desktop side, while the shared engine-facing implementation lives at
  `src/shared/dockerService.js` (1,171 lines) and is served via the agent.

### 2.4 Gaps against the V2-B checklist

- No app cards/categories/search/favorites or launch links from a dashboard.
- No install-requirements guidance (target node/storage/ports/access) beyond
  what the create-instance form offers today.
- No coherent app detail page (start/stop/restart/config/logs/update/
  uninstall on one screen).
- No managed/imported/external distinction — everything created via
  marketplace or presets is implicitly AnxOS-managed; there is no adoption
  flow for existing external services.
- No explicit stale/offline agreement between dashboard numbers and actual
  agent health (the `metricsUpdated` staleness concept exists in the agent
  health surface but is not surfaced as a first-class dashboard rule).

---

## 3. Proposed Wave-1 architecture

1. **App record model on top of the instance foundation.** Reuse the V2-A
   instance record + job lifecycle as the source of truth for lifecycle ops;
   add a thin "app" projection (display name, category, node, status derived
   from instance health, launch URL, configuration schema pointer from the
   marketplace template).
2. **Dashboard slice.** Upgrade `renderFriendlyDashboard()` to a small widget
   grid fed by the already-polled instance/nodes/health data with an explicit
   staleness rule (any source older than the configured
   `metricsUpdated` threshold renders as stale, not healthy).
3. **Managed vs imported vs external.** Add `ownership: "anxos-managed" |
   "imported" | "external"` to the app record; managing a non-managed record
   requires an explicit **adopt** action first (per checklist).
4. **Node context persistence.** Every app card/detail action shows the target
   node and refuses to run when the node context changes mid-flight (reuses
   the V2-A wrong-node fail-safe).

### Dependency note (V2-C / V2-D)

- The first app slice must NOT wait for full V2-C: marketplace installs today
  are native/SteamCMD/docker-image driven. Reference apps for Wave 1 should be
  **native-process or existing-template backed** (e.g., Palworld, Minecraft
  vanilla via presets), with Docker-backed apps flowing in with V2-C.
- V2-D provides the catalog/provenance upgrade; this brief only consumes the
  current template schema.

---

## 4. Owner decisions required

1. **First reference app catalog scope** — ship the Wave-1 slice with the
   existing template/preset catalog (recommended: yes, bounded to
   already-tested templates) vs. a curated 8-10-app sub-catalog first.
2. **Adopt-first for existing resources** — require an explicit adopt action
   before managing any non-AnxOS-created service in Wave 1 (recommended: yes,
   matches the checklist) vs. automatic adoption with a warning.
3. **Dashboard staleness policy** — treat any source older than the agent
   `metricsUpdated` threshold as stale/unknown (recommended) vs. render
   last-known data without aging.
4. **App detail page timing** — ship the app detail page with the dashboard
   slice now, with Docker-backed apps gated behind V2-C availability
   (recommended), vs. defer the detail page until V2-C ships.