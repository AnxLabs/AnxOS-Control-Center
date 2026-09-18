const fs = require("fs");
const { getDeviceIdentity } = require("../services/deviceIdentityService");
const { getConfiguredApiPermissions } = require("../permissions");

// Tokens that let a credential mutate state. API permissions are fail-closed
// by default for standalone/remote agents (no implicit "*"); the desktop's
// local single-node Owner profile still configures the wildcard, so unless an
// operator explicitly narrows it, a local agent is read-write and must not
// claim to be read-only.
const WRITE_CAPABLE_PERMISSIONS = new Set([
  "docker:write",
  "files:write",
  "console:write",
  "instance:write",
  "instance:lifecycle",
  "instance:delete",
  "backups:write",
  "backups:restore",
  "dependencies:write",
  "public-access:write",
  "agent:manage",
]);

function isWriteEnabled(permissions) {
  if (permissions.size === 0) {
    return false;
  }
  if (permissions.has("*")) {
    return true;
  }
  for (const permission of permissions) {
    if (permission === "*" || permission === "*:*") {
      return true;
    }
    if (WRITE_CAPABLE_PERMISSIONS.has(permission)) {
      return true;
    }
    // A "<category>:*" wildcard grants every mutation in that category.
    if (/^[a-zA-Z0-9_-]+:\*$/.test(permission)) {
      return true;
    }
  }
  return false;
}

// The reported mode must reflect the actually configured API permissions rather
// than a hard-coded claim. With the default "*" permission set (or any explicit
// write-capable token) the agent is read-write; it is read-only only when every
// configured permission is genuinely non-mutating.
function computeHealthMode(permissions) {
  if (permissions.size === 0) {
    return "no-access";
  }
  return isWriteEnabled(permissions) ? "read-write" : "read-only";
}

// V2-G wave 5: honest agent self-update capability reporting. The mechanism
// names what the product actually implements today: on Windows the update is
// driven through the scheduled-task lifecycle (stop, re-register the startup
// task against the bundled runtime, restart), and on Linux through the
// systemd user unit plus a post-exit swap driven from Agent Control.
// Platforms without one of those mechanisms (or a Linux host where systemd is
// not the init system) must not claim support.
function detectLinuxSystemd() {
  try {
    return fs.existsSync("/run/systemd/system");
  } catch {
    return false;
  }
}

function getAgentUpdateCapability(platform = process.platform, systemdPresent = detectLinuxSystemd()) {
  if (platform === "win32") {
    return { supported: true, mechanism: "windows-scheduled-task" };
  }
  if (platform === "linux") {
    return systemdPresent
      ? { supported: true, mechanism: "linux-systemd" }
      : { supported: false, mechanism: null };
  }
  return { supported: false, mechanism: null };
}

function buildAgentCapabilities(identity = {}) {
  const platform = identity.platform || process.platform;
  const windows = platform === "win32";

  return {
    os: windows ? "windows" : platform === "linux" ? "linux" : platform || "unknown",
    supportsSystemMetrics: true,
    supportsDocker: null,
    supportsSsh: false,
    supportsGameServers: windows ? false : true,
    supportsServiceControl: false,
    supportsFileRoots: true,
    supportsPublicAccess: true,
    supportsPlayit: true,
    agentUpdate: getAgentUpdateCapability(platform),
    unsupportedActions: {
      ...(windows
        ? {
            ssh: "SSH is not enabled for Windows Agent MVP nodes unless a profile is configured separately.",
            gameServers: "Windows game-server hosting is planned for a later build.",
            serviceControl: "Windows Agent service control is not exposed through remote node health in this build.",
          }
        : {}),
    },
  };
}

async function handleHealth(config = {}) {
  const identity = getDeviceIdentity();
  return {
    statusCode: 200,
    body: {
      ok: true,
      service: "anxos-agent",
      identity,
      mode: computeHealthMode(getConfiguredApiPermissions()),
      capabilities: buildAgentCapabilities(identity),
      tokenConfigured: Boolean(config.token),
      tokenFingerprint: config.tokenStatus?.fingerprint || null,
      configPath: config.tokenStatus?.configPath || null,
      apiVersion: "v1",
      protocolVersion: 1,
      process: {
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        memoryBytes: process.memoryUsage().rss,
        cpuSeconds: (process.cpuUsage().user + process.cpuUsage().system) / 1_000_000,
        connectedClients: Number(config.connectedClients || 0),
      },
      time: new Date().toISOString(),
    },
  };
}

module.exports = {
  handleHealth,
  _test: {
    buildAgentCapabilities,
    computeHealthMode,
    detectLinuxSystemd,
    getAgentUpdateCapability,
    isWriteEnabled,
  },
};
