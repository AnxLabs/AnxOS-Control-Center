const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const servicePath = path.join(root, "src", "services", "publicAccessProviderService.js");
const sharedDetectionPath = path.join(root, "src", "shared", "publicAccessProviderDetection.js");
const agentRoutePath = path.join(root, "agent", "src", "routes", "publicAccess.js");
const agentPlayitRoutePath = path.join(root, "agent", "src", "routes", "playit.js");
const agentPlayitServicePath = path.join(root, "agent", "src", "services", "playitService.js");
const agentServerPath = path.join(root, "agent", "src", "server.js");
const appPath = path.join(root, "app.js");
const indexPath = path.join(root, "index.html");
const preloadPath = path.join(root, "preload.js");
const ipcPath = path.join(root, "src", "ipc", "publicAccessIpc.js");

const publicAccess = require("../src/services/publicAccessProviderService");
const agentPlayitService = require("../agent/src/services/playitService");
const detection = require("../src/shared/publicAccessProviderDetection");
const registry = require("../src/shared/publicAccessServiceRegistry");
const serviceSource = fs.readFileSync(servicePath, "utf8");
const sharedDetectionSource = fs.readFileSync(sharedDetectionPath, "utf8");
const agentRouteSource = fs.readFileSync(agentRoutePath, "utf8");
const agentPlayitRouteSource = fs.readFileSync(agentPlayitRoutePath, "utf8");
const agentPlayitServiceSource = fs.readFileSync(agentPlayitServicePath, "utf8");
const agentServerSource = fs.readFileSync(agentServerPath, "utf8");
const appSource = fs.readFileSync(appPath, "utf8");
const indexSource = fs.readFileSync(indexPath, "utf8");
const preloadSource = fs.readFileSync(preloadPath, "utf8");
const ipcSource = fs.readFileSync(ipcPath, "utf8");

const providers = publicAccess.PUBLIC_ACCESS_PROVIDERS;
const byId = new Map(providers.map((provider) => [provider.id, provider]));

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert(start >= 0, `Missing function ${name}.`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not parse function ${name}.`);
}

assert(byId.has("playit") && byId.has("tailscale") && byId.has("cloudflare-tunnel") && byId.has("manual-port-forwarding") && byId.has("anxos-relay"), "Public Access must declare all evaluated providers.");
assert.strictEqual(byId.get("playit").status, "supported", "Playit must remain the supported provider.");
assert.strictEqual(byId.get("playit").capabilities.createService, true, "Playit must support AnxOS access service record creation.");
assert.strictEqual(byId.get("playit").capabilities.createProviderResource, false, "Playit must not claim provider tunnel creation unless the integration supports it.");
assert.strictEqual(byId.get("playit").capabilities.tcp, true, "Playit must advertise TCP support.");
assert.strictEqual(byId.get("playit").capabilities.udp, true, "Playit must advertise UDP support.");
assert.strictEqual(byId.get("tailscale").exposureScope, "tailnet-only", "Tailscale must not be described as public internet exposure.");
assert.strictEqual(byId.get("tailscale").capabilities.serviceExposure, true, "Tailscale must support private tailnet service records.");
assert.strictEqual(byId.get("tailscale").capabilities.publicAddress, false, "Tailscale must not be treated as a public address provider.");
assert.strictEqual(byId.get("cloudflare-tunnel").capabilities.createTunnel, false, "Cloudflare Tunnel must not claim tunnel creation until real lifecycle support is implemented.");
assert.strictEqual(byId.get("cloudflare-tunnel").capabilities.createProviderResource, false, "Cloudflare Tunnel must not claim provider-resource creation for metadata-only records.");
assert.strictEqual(byId.get("cloudflare-tunnel").capabilities.serviceExposure, true, "Cloudflare must support HTTP/HTTPS service records.");
assert.strictEqual(byId.get("cloudflare-tunnel").capabilities.httpServices, true, "Cloudflare must be limited to HTTP/HTTPS services.");
assert.strictEqual(byId.get("manual-port-forwarding").capabilities.routerConfiguration, true, "Manual Port Forwarding must explain router configuration.");
assert.strictEqual(byId.get("manual-port-forwarding").capabilities.firewallRules, true, "Manual Port Forwarding must expose firewall-rule requirements.");
assert.strictEqual(byId.get("anxos-relay").status, "disabled", "AnxOS Relay must stay disabled without a real backend.");

const playitService = publicAccess._test.buildServiceFromPlayitSnapshot({
  connected: true,
  tunnelAddress: "example.playit.gg",
  localPort: "25565",
});
assert.strictEqual(playitService.status, "Public");
assert.strictEqual(playitService.exposureScope, "public-internet");

const playitProvider = publicAccess._test.buildPlayitProviderState({
  installed: true,
  running: true,
  connected: true,
  tunnelAddress: "example.playit.gg",
});
assert.strictEqual(playitProvider.health, "healthy");
assert.strictEqual(playitProvider.publicAddress, "example.playit.gg");

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-public-access-registry-"));
  const service = registry.createAccessService({
    nodeId: "anxlab",
    providerId: "playit",
    providerName: "Playit.gg",
    name: "Palworld",
    localHost: "127.0.0.1",
    localPort: "8211",
    protocol: "udp",
    linkedInstanceId: "palworld",
  }, { configDir: tempRoot });
  assert.strictEqual(service.nodeId, "anxlab", "Access service must preserve selected node.");
  assert.strictEqual(service.providerId, "playit", "Access service must preserve provider id.");
  assert.strictEqual(service.localPort, 8211, "Access service port must normalize to a number.");
  assert.strictEqual(service.protocol, "udp", "Access service protocol must normalize.");
  assert.strictEqual(service.state, "pending-provider-setup", "Playit service records must not fake provider tunnel creation.");
  assert.strictEqual(service.status, "Pending Playit tunnel setup", "Playit service records must explain that provider setup is still pending.");
  assert.strictEqual(service.providerResourceStatus, "not-created-by-anxos", "Playit records must mark provider resources as not created by AnxOS.");
  assert.strictEqual(registry.listAccessServices({ configDir: tempRoot, nodeId: "anxlab" }).length, 1, "Access service must persist.");
  assert.throws(() => registry.createAccessService({
    nodeId: "anxlab",
    providerId: "playit",
    localHost: "127.0.0.1",
    localPort: 8211,
    protocol: "udp",
  }, { configDir: tempRoot }), /already exists/, "Duplicate access services must be rejected.");
  const reconciled = registry.reconcileAccessServices([service], {
    checkedAt: "2026-01-01T00:00:00.000Z",
    services: [{
      providerId: "playit",
      localPort: 8211,
      protocol: "udp",
      publicAddress: "palworld.playit.fan",
      tunnelId: "tun-1",
      status: "Public",
    }],
  });
  assert.strictEqual(reconciled[0].publicAddress, "palworld.playit.fan", "Access service reconciliation must adopt matching Playit public address.");
  assert.strictEqual(reconciled[0].state, "running", "Access service reconciliation must mark matched public Playit service running.");
  assert.strictEqual(reconciled[0].providerResourceStatus, "detected", "Playit reconciliation must distinguish detected provider resources from AnxOS-created records.");
  registry.deleteAccessService(service.id, { configDir: tempRoot });
  assert.strictEqual(registry.listAccessServices({ configDir: tempRoot }).length, 0, "Access service delete must persist.");
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-tailscale-access-registry-"));
  const service = registry.createAccessService({
    nodeId: "anxlab",
    providerId: "tailscale",
    providerName: "Tailscale",
    accessType: "private-tailnet",
    name: "Terraria private",
    localHost: "127.0.0.1",
    localPort: 7777,
    protocol: "tcp",
  }, { configDir: tempRoot });
  const reconciled = registry.reconcileAccessServices([service], {
    checkedAt: "2026-01-01T00:00:00.000Z",
    providers: [{
      id: "tailscale",
      name: "Tailscale",
      connected: true,
      lifecycleState: "running",
      DNSName: "anxlab.tailnet.ts.net.",
      IPv4: "100.64.0.10",
    }],
    services: [],
  });
  assert.strictEqual(reconciled[0].accessType, "private-tailnet", "Tailscale service must stay private-tailnet.");
  assert.strictEqual(reconciled[0].exposureScope, "tailnet-only", "Tailscale service must use tailnet-only exposure.");
  assert.strictEqual(reconciled[0].privateAddress, "anxlab.tailnet.ts.net:7777", "Tailscale service should prefer MagicDNS private endpoint.");
  assert.strictEqual(reconciled[0].addressPreference, "magicdns", "Tailscale service should persist a MagicDNS endpoint preference.");
  assert.deepStrictEqual(reconciled[0].endpointOptions.map((option) => option.type), ["magicdns", "ipv4"], "Tailscale service should expose concrete private endpoint choices.");
  assert.strictEqual(reconciled[0].publicAddress, null, "Tailscale service must not invent a public address.");
  const ipv4Preferred = registry._test.selectTailscaleEndpoint({ ...reconciled[0], privateAddress: null, addressPreference: "ipv4" }, {});
  assert.strictEqual(ipv4Preferred.address, "100.64.0.10:7777", "Tailscale IPv4 preference should produce a private IPv4 endpoint.");
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-public-access-recovery-"));
  const filePath = registry.registryPath({ configDir: tempRoot });
  fs.writeFileSync(filePath, `${JSON.stringify({ services: [] })}\n`, { mode: 0o600 });
  assert.deepStrictEqual(registry.listAccessServices({ configDir: tempRoot }), [], "legacy Public Access state should migrate without changing records.");
  assert.strictEqual(JSON.parse(fs.readFileSync(filePath, "utf8")).schemaVersion, registry.SCHEMA_VERSION, "legacy Public Access state should be rewritten with the current schema.");
  assert(fs.existsSync(`${filePath}.schema-v0.backup`), "legacy Public Access migration should preserve the original state once.");

  const futureState = { schemaVersion: registry.SCHEMA_VERSION + 1, services: [{ id: "future-service" }] };
  fs.writeFileSync(filePath, `${JSON.stringify(futureState)}\n`, { mode: 0o600 });
  const futureRaw = fs.readFileSync(filePath, "utf8");
  assert.throws(
    () => registry.listAccessServices({ configDir: tempRoot }),
    (error) => error?.code === "PUBLIC_ACCESS_SCHEMA_UNSUPPORTED" && error?.details?.schemaVersion === futureState.schemaVersion,
    "future Public Access schemas must fail without being downgraded.",
  );
  assert.strictEqual(fs.readFileSync(filePath, "utf8"), futureRaw, "future Public Access state must remain unchanged.");

  fs.writeFileSync(filePath, "{not-json\n", { mode: 0o600 });
  assert.throws(
    () => registry.listAccessServices({ configDir: tempRoot }),
    (error) => error?.code === "PUBLIC_ACCESS_REGISTRY_CORRUPT",
    "corrupt Public Access state must not silently clear service records.",
  );
  assert(fs.readdirSync(tempRoot).some((name) => name.startsWith(`${registry.DEFAULT_FILE_NAME}.corrupt-`)), "corrupt Public Access state should be preserved.");
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-instance-access-registry-"));
  const palworldPublic = registry.createAccessService({
    nodeId: "anxlab",
    providerId: "playit",
    providerName: "Playit.gg",
    accessType: "public-internet",
    name: "Palworld public",
    linkedInstanceId: "palworld",
    localHost: "127.0.0.1",
    localPort: 8211,
    protocol: "udp",
  }, { configDir: tempRoot });
  const palworldPrivate = registry.createAccessService({
    nodeId: "anxlab",
    providerId: "tailscale",
    providerName: "Tailscale",
    accessType: "private-tailnet",
    name: "Palworld private",
    linkedInstanceId: "palworld",
    localHost: "127.0.0.1",
    localPort: 8211,
    protocol: "udp",
  }, { configDir: tempRoot });
  assert.strictEqual(registry.listAccessServices({ configDir: tempRoot, nodeId: "anxlab" }).length, 2, "Instances must support multiple access providers for one service port.");
  assert.strictEqual(palworldPublic.linkedInstanceId, "palworld", "Public access service must persist linked instance id.");
  assert.strictEqual(palworldPrivate.accessType, "private-tailnet", "Private access service must persist private tailnet type.");
  registry.deleteAccessService(palworldPublic.id, { configDir: tempRoot });
  registry.deleteAccessService(palworldPrivate.id, { configDir: tempRoot });
  assert.strictEqual(registry.listAccessServices({ configDir: tempRoot }).length, 0, "Instance access cleanup must be able to delete linked services.");
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-cloudflare-access-registry-"));
  const service = registry.createAccessService({
    nodeId: "anxlab",
    providerId: "cloudflare-tunnel",
    providerName: "Cloudflare Tunnel",
    accessType: "public-internet",
    name: "Panel",
    localHost: "127.0.0.1",
    localPort: 8080,
    protocol: "http",
    publicHostname: "panel.example.com",
    localServiceUrl: "http://127.0.0.1:8080",
  }, { configDir: tempRoot });
  assert.strictEqual(service.publicAddress, "panel.example.com", "Cloudflare service must persist the public hostname.");
  assert.strictEqual(service.protocol, "http", "Cloudflare service must keep HTTP protocol.");
  assert.strictEqual(service.localServiceUrl, "http://127.0.0.1:8080", "Cloudflare service must persist a normalized HTTP local service URL.");
  assert.strictEqual(service.ingressStatus, "pending-config", "Cloudflare service must distinguish saved metadata from configured ingress.");
  assert.throws(() => registry.createAccessService({
    nodeId: "anxlab",
    providerId: "cloudflare-tunnel",
    providerName: "Cloudflare Tunnel",
    accessType: "public-internet",
    name: "Duplicate Panel",
    localHost: "127.0.0.1",
    localPort: 8081,
    protocol: "http",
    publicHostname: "panel.example.com",
    localServiceUrl: "http://127.0.0.1:8081",
  }, { configDir: tempRoot }), /ingress route already exists/, "Cloudflare must reject duplicate hostname/path ingress records.");
  assert.throws(() => registry.createAccessService({
    nodeId: "anxlab",
    providerId: "cloudflare-tunnel",
    localHost: "127.0.0.1",
    localPort: 8211,
    protocol: "udp",
    publicHostname: "palworld.example.com",
  }, { configDir: tempRoot }), /HTTP and HTTPS/, "Cloudflare must reject raw UDP game services.");
  assert.throws(() => registry.createAccessService({
    nodeId: "anxlab",
    providerId: "cloudflare-tunnel",
    localHost: "127.0.0.1",
    localPort: 8081,
    protocol: "http",
    publicHostname: "not a hostname",
  }, { configDir: tempRoot }), /valid DNS hostname/, "Cloudflare must reject invalid hostnames.");
  assert.throws(() => registry.createAccessService({
    nodeId: "anxlab",
    providerId: "cloudflare-tunnel",
    localHost: "127.0.0.1",
    localPort: 8082,
    protocol: "http",
    publicHostname: "bad-url.example.com",
    localServiceUrl: "tcp://127.0.0.1:8082",
  }, { configDir: tempRoot }), /HTTP or HTTPS/, "Cloudflare must reject non-HTTP local service URLs.");
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const readiness = publicAccess._test.summarizePublicAccessReadiness({
  providers: [
    publicAccess._test.createProviderState(publicAccess.TailscaleProvider, {
      available: true,
      installed: true,
      connected: true,
      health: "healthy",
      tailnetAddress: "100.64.0.1",
    }),
  ],
  services: [],
  activeTunnels: 0,
  exposureScope: "tailnet-only",
});
assert.strictEqual(readiness.state, "degraded", "Tailnet-only connectivity should be degraded for public access validation.");
assert.strictEqual(readiness.context.providerCapabilities[0].publicInternet, false, "Tailscale tailnet-only capability must not be reported as public internet.");

async function assertDetectionCases() {
  const tailscaleRunCommand = async (command, args = []) => {
    const signature = `${command} ${args.join(" ")}`;
    if (signature === "sh -lc command -v tailscale") return { ok: true, stdout: "/usr/bin/tailscale", stderr: "" };
    if (signature === "sh -lc command -v tailscaled") return { ok: true, stdout: "/usr/sbin/tailscaled", stderr: "" };
    if (signature === "tailscale version") return { ok: true, stdout: "1.70.0\n  go version: go1.22", stderr: "" };
    if (signature === "tailscale status --json") return {
      ok: true,
      stdout: JSON.stringify({
        BackendState: "Running",
        Self: {
          HostName: "anxlab",
          DNSName: "anxlab.tailnet.ts.net.",
          TailscaleIPs: ["100.64.0.10", "fd7a:115c:a1e0::10"],
          Online: true,
        },
        CurrentTailnet: { Name: "tailnet.ts.net", MagicDNSSuffix: "tailnet.ts.net" },
      }),
      stderr: "",
    };
    if (signature === "tailscale ip -4") return { ok: true, stdout: "100.64.0.10", stderr: "" };
    if (signature === "tailscale ip -6") return { ok: true, stdout: "fd7a:115c:a1e0::10", stderr: "" };
    if (signature === "systemctl is-active tailscaled") return { ok: true, stdout: "active", stderr: "" };
    if (signature === "systemctl is-enabled tailscaled") return { ok: true, stdout: "enabled", stderr: "" };
    if (signature === "tailscale serve status --json") return { ok: true, stdout: "{}", stderr: "" };
    if (signature === "tailscale funnel status --json") return { ok: false, errorCode: 1, stdout: "", stderr: "not enabled" };
    return { ok: false, errorCode: "ENOENT", stdout: "", stderr: "" };
  };
  const tailscale = await detection.detectTailscaleProvider({ runCommand: tailscaleRunCommand, nodeId: "anxlab", platform: "linux" });
  assert.strictEqual(tailscale.nodeId, "anxlab", "Tailscale detection must preserve selected node id.");
  assert.strictEqual(tailscale.providerId, "tailscale", "Provider result must expose a stable providerId.");
  assert.strictEqual(tailscale.displayState, "Installed and connected", "Connected Tailscale must not be shown as Not Installed.");
  assert.strictEqual(tailscale.IPv4, "100.64.0.10", "Tailscale IPv4 address should be captured.");
  assert.strictEqual(tailscale.DNSName, "anxlab.tailnet.ts.net.", "Tailscale MagicDNS name should be captured.");
  assert.strictEqual(tailscale.capabilities.serviceExposure, true, "Connected Tailscale must expose private service capability.");

  const tailscaleLoginRequired = await detection.detectTailscaleProvider({
    nodeId: "anxlab",
    platform: "linux",
    runCommand: async (command, args = []) => {
      const signature = `${command} ${args.join(" ")}`;
      if (signature === "sh -lc command -v tailscale") return { ok: true, stdout: "/usr/bin/tailscale", stderr: "" };
      if (signature === "sh -lc command -v tailscaled") return { ok: true, stdout: "/usr/sbin/tailscaled", stderr: "" };
      if (signature === "tailscale status --json") return { ok: true, stdout: JSON.stringify({ BackendState: "NeedsLogin" }), stderr: "" };
      return { ok: false, errorCode: 1, stdout: "", stderr: "" };
    },
  });
  assert.strictEqual(tailscaleLoginRequired.lifecycleState, "auth-required", "Tailscale login-required state should be explicit.");

  const cloudflareRunCommand = async (command, args = []) => {
    const signature = `${command} ${args.join(" ")}`;
    if (signature === "sh -lc command -v cloudflared") return { ok: true, stdout: "/usr/bin/cloudflared", stderr: "" };
    if (signature === "cloudflared --version") return { ok: true, stdout: "cloudflared version 2026.7.0", stderr: "" };
    if (signature === "cloudflared tunnel list --output json") return { ok: true, stdout: "[]", stderr: "" };
    if (signature === "pgrep -af cloudflared") return { ok: false, errorCode: 1, stdout: "", stderr: "" };
    if (signature === "systemctl is-active cloudflared") return { ok: false, errorCode: 3, stdout: "inactive", stderr: "" };
    if (signature.includes("cert.pem")) return { ok: false, errorCode: 1, stdout: "", stderr: "" };
    if (signature.includes("config.yml")) return { ok: false, errorCode: 1, stdout: "", stderr: "" };
    return { ok: false, errorCode: 1, stdout: "", stderr: "" };
  };
  const cloudflare = await detection.detectCloudflareProvider({ runCommand: cloudflareRunCommand, nodeId: "anxlab", platform: "linux" });
  assert.strictEqual(cloudflare.displayState, "Authentication Required", "cloudflared with no auth should not be shown as Not Installed.");

  const cloudflareConfigured = await detection.detectCloudflareProvider({
    nodeId: "anxlab",
    platform: "linux",
    runCommand: async (command, args = []) => {
      const signature = `${command} ${args.join(" ")}`;
      if (signature === "sh -lc command -v cloudflared") return { ok: true, stdout: "/usr/bin/cloudflared", stderr: "" };
      if (signature === "cloudflared --version") return { ok: true, stdout: "cloudflared version 2026.7.0", stderr: "" };
      if (signature === "cloudflared tunnel list --output json") return { ok: true, stdout: JSON.stringify([{ id: "tunnel-1", name: "anxlab" }]), stderr: "" };
      if (signature === "pgrep -af cloudflared") return { ok: true, stdout: "123 /usr/bin/cloudflared tunnel run anxlab", stderr: "" };
      if (signature === "systemctl is-active cloudflared") return { ok: true, stdout: "active", stderr: "" };
      if (signature.includes("config.yml")) return { ok: true, stdout: "/etc/cloudflared/config.yml", stderr: "" };
      if (signature.includes("cert.pem")) return { ok: true, stdout: "present", stderr: "" };
      return { ok: false, errorCode: 1, stdout: "", stderr: "" };
    },
  });
  assert.strictEqual(cloudflareConfigured.displayState, "Running", "Configured active cloudflared should report Running.");
  assert.strictEqual(cloudflareConfigured.tunnelCount, 1, "Cloudflare tunnel count should be captured.");

  const windowsSnapshot = await detection.buildPublicAccessSnapshot({
    nodeId: "this-pc",
    platform: "win32",
    getPlayitSnapshot: async () => ({ installed: true, running: false, connected: false }),
    runCommand: async (command, args = []) => {
      const signature = `${command} ${args.join(" ")}`;
      if (signature === "where.exe cloudflared") return { ok: false, errorCode: 1, stdout: "", stderr: "" };
      if (signature === "where.exe tailscale") return { ok: false, errorCode: 1, stdout: "", stderr: "" };
      if (signature === "where.exe tailscaled") return { ok: false, errorCode: 1, stdout: "", stderr: "" };
      return { ok: false, errorCode: 1, stdout: "", stderr: "" };
    },
  });
  const manualWindows = windowsSnapshot.providers.find((provider) => provider.id === "manual-port-forwarding");
  const tailscaleWindows = windowsSnapshot.providers.find((provider) => provider.id === "tailscale");
  assert.strictEqual(manualWindows.providerStatus, "Configuration Required", "Manual Port Forwarding should be configuration-required.");
  assert.strictEqual(manualWindows.firewall.required, true, "Manual Port Forwarding on Windows should require firewall review.");
  assert.strictEqual(manualWindows.firewall.routerPortForwardRequired, true, "Manual Port Forwarding should require router configuration.");
  assert.strictEqual(tailscaleWindows.firewall.managedRulesSupported, true, "Tailscale on Windows should expose managed firewall rule support.");

  const normalized = publicAccess._test.normalizeSnapshotContext({
    providers: [publicAccess._test.createProviderState(publicAccess.TailscaleProvider, { nodeId: "old-node", platform: "win32" })],
    services: [{ id: "stale", nodeId: "old-node" }],
  }, { nodeId: "anxlab", platform: "linux", checkedAt: "2026-07-13T00:00:00.000Z" });
  assert.strictEqual(normalized.providers[0].nodeId, "anxlab", "Snapshot context should prevent stale node data from leaking into provider rows.");
  assert.strictEqual(normalized.services[0].nodeId, "anxlab", "Service context should be tied to the active node.");
}

assert(sharedDetectionSource.includes('execFile(command, args') === false, "Shared detection should receive a command runner instead of executing directly.");
assert(serviceSource.includes('execFile(command, args'), "Desktop provider detection must use execFile with argument arrays.");
assert(sharedDetectionSource.includes('runCommand("tailscale", ["status", "--json"])'), "Tailscale foundation must inspect real CLI status.");
assert(sharedDetectionSource.includes('runCommand("cloudflared", ["--version"])'), "Cloudflare foundation must inspect real cloudflared availability.");
assert(sharedDetectionSource.includes("redactOutput"), "Provider diagnostics must redact token-like output.");
assert(serviceSource.includes("summarizePublicAccessReadiness"), "Public Access snapshots must include readiness summaries.");
assert(serviceSource.includes("agentClient.getPublicAccessSnapshot") && agentRouteSource.includes("/api/v1/public-access/snapshot") && agentServerSource.includes("handlePublicAccess"), "Remote Public Access detection must route through the selected Agent.");
assert(serviceSource.includes("createPublicAccessService") && serviceSource.includes("deletePublicAccessService"), "Desktop Public Access service lifecycle must route through the selected backend.");
assert(agentRouteSource.includes("/api/v1/public-access/services") && agentServerSource.includes("pathname.startsWith(\"/api/v1/public-access/services/\")"), "Agent must register Public Access service lifecycle routes.");
assert(agentServerSource.includes("/api/v1/public-access/playit/") && agentPlayitRouteSource.includes("handlePublicAccessPlayit"), "Agent must register narrow Playit management routes under Public Access.");
[
  "PLAYIT_NOT_INSTALLED",
  "PLAYIT_SERVICE_NOT_FOUND",
  "PLAYIT_START_FAILED",
  "PLAYIT_STOP_FAILED",
  "PLAYIT_RESTART_FAILED",
  "PLAYIT_LOGS_UNAVAILABLE",
  "PLAYIT_NOT_RUNNING",
].forEach((needle) => assert(agentPlayitServiceSource.includes(needle) || ipcSource.includes(needle), `Playit management should expose ${needle}.`));
[
  "getPlayitServiceStatusForNode",
  "controlPlayitService",
  "getPlayitLogsForNode",
  "listPlayitTunnelsForNode",
  "agentClient.getPublicAccessPlayitStatus",
  "agentClient.controlPublicAccessPlayit",
  "agentClient.getPublicAccessPlayitLogs",
  "agentClient.getPublicAccessPlayitTunnels",
].forEach((needle) => assert(serviceSource.includes(needle), `Selected-node Public Access routing should include ${needle}.`));
assert(!agentPlayitRouteSource.includes("body.command") && !agentPlayitRouteSource.includes("payload.command"), "Playit management must not expose a generic command runner.");
assert(appSource.includes("function renderPublicAccessProviders") && appSource.includes("Tailnet-only"), "Renderer must show provider capability and exposure scope honestly.");
assert(appSource.includes("create-firewall-rule") && appSource.includes("Create Firewall Rule"), "Renderer must expose consent-gated Windows Firewall rule creation.");
assert(appSource.includes("buildTailscalePrivateAddress") && appSource.includes("private-tailnet"), "Renderer must create Tailscale services as private tailnet records.");
assert(appSource.includes("chooseTailscaleEndpoint") && appSource.includes("getTailscaleEndpointOptions(provider, port)"), "Renderer must derive real Tailscale endpoint types when available.");
assert(appSource.includes("Private tailnet") && appSource.includes("service.privateAddress"), "Renderer must display Tailscale private reachability and endpoint.");
assert(appSource.includes("Create Web Service") && appSource.includes("cloudflare-tunnel") && appSource.includes("Public hostname"), "Renderer must expose Cloudflare web-service setup without raw game-port compatibility.");
assert(indexSource.includes('data-instance-action="expose-share"') && indexSource.includes('data-instance-action="copy-access-address"') && indexSource.includes('data-instance-action="manage-access"'), "Instances must expose provider sharing, copy, and manage actions.");
[
  "function getInstanceAccessSuggestions",
  "function createAccessServiceForInstance",
  "function copyInstanceAccessAddress",
  "function deleteAccessServicesForInstance",
  "linkedInstanceId: instance.id",
  "Public via Playit",
  "Private via Tailscale",
  "Web via Cloudflare",
  "Cloudflare Tunnel supports HTTP and HTTPS services, not Palworld UDP ports.",
  "Cloudflare Tunnel supports HTTP and HTTPS services, not Terraria TCP game ports.",
  "Cloudflare Tunnel supports HTTP and HTTPS services, not Minecraft TCP game ports.",
  "runInstanceAction(\"expose-share\")",
  "runInstanceAction(\"copy-access-address\")",
  "runInstanceAction(\"manage-access\")",
  "linked access service",
  "summarizeAccessCleanupResult",
].forEach((needle) => assert(appSource.includes(needle), `Instances Public Access integration should include ${needle}.`));
assert(appSource.includes("renderPublicAccessProviderMetricFields(provider, {})"), "Provider switching must clear stale provider details immediately.");
assert(appSource.includes('provider?.id === "playit"') && appSource.includes("provider?.tailnetAddress"), "Provider copy actions must not reuse Playit addresses for other providers.");
assert(indexSource.includes("data-public-access-providers"), "Public Access workspace must expose a provider list surface.");
assert(indexSource.includes("Expose services through public tunnel providers or securely share them across your private Tailscale network."), "Public Access page copy must distinguish public providers from private tailnet sharing.");
assert(indexSource.includes('data-public-access-service-card="playit-primary"') && indexSource.includes('role="button"') && indexSource.includes("data-public-access-service-actions"), "Public Access service cards must be clickable and render live actions.");
assert(indexSource.includes("data-public-access-provider-detail-pill") && indexSource.includes("data-public-access-provider-actions") && indexSource.includes("data-public-access-provider-unsupported"), "Provider Details must expose dynamic actions and unsupported reasons.");
assert(indexSource.includes("data-playit-service-actions") && indexSource.includes("data-playit-tunnel-list") && indexSource.includes("data-playit-logs-panel"), "Public Access page must include compact Playit service controls, tunnels, and logs surfaces.");
[
  "publicAccessConnectionHealth",
  "publicAccessReachability",
  "publicAccessProviderCapabilities",
  "playitLastSuccessfulRefresh",
  "playitLatency",
].forEach((needle) => assert(indexSource.includes(needle) || appSource.includes(needle), `Public Access details should display ${needle}.`));
[
  "function renderPublicAccessProviderDetails",
  "function getPublicAccessActionDefinitions",
  "function renderPublicAccessActionButtons",
  "function runPublicAccessAction",
  "function createPublicAccessServiceModal",
  "function submitProviderAccessService",
  "publicAccessCreateSubmit",
  "field-error",
  "Create Service",
  "createAccessServiceForInstance(instance, \"playit\")",
  "providerResourceStatus: provider.id === \"cloudflare-tunnel\" ? \"not-created-by-anxos\"",
  "This provider does not expose start controls through AnxOS.",
  "create-access-service",
  "api.publicAccess.createService",
  "install-dependency",
  "dependencyIds: [provider.dependencyId]",
  "api.dependencies.check",
  "Tailscale installed successfully. Sign in to Tailscale",
  "cloudflared installed successfully. Authenticate Cloudflare",
  "copy-public-address",
  "copy-local-endpoint",
  "tunnel-config",
  "provider-diagnostics",
  "open-logs",
  "playit-start",
  "playit-stop",
  "playit-restart",
  "playit-refresh-tunnels",
  "playit-logs",
  "renderPlayitTunnels",
  "renderPlayitServiceStatus",
  "copyPublicAccessValue(tunnel?.publicAddress",
  "entry.reason || \"Unsupported by this provider.\"",
  "article.addEventListener(\"click\"",
  "selectedPublicAccessProviderId",
  "selectedPublicAccessServiceId",
].forEach((needle) => assert(appSource.includes(needle), `Public Access UX should include ${needle}.`));
const createProviderBody = functionBody(appSource, "createProviderAccessService");
assert(!/window\.prompt|prompt\(/.test(createProviderBody), "Create Access Service workflow must not use browser prompt().");
assert(createProviderBody.includes("createPublicAccessServiceModal"), "Create Access Service workflow must open the in-app modal.");
assert(appSource.includes("function validatePublicAccessCreateForm") && appSource.includes("Port must be a whole number from 1 to 65535."), "Create Access Service modal must validate port range.");
[
  "chooseTailscaleEndpoint",
  "chooseInstanceAccessSuggestion",
  "createAccessServiceForInstance",
  "copyInstanceAccessAddress",
  "runPublicAccessAction",
].forEach((functionName) => {
  const body = functionBody(appSource, functionName);
  assert(!/window\.prompt|prompt\(|window\.alert|alert\(|window\.confirm|confirm\(/.test(body), `${functionName} must not use browser dialogs in Public Access workflows.`);
});
assert(!indexSource.includes('data-public-access-action="disable" disabled') && !indexSource.includes('data-public-access-action="restart" disabled'), "Public Access must not render dead disabled action buttons.");
assert(preloadSource.includes("publicAccess:getSnapshot") && ipcSource.includes("getPublicAccessSnapshot"), "Public Access IPC bridge must remain wired.");
assert(preloadSource.includes("publicAccess:createService") && ipcSource.includes("publicAccess:createService"), "Public Access service creation IPC bridge must remain wired.");
assert(preloadSource.includes("publicAccess:deleteService") && ipcSource.includes("publicAccess:deleteService"), "Public Access service deletion IPC bridge must remain wired.");
assert(preloadSource.includes("publicAccess:createFirewallRule") && ipcSource.includes("createWindowsFirewallRule"), "Public Access firewall rule IPC bridge must remain wired.");
assert(preloadSource.includes("publicAccess:getPlayitStatus") && ipcSource.includes("getPlayitServiceStatusForNode"), "Playit service status IPC bridge must be wired.");
assert(preloadSource.includes("publicAccess:controlPlayit") && ipcSource.includes("controlPlayitService"), "Playit service control IPC bridge must be wired.");
assert(preloadSource.includes("publicAccess:listPlayitTunnels") && ipcSource.includes("listPlayitTunnelsForNode"), "Playit tunnel listing IPC bridge must be wired.");
assert(preloadSource.includes("publicAccess:getPlayitLogs") && ipcSource.includes("getPlayitLogsForNode"), "Playit logs IPC bridge must be wired.");

{
  const tunnels = agentPlayitService._test.parseTunnelObjectsFromContent(JSON.stringify({
    tunnels: [
      { id: "tun-1", name: "Minecraft", display_address: "mc.example.playit.gg:25565", destination: "127.0.0.1:25565", protocol: "tcp" },
      { tunnel_id: "tun-2", display_address: "voice.example.playit.gg:24454", destination: "127.0.0.1:24454", port_type: "udp" },
    ],
  })).map((entry, index) => agentPlayitService._test.normalizeTunnel(entry, "fixture", index));
  assert.strictEqual(tunnels.length, 2, "Playit tunnel parser should handle multiple tunnels without a real service.");
  assert.strictEqual(tunnels[0].localPort, 25565, "Playit tunnels should expose local ports.");
  assert.strictEqual(tunnels[0].publicAddress, "mc.example.playit.gg:25565", "Playit tunnels should expose public endpoints for copy actions.");
  assert.strictEqual(tunnels[1].protocol, "UDP", "Playit tunnels should normalize protocol metadata.");
}

assertDetectionCases().then(() => {
  console.log("Public Access smoke checks passed.");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
