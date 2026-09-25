# V2-E bullet 1 — Game Adapter Contract

**Scope of every statement in this document:** a *code-path* claim about this
build (`dev`, HEAD `a950171`). Nothing here is a claim about a live game server.
No adapter in this repository has been observed starting, serving players, or
updating a real game; the V2-E acceptance gate remains **NOT VERIFIED**
(`docs/MASTER_ROADMAP.md:210,214`). Where the code does not settle a question the
row says **UNPROVEN**, and no plausible answer is substituted.

This is the V2-E deliverable "establish a documented game-adapter contract for
installation, versions, configuration, lifecycle, readiness and updates"
(`docs/MASTER_ROADMAP.md:212`). It was **ABSENT** before this document.

Companion artifacts:

| Artifact | Role |
| --- | --- |
| `docs/v2/V2E_GAME_ADAPTER_CONTRACT.md` (this file) | The contract, the shipped-adapter matrix, the divergences |
| `src/shared/gameAdapterContract.js` | The same required/optional split and the same status table, in machine-checkable form, plus `validateAdapterContract()` |
| `scripts/game-adapter-contract-smoke.js` | Derives each capability from the shipped code and fails if document, module or code disagree |

## 1. What a "game adapter" is in this codebase

The roadmap bullet names six concerns. The code does **not** implement them
through one interface. Three unrelated mechanisms share the word "adapter", and
the contract has to describe all three honestly rather than pretend one exists:

| Layer | What it is | Where | Covers |
| --- | --- | --- | --- |
| **Config adapter** | A registry entry describing a game's settings file: id, format, default path, field set | `src/shared/gameServerConfigManager.js:222-247` (`ADAPTERS`), read through `getAdapter` (`:272-274`) | configuration |
| **Game family** | A string family the instance core switches on to pick config paths, world scopes, readiness quirks | `src/shared/instances/instanceServiceCore.js:1685-1705` (`inferGameFamily`) | configuration paths, readiness, backup scope |
| **Installer type** | How an instance's runtime is obtained and installed | `src/services/marketplaceInstallerRegistry.js:1-11` (`SUPPORTED_INSTALLER_TYPES`), `config/marketplace-templates.json` | installation, updates |

A game is therefore an adapter only if it appears in `ADAPTERS`. Three do:
`minecraft`, `palworld`, `fivem` (`src/shared/gameServerConfigManager.js:222-247`).
Four further families are recognized by the core without a config adapter:
`terraria`, `valheim`, `rust`, `cs2` (`src/shared/instances/instanceServiceCore.js:1698-1703`).
Both groups ship, and both are covered by the matrix in §5.

The adapter registry is frozen and is resolved by lowercased id
(`src/shared/gameServerConfigManager.js:222,273`), so adapter ids must be
lowercase and unique.

## 2. The contract: required and optional capabilities

A capability is a behaviour the *contract* names. `required` means the instance
core cannot serve the adapter at all without it; `optional` means the adapter is
fully operable without it and the matrix records who has it.

### 2.1 Required (8)

| Capability | Area | What the contract requires |
| --- | --- | --- |
| `install.provision` | installation | Declares a way to obtain the runtime. Either an installer type from `SUPPORTED_INSTALLER_TYPES` (`src/services/marketplaceInstallerRegistry.js:1-11`), or the explicit `no-install` path. |
| `config.adapter` | configuration | Resolves in `ADAPTERS` with a format from the supported set, at least one field, and a non-empty `defaultFilePath`. |
| `config.resolvePath` | configuration | Has an in-instance config path resolver, so the editor can locate the file before it exists (`src/shared/instances/instanceServiceCore.js:6224-6260`). |
| `config.write` | configuration | Implements parse → read → validate → serialize for its declared format (`src/shared/gameServerConfigManager.js:590-606,641-704`). |
| `lifecycle.startStop` | lifecycle | Maps to an instance type in `INSTANCE_TYPES` (`src/shared/instances/instanceServiceCore.js:52-58`), so start/stop/restart apply. |
| `lifecycle.logs` | lifecycle | Console capture. Provided generically for every instance type (`:5865`). |
| `lifecycle.metrics` | lifecycle | Process metrics. Provided generically for every instance type (`:6452`). |
| `readiness.signal` | readiness | Readiness is observable. See §3. |

**`update` has no required capability.** This is deliberate and is the single
most consequential finding in this contract: an adapter may ship with no update
path at all, and four of the seven shipped families do. See §6 and divergence
**D-4**.

### 2.2 Optional (14)

| Capability | Area | Meaning |
| --- | --- | --- |
| `install.artifactVerify` | installation | Declares `installer.verifyFiles`, so an installer that exits 0 without producing the runtime is still detected as failed. |
| `install.sessionPhases` | installation | Installation is driven through the agent installation-session protocol with a named installer family and phase. |
| `config.secrets` | configuration | At least one field is `sensitive`, so its value is redacted before it reaches the renderer (`src/shared/gameServerConfigManager.js:719-721,764-773`). |
| `config.restartRequired` | configuration | Fields are marked `restartRequired`, so the write result can tell the operator a restart is needed (`src/shared/instances/instanceServiceCore.js:6372`). |
| `config.validation` | configuration | Field constraints are declared and enforced before any write (`src/shared/gameServerConfigManager.js:641-704`). |
| `readiness.gate` | readiness | A pre-start gate can block startup until the adapter's prerequisites are met. |
| `readiness.gameSpecific` | readiness | The adapter contributes behaviour beyond the shared signal: its own failure classification, timeout policy or stderr filtering. |
| `version.resolveAtInstall` | versions | Install resolves a concrete artifact version and persists it. |
| `version.detect` | versions | A post-install version detection path exists. |
| `version.detectFromArtifact` | versions | Version is re-derived from the installed artifact or its manifest, not re-read from install-written metadata. |
| `version.pin` | versions | A durable version identity is persisted **and a later operation compares against it**. |
| `update.inPlace` | updates | An in-place update operation exists. |
| `update.rollback` | updates | A rollback path exists for a failed update. |
| `backup.worldScope` | persistence | Declares the instance-relative save-data directories a world backup must capture. Extension area beyond the six roadmap areas. |

## 3. The readiness signal contract

**Required signal.** Every instance type gets two shared signals, and neither is
declared by an adapter:

1. **Log pattern.** One regex, shared by all games:
   `Done (...) ! | For help, type | Timings Reset | Server marked as running | Listening on port <n> | Server started`
   (`src/shared/instances/instanceServiceCore.js:5089`). On a match the instance
   is marked `Running`, `readinessState: "ready"`, `healthState: "healthy"`, and
   a version refresh is scheduled (`:5094-5101`).
2. **Port probe.** A listening primary port (or first declared port) is accepted
   as readiness without waiting for a log line; polled until the startup timeout
   (`src/shared/instances/instanceServiceCore.js:5303-5345`).

**Startup timeout.** If neither signal fires within `startupTimeoutMs`
(default 15000 ms, `:61`), the instance is marked `Running` with
`readinessState: "timeout"`, `healthState: "degraded"`,
`failureReason: "READINESS_TIMEOUT"` (`:5286-5300`).

**The contract's readiness rule.** An adapter that declares `readiness.signal`
must accept this shared signal as its readiness definition. An adapter whose
game is ready before any of those log lines appear and before its port listens
is **mis-served** by the shared signal and must declare `readiness.gameSpecific`
and document its own signal. No shipped adapter does this: the two
game-specific readiness behaviours that exist are hardcoded family branches, not
declared adapter capabilities (divergences **D-1**, **D-2**).

**Gate.** `readiness.gate` means readiness can *block startup*, not merely
report. Exactly one shipped adapter has this: FiveM. Its gate is
`evaluateFiveMReadiness` (`src/shared/instances/instanceServiceCore.js:2071-2090`),
which returns `setupRequired: true` with `reasonCode` in
`CONFIG_MISSING | LICENSE_MISSING | LICENSE_PLACEHOLDER | LICENSE_INVALID |
RESOURCES_MISSING` (`:2018-2050`), the license must match 32 alphanumerics or a
`cfxk_` prefix (`:1966-1972`), and both spawn resources `mapmanager` and
`spawnmanager` must exist on disk under `server/resources` (`:105-107`,
`:1993-2016`). The gate is re-evaluated and persisted on demand (`:2092-2126`,
`:2128-2159`) and a runtime license failure is also classified from output
(`:100`, `:5224`, `:5273`).

## 4. Version resolution and pinning rules

**Resolution at install.** The install path may resolve a concrete artifact
version and persist it. The resolved version comes from the download resolver
(`src/services/marketplaceService.js:2204-2246`) and is written into instance
version metadata by `buildResolvedVersionMetadata` (`:3499-3534`) and
`persistMarketplaceMetadata` (`:3580-3595`). Resolvers that return a version
include `papermc` (`:1896-1926`, version + build + sha256 checksum),
`github-release` (`:2136-2140`, tag name) and `fivem-linux`/`fivem-windows`
(`:2162-2166`, version extracted from the artifact path). `mojang-vanilla`
defaults `"latest"` to `manifest.latest.release` (`:2169-2202`).

**Pinning rules.**

1. **Only SteamCMD adapters pin.** A SteamCMD adapter persists `steamAppId` and
   the resolved `steamInstallDir` (`src/services/marketplaceService.js:2708-2714`)
   and, after an update, `steamBuildId` (`src/shared/instances/instanceServiceCore.js:605-611`).
   The update compares `buildIdBefore` against `buildIdAfter` and reports
   `buildChanged` (`:571,586,612`), and verifies `Success! App <id> fully
   installed` plus the app manifest before declaring success (`:589,595`). A
   successful download that leaves the manifest build unchanged is rejected as
   `STEAMCMD_UPDATE_NOT_APPLIED` (`:602-604`).
2. **Minecraft persists a version identity but never compares it.** The
   requested version is persisted at install (`src/services/marketplaceService.js:2685-2707`)
   and `minecraftVersion` is stored on the instance
   (`src/shared/instances/instanceServiceCore.js:1265`), but no operation
   compares a stored version against a candidate — there is no update path to
   consume it (§6). `version.pin` is therefore **NO** for Minecraft, not YES.
3. **Nothing else pins.** FiveM and Terraria record the artifact version once
   and never re-derive or compare it.
4. **A detected version is a cache, not a pin.** `versionInfo` +
   `versionCacheVersion` (`:75`, `:3350-3373`) exist to avoid re-scanning, and
   are invalidated by the version-cache constant, not by a desired-version
   mismatch.

**Detection after install.** Three different qualities of detection exist, and
the matrix separates them with `version.detect` and `version.detectFromArtifact`:

| Quality | Families | Code path |
| --- | --- | --- |
| Multi-source artifact inspection plus a live Minecraft status ping | minecraft | `src/shared/instances/instanceServiceCore.js:3375-3435`, `:3067-3126` (metadata.json, version.json, install_profile.json, Forge/NeoForge/Fabric libraries), `:3308-3320` (server-list ping) |
| The installed artifact's own manifest | palworld, valheim, rust, cs2 | `src/services/marketplaceService.js:3544-3575` (reads `steamapps/appmanifest_<appId>.acf` for `buildid`) |
| Re-read of install-written metadata only | fivem, terraria | `src/shared/instances/instanceServiceCore.js:3070-3094` reading `data/metadata.json` written at `src/services/marketplaceService.js:3593`. Nothing inspects the installed artifact. |

## 5. Shipped adapters: inventory and capability matrix

### 5.1 Inventory

<!-- contract-inventory:start -->

| Id | Kind | Installer type | Config adapter | Config format | Default config path | Fields (secret / restart-required) |
| --- | --- | --- | --- | --- | --- | --- |
| minecraft | config adapter + family | java-runtime | yes | properties | server.properties | 17 (0 / 9) |
| palworld | config adapter + family | steamcmd-native | yes | palworld-options | server/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini | 13 (2 / 13) |
| fivem | config adapter + family | archive-download | yes | fivem-cfg | server/server.cfg | 6 (1 / 6) |
| terraria | family only | archive-download | no | none | none | 0 (0 / 0) |
| valheim | family only | steamcmd-native | no | none | none | 0 (0 / 0) |
| rust | family only | steamcmd-native | no | none | none | 0 (0 / 0) |
| cs2 | family only | steamcmd-native | no | none | none | 0 (0 / 0) |

<!-- contract-inventory:end -->

Field counts are read from `MINECRAFT_FIELDS` (`gameServerConfigManager.js:19-101`),
`PALWORLD_FIELDS` (`:103-174`) and `FIVEM_FIELDS` (`:176-220`). A family with no
config adapter gets `UNSUPPORTED_GAME_CONFIG` (404) from both
`readGameServerConfig` (`instanceServiceCore.js:6335`) and
`resolveExistingGameConfigPath` (`:6258`). This table is parsed and checked
against the shipped code by the smoke, like the capability matrix below.

### 5.2 Capability matrix (machine-checked)

Every row below is parsed by `scripts/game-adapter-contract-smoke.js` and
compared against `ADAPTER_CONTRACT_STATUS` in `src/shared/gameAdapterContract.js`,
which is itself compared against the shipped code. Editing a row without editing
the code — or the reverse — fails the smoke.

<!-- contract-matrix:start -->

#### minecraft

| Capability | Status | Evidence (code path) |
| --- | --- | --- |
| install.provision | YES | `config/marketplace-templates.json` `minecraft-*` installerType `java-runtime`; `src/services/marketplaceInstallerRegistry.js:35-74,162-170` |
| install.artifactVerify | NO | Minecraft templates declare `downloads` but no `installer.verifyFiles`; nothing verifies the downloaded jar beyond the download step |
| install.sessionPhases | YES | `src/shared/instances/instanceServiceCore.js:126-134` (forge, neoforge, quilt), `:249-251`, `:275-293` (quilt version args), `:295-359` |
| config.adapter | YES | `src/shared/gameServerConfigManager.js:223-230` |
| config.resolvePath | YES | `src/shared/instances/instanceServiceCore.js:6225-6236` (`server.properties`, `server/server.properties`) |
| config.write | YES | `src/shared/gameServerConfigManager.js:590-606` properties branch, `:641-704` |
| config.secrets | NO | no `sensitive` field in `src/shared/gameServerConfigManager.js:19-101` |
| config.restartRequired | YES | 9 fields in `src/shared/gameServerConfigManager.js:19-101`; surfaced at `src/shared/instances/instanceServiceCore.js:6372` |
| config.validation | YES | required `server-port` and `max-players`, min/max and `allowedValues` in `src/shared/gameServerConfigManager.js:19-101` |
| lifecycle.startStop | YES | instance type `minecraft-paper` in `src/shared/instances/instanceServiceCore.js:52-58` |
| lifecycle.logs | YES | `src/shared/instances/instanceServiceCore.js:5865` |
| lifecycle.metrics | YES | `src/shared/instances/instanceServiceCore.js:6452` |
| readiness.signal | YES | shared log pattern `src/shared/instances/instanceServiceCore.js:5089` plus port probe `:5303-5345` |
| readiness.gate | NO | no pre-start gate; `evaluateFiveMReadiness` returns `NOT_FIVEM` for this family (`:2071-2073,2071-2090`) |
| readiness.gameSpecific | NO | no family branch in the readiness path for Minecraft |
| version.resolveAtInstall | YES | template `configurationSchema` includes `version`; `src/services/marketplaceService.js:1900,2171` honour `options.version`; persisted `:3499-3534` |
| version.detect | YES | `src/shared/instances/instanceServiceCore.js:3375-3435` |
| version.detectFromArtifact | YES | jars, libraries, `server.properties`, logs and a live status ping (`:3067-3126`, `:3308-3320`) |
| version.pin | NO | `minecraftVersion` persisted (`:1265`) but never compared; no update path consumes it |
| update.inPlace | NO | no Minecraft branch in the update surface; the agent route table exposes only `/steamcmd/update*` (`agent/src/routes/instances.js:407-425`) |
| update.rollback | NO | no rollback symbol in the update path |
| backup.worldScope | NO | `getWorldScopeCandidates` returns `[]` for this family (`src/shared/instances/instanceServiceCore.js:6215`) |

#### palworld

| Capability | Status | Evidence (code path) |
| --- | --- | --- |
| install.provision | YES | `config/marketplace-templates.json` `palworld` installerType `steamcmd-native`, appId 2394010 |
| install.artifactVerify | YES | `installer.verifyFiles` `server/PalServer.sh` and the Windows executable |
| install.sessionPhases | NO | `steamcmd-update` is not in `INSTALLER_PHASES` (`src/shared/instances/instanceServiceCore.js:126-134`), so `executeInstallationPhase` cannot run it; the SteamCMD session is a separate protocol (`:379-421`) |
| config.adapter | YES | `src/shared/gameServerConfigManager.js:231-238` |
| config.resolvePath | YES | `src/shared/instances/instanceServiceCore.js:6237-6249` over platform-ordered candidates (`:6183-6193`) |
| config.write | YES | `src/shared/gameServerConfigManager.js:591,597,603` palworld branch |
| config.secrets | YES | `ServerPassword`, `AdminPassword` in `src/shared/gameServerConfigManager.js:103-174` |
| config.restartRequired | YES | all 13 fields in `src/shared/gameServerConfigManager.js:103-174` |
| config.validation | YES | required `PublicPort`, `ServerPlayerMaxNum` plus min/max in `src/shared/gameServerConfigManager.js:103-174` |
| lifecycle.startStop | YES | instance type `custom-command` in `src/shared/instances/instanceServiceCore.js:52-58` |
| lifecycle.logs | YES | `src/shared/instances/instanceServiceCore.js:5865` |
| lifecycle.metrics | YES | `src/shared/instances/instanceServiceCore.js:6452` |
| readiness.signal | YES | shared log pattern `:5089` plus port probe `:5303-5345` |
| readiness.gate | NO | `evaluateFiveMReadiness` returns `NOT_FIVEM` (`:2071-2073`) |
| readiness.gameSpecific | YES | startup-timeout suppression `:5291` and benign stderr classification `:3733-3761`, used at `:5110-5123` |
| version.resolveAtInstall | NO | SteamCMD templates resolve no version; `resolveDownloadUrl` falls through to the URL template for them (`src/services/marketplaceService.js:2245`) |
| version.detect | YES | app manifest `buildid` (`src/services/marketplaceService.js:3544-3575`) |
| version.detectFromArtifact | YES | the app manifest belongs to the installed artifact (`steamapps/appmanifest_2394010.acf`) |
| version.pin | YES | `steamAppId` and `steamBuildId` persisted and compared (`src/shared/instances/instanceServiceCore.js:605-611`, `:571,586,612`) |
| update.inPlace | YES | `executeSteamCmdUpdate` (`src/shared/instances/instanceServiceCore.js:543-612`) |
| update.rollback | NO | a failed update is reported with `buildIdBefore` but no build is restored |
| backup.worldScope | YES | `src/shared/instances/instanceServiceCore.js:6199-6207` |

#### fivem

| Capability | Status | Evidence (code path) |
| --- | --- | --- |
| install.provision | YES | `config/marketplace-templates.json` `fivem` installerType `archive-download`, resolver `fivem-linux`, plus the official `cfx-server-data` pack (resolver `fivem-server-data`, `src/services/marketplaceService.js:2169`) extracted into `server/resources` via `installer.additionalArchives` (`:2474-2530`) |
| install.artifactVerify | YES | `installer.verifyFiles` `server/run.sh`, `server/FXServer.exe` and `server/resources/[managers]/spawnmanager/fxmanifest.lua` |
| install.sessionPhases | NO | archive installs run a generated script, not the installation-session protocol (`src/services/marketplaceService.js:2518-2544`) |
| config.adapter | YES | `src/shared/gameServerConfigManager.js:239-246` |
| config.resolvePath | YES | `src/shared/instances/instanceServiceCore.js:6250-6257` (`server/server.cfg`, write-guarded) |
| config.write | YES | `src/shared/gameServerConfigManager.js:592,598,604` fivem branch with `repeated-command` persistence (`:580-582`) |
| config.secrets | YES | `licenseKey` in `src/shared/gameServerConfigManager.js:176-220` |
| config.restartRequired | YES | all 6 fields in `src/shared/gameServerConfigManager.js:176-220` |
| config.validation | YES | 5 required fields plus endpoint and license-key patterns in `src/shared/gameServerConfigManager.js:176-220` |
| lifecycle.startStop | YES | instance type `custom-command` in `src/shared/instances/instanceServiceCore.js:52-58` |
| lifecycle.logs | YES | `src/shared/instances/instanceServiceCore.js:5865` |
| lifecycle.metrics | YES | `src/shared/instances/instanceServiceCore.js:6452` |
| readiness.signal | YES | shared log pattern `:5089` plus port probe `:5303-5345` |
| readiness.gate | YES | `evaluateFiveMReadiness` (`:2071-2090`), readiness model `:2018-2050`, key rules `:1966-1972`, spawn-resource check `:1993-2016`, persistence `:2092-2126`, refresh `:2128-2159` |
| readiness.gameSpecific | YES | the license gate, the spawn-resource gate and runtime license-failure classification (`:100`, `:5224`, `:5273`) |
| version.resolveAtInstall | YES | artifact version extracted from the FiveM listing (`src/services/marketplaceService.js:2162-2166`) and persisted (`:3499-3534`) |
| version.detect | YES | `data/metadata.json` re-read (`src/shared/instances/instanceServiceCore.js:3070-3094`) |
| version.detectFromArtifact | NO | nothing inspects the extracted FXServer tree; the value is whatever the installer wrote |
| version.pin | NO | no durable version identity is compared by any later operation |
| update.inPlace | NO | no FiveM branch in the update surface; only `/steamcmd/update*` exists (`agent/src/routes/instances.js:407-425`) |
| update.rollback | NO | no rollback symbol in the update path |
| backup.worldScope | YES | `src/shared/instances/instanceServiceCore.js:6208-6214` |

#### terraria

| Capability | Status | Evidence (code path) |
| --- | --- | --- |
| install.provision | YES | `config/marketplace-templates.json` `terraria-tshock` installerType `archive-download`, resolver `github-release` |
| install.artifactVerify | YES | `installer.verifyFiles` `server/TShock.Server` and the Windows variant |
| install.sessionPhases | NO | archive installs run a generated script, not the installation-session protocol (`src/services/marketplaceService.js:2518-2544`) |
| config.adapter | NO | absent from `ADAPTERS` (`src/shared/gameServerConfigManager.js:222-247`); `inferConfigAdapterId` returns null |
| config.resolvePath | NO | `resolveExistingGameConfigPath` throws `UNSUPPORTED_GAME_CONFIG` (`src/shared/instances/instanceServiceCore.js:6258`) |
| config.write | NO | `readGameServerConfig` throws `UNSUPPORTED_GAME_CONFIG` (`src/shared/instances/instanceServiceCore.js:6335`) |
| config.secrets | NO | no config adapter, so no declared field |
| config.restartRequired | NO | no config adapter, so no declared field |
| config.validation | NO | no config adapter, so no declared field |
| lifecycle.startStop | YES | instance type `custom-command` in `src/shared/instances/instanceServiceCore.js:52-58` |
| lifecycle.logs | YES | `src/shared/instances/instanceServiceCore.js:5865` |
| lifecycle.metrics | YES | `src/shared/instances/instanceServiceCore.js:6452` |
| readiness.signal | YES | shared log pattern `:5089` plus port probe `:5303-5345` |
| readiness.gate | NO | `evaluateFiveMReadiness` returns `NOT_FIVEM` (`:2071-2073`) |
| readiness.gameSpecific | NO | no family branch in the readiness path for Terraria |
| version.resolveAtInstall | YES | `github-release` returns the release tag name (`src/services/marketplaceService.js:2136-2140`), persisted `:3499-3534` |
| version.detect | YES | `data/metadata.json` re-read (`src/shared/instances/instanceServiceCore.js:3070-3094`) |
| version.detectFromArtifact | NO | nothing inspects the extracted TShock tree |
| version.pin | NO | no durable version identity is compared by any later operation |
| update.inPlace | NO | only `/steamcmd/update*` exists (`agent/src/routes/instances.js:407-425`) |
| update.rollback | NO | no rollback symbol in the update path |
| backup.worldScope | YES | `src/shared/instances/instanceServiceCore.js:6210-6212` (`server/Worlds`, `server/tshock`, `tshock`) |

#### valheim

| Capability | Status | Evidence (code path) |
| --- | --- | --- |
| install.provision | YES | `config/marketplace-templates.json` `valheim` installerType `steamcmd-native`, appId 896660 |
| install.artifactVerify | YES | `installer.verifyFiles` `server/valheim_server.x86_64` and the Windows executable |
| install.sessionPhases | NO | `steamcmd-update` is not in `INSTALLER_PHASES` (`src/shared/instances/instanceServiceCore.js:126-134`) |
| config.adapter | NO | absent from `ADAPTERS` (`src/shared/gameServerConfigManager.js:222-247`) |
| config.resolvePath | NO | `resolveExistingGameConfigPath` throws `UNSUPPORTED_GAME_CONFIG` (`src/shared/instances/instanceServiceCore.js:6258`) |
| config.write | NO | `readGameServerConfig` throws `UNSUPPORTED_GAME_CONFIG` (`src/shared/instances/instanceServiceCore.js:6335`) |
| config.secrets | NO | no config adapter, so no declared field |
| config.restartRequired | NO | no config adapter, so no declared field |
| config.validation | NO | no config adapter, so no declared field |
| lifecycle.startStop | YES | instance type `custom-command` in `src/shared/instances/instanceServiceCore.js:52-58` |
| lifecycle.logs | YES | `src/shared/instances/instanceServiceCore.js:5865` |
| lifecycle.metrics | YES | `src/shared/instances/instanceServiceCore.js:6452` |
| readiness.signal | YES | shared log pattern `:5089` plus port probe `:5303-5345` |
| readiness.gate | NO | `evaluateFiveMReadiness` returns `NOT_FIVEM` (`:2071-2073`) |
| readiness.gameSpecific | NO | no family branch in the readiness path for Valheim |
| version.resolveAtInstall | NO | SteamCMD templates resolve no version (`src/services/marketplaceService.js:2245`) |
| version.detect | YES | app manifest `buildid` (`src/services/marketplaceService.js:3544-3575`) |
| version.detectFromArtifact | YES | the app manifest belongs to the installed artifact |
| version.pin | YES | `steamAppId` and `steamBuildId` persisted and compared (`src/shared/instances/instanceServiceCore.js:605-611`, `:571,586,612`) |
| update.inPlace | YES | `executeSteamCmdUpdate` (`src/shared/instances/instanceServiceCore.js:543-612`); template metadata migration `:139-144`, `:519-541` |
| update.rollback | NO | a failed update is reported but no build is restored |
| backup.worldScope | NO | `getWorldScopeCandidates` returns `[]` for this family (`src/shared/instances/instanceServiceCore.js:6215`) |

#### rust

| Capability | Status | Evidence (code path) |
| --- | --- | --- |
| install.provision | YES | `config/marketplace-templates.json` `rust` installerType `steamcmd-native`, appId 258550 |
| install.artifactVerify | YES | `installer.verifyFiles` `server/RustDedicated` and the Windows executable |
| install.sessionPhases | NO | `steamcmd-update` is not in `INSTALLER_PHASES` (`src/shared/instances/instanceServiceCore.js:126-134`) |
| config.adapter | NO | absent from `ADAPTERS` (`src/shared/gameServerConfigManager.js:222-247`) |
| config.resolvePath | NO | `resolveExistingGameConfigPath` throws `UNSUPPORTED_GAME_CONFIG` (`src/shared/instances/instanceServiceCore.js:6258`) |
| config.write | NO | `readGameServerConfig` throws `UNSUPPORTED_GAME_CONFIG` (`src/shared/instances/instanceServiceCore.js:6335`) |
| config.secrets | NO | no config adapter, so no declared field |
| config.restartRequired | NO | no config adapter, so no declared field |
| config.validation | NO | no config adapter, so no declared field |
| lifecycle.startStop | YES | instance type `custom-command` in `src/shared/instances/instanceServiceCore.js:52-58` |
| lifecycle.logs | YES | `src/shared/instances/instanceServiceCore.js:5865` |
| lifecycle.metrics | YES | `src/shared/instances/instanceServiceCore.js:6452` |
| readiness.signal | YES | shared log pattern `:5089` plus port probe `:5303-5345` |
| readiness.gate | NO | `evaluateFiveMReadiness` returns `NOT_FIVEM` (`:2071-2073`) |
| readiness.gameSpecific | NO | no family branch in the readiness path for Rust |
| version.resolveAtInstall | NO | SteamCMD templates resolve no version (`src/services/marketplaceService.js:2245`) |
| version.detect | YES | app manifest `buildid` (`src/services/marketplaceService.js:3544-3575`) |
| version.detectFromArtifact | YES | the app manifest belongs to the installed artifact |
| version.pin | YES | `steamAppId` and `steamBuildId` persisted and compared (`src/shared/instances/instanceServiceCore.js:605-611`, `:571,586,612`) |
| update.inPlace | YES | `executeSteamCmdUpdate` (`src/shared/instances/instanceServiceCore.js:543-612`); template metadata migration `:139-144`, `:519-541` |
| update.rollback | NO | a failed update is reported but no build is restored |
| backup.worldScope | NO | `getWorldScopeCandidates` returns `[]` for this family (`src/shared/instances/instanceServiceCore.js:6215`) |

#### cs2

| Capability | Status | Evidence (code path) |
| --- | --- | --- |
| install.provision | YES | `config/marketplace-templates.json` `cs2` installerType `steamcmd-native`, appId 730 |
| install.artifactVerify | YES | `installer.verifyFiles` `server/game/bin/linuxsteamrt64/cs2` and the Windows executable |
| install.sessionPhases | NO | `steamcmd-update` is not in `INSTALLER_PHASES` (`src/shared/instances/instanceServiceCore.js:126-134`) |
| config.adapter | NO | absent from `ADAPTERS` (`src/shared/gameServerConfigManager.js:222-247`) |
| config.resolvePath | NO | `resolveExistingGameConfigPath` throws `UNSUPPORTED_GAME_CONFIG` (`src/shared/instances/instanceServiceCore.js:6258`) |
| config.write | NO | `readGameServerConfig` throws `UNSUPPORTED_GAME_CONFIG` (`src/shared/instances/instanceServiceCore.js:6335`) |
| config.secrets | NO | no config adapter, so no declared field |
| config.restartRequired | NO | no config adapter, so no declared field |
| config.validation | NO | no config adapter, so no declared field |
| lifecycle.startStop | YES | instance type `custom-command` in `src/shared/instances/instanceServiceCore.js:52-58` |
| lifecycle.logs | YES | `src/shared/instances/instanceServiceCore.js:5865` |
| lifecycle.metrics | YES | `src/shared/instances/instanceServiceCore.js:6452` |
| readiness.signal | YES | shared log pattern `:5089` plus port probe `:5303-5345` |
| readiness.gate | NO | `evaluateFiveMReadiness` returns `NOT_FIVEM` (`:2071-2073`) |
| readiness.gameSpecific | NO | no family branch in the readiness path for CS2 |
| version.resolveAtInstall | NO | SteamCMD templates resolve no version (`src/services/marketplaceService.js:2245`) |
| version.detect | YES | app manifest `buildid` (`src/services/marketplaceService.js:3544-3575`) |
| version.detectFromArtifact | YES | the app manifest belongs to the installed artifact |
| version.pin | YES | `steamAppId` and `steamBuildId` persisted and compared (`src/shared/instances/instanceServiceCore.js:605-611`, `:571,586,612`) |
| update.inPlace | YES | `executeSteamCmdUpdate` (`src/shared/instances/instanceServiceCore.js:543-612`); template metadata migration `:139-144`, `:519-541` |
| update.rollback | NO | a failed update is reported but no build is restored |
| backup.worldScope | NO | `getWorldScopeCandidates` returns `[]` for this family (`src/shared/instances/instanceServiceCore.js:6215`) |

<!-- contract-matrix:end -->

## 6. The update and rollback story

**One in-place update path exists: SteamCMD.** It is a session-based protocol
(`beginSteamCmdUpdateSession` `src/shared/instances/instanceServiceCore.js:383-425`,
`executeSteamCmdUpdate` `:543-612`), exposed as agent routes
`/steamcmd/update/session`, `/status`, `/migrate`, `/update`
(`agent/src/routes/instances.js:407-425`). Its rules:

- The instance must be `Stopped` or `Failed` and have no live process, else
  `STEAMCMD_UPDATE_REQUIRES_STOPPED` (`:393-398`, `:545-549`).
- The instance must carry `installerType: "steamcmd-native"` and an integer
  `steamAppId`, else `STEAMCMD_UPDATE_UNSUPPORTED` (`:385-386`, `:545`).
- The update runs `+force_install_dir <absolute data install dir> +login anonymous
  +app_update <id> validate +quit` (`:559-560`) with the install directory
  validated against traversal (`:554`) and resolved to an absolute path under
  `data/`: SteamCMD resolves a relative `+force_install_dir` against its own
  root, not the spawn working directory, so a relative value would install into
  a stray directory while the instance stays stale.
- Success requires exit 0, the `Success! App <id> fully installed` marker, a
  readable app manifest, and every declared verify file present (`:594-601`);
  when SteamCMD reported downloaded bytes, the instance manifest build must also
  have changed, else the update is rejected as `STEAMCMD_UPDATE_NOT_APPLIED`
  (`:602-604`). Failures are classified as `STEAMCMD_APP_ID_INVALID`,
  `STEAMCMD_AUTHORIZATION_FAILED`, `STEAMCMD_NETWORK_UNAVAILABLE` or
  `STEAMCMD_UPDATE_FAILED` (`:511-517`).
- Legacy template metadata is migrated to native SteamCMD metadata
  (`:139-144`, `:519-541`) and refuses with `STEAMCMD_METADATA_MIGRATION_REQUIRED`
  when the template is unknown (`:523`).

**Everything else has no update operation.** Minecraft, FiveM and Terraria have
no adapter-level update: the only update routes are the SteamCMD ones. Updating
one of those means re-running the template install, which re-downloads and
overwrites the artifact; that is a reinstall, not a versioned upgrade, and this
document does not describe it as one.

**Rollback does not exist for any adapter.** A failed SteamCMD update reports
`buildIdBefore`/`buildIdAfter` and the manifest path (`:590`) but restores
nothing. `update.rollback` is `NO` for all seven shipped adapters.

## 7. Configuration and file-layout expectations

**Instance data root.** Managed files live under `instances/<id>/data`. Install
steps write into `data/` (java-runtime: `data/paper.jar`, `data/server.jar`) or
into a declared `installDir` under it (steamcmd and archive: `data/server`),
which is also the working directory of the installed runtime
(`config/marketplace-templates.json` `startup.workingDirectory`).

**Config file resolution.** The adapter declares one default path, and the core
adds candidate fallbacks so both flat and nested installs resolve:

| Adapter | Candidates | Code path |
| --- | --- | --- |
| minecraft | `server.properties`, `server/server.properties` | `src/shared/instances/instanceServiceCore.js:6225-6236` |
| palworld | `<installDir>/Pal/Saved/Config/<Platform>/PalWorldSettings.ini` for the platform order, where `<installDir>` derives from `steamInstallDir`, `workingDirectory` or the `PalServer` argv path | `:6155-6193`, `:6237-6249` |
| fivem | `server/server.cfg` only, write-guarded by `assertNoInstanceDataEscape(..., { forWrite: true })` | `:81`, `:6250-6257` |

A path outside the instance data root is rejected before any read or write
(`assertNoInstanceDataEscape`, `src/shared/instances/instanceServiceCore.js:1031-1060`,
called from the resolver at `:6228,6241,6253`).

**Write discipline.** Every config write is hash-guarded: the caller submits the
`sourceHash` it read, and a mismatch raises `CONFIG_MODIFIED_EXTERNALLY` (409)
rather than clobbering an external edit (`:6345`). Validation failures raise
`CONFIG_VALIDATION_FAILED` (400) with per-field errors (`:6350`). Comments and
unknown keys are preserved by the format serializers — properties
(`src/shared/gameServerConfigManager.js:280-338`), palworld (`:340-489`), FiveM
(`:490-587`) — and the write result reports `restartRequired` when any submitted
field is marked (`src/shared/instances/instanceServiceCore.js:6372`).

**Format trap.** `parseDocument`, `readDocumentValues` and `serializeDocument`
select behaviour by `adapter.format` and **fall through to the properties
implementation for anything unrecognized**
(`src/shared/gameServerConfigManager.js:590-606`). A new adapter that declares an
unlisted format would appear to work while reading and writing the wrong
document. The validator refuses that (`CONFIG_FORMAT_UNSUPPORTED`).

**Adapter identity.** `getAdapter` lowercases the requested id
(`src/shared/gameServerConfigManager.js:273`), so ids must be lowercase; the
registry is frozen (`:222`), so a new adapter is a code change, not a config
change.

**World scope (persistence extension).** Only palworld, fivem and terraria
declare save-data directories (`src/shared/instances/instanceServiceCore.js:6198-6215`);
Minecraft and the remaining SteamCMD families fall back to the generic
`data/world` candidate. Valheim, Rust and CS2 save data is therefore **not**
captured by a per-game world scope (divergence **D-6**).

## 8. Divergences between the shipped adapters and this contract

These are findings, not defects to smooth over. Each is a place where the shipped
adapters disagree with each other or with the contract's own rules.

| Id | Divergence | Evidence |
| --- | --- | --- |
| **D-1** | **Readiness is not an adapter capability.** The contract requires `readiness.signal`, but no adapter declares one: every game gets the same log regex and port probe, hardcoded in the core. A game whose readiness never matches that regex and never listens is only ever reported as `timeout`/`degraded`. | `src/shared/instances/instanceServiceCore.js:5089`, `:5303-5345`, `:5286-5300` |
| **D-2** | **The two game-specific readiness behaviours are family branches, not adapter declarations.** Palworld's timeout suppression and benign-stderr filter, and FiveM's license gate, are selected by `isPalworldRuntimeCandidate`/`isFiveMInstance` — string matching on tags, ids and argv — not by an adapter capability. A new adapter cannot declare either. | `:3708-3718`, `:5291`, `:3733-3761`, `:1909-1924`, `:2071-2090` |
| **D-3** | **Installation is three unrelated mechanisms.** (a) the core installation-session protocol for forge/neoforge/quilt; (b) the SteamCMD session, which is a separate protocol and cannot run through (a); (c) generated marketplace install scripts for every other installer type. Only (a) and (b) are adapter-facing; (c) lives in the desktop app. | `:126-134`, `:236-267`, `:295-359`, `:379-421`, `src/services/marketplaceService.js:2518-2544` |
| **D-4** | **Updates are optional in practice.** The contract requires no update capability, and only SteamCMD adapters have one. Minecraft, FiveM and Terraria have no adapter update path at all; the agent exposes only `/steamcmd/update*`. | `agent/src/routes/instances.js:407-425`, `:543-612` |
| **D-5** | **Four recognized families have no configuration adapter.** The core recognizes terraria, valheim, rust and cs2, but `ADAPTERS` has only minecraft, palworld and fivem, so the config editor refuses those four with `UNSUPPORTED_GAME_CONFIG`. | `src/shared/instances/instanceServiceCore.js:1698-1703`, `src/shared/gameServerConfigManager.js:222-247`, `:6258`, `:6335` |
| **D-6** | **World scope is inconsistent across SteamCMD families.** Palworld declares save-data candidates; Valheim, Rust and CS2 — installed by the same SteamCMD mechanism and recognized by the same family switch — declare none, so their saves fall back to the generic `data/world` candidate. | `:6198-6215` |
| **D-7** | **"Version detection" means three different things.** Minecraft inspects artifacts and pings the server; SteamCMD families read the installed app manifest; FiveM and Terraria merely re-read the metadata the installer wrote. The contract separates these with `version.detectFromArtifact`, and FiveM/Terraria are `NO` on that row. | `:3067-3126`, `:3308-3320`, `src/services/marketplaceService.js:3544-3575`, `src/shared/instances/instanceServiceCore.js:3070-3094` |
| **D-8** | **No version pinning outside SteamCMD.** Only SteamCMD persists a version identity that a later operation compares. Minecraft persists `minecraftVersion` but nothing consumes it; FiveM and Terraria persist a display version only. There is no "run version X" guarantee for any non-SteamCMD adapter. | `:1265`, `:571,586,612`, `src/services/marketplaceService.js:2685-2707` |
| **D-9** | **Palworld's world-scope candidate list contains a duplicate.** `getPalworldInstallDirectory` defaults to `server`, and the literal `server/Pal/Saved` candidate is appended alongside the derived one, so the list can repeat. Harmless for a backup that de-duplicates paths; recorded because the contract cites the list. | `:6199-6207` (returns `["server/Pal/Saved", "server/Pal/Saved", "Pal/Saved"]` for a default install) |
| **D-10** | **Installer verification is uneven.** Palworld, Valheim, Rust, CS2, FiveM and Terraria declare `installer.verifyFiles`; the Minecraft templates declare downloads but no verification files, so a Minecraft install has no post-install artifact check at the template level. | `config/marketplace-templates.json` (`minecraft-*` vs the others), `src/services/marketplaceService.js:2289-2291` |

## 9. UNPROVEN items

Recorded as UNPROVEN rather than filled in plausibly. None of these is settled by
the code, and none may be reported as working.

1. **Whether the shared readiness regex is sufficient for valheim, rust, cs2 and
   terraria.** Their startup output is never matched in any test or fixture in
   this repository. The regex contains `Listening on port <n>` and `Server
   started`, which may or may not appear in those servers' output. UNPROVEN for
   all four.
2. **Whether a Minecraft or FiveM version upgrade is expected outside a
   reinstall.** No code, route or document in this repository describes one. The
   contract records `update.inPlace: NO` for both; whether that is a gap or a
   deliberate limitation is an owner decision, not a code fact.
3. **Whether the FiveM license gate is the only pre-start gate a future adapter
   will need.** `readiness.gate` is modelled on FiveM alone.
4. **Whether `version.detectFromArtifact` for palworld/valheim/rust/cs2 should
   count the app manifest as artifact-derived.** It is the installed artifact's
   own manifest, but it is produced by SteamCMD rather than inspected by this
   codebase. The contract counts it; the reasoning is stated so it can be
   overruled.
5. **Whether any shipped adapter's config field set is complete for its game.**
   The contract checks that fields exist, are typed, validated and redacted
   correctly; it makes no claim about coverage of each game's settings.
6. **Runtime behaviour of every row in §5.2.** Every row is a code-path claim.
   No adapter has been observed installing, starting, serving or updating a real
   game; the V2-E acceptance gate remains NOT VERIFIED.

## 10. Enforcement

**Validator.** `src/shared/gameAdapterContract.js` exports
`validateAdapterContract(definition, options)`. It is pure, returns a typed
verdict (`{ ok, adapterId, missingRequired, violations, codes, ... }`) and never
throws. A definition must declare `id`, `label`, a `capabilities` map, and the
`config`/`install`/`readiness` sections its claimed capabilities depend on.

**Integration point (recommended, not yet wired).** The contract is not wired
into a production call site, because the only adapter-resolution call site is
`getAdapter` inside `src/shared/gameServerConfigManager.js:272-274`, and the
module's ownership for this change excluded the adapters and the instance core.
The recommended integration is a load-time or registry-construction check in
`gameServerConfigManager.js`: for each entry in `ADAPTERS`, build a definition
from the entry (id, label, format, defaultFilePath, field count, path candidates)
and call `validateAdapterContract`, throwing on `ok === false`. That makes a new
adapter with an unsupported format or an empty field set fail at module load
rather than at the first config write. Until then, the smoke is the gate.

**Smoke.** `scripts/game-adapter-contract-smoke.js` (register as
`game-adapter-contract:smoke`):

1. Validates a definition that meets the contract, and refuses one missing each
   required capability in turn, naming that capability.
2. Derives every capability for every shipped adapter from the shipped code —
   by calling the real registry, the real template catalog, the real installer
   type resolver and the real instance core, and by reading named source anchors
   for the few rows that only a source read can settle.
3. Parses the §5.1 inventory table and the §5.2 capability matrix out of this
   document and compares both against the derived map, so code, module and
   document cannot drift apart without the gate failing.
4. Re-runs the shipped adapters against an extended required set to prove the
   validator actually refuses rather than always accepting.

**Existing gate coverage.** The adapter-relevant smokes that `rc:validate`
already runs are `instances:runtime:smoke`, `minecraft:players:smoke`,
`steamcmd:instance-update:smoke`, `instances:deletion:smoke`,
`minecraft-java-runtime:smoke`, `backups:world-scopes:smoke` and
`restart:schedule:smoke`. `scripts/game-server-config-smoke.js` — the smoke that
exercises the config adapter write path directly — exists but has **no npm
alias**, so `rc:validate` does not run it. Registering it is a one-line
`package.json` change and is recommended; it was outside this change's
ownership.
