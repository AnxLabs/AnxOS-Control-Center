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
const { buildWindowsFirewallRule } = require("../shared/windowsFirewallRule");

const COMMAND_TIMEOUT_MS = 2200;

// V2-H firewall lifecycle: the desktop previews a rule before it is applied,
// flags rules that touch a management port, and guards access-affecting changes
// with a rollback probe. The Agent port and SSH port are the two well-known
// ways an operator can lose remote access to a node.
const DEFAULT_AGENT_PORT = 47131;
const DEFAULT_SSH_PORT = 22;
const FIREWALL_ROLLBACK_DELAY_MS = 5000;
const MANAGED_FIREWALL_RULE_PREFIX = "AnxOS ";

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

async function createWindowsFirewallRule(payload = {}) {
  if (process.platform !== "win32") {
    const error = new Error("Windows Firewall rule creation is only available on Windows.");
    error.code = "FIREWALL_PLATFORM_UNSUPPORTED";
    throw error;
  }
  return agentClient.createWindowsFirewallRule(payload);
}

function normalizeFirewallPort(value) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function getFirewallPlatform(payload = {}, options = {}) {
  return options.platform || getPlatformForNode(payload.nodeId) || process.platform;
}

// A rule is "access-affecting" when its port is a management port: the AnxOS
// Agent port, the SSH port, or any port the caller reports as currently in use
// by a management service. Applying such a rule requires elevated confirmation
// and arms the rollback guard.
function assessFirewallLockoutRisk(payload = {}, context = {}) {
  const port = normalizeFirewallPort(payload.localPort ?? payload.port);
  const agentPort = normalizeFirewallPort(context.agentPort) ?? DEFAULT_AGENT_PORT;
  const sshPort = normalizeFirewallPort(context.sshPort) ?? DEFAULT_SSH_PORT;
  const reasons = [];
  if (port !== null && port === agentPort) {
    reasons.push({ code: "AGENT_PORT", port, message: `Port ${port} is the AnxOS Agent management port.` });
  }
  if (port !== null && port === sshPort) {
    reasons.push({ code: "SSH_PORT", port, message: `Port ${port} is the SSH management port.` });
  }
  const inUsePorts = new Set(
    [...(Array.isArray(context.managementPorts) ? context.managementPorts : []), ...(Array.isArray(context.inUsePorts) ? context.inUsePorts : [])]
      .map(normalizeFirewallPort)
      .filter((value) => value !== null),
  );
  if (port !== null && inUsePorts.has(port) && !reasons.length) {
    reasons.push({ code: "MANAGEMENT_PORT", port, message: `Port ${port} is currently used by a management service.` });
  }
  return { risky: reasons.length > 0, port, agentPort, sshPort, reasons };
}

function buildManualFirewallRuleDeleteCommand(name) {
  const safeName = String(name || "").replace(/["\r\n]/g, " ").trim().slice(0, 120);
  return `netsh advfirewall firewall delete rule name="${safeName}"`;
}

function buildWindowsFirewallRulePreviewSummary(rule, lockoutRisk) {
  if (!rule) return "No rule could be previewed.";
  const base = `Inbound ${rule.protocol} allow rule on port ${rule.port} named "${rule.name}".`;
  if (!lockoutRisk.risky) return `${base} No management port is affected.`;
  const messages = lockoutRisk.reasons.map((reason) => reason.message).join(" ");
  return `${base} LOCKOUT RISK: ${messages}`;
}

// Desktop-side preview: reports exactly what buildWindowsFirewallRule would
// create, without changing anything. Non-Windows is reported honestly as
// unsupported (no throw) so the UI can explain it.
function buildWindowsFirewallRulePreview(payload = {}, context = {}) {
  const platform = getFirewallPlatform(payload, context);
  const lockoutRisk = assessFirewallLockoutRisk(payload, context);
  if (platform !== "win32") {
    return {
      platform,
      supported: false,
      previewable: false,
      managedRulePrefix: MANAGED_FIREWALL_RULE_PREFIX,
      reason: "Windows Firewall rule preview is only available on Windows.",
      rule: null,
      error: null,
      lockoutRisk,
      summary: "Windows Firewall rule preview is only available on Windows.",
    };
  }
  let rule = null;
  let error = null;
  try {
    const built = buildWindowsFirewallRule({ ...payload, confirmConsent: true });
    rule = {
      name: built.name,
      protocol: built.protocol,
      port: built.port,
      direction: "in",
      action: "allow",
      // The current builder does not scope the rule to a program; reported
      // honestly rather than implying a program restriction that will not exist.
      program: null,
      programScopeSupported: false,
      command: `netsh ${built.args.join(" ")}`,
    };
  } catch (buildError) {
    error = { code: buildError?.code || "INVALID_FIREWALL_RULE", message: buildError?.message || "The firewall rule could not be prepared." };
  }
  return {
    platform,
    supported: true,
    previewable: Boolean(rule),
    managedRulePrefix: MANAGED_FIREWALL_RULE_PREFIX,
    rule,
    error,
    lockoutRisk,
    summary: error ? error.message : buildWindowsFirewallRulePreviewSummary(rule, lockoutRisk),
  };
}

async function runFirewallRollbackGuard({ preview, ruleName, transport, config, options = {} }) {
  if (!preview.lockoutRisk.risky) {
    return { status: "not-needed", reason: "This rule does not affect a management port, so no rollback guard was required." };
  }
  const delayMs = Number.isFinite(options.rollbackDelayMs) ? Math.max(0, options.rollbackDelayMs) : FIREWALL_ROLLBACK_DELAY_MS;
  const wait = typeof options.delay === "function" ? options.delay : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (delayMs > 0) await wait(delayMs);
  const probe = typeof options.reachabilityProbe === "function"
    ? options.reachabilityProbe
    : () => agentClient.isHealthy(config);
  let reachable = false;
  let probeError = null;
  try {
    reachable = Boolean(await probe());
  } catch (error) {
    probeError = error?.message || String(error);
  }
  if (reachable) {
    return { status: "not-needed", reason: "The Agent stayed reachable after the rule was applied." };
  }
  const manualCommand = buildManualFirewallRuleDeleteCommand(ruleName);
  try {
    await transport.deleteWindowsFirewallRule({ name: ruleName }, config);
    return {
      status: "rolled-back",
      reason: probeError ? `The Agent became unreachable (${probeError}); the new rule was removed.` : "The Agent became unreachable; the new rule was removed.",
      manualCommand,
    };
  } catch (error) {
    return {
      status: "rollback-failed",
      reason: `The Agent became unreachable and the rule could not be removed automatically: ${error?.message || error}`,
      errorCode: error?.code || null,
      manualCommand,
    };
  }
}

// Guarded apply: preview first, require elevated confirmation for a rule that
// affects a management port, then arm the rollback guard so a loss of access is
// recoverable (or reported honestly if it is not).
async function applyWindowsFirewallRule(payload = {}, options = {}) {
  const platform = getFirewallPlatform(payload, options);
  if (platform !== "win32") {
    const error = new Error("Windows Firewall rule creation is only available on Windows.");
    error.code = "FIREWALL_PLATFORM_UNSUPPORTED";
    throw error;
  }
  const preview = buildWindowsFirewallRulePreview(payload, { ...options, platform });
  if (!preview.previewable) {
    const error = new Error(preview.error?.message || "The firewall rule could not be prepared.");
    error.code = preview.error?.code || "FIREWALL_PREVIEW_FAILED";
    throw error;
  }
  if (preview.lockoutRisk.risky && payload.confirmElevated !== true) {
    const error = new Error("Applying a firewall rule that affects a management port requires elevated confirmation.");
    error.code = "FIREWALL_ELEVATED_CONFIRM_REQUIRED";
    error.statusCode = 403;
    error.details = { lockoutRisk: preview.lockoutRisk };
    throw error;
  }
  const transport = options.transport || agentClient;
  const config = options.config !== undefined ? options.config : getAgentConfigForPublicAccess(payload.nodeId);
  const createResult = await transport.createWindowsFirewallRule({ ...payload, confirmConsent: true }, config);
  const ruleName = createResult?.rule?.name || preview.rule.name;
  const rollback = await runFirewallRollbackGuard({ preview, ruleName, transport, config, options });
  return {
    ...(createResult && typeof createResult === "object" ? createResult : { ok: true }),
    rule: createResult?.rule || preview.rule,
    lockoutRisk: preview.lockoutRisk,
    rollback,
  };
}

function isFirewallInventoryUnsupportedError(error = {}) {
  const status = error?.status || error?.statusCode || error?.payload?.error?.status || null;
  const code = String(error?.code || error?.payload?.error?.code || "").toUpperCase();
  if (status === 404 || status === 405) return true;
  return /NOT_FOUND|NOT_SUPPORTED|ENDPOINT_NOT_SUPPORTED|METHOD_NOT_ALLOWED|CAPABILITY_MISSING/.test(code);
}

async function listWindowsFirewallRules(payload = {}, options = {}) {
  const nodeId = payload.nodeId || getSelectedNodeId();
  const platform = getFirewallPlatform(payload, options);
  if (platform !== "win32") {
    return {
      ok: true,
      supported: false,
      platform,
      nodeId,
      managedRulePrefix: MANAGED_FIREWALL_RULE_PREFIX,
      rules: [],
      message: "Windows Firewall rules are only available on Windows.",
    };
  }
  const transport = options.transport || agentClient;
  const config = options.config !== undefined ? options.config : getAgentConfigForPublicAccess(nodeId);
  try {
    const result = await transport.listWindowsFirewallRules({ nodeId }, config);
    return { ...result, nodeId, platform };
  } catch (error) {
    // An older Agent without the inventory endpoint is reported honestly as
    // unsupported rather than surfaced as a repeated transport failure.
    if (isFirewallInventoryUnsupportedError(error)) {
      return {
        ok: true,
        supported: false,
        platform,
        nodeId,
        managedRulePrefix: MANAGED_FIREWALL_RULE_PREFIX,
        rules: [],
        message: "This Agent does not support AnxOS firewall rule inventory yet. Update the Agent to manage firewall rules.",
      };
    }
    throw error;
  }
}

async function deleteWindowsFirewallRule(payload = {}, options = {}) {
  const nodeId = payload.nodeId || getSelectedNodeId();
  const name = String(payload.name || payload.id || "").trim();
  if (!name.startsWith(MANAGED_FIREWALL_RULE_PREFIX)) {
    const error = new Error("AnxOS can only delete firewall rules it created.");
    error.code = "FIREWALL_RULE_UNMANAGED";
    throw error;
  }
  const platform = getFirewallPlatform(payload, options);
  if (platform !== "win32") {
    return { ok: true, supported: false, platform, nodeId, deleted: null, message: "Windows Firewall rules are only available on Windows." };
  }
  const transport = options.transport || agentClient;
  const config = options.config !== undefined ? options.config : getAgentConfigForPublicAccess(nodeId);
  const result = await transport.deleteWindowsFirewallRule({ name }, config);
  return { ...result, nodeId, platform };
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
  applyWindowsFirewallRule,
  buildManualFirewallRuleDeleteCommand,
  buildWindowsFirewallRulePreview,
  controlPlayitService,
  deletePublicAccessService,
  deleteWindowsFirewallRule,
  getPlayitLogsForNode,
  getPlayitServiceStatusForNode,
  getPublicAccessSnapshot,
  listPlayitTunnelsForNode,
  listPublicAccessServices,
  listWindowsFirewallRules,
  _test: {
    assessFirewallLockoutRisk,
    buildPlayitProviderState,
    buildServiceFromPlayitSnapshot,
    buildWindowsFirewallRulePreview,
    createProviderState,
    createWindowsFirewallRule,
    deleteWindowsFirewallRule,
    detectCloudflareProvider,
    detectTailscaleProvider,
    listWindowsFirewallRules,
    normalizeSnapshotContext,
    registryOptions,
    redactOutput,
    runCommand,
    runFirewallRollbackGuard,
    summarizePublicAccessReadiness,
  },
};
