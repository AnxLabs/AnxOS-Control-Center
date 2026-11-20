#!/usr/bin/env node
"use strict";

// Build 216 frozen identifiers (AnxHost CC rebirth, PLANS.md section 6).
//
// The visible product name changes to AnxHost Control Center, but these
// identifiers must not change: Build 215 installs, Agents, paired phones,
// Docker containers and update clients depend on them. Each check reads the
// file that defines the identifier and fails if the exact value is gone.
// docs/anxhost/FROZEN_IDENTIFIERS.md must list every check ID.
//
// Run: node scripts/frozen-identifiers-smoke.js

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const pkg = () => JSON.parse(read("package.json"));

// contains: the file must contain this exact text.
// value: a computed value must equal the expected one.
const CHECKS = [
  // Installer and application identity
  { id: "FI-APP-01", what: "electron-builder appId (NSIS uninstall GUID and in-place upgrade)", file: "package.json", value: () => pkg().build.appId, expect: "com.anxos.controlcenter" },
  { id: "FI-APP-02", what: "npm package name (Linux deb package name)", file: "package.json", value: () => pkg().name, expect: "anxos-control-center" },
  { id: "FI-APP-03", what: "NSIS GUID stays derived from appId (no explicit nsis.guid)", file: "package.json", value: () => String(pkg().build.nsis?.guid ?? "derived-from-appId"), expect: "derived-from-appId" },
  { id: "FI-APP-04", what: "Windows executable name (productName or win.executableName)", file: "package.json", value: () => { const p = pkg(); return p.build.win?.executableName || p.build.productName || p.productName; }, expect: "AnxOS Control Center" },
  { id: "FI-APP-05", what: "Linux executable name", file: "package.json", value: () => pkg().build.linux?.executableName, expect: "anxos-control-center" },
  { id: "FI-APP-06", what: "Linux desktop file name", file: "package.json", value: () => pkg().desktopName, expect: "anxos-control-center.desktop" },
  { id: "FI-APP-07", what: "Linux StartupWMClass", file: "package.json", value: () => pkg().build.linux?.desktop?.entry?.StartupWMClass, expect: "anxos-control-center" },
  { id: "FI-APP-08", what: "Helper task script finds the app by exe name", file: "windows/install-agent-task.ps1", contains: "Name = 'AnxOS Control Center.exe'" },
  { id: "FI-APP-09", what: "Agent Control recognises the packaged app exe", file: "src/services/agentControlService.js", contains: "\"anxos control center.exe\"" },
  // User data and storage
  { id: "FI-DATA-01", what: "userData folder %APPDATA%\\AnxHub", file: "src/services/electronPaths.js", contains: "const APP_DATA_NAME = \"AnxHub\";" },
  { id: "FI-DATA-02", what: "config directory override variable", file: "src/services/agentClient.js", contains: "process.env.ANXHUB_CONFIG_DIR" },
  { id: "FI-DATA-03", what: "renderer settings storage key", file: "app.js", contains: "const SETTINGS_STORAGE_KEY = \"anxos.settings.v1\";" },
  { id: "FI-DATA-04", what: "renderer last-page storage key", file: "app.js", contains: "const LAST_PAGE_STORAGE_KEY = \"anxos.navigation.lastPage.v1\";" },
  { id: "FI-DATA-05", what: "Marketplace favorites storage key", file: "app.js", contains: "const MARKETPLACE_FAVORITES_KEY = \"anxos:marketplace-favorites\";" },
  { id: "FI-DATA-06", what: "preload global window.anx", file: "preload.js", contains: "contextBridge.exposeInMainWorld(\"anx\", desktopApi);" },
  { id: "FI-DATA-07", what: "preload global window.anxhub", file: "preload.js", contains: "contextBridge.exposeInMainWorld(\"anxhub\", desktopApi);" },
  { id: "FI-DATA-08", what: "preload global window.anxos", file: "preload.js", contains: "contextBridge.exposeInMainWorld(\"anxos\", desktopApi);" },
  { id: "FI-DATA-09", what: "preload global window.electronAPI", file: "preload.js", contains: "contextBridge.exposeInMainWorld(\"electronAPI\", desktopApi);" },
  { id: "FI-DATA-10", what: "preload global window.anxWindow", file: "preload.js", contains: "contextBridge.exposeInMainWorld(\"anxWindow\", windowApi);" },
  // Windows Helper
  { id: "FI-HELPER-01", what: "Helper scheduled task name", file: "src/shared/windowsAgentScheduledTask.js", contains: "const WINDOWS_AGENT_TASK_NAME = \"AnxOSAgent\";" },
  { id: "FI-HELPER-02", what: "legacy Helper task name kept for cleanup", file: "src/shared/windowsAgentScheduledTask.js", contains: "const WINDOWS_AGENT_LEGACY_TASK_NAMES = [\"AnxOS Agent\"];" },
  { id: "FI-HELPER-03", what: "Helper task name in the install script", file: "windows/install-agent-task.ps1", contains: "$taskName = \"AnxOSAgent\"" },
  { id: "FI-HELPER-04", what: "installer detects the existing Helper task", file: "windows/installer.nsh", contains: "AnxOSAgent" },
  // Linux Agent identity
  { id: "FI-AGENT-01", what: "Agent Debian package name", file: "packaging/agent-deb/control.template", contains: "Package: anxos-agent" },
  { id: "FI-AGENT-02", what: "Agent service user", file: "packaging/agent-deb/anxos-agent.service", contains: "User=anxos-agent" },
  { id: "FI-AGENT-03", what: "Agent service group", file: "packaging/agent-deb/anxos-agent.service", contains: "Group=anxos-agent" },
  { id: "FI-AGENT-04", what: "Agent runtime path", file: "packaging/agent-deb/anxos-agent.service", contains: "/usr/lib/anxos-agent/agent/src/server.js" },
  { id: "FI-AGENT-05", what: "sudoers group for service control", file: "packaging/agent-deb/anxos-agent.sudoers", contains: "%anxos-control ALL=(root)" },
  { id: "FI-AGENT-06", what: "sudoers group for package updates", file: "packaging/agent-deb/anxos-agent.sudoers", contains: "%anxos-update ALL=(root)" },
  { id: "FI-AGENT-07", what: "update helper path", file: "src/services/packageAgentUpdateService.js", contains: "const UPDATE_HELPER_PATH = \"/usr/lib/anxos-agent/update-helper\";" },
  { id: "FI-AGENT-08", what: "update helper package name", file: "packaging/agent-deb/update-helper", contains: "PACKAGE=anxos-agent" },
  { id: "FI-AGENT-09", what: "Agent .deb release asset pattern (Agent self-update)", file: "agent/src/services/agentUpdateCheck.js", contains: "const DEB_ASSET_PATTERN = /^AnxOS-Agent-.*\\.deb$/;" },
  { id: "FI-AGENT-10", what: "Agent .deb asset name used by the desktop", file: "src/services/packageAgentUpdateService.js", contains: "return `AnxOS-Agent-${build}.deb`;" },
  { id: "FI-AGENT-11", what: "Agent state backup includes /etc/anxos-agent", file: "src/services/packageAgentUpdateService.js", contains: "/etc/anxos-agent" },
  { id: "FI-AGENT-12", what: "Agent data path /var/lib/anxos-agent", file: "src/services/packageAgentUpdateService.js", contains: "/var/lib/anxos-agent/config" },
  { id: "FI-AGENT-13", what: "Agent user config directory ~/.config/anxos-control-center", file: "agent/src/config.js", contains: "\".config\", \"anxos-control-center\"" },
  { id: "FI-AGENT-14", what: "Agent pairing payload type", file: "src/shared/agentTokenStore.js", contains: "type: \"anxos-agent-pairing\"" },
  { id: "FI-AGENT-15", what: "temporary pairing payload type", file: "src/shared/agentPairing.js", contains: "type: \"anxos-agent-temporary-pairing\"" },
  // AnxNet
  { id: "FI-ANXNET-01", what: "secure UDP packet magic", file: "src/anxnet/secureUdp.js", contains: "const MAGIC = Buffer.from(\"ANX1\");" },
  { id: "FI-ANXNET-02", what: "secure UDP key derivation label", file: "src/anxnet/secureUdp.js", contains: "\"anxnet-udp-v1 keys\"" },
  { id: "FI-ANXNET-03", what: "AnxNet state file", file: "src/anxnet/node.js", contains: "\"anxnet-state.json\"" },
  { id: "FI-ANXNET-04", what: "AnxNet device key file", file: "src/anxnet/node.js", contains: "\"anxnet-device.key\"" },
  { id: "FI-ANXNET-05", what: "AnxNet settings file", file: "src/services/anxnetService.js", contains: "\"anxnet-settings.json\"" },
  { id: "FI-ANXNET-06", what: "AnxNet host socket and pipe names", file: "src/anxnet/host.js", contains: "anxnet-host-${id}" },
  { id: "FI-ANXNET-07", what: "AnxNet host token file", file: "src/anxnet/host.js", contains: "\"anxnet-host.token\"" },
  { id: "FI-ANXNET-08", what: "AnxNet Linux DNS link", file: "src/anxnet/dnsIntegration.js", contains: "const LINUX_LINK = \"anxnet0\";" },
  // Docker labels and wire identifiers
  { id: "FI-WIRE-01", what: "Docker managed label", file: "src/services/dockerServiceUpdateService.js", contains: "labels[\"anxos.managed\"]" },
  { id: "FI-WIRE-02", what: "Docker previous-image label", file: "src/services/dockerServiceUpdateService.js", contains: "keptLabels[\"anxos.previous-image\"]" },
  { id: "FI-WIRE-03", what: "Docker template and instance labels", file: "src/shared/dockerService.js", contains: "anxos.template" },
  { id: "FI-WIRE-04", what: "Docker instance label", file: "src/shared/dockerService.js", contains: "anxos.instance" },
  { id: "FI-WIRE-05", what: "workload trust declaration field", file: "src/shared/workloadTrustPolicy.js", contains: "\"x-anxos-trust-level\"" },
  { id: "FI-WIRE-06", what: "correlation header", file: "src/shared/structuredLogger.js", contains: "const CORRELATION_HEADER = \"x-anxos-correlation-id\";" },
  { id: "FI-WIRE-07", what: "CurseForge proxy authentication header", file: "agent/src/services/curseforgeProxyService.js", contains: "\"X-AnxOS-CurseForge-Authenticated\"" },
  { id: "FI-WIRE-08", what: "Agent file download name header", file: "agent/src/routes/files.js", contains: "\"X-AnxHub-File-Name\"" },
  { id: "FI-WIRE-09", what: "desktop reads the file name header", file: "src/services/agentClient.js", contains: "headers[\"x-anxhub-file-name\"]" },
  // Phone Access
  { id: "FI-PHONE-01", what: "phone session cookie", file: "src/mobile/gateway.js", contains: "const COOKIE = \"__Host-anxos-session\";" },
  { id: "FI-PHONE-02", what: "phone CSRF header (gateway)", file: "src/mobile/gateway.js", contains: "req.headers[\"x-anxos-csrf\"]" },
  { id: "FI-PHONE-03", what: "phone CSRF header (PWA)", file: "src/mobile/web/app.js", contains: "\"X-AnxOS-CSRF\": state.csrf" },
  { id: "FI-PHONE-04", what: "local CA download path", file: "src/mobile/gateway.js", contains: "url.pathname === \"/anxos-local-ca.crt\"" },
  { id: "FI-PHONE-05", what: "local CA subject organisation default (leaf issuer must match)", file: "src/mobile/localCa.js", contains: "const name = (commonName, organization = \"AnxOS\") =>" },
  { id: "FI-PHONE-06", what: "local CA files", file: "src/mobile/localCa.js", contains: "anxos-local-ca" },
  // Signing
  { id: "FI-SIGN-01", what: "pinned installer publisher", file: "src/shared/installerSignature.js", contains: "commonName: \"Anjo ROSIMO\"," },
  { id: "FI-SIGN-02", what: "pinned issuer prefix", file: "src/shared/installerSignature.js", contains: "issuerCommonNamePrefix: \"Microsoft ID Verified CS\"," },
  { id: "FI-SIGN-03", what: "NSIS plugin signing for Smart App Control", file: "scripts/sign-nsis-toolsets.js", contains: "" },
  // Domains, services and update endpoints
  { id: "FI-UPD-01", what: "official site origin (sign-in host allowlist, update fallback)", file: "src/shared/officialSite.js", contains: "const OFFICIAL_SITE_ORIGIN = \"https://anxoscontrolcenter.org\";" },
  { id: "FI-UPD-02", what: "release website URL", file: "src/shared/releaseConfig.js", contains: "const RELEASE_WEBSITE_URL = \"https://anxoscontrolcenter.org\";" },
  { id: "FI-UPD-03", what: "desktop update repository", file: "src/services/updateManager.js", contains: "const DEFAULT_UPDATE_REPOSITORY = \"AnxLabs/AnxOS-Control-Center-Releases\";" },
  { id: "FI-UPD-04", what: "update manifest URL", file: "src/services/updateManager.js", contains: "/releases/latest/download/update-manifest.json" },
  { id: "FI-UPD-05", what: "installer asset preference (NSIS setup first)", file: "src/services/updateManager.js", contains: "[/setup.*\\.exe$/i, /installer.*\\.exe$/i, /control-center-setup.*\\.exe$/i," },
  { id: "FI-UPD-06", what: "Agent release download base", file: "src/services/packageAgentUpdateService.js", contains: "const DEFAULT_RELEASE_BASE_URL = \"https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/download\";" },
  { id: "FI-UPD-07", what: "website download worker repository", file: "website/_worker.js", contains: "AnxLabs/AnxOS-Control-Center-Releases" },
  { id: "FI-UPD-08", what: "Supabase project and account function", file: "website/account-config.js", contains: "https://arqfbxstobusuamlizyq.functions.supabase.co/anxos-account" },
  { id: "FI-UPD-09", what: "Supabase CurseForge proxy function", file: "website/marketplace-config.js", contains: "https://arqfbxstobusuamlizyq.functions.supabase.co/anxos-marketplace-curseforge" },
  { id: "FI-UPD-10", what: "Supabase account function source folder", file: "supabase/functions/anxos-account/index.ts", contains: "" },
  { id: "FI-UPD-11", what: "Supabase CurseForge function source folder", file: "supabase/functions/anxos-marketplace-curseforge/index.ts", contains: "" },
];

function main() {
  const failures = [];
  for (const check of CHECKS) {
    const file = path.join(root, check.file);
    if (!fs.existsSync(file)) { failures.push(`${check.id} ${check.what}: ${check.file} is missing`); continue; }
    if (check.value) {
      let actual;
      try { actual = check.value(); } catch (error) { actual = `error: ${error.message}`; }
      if (actual !== check.expect) failures.push(`${check.id} ${check.what}: expected "${check.expect}", found "${actual}" (${check.file})`);
    } else if (check.contains && !read(check.file).includes(check.contains)) {
      failures.push(`${check.id} ${check.what}: "${check.contains}" no longer in ${check.file}`);
    }
  }
  const doc = path.join(root, "docs", "anxhost", "FROZEN_IDENTIFIERS.md");
  const docText = fs.existsSync(doc) ? fs.readFileSync(doc, "utf8") : "";
  const undocumented = CHECKS.filter((check) => !docText.includes(check.id)).map((check) => check.id);
  if (undocumented.length) failures.push(`docs/anxhost/FROZEN_IDENTIFIERS.md does not list: ${undocumented.join(", ")}`);
  const ids = new Set();
  for (const check of CHECKS) { if (ids.has(check.id)) failures.push(`duplicate check id ${check.id}`); ids.add(check.id); }

  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.error(`${failures.length} frozen identifier check(s) failed. These identifiers keep Build 215 installs, Agents, phones and update clients working; see docs/anxhost/FROZEN_IDENTIFIERS.md.`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS frozen identifiers: ${CHECKS.length} checks`);
}

if (require.main === module) main();
module.exports = { CHECKS };
