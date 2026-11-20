# Frozen identifiers (Build 216, AnxHost CC)

Build 216 changes the **visible** product name to AnxHost Control Center
(AnxHost CC, "formerly AnxOS Control Center"). The identifiers below are
**not** changed in Build 216, because Build 215 installations, Agents on
other computers, paired phones, managed Docker containers and update clients
depend on them. Source of truth: `PLANS.md` section 6.

Guarded by `scripts/frozen-identifiers-smoke.js`
(`npm run frozen-identifiers:smoke`, included in `rc:validate` because it is
a `*:smoke` script). Each check reads the file that defines the identifier
and fails when the exact value disappears. The smoke also fails if this
document stops listing a check ID.

## Rules

- Rename only **user-visible strings**, through the allowlist kept for the
  in-app rename (216-B1). Never search-and-replace "AnxOS", "anxos" or
  "AnxHub".
- Host lists only grow. A new domain is added beside `anxoscontrolcenter.org`;
  nothing is removed in Build 216.
- Release assets: exactly one asset may match `/setup.*\.exe$/i`, and it must
  be the signed NSIS installer (Build 215's updater picks the first match of
  the patterns in FI-UPD-05). `update-manifest.json` stays at its Build 215
  URL.
- Changing any identifier below needs an explicit owner decision, a migration
  with a rollback, a regression test with a Build 215 record, and an update of
  this document and the smoke in the same change.

## What would break if each group changed

| Group | Consequence of a change |
| --- | --- |
| Installer and app identity | A new appId gives a new NSIS uninstall GUID: Build 216 installs beside 215 instead of upgrading it, with two Helper registrations. A new exe name breaks the Helper start check in `install-agent-task.ps1` and Agent Control's packaged-app detection. |
| User data and storage | A new userData name loses settings, encrypted sessions and credentials (the safeStorage key lives in that profile). New storage keys reset UI preferences and favorites. Removing a preload alias breaks renderer code that uses it. |
| Windows Helper | A new task name orphans the existing Helper task on every Windows PC. |
| Linux Agent | A new package, user, path, group or `.deb` asset name breaks Agent self-update, desktop-driven Agent updates and the sudoers rules on every 215 node. Pairing payload types are read by both sides. |
| AnxNet | Packet magic and key labels are wire format between devices; state and key file names hold existing AnxNet identities. |
| Docker labels and wire identifiers | Labels identify containers AnxOS already manages on nodes. Headers are read by mixed-version desktops and Agents. |
| Phone Access | Renaming the cookie or CSRF header logs out every paired phone. The CA subject must match byte for byte when the leaf certificate is reissued, or HTTPS breaks on phones that installed the CA. |
| Signing | Build 215 refuses an update whose Authenticode publisher or issuer differs. |
| Domains and update endpoints | Build 215 clients poll these exact URLs for updates and sign-in; the Supabase function slugs are baked into shipped apps. |

## Identifiers

### Installer and application identity

| ID | Identifier | Value | Defined in |
| --- | --- | --- | --- |
| FI-APP-01 | electron-builder appId (NSIS uninstall GUID and in-place upgrade) | `com.anxos.controlcenter` | `package.json` |
| FI-APP-02 | npm package name (Linux deb package name) | `anxos-control-center` | `package.json` |
| FI-APP-03 | NSIS GUID stays derived from appId (no explicit nsis.guid) | `derived-from-appId` | `package.json` |
| FI-APP-04 | Windows executable name (productName or win.executableName) | `AnxOS Control Center` | `package.json` |
| FI-APP-05 | Linux executable name | `anxos-control-center` | `package.json` |
| FI-APP-06 | Linux desktop file name | `anxos-control-center.desktop` | `package.json` |
| FI-APP-07 | Linux StartupWMClass | `anxos-control-center` | `package.json` |
| FI-APP-08 | Helper task script finds the app by exe name | `Name = 'AnxOS Control Center.exe'` | `windows/install-agent-task.ps1` |
| FI-APP-09 | Agent Control recognises the packaged app exe | `"anxos control center.exe"` | `src/services/agentControlService.js` |

### User data, storage keys and preload globals

| ID | Identifier | Value | Defined in |
| --- | --- | --- | --- |
| FI-DATA-01 | userData folder %APPDATA%\AnxHub | `const APP_DATA_NAME = "AnxHub";` | `src/services/electronPaths.js` |
| FI-DATA-02 | config directory override variable | `process.env.ANXHUB_CONFIG_DIR` | `src/services/agentClient.js` |
| FI-DATA-03 | renderer settings storage key | `const SETTINGS_STORAGE_KEY = "anxos.settings.v1";` | `app.js` |
| FI-DATA-04 | renderer last-page storage key | `const LAST_PAGE_STORAGE_KEY = "anxos.navigation.lastPage.v1";` | `app.js` |
| FI-DATA-05 | Marketplace favorites storage key | `const MARKETPLACE_FAVORITES_KEY = "anxos:marketplace-favorites";` | `app.js` |
| FI-DATA-06 | preload global window.anx | `contextBridge.exposeInMainWorld("anx", desktopApi);` | `preload.js` |
| FI-DATA-07 | preload global window.anxhub | `contextBridge.exposeInMainWorld("anxhub", desktopApi);` | `preload.js` |
| FI-DATA-08 | preload global window.anxos | `contextBridge.exposeInMainWorld("anxos", desktopApi);` | `preload.js` |
| FI-DATA-09 | preload global window.electronAPI | `contextBridge.exposeInMainWorld("electronAPI", desktopApi);` | `preload.js` |
| FI-DATA-10 | preload global window.anxWindow | `contextBridge.exposeInMainWorld("anxWindow", windowApi);` | `preload.js` |

### Windows Helper

| ID | Identifier | Value | Defined in |
| --- | --- | --- | --- |
| FI-HELPER-01 | Helper scheduled task name | `const WINDOWS_AGENT_TASK_NAME = "AnxOSAgent";` | `src/shared/windowsAgentScheduledTask.js` |
| FI-HELPER-02 | legacy Helper task name kept for cleanup | `const WINDOWS_AGENT_LEGACY_TASK_NAMES = ["AnxOS Agent"];` | `src/shared/windowsAgentScheduledTask.js` |
| FI-HELPER-03 | Helper task name in the install script | `$taskName = "AnxOSAgent"` | `windows/install-agent-task.ps1` |
| FI-HELPER-04 | installer detects the existing Helper task | `AnxOSAgent` | `windows/installer.nsh` |

### Linux Agent identity, paths, groups, release assets and pairing

| ID | Identifier | Value | Defined in |
| --- | --- | --- | --- |
| FI-AGENT-01 | Agent Debian package name | `Package: anxos-agent` | `packaging/agent-deb/control.template` |
| FI-AGENT-02 | Agent service user | `User=anxos-agent` | `packaging/agent-deb/anxos-agent.service` |
| FI-AGENT-03 | Agent service group | `Group=anxos-agent` | `packaging/agent-deb/anxos-agent.service` |
| FI-AGENT-04 | Agent runtime path | `/usr/lib/anxos-agent/agent/src/server.js` | `packaging/agent-deb/anxos-agent.service` |
| FI-AGENT-05 | sudoers group for service control | `%anxos-control ALL=(root)` | `packaging/agent-deb/anxos-agent.sudoers` |
| FI-AGENT-06 | sudoers group for package updates | `%anxos-update ALL=(root)` | `packaging/agent-deb/anxos-agent.sudoers` |
| FI-AGENT-07 | update helper path | `const UPDATE_HELPER_PATH = "/usr/lib/anxos-agent/update-helper";` | `src/services/packageAgentUpdateService.js` |
| FI-AGENT-08 | update helper package name | `PACKAGE=anxos-agent` | `packaging/agent-deb/update-helper` |
| FI-AGENT-09 | Agent .deb release asset pattern (Agent self-update) | `const DEB_ASSET_PATTERN = /^AnxOS-Agent-.*\.deb$/;` | `agent/src/services/agentUpdateCheck.js` |
| FI-AGENT-10 | Agent .deb asset name used by the desktop | `return `AnxOS-Agent-${build}.deb`;` | `src/services/packageAgentUpdateService.js` |
| FI-AGENT-11 | Agent state backup includes /etc/anxos-agent | `/etc/anxos-agent` | `src/services/packageAgentUpdateService.js` |
| FI-AGENT-12 | Agent data path /var/lib/anxos-agent | `/var/lib/anxos-agent/config` | `src/services/packageAgentUpdateService.js` |
| FI-AGENT-13 | Agent user config directory ~/.config/anxos-control-center | `".config", "anxos-control-center"` | `agent/src/config.js` |
| FI-AGENT-14 | Agent pairing payload type | `type: "anxos-agent-pairing"` | `src/shared/agentTokenStore.js` |
| FI-AGENT-15 | temporary pairing payload type | `type: "anxos-agent-temporary-pairing"` | `src/shared/agentPairing.js` |

### AnxNet

| ID | Identifier | Value | Defined in |
| --- | --- | --- | --- |
| FI-ANXNET-01 | secure UDP packet magic | `const MAGIC = Buffer.from("ANX1");` | `src/anxnet/secureUdp.js` |
| FI-ANXNET-02 | secure UDP key derivation label | `"anxnet-udp-v1 keys"` | `src/anxnet/secureUdp.js` |
| FI-ANXNET-03 | AnxNet state file | `"anxnet-state.json"` | `src/anxnet/node.js` |
| FI-ANXNET-04 | AnxNet device key file | `"anxnet-device.key"` | `src/anxnet/node.js` |
| FI-ANXNET-05 | AnxNet settings file | `"anxnet-settings.json"` | `src/services/anxnetService.js` |
| FI-ANXNET-06 | AnxNet host socket and pipe names | `anxnet-host-${id}` | `src/anxnet/host.js` |
| FI-ANXNET-07 | AnxNet host token file | `"anxnet-host.token"` | `src/anxnet/host.js` |
| FI-ANXNET-08 | AnxNet Linux DNS link | `const LINUX_LINK = "anxnet0";` | `src/anxnet/dnsIntegration.js` |

### Docker labels and wire identifiers

| ID | Identifier | Value | Defined in |
| --- | --- | --- | --- |
| FI-WIRE-01 | Docker managed label | `labels["anxos.managed"]` | `src/services/dockerServiceUpdateService.js` |
| FI-WIRE-02 | Docker previous-image label | `keptLabels["anxos.previous-image"]` | `src/services/dockerServiceUpdateService.js` |
| FI-WIRE-03 | Docker template and instance labels | `anxos.template` | `src/shared/dockerService.js` |
| FI-WIRE-04 | Docker instance label | `anxos.instance` | `src/shared/dockerService.js` |
| FI-WIRE-05 | workload trust declaration field | `"x-anxos-trust-level"` | `src/shared/workloadTrustPolicy.js` |
| FI-WIRE-06 | correlation header | `const CORRELATION_HEADER = "x-anxos-correlation-id";` | `src/shared/structuredLogger.js` |
| FI-WIRE-07 | CurseForge proxy authentication header | `"X-AnxOS-CurseForge-Authenticated"` | `agent/src/services/curseforgeProxyService.js` |
| FI-WIRE-08 | Agent file download name header | `"X-AnxHub-File-Name"` | `agent/src/routes/files.js` |
| FI-WIRE-09 | desktop reads the file name header | `headers["x-anxhub-file-name"]` | `src/services/agentClient.js` |

### Phone Access (cookie, CSRF, local CA)

| ID | Identifier | Value | Defined in |
| --- | --- | --- | --- |
| FI-PHONE-01 | phone session cookie | `const COOKIE = "__Host-anxos-session";` | `src/mobile/gateway.js` |
| FI-PHONE-02 | phone CSRF header (gateway) | `req.headers["x-anxos-csrf"]` | `src/mobile/gateway.js` |
| FI-PHONE-03 | phone CSRF header (PWA) | `"X-AnxOS-CSRF": state.csrf` | `src/mobile/web/app.js` |
| FI-PHONE-04 | local CA download path | `url.pathname === "/anxos-local-ca.crt"` | `src/mobile/gateway.js` |
| FI-PHONE-05 | local CA subject organisation default (leaf issuer must match) | `const name = (commonName, organization = "AnxOS") =>` | `src/mobile/localCa.js` |
| FI-PHONE-06 | local CA files | `anxos-local-ca` | `src/mobile/localCa.js` |

### Signing

| ID | Identifier | Value | Defined in |
| --- | --- | --- | --- |
| FI-SIGN-01 | pinned installer publisher | `commonName: "Anjo ROSIMO",` | `src/shared/installerSignature.js` |
| FI-SIGN-02 | pinned issuer prefix | `issuerCommonNamePrefix: "Microsoft ID Verified CS",` | `src/shared/installerSignature.js` |
| FI-SIGN-03 | NSIS plugin signing for Smart App Control | `(file must exist)` | `scripts/sign-nsis-toolsets.js` |

### Old domain, services and update endpoints

| ID | Identifier | Value | Defined in |
| --- | --- | --- | --- |
| FI-UPD-01 | official site origin (sign-in host allowlist, update fallback) | `const OFFICIAL_SITE_ORIGIN = "https://anxoscontrolcenter.org";` | `src/shared/officialSite.js` |
| FI-UPD-02 | release website URL | `const RELEASE_WEBSITE_URL = "https://anxoscontrolcenter.org";` | `src/shared/releaseConfig.js` |
| FI-UPD-03 | desktop update repository | `const DEFAULT_UPDATE_REPOSITORY = "AnxLabs/AnxOS-Control-Center-Releases";` | `src/services/updateManager.js` |
| FI-UPD-04 | update manifest URL | `/releases/latest/download/update-manifest.json` | `src/services/updateManager.js` |
| FI-UPD-05 | installer asset preference (NSIS setup first) | `[/setup.*\.exe$/i, /installer.*\.exe$/i, /control-center-setup.*\.exe$/i,` | `src/services/updateManager.js` |
| FI-UPD-06 | Agent release download base | `const DEFAULT_RELEASE_BASE_URL = "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/download";` | `src/services/packageAgentUpdateService.js` |
| FI-UPD-07 | website download worker repository | `AnxLabs/AnxOS-Control-Center-Releases` | `website/_worker.js` |
| FI-UPD-08 | Supabase project and account function | `https://arqfbxstobusuamlizyq.functions.supabase.co/anxos-account` | `website/account-config.js` |
| FI-UPD-09 | Supabase CurseForge proxy function | `https://arqfbxstobusuamlizyq.functions.supabase.co/anxos-marketplace-curseforge` | `website/marketplace-config.js` |
| FI-UPD-10 | Supabase account function source folder | `(file must exist)` | `supabase/functions/anxos-account/index.ts` |
| FI-UPD-11 | Supabase CurseForge function source folder | `(file must exist)` | `supabase/functions/anxos-marketplace-curseforge/index.ts` |

## Not frozen (expected to change in Build 216)

| Item | Where | Plan |
| --- | --- | --- |
| Visible product name, window titles, tray and notifications text | `package.json` `productName` and `build.productName`, `main.js`, `app.js`, `index.html` | 216-B1 (inside wave A1). Changing `productName` also changes the exe name unless `build.win.executableName` keeps `AnxOS Control Center`; FI-APP-04 enforces that. |
| Saved display name `app.displayName` | preferences and `anxos.settings.v1` | Migrated only when it still equals the old default (216-B1). |
| NSIS shortcut and uninstall display names, installer pages and art | `package.json` `build.nsis`, `windows/installer.nsh`, `windows/installer-art/` | 216-D. |
| Phone PWA title, manifest name and service-worker cache | `src/mobile/web/` (`anxos-shell-v2` moves to `anxos-shell-v3`) | 216-C. |
| Windows installer asset file name | `package.json` `build.nsis.artifactName` | Allowed to change only while it still matches `/setup.*\.exe$/i` and stays the only match. |
