# V2-D Marketplace, Templates & Dependencies/Runtimes — Design Brief (Wave 1)

**Milestone:** V2-D — Marketplace, templates and dependencies/runtimes
**Wave:** 1 (design brief only — no code changes, no commits, no pushes)
**Author:** Design/Research
**Date:** 2026-09-16
**Status:** Proposal — pending owner review
**Approved:** 2026-09-16 — all owner decisions accepted.

This brief designs the Wave-1 marketplace/runtimes slice for **V2-D
"Marketplace, templates and dependencies/runtimes"** per
`docs/MASTER_ROADMAP.md` §6 (Milestone V2-D at line 179). It maps the current
Marketplace 1.x and dependency/runtime machinery so the V2 package format and
install transactions reuse what exists.

---

## 1. Goal & scope

Roadmap V2-D checklist item this brief serves (`docs/MASTER_ROADMAP.md:179`):

> Define a versioned package/template format with provenance, compatible
> hosts, requirements, ports, volumes, permissions and lifecycle actions;
> organize a curated initial catalog; show installed vs available versions,
> update notes, maintenance state and unsupported combinations; resolve
> runtime versions per workload; validate downloads and package integrity;
> show the installation plan before changes and track progress, interruption,
> resume and cleanup; provide a bounded extension/adaptor interface with a
> clear trust warning; support catalog export/import and document offline
> installation limits.

Acceptance-gate sentence this brief supports (`MASTER_ROADMAP.md:192`):

> A catalog package installs reproducibly on a clean supported host with its
> declared dependencies. Corrupt downloads, missing dependencies,
> incompatible templates and failed installs produce safe, diagnosable
> outcomes. Updating one runtime does not break a pinned reference workload.

Section 6A maps "Marketplace 2.0" and "Dependency Center" to V2-D.

### In scope (Wave 1 design)

- Versioned package/template format reconciled with the existing schema;
  catalog model; runtime resolution rules per workload without breaking shared
  dependencies; install transaction semantics (plan → execute → resume/
  cleanup) riding the V2-A durable job lifecycle.

### Out of scope (this Wave)

- Extension/plugin SDK (V2-N) and full catalog 2.0 curation.
- Public trust infrastructure beyond recorded provenance fields.

---

## 2. Current-state fidelity notes (verified file:line)

All paths relative to repo root; verified against the working tree on
2026-09-16.

### 2.1 Marketplace 1.x

- Catalog: `config/marketplace.json` (encrypted, aes-256-gcm, schemaVersion
  2), `config/marketplace-templates.json` (1,906 lines; fields incl.
  `displayName`, `instanceType`, `startupType`, `downloadSource`,
  `downloads`, `installScript`, `configurationSchema`, `installerType`),
  `config/marketplace-server-certifications.json` (certification records).
- Core service: `src/services/marketplaceService.js` (4,171 lines);
  `TEMPLATE_PATH` line 27, `CATEGORIES` line 28, `readTemplatesFile()` line
  554, `deepMergeTemplate()` line 572, `getInstallTargetPlatform()` line 594;
  `ensureTemplateDependencies()` line 194 → `agentClient.checkDependencies`.
- Installer registry: `src/services/marketplaceInstallerRegistry.js` —
  `SUPPORTED_INSTALLER_TYPES` line 1 (archive-download, curseforge,
  direct-download, docker-image, java-runtime, local-import, no-install,
  provider-download, steamcmd-native), `LEGACY_INSTALLER_TYPE_MAP` line 13,
  `normalizeInstallerType()` line 30, `getTemplateInstallerType()` line 35.
- IPC with redaction: `src/ipc/marketplaceIpc.js` (402 lines);
  `getSafeMarketplaceDetails()` line 33.
- Install execution: `src/services/marketplaceInstallService.js` (3,827
  lines) — CurseForge agent/browse configs, `buildInstallContext`,
  `resolveMarketplaceInstallTarget`, local fallback
  `sourceFallback: "marketplace-provider"`, `installPathFallback: "data"`.
- Providers: `src/services/providerConfigService.js`, `src/services/providers/
  curseforgeProvider.js` (1,731 lines), `src/shared/marketplaceError.js`.

### 2.2 Dependency check service

- Router: `src/services/serviceRouter.js` exports `checkDependencies`,
  `getDependencyCatalog`, `installDependencies`,
  `planDependencyPreparation` (routed to agent); line 193 ("This instance
  requires node dependencies before it can start."), lines 502-509 (nodeIds
  backfilled onto deps/jobs), lines 802/833 (local-desktop install no-op
  returns `completed` with `installationMethod: "local-noop"`,
  `executionBackend: "desktop"`).
- IPC: `src/ipc/dependenciesIpc.js` (114 lines) — `invokeDependencyOperation()`
  line 19 wraps errors `DEPENDENCY_REQUEST_FAILED`; `requireNodeContext`.
- Agent REST: `agent/src/routes/dependencies.js` — `GET /api/v1/dependencies/
  catalog`, `POST .../check|plan|install`.
- Agent service: `agent/src/services/dependencyService.js` (1,064 lines) —
  imports `DEPENDENCY_REGISTRY`, `assertKnownDependencyId`,
  `compareVersions`, `dependencyIdsForGroups` from
  `src/shared/marketplaceDependencies`; `bundledRuntimePaths` import line 15;
  `DEFAULT_TIMEOUT_MS = 120000` line 18, `INSTALL_TIMEOUT_MS` 15 min line 19;
  `createJobId()` line 35; injected helpers (test seams) lines 24-29;
  `checkDependency` line 475 (with `nodejs` special-case via
  `ANXOS_LOCAL_AGENT_RUNTIME_ROOT` lines 494-495); `checkDependencies` line
  590 → `{ok, distribution, dependencies, missingDependencyIds, checkedAt}`
  lines 628-634; Windows installer resolution lines 466/470 (winget).
- Registry: `src/shared/marketplaceDependencies.js` (688 lines) —
  `DEPENDENCY_REGISTRY` line 3 (frozen): `java` minVersion 17, `dotnet-runtime`
  minVersion 8.0, `docker`, `docker-compose`, `steamcmd`; `DEPENDENCY_GROUPS`
  line 436; `COMMAND_DEPENDENCY_MAP` line 494; `normalizeDependencyIds` line
  542; `dependencyIdsForGroups` line 550; `resolveTemplateDependencyIds` line
  579.

### 2.3 Bundled runtimes

- `src/shared/bundledRuntimePaths.js` (55 lines) — candidate roots lines
  7-18 (`ANXOS_BUNDLED_RUNTIME_ROOT`, `<resources>/bundled-runtimes/win-x64`,
  `resources/bundled-runtimes/win-x64`); `resolveRoot()` via
  `bundle-manifest.json` lines 20-22; `executableCandidates(id)` **win32
  only** lines 24-34 (java-8|16|17|21 → `java/<ver>/bin/java.exe`,
  dotnet-8 → `dotnet/8/dotnet.exe`, steamcmd → `steamcmd/steamcmd.exe`);
  `buildRuntimeEnvironment` extends `process.env`.
- `config/windows-runtime-bundle.json` — win-x64 artifacts (java 8.0.492+9,
  16.0.2+7, 17.0.20+8, 21.0.12+8, dotnet 8.0.29, steamcmd),
  `resources/bundled-runtimes/win-x64/bundle-manifest.json` (generated
  2026-07-29).
- Build 202 fixes relevant to this surface: `8cc5768` (accept
  missing-dependency scan results as a normal result; detect bundled Java on
  Windows), `7ea544a` (node-switch state reset — the "Switching node…" UX
  defect), both shipped in build 202 (`RELEASE_NOTES_1.9-build202.md`).

---

## 3. Proposed Wave-1 architecture

1. **Versioned package format (V2).** Extend the existing template schema with
   `packageVersion` + provenance (source, author, publishedAt, checksum) +
   declared requirements (hosts, runtimes, ports, volumes, permissions,
   lifecycle actions) instead of replacing it — `deepMergeTemplate()`
   (`marketplaceService.js:572`) already provides a compatibility seam.
2. **Catalog model.** Keep `config/marketplace-templates.json` as the curated
   catalog; add an installed-vs-available view derived from instance records +
   template `packageVersion`.
3. **Runtime resolution per workload.** Resolve runtime versions through the
   existing `DEPENDENCY_REGISTRY` + bundled-runtime discovery, with an
   explicit rule that changing one workload's runtime must **not** silently
   alter another pinned workload's runtime (per acceptance gate).
4. **Install transactions on the V2-A job lifecycle.** Model
   plan → execute → resume/cleanup as durable jobs
   (`instanceServiceCore.js:5501`, `jobLifecycle.js`), reusing the
   curated-idempotency and non-replay rules; show the plan before executing.
5. **Integrity + trust.** Verify download checksums before execution
   (fields added in step 1); keep the existing certification records and add
   per-item trust warnings for third-party executable content.

---

## 4. Owner decisions required

1. **Package format strategy** — evolve the existing template schema with
   versioning/provenance fields (recommended: yes — backward compatible with
   Marketplace 1.x), vs. a clean v2 package schema with a migration step.
2. **Catalog provenance/trust** — record provenance + checksum in the catalog
   and verify before install, surfacing trust warnings for unverified items
   (recommended), vs. gating unverified items out of the curated catalog.
3. **Runtime isolation** — enforce per-workload runtime resolution with a
   no-cross-wiring assertion (an update to one workload's runtime must not
   silently change another pinned workload) (recommended: yes —
   `resolveTemplateDependencyIds` extended with pin metadata), vs. shared
   runtime pools.
4. **Install transactions** — ride the V2-A durable job lifecycle now
   (recommended), vs. a parallel marketplace store.