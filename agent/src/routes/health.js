const { getDeviceIdentity } = require("../services/deviceIdentityService");

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
      mode: "read-only",
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
  },
};
