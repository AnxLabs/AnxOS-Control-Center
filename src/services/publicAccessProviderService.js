const { execFile } = require("child_process");
const path = require("path");
const { app } = require("electron");
const agentClient = require("./agentClient");
const { getPlayitSnapshot } = require("./serviceRouter");
const {
  getPlayitLogs,
  getPlayitStatus,
  listPlayitTunnels,
  restartPlayit,
  startPlayit,
  stopPlayit,
} = require("./playitService");
const { summarizePublicAccessReadiness } = require("./readinessService");
const { getExecutionTarget, getNode, getSelectedNodeId } = require("./nodeService");
const {
  createAccessService,
  deleteAccessService,
  listAccessServices,
  reconcileAccessServices,
} = require("../shared/publicAccessServiceRegistry");
const {
  PUBLIC_ACCESS_PROVIDERS,
  buildPlayitProviderState,
  buildPublicAccessSnapshot,
  buildServiceFromPlayitSnapshot,
  createProviderState,
  detectCloudflareProvider,
  detectTailscaleProvider,
  redactOutput,
} = require("../shared/publicAccessProviderDetection");

const COMMAND_TIMEOUT_MS = 2200;
const FIREWALL_COMMAND_TIMEOUT_MS = 30000;

function getConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) return process.env.ANXHUB_CONFIG_DIR;
  try { return app ? path.join(app.getPath("userData"), "config") : path.join(process.cwd(), "config"); }
  catch { return path.join(process.cwd(), "config"); }
}

function registryOptions() {
  return { configDir: getConfigDirectory() };
}

function runCommand(command, args = []) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        errorCode: error?.code || error?.name || null,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
      });
    });
  });
}

function validateFirewallRulePayload(payload = {}) {
  const protocol = String(payload.protocol || "tcp").trim().toUpperCase();
  const port = Number.parseInt(payload.localPort || payload.port, 10);
  if (!["TCP", "UDP"].includes(protocol)) {
    const error = new Error("Windows Firewall rules can only be created for TCP or UDP services.");
    error.code = "INVALID_FIREWALL_PROTOCOL";
    throw error;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error("Choose a service port from 1 to 65535 before creating a firewall rule.");
    error.code = "INVALID_FIREWALL_PORT";
    throw error;
  }
  return {
    protocol,
    port,
    name: String(payload.name || `AnxOS ${protocol} ${port}`).trim().replace(/["\r\n]/g, " ").slice(0, 80),
  };
}

function runFirewallCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: FIREWALL_COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(String(stderr || stdout || error.message || "Windows Firewall rule could not be created.").trim());
        failure.code = error.code || "FIREWALL_RULE_FAILED";
        reject(failure);
        return;
      }
      resolve({
        ok: true,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
      });
    });
  });
}

async function createWindowsFirewallRule(payload = {}) {
  if (process.platform !== "win32") {
    const error = new Error("Windows Firewall rule creation is only available on Windows.");
    error.code = "FIREWALL_PLATFORM_UNSUPPORTED";
    throw error;
  }
  if (payload.confirmConsent !== true) {
    const error = new Error("Creating a Windows Firewall rule requires explicit confirmation.");
    error.code = "FIREWALL_CONSENT_REQUIRED";
    throw error;
  }
  const rule = validateFirewallRulePayload(payload);
  const result = await runFirewallCommand("netsh", [
    "advfirewall",
    "firewall",
    "add",
    "rule",
    `name=${rule.name}`,
    "dir=in",
    "action=allow",
    `protocol=${rule.protocol}`,
    `localport=${rule.port}`,
  ]);
  return {
    ok: true,
    rule: {
      name: rule.name,
      protocol: rule.protocol,
      localPort: rule.port,
      direction: "in",
      action: "allow",
      managedBy: "AnxOS",
    },
    diagnostics: {
      command: "netsh advfirewall firewall add rule",
      ok: true,
      hasOutput: Boolean(result.stdout || result.stderr),
    },
  };
}

function getPlatformForNode(nodeId) {
  try {
    const node = getNode(nodeId);
    return node.kind === "agent"
      ? node.agentIdentity?.platform || node.agentIdentity?.operatingSystem || null
      : process.platform;
  } catch {
    return process.platform;
  }
}

function normalizeProviderContext(provider, context = {}) {
  return {
    ...provider,
    nodeId: context.nodeId || provider.nodeId || null,
    providerId: provider.providerId || provider.id || null,
    platform: context.platform || provider.platform || null,
    checkedAt: provider.checkedAt || context.checkedAt || new Date().toISOString(),
  };
}

function normalizeSnapshotContext(snapshot = {}, context = {}) {
  const checkedAt = snapshot.checkedAt || context.checkedAt || new Date().toISOString();
  const discoveredServices = Array.isArray(snapshot.services) ? snapshot.services : [];
  const persistedServices = Array.isArray(snapshot.persistedServices)
    ? reconcileAccessServices(snapshot.persistedServices, { ...snapshot, services: discoveredServices, checkedAt })
    : [];
  const mergedServices = [
    ...discoveredServices,
    ...persistedServices.filter((service) => !discoveredServices.some((entry) => entry.id === service.id)),
  ];
  const normalized = {
    ...snapshot,
    nodeId: context.nodeId || snapshot.nodeId || null,
    platform: context.platform || snapshot.platform || null,
    checkedAt,
    providers: Array.isArray(snapshot.providers)
      ? snapshot.providers.map((provider) => normalizeProviderContext(provider, { ...context, checkedAt }))
      : [],
    services: mergedServices
      .map((service) => ({
          ...service,
          nodeId: context.nodeId || service.nodeId || null,
          lastCheckedAt: service.lastCheckedAt || checkedAt,
        })),
  };
  return {
    ...normalized,
    readiness: summarizePublicAccessReadiness(normalized),
  };
}

function getAgentConfigForPublicAccess(nodeId) {
  const target = getExecutionTarget(nodeId);
  if (target.type !== "agent") {
    return null;
  }
  const node = getNode(target.nodeId);
  if (node?.enabled === false) {
    const error = new Error("Selected node is disabled.");
    error.code = "NODE_DISABLED";
    error.statusCode = 403;
    throw error;
  }
  return {
    ...target.config,
    nodeId: target.nodeId,
    agentNodeId: target.nodeId,
  };
}

async function getLocalPublicAccessSnapshot(options = {}) {
  const nodeId = options.nodeId || getSelectedNodeId();
  const platform = getPlatformForNode(nodeId) || process.platform;
  const snapshot = await buildPublicAccessSnapshot({
    runCommand,
    getPlayitSnapshot: () => getPlayitSnapshot(options),
    nodeId,
    platform,
  });
  snapshot.persistedServices = listAccessServices({ ...registryOptions(), nodeId });
  return normalizeSnapshotContext(snapshot, { nodeId, platform });
}

async function getRemotePublicAccessSnapshot(options = {}) {
  const nodeId = options.nodeId || getSelectedNodeId();
  const platform = getPlatformForNode(nodeId);
  const snapshot = await agentClient.getPublicAccessSnapshot(getAgentConfigForPublicAccess(nodeId));
  return normalizeSnapshotContext(snapshot, { nodeId, platform });
}

async function getPublicAccessSnapshot(options = {}) {
  const nodeId = options.nodeId || getSelectedNodeId();
  const target = getExecutionTarget(nodeId);
  return target.type === "application-host"
    ? getLocalPublicAccessSnapshot({ ...options, nodeId })
    : getRemotePublicAccessSnapshot({ ...options, nodeId });
}

async function createPublicAccessService(payload = {}) {
  const nodeId = payload.nodeId || getSelectedNodeId();
  const target = getExecutionTarget(nodeId);
  if (target.type === "application-host") {
    const service = createAccessService({ ...payload, nodeId }, registryOptions());
    return { success: true, service, services: listAccessServices({ ...registryOptions(), nodeId }) };
  }
  const result = await agentClient.createPublicAccessService({ ...payload, nodeId }, getAgentConfigForPublicAccess(nodeId));
  return normalizeSnapshotContext({
    ...result,
    services: Array.isArray(result?.services) ? result.services : result?.service ? [result.service] : [],
  }, { nodeId, platform: getPlatformForNode(nodeId) });
}

async function listPublicAccessServices(options = {}) {
  const nodeId = options.nodeId || getSelectedNodeId();
  const target = getExecutionTarget(nodeId);
  if (target.type === "application-host") {
    return { nodeId, services: listAccessServices({ ...registryOptions(), nodeId }) };
  }
  const result = await agentClient.listPublicAccessServices({ nodeId }, getAgentConfigForPublicAccess(nodeId));
  return {
    ...result,
    nodeId,
    services: Array.isArray(result?.services) ? result.services.map((service) => ({ ...service, nodeId: service.nodeId || nodeId })) : [],
  };
}

async function deletePublicAccessService(payload = {}) {
  const nodeId = payload.nodeId || getSelectedNodeId();
  const serviceId = payload.serviceId || payload.id;
  const target = getExecutionTarget(nodeId);
  if (target.type === "application-host") {
    return deleteAccessService(serviceId, { ...registryOptions(), nodeId });
  }
  const result = await agentClient.deletePublicAccessService(serviceId, getAgentConfigForPublicAccess(nodeId));
  return {
    ...result,
    nodeId,
    service: result?.service && typeof result.service === "object" ? { ...result.service, nodeId: result.service.nodeId || nodeId } : result?.service,
  };
}

async function getPlayitServiceStatusForNode(options = {}) {
  const nodeId = options.nodeId || getSelectedNodeId();
  const target = getExecutionTarget(nodeId);
  return target.type === "application-host"
    ? getPlayitStatus(options)
    : agentClient.getPublicAccessPlayitStatus(getAgentConfigForPublicAccess(nodeId));
}

async function controlPlayitService(payload = {}) {
  const nodeId = payload.nodeId || getSelectedNodeId();
  const action = String(payload.action || "").trim().toLowerCase();
  const target = getExecutionTarget(nodeId);
  if (target.type !== "application-host") {
    return agentClient.controlPublicAccessPlayit(action, getAgentConfigForPublicAccess(nodeId));
  }
  if (action === "start") return startPlayit();
  if (action === "stop") return stopPlayit();
  if (action === "restart") return restartPlayit();
  const error = new Error("Unsupported Playit action.");
  error.code = "PLAYIT_ACTION_UNSUPPORTED";
  throw error;
}

async function getPlayitLogsForNode(options = {}) {
  const nodeId = options.nodeId || getSelectedNodeId();
  const target = getExecutionTarget(nodeId);
  return target.type === "application-host"
    ? getPlayitLogs(options)
    : agentClient.getPublicAccessPlayitLogs(options, getAgentConfigForPublicAccess(nodeId));
}

async function listPlayitTunnelsForNode(options = {}) {
  const nodeId = options.nodeId || getSelectedNodeId();
  const target = getExecutionTarget(nodeId);
  return target.type === "application-host"
    ? listPlayitTunnels(options)
    : agentClient.getPublicAccessPlayitTunnels(options, getAgentConfigForPublicAccess(nodeId));
}

module.exports = {
  PUBLIC_ACCESS_PROVIDERS,
  PlayitProvider: PUBLIC_ACCESS_PROVIDERS[0],
  CloudflareTunnelProvider: PUBLIC_ACCESS_PROVIDERS[1],
  TailscaleProvider: PUBLIC_ACCESS_PROVIDERS[2],
  AnxOSRelayProvider: PUBLIC_ACCESS_PROVIDERS[3],
  ManualPortForwardingProvider: PUBLIC_ACCESS_PROVIDERS.find((provider) => provider.id === "manual-port-forwarding"),
  createPublicAccessService,
  createWindowsFirewallRule,
  controlPlayitService,
  deletePublicAccessService,
  getPlayitLogsForNode,
  getPlayitServiceStatusForNode,
  getPublicAccessSnapshot,
  listPlayitTunnelsForNode,
  listPublicAccessServices,
  _test: {
    buildPlayitProviderState,
    buildServiceFromPlayitSnapshot,
    createProviderState,
    createWindowsFirewallRule,
    detectCloudflareProvider,
    detectTailscaleProvider,
    normalizeSnapshotContext,
    registryOptions,
    redactOutput,
    runCommand,
    summarizePublicAccessReadiness,
  },
};
