const { SshService } = require("./sshService");
const { APPLICATION_HOST_NODE_ID } = require("./applicationHostService");
const diagnostics = require("./diagnosticsService");

// Start / Stop / Restart for a remote node's Agent. Two mechanisms:
// - SSH (preferred, all three actions): the node's assigned SSH profile with
//   key auth and an approved host key, like the remote Agent update. A user
//   systemd unit (desktop-installed Agents) is driven with `systemctl --user`;
//   the packaged system unit with `sudo -n systemctl`, which needs a NOPASSWD
//   rule for these commands (the .deb ships one for the anxos-control group).
// - Agent API (restart only, no SSH): POST /api/v1/agent/restart, offered by
//   Agents that run under systemd and advertise capabilities.selfRestart.
// Each action is confirmed afterwards: the Agent answers health again after
// Start/Restart, and stops answering after Stop.
const LINUX_AGENT_UNIT_NAME = "anxos-agent";
const REMOTE_AGENT_ACTIONS = new Set(["start", "stop", "restart"]);
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const DEFAULT_VERIFY_ATTEMPTS = 15;
const DEFAULT_VERIFY_DELAY_MS = 2000;

let defaultSshService = null;
function getDefaultSshService() {
  if (!defaultSshService) defaultSshService = new SshService();
  return defaultSshService;
}

function fail(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

// LoadState is "loaded" only for a unit that exists; probing both scopes in
// one round trip tells a desktop-installed user unit from the packaged one.
function buildScopeProbeCommand(unitName = LINUX_AGENT_UNIT_NAME) {
  return [
    'echo "--- user ---"',
    `systemctl --user show ${unitName} -p LoadState --value 2>/dev/null || true`,
    'echo "--- system ---"',
    `systemctl show ${unitName} -p LoadState --value 2>/dev/null || true`,
  ].join("\n");
}

function parseScopeProbe(output = "") {
  const text = String(output || "");
  const section = (name) => {
    const match = text.match(new RegExp(`--- ${name} ---\\s*\\n([^\\n]*)`));
    return String(match?.[1] || "").trim();
  };
  if (section("user") === "loaded") return "user";
  if (section("system") === "loaded") return "system";
  return null;
}

function buildActionCommand(scope, action, unitName = LINUX_AGENT_UNIT_NAME) {
  if (!REMOTE_AGENT_ACTIONS.has(action)) throw fail("REMOTE_AGENT_ACTION_INVALID", "Choose Start, Stop or Restart.");
  return scope === "user"
    ? `systemctl --user ${action} ${unitName}`
    : `sudo -n systemctl ${action} ${unitName}`;
}

function isSudoPasswordFailure(result = {}) {
  return /a password is required|sudo: a terminal is required|not allowed to execute|may not run sudo/i.test(`${result.stderr || ""}\n${result.stdout || ""}`);
}

function readNodeHealthSnapshot(health = {}) {
  return {
    connected: health?.connected === true || health?.ok === true || health?.state === "online",
    selfRestart: health?.capabilities?.selfRestart?.supported === true
      || health?.connection?.capabilities?.selfRestart?.supported === true
      || health?.capabilitiesMetadata?.selfRestart?.supported === true,
  };
}

function createRemoteAgentLifecycleService(deps = {}) {
  const getSsh = () => deps.sshService || getDefaultSshService();
  const resolveNode = deps.resolveNode || ((nodeId) => require("./nodeService").getNode(nodeId));
  const run = deps.runner || ((profileId, command, options) => getSsh().runCommand(profileId, command, options));
  const getProfile = deps.getProfile || ((nodeId) => getSsh().getProfileForNode(nodeId));
  const probeHealth = deps.healthProbe || (async (nodeId) => {
    const { checkNodeHealth, getNode } = require("./nodeService");
    const health = await checkNodeHealth(nodeId, { timeoutMs: 4000 }).catch(() => null);
    const node = (() => { try { return getNode(nodeId); } catch { return null; } })();
    return readNodeHealthSnapshot({ ...(node || {}), ...(health || {}), connected: health?.state === "online" || health?.connected === true });
  });
  const requestSelfRestart = deps.requestSelfRestart || (async (nodeId) => {
    const { getNodeAgentConfig } = require("./nodeService");
    return require("./agentClient").requestAgentSelfRestart(getNodeAgentConfig(nodeId));
  });
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const verifyAttempts = Number.isFinite(deps.verifyAttempts) ? deps.verifyAttempts : DEFAULT_VERIFY_ATTEMPTS;
  const verifyDelayMs = Number.isFinite(deps.verifyDelayMs) ? deps.verifyDelayMs : DEFAULT_VERIFY_DELAY_MS;

  function requireRemoteNode(nodeId) {
    if (!nodeId || nodeId === APPLICATION_HOST_NODE_ID) {
      throw fail("REMOTE_AGENT_LIFECYCLE_LOCAL_TARGET", "This PC's Agent is controlled from Agent Control's local lifecycle.");
    }
    const node = resolveNode(nodeId);
    if (!node || node.kind !== "agent") throw fail("NODE_NOT_FOUND", "The node does not exist.", { nodeId });
    return node;
  }

  function getUsableSshProfile(nodeId) {
    const profile = getProfile(nodeId);
    return profile && profile.authType === "privateKey" ? profile : null;
  }

  async function waitFor(nodeId, wantConnected) {
    for (let attempt = 0; attempt < verifyAttempts; attempt += 1) {
      if (attempt > 0) await sleep(verifyDelayMs);
      const health = await probeHealth(nodeId).catch(() => ({ connected: false }));
      if (health.connected === wantConnected) return true;
    }
    return false;
  }

  async function controlOverSsh(node, profile, action) {
    const probe = await run(profile.id, buildScopeProbeCommand(), { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS });
    const scope = parseScopeProbe(probe?.stdout);
    if (!scope) {
      throw fail("REMOTE_AGENT_UNIT_NOT_FOUND", "No anxos-agent systemd unit was found on the node.", { nodeId: node.id });
    }
    const result = await run(profile.id, buildActionCommand(scope, action), { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS });
    if (result?.code !== 0) {
      if (scope === "system" && isSudoPasswordFailure(result)) {
        throw fail(
          "REMOTE_AGENT_SUDO_REQUIRED",
          `The Agent runs as a system service and ${profile.username || "this SSH user"} cannot control it without a password. Add the user to the anxos-control group (the Agent package allows that group to start, stop and restart anxos-agent).`,
          { nodeId: node.id, scope },
        );
      }
      throw fail("REMOTE_AGENT_ACTION_FAILED", `systemctl ${action} anxos-agent failed on the node.`, { nodeId: node.id, scope, exitCode: result?.code ?? null });
    }
    return scope;
  }

  async function control(nodeId, action, options = {}) {
    if (!REMOTE_AGENT_ACTIONS.has(action)) throw fail("REMOTE_AGENT_ACTION_INVALID", "Choose Start, Stop or Restart.");
    const node = requireRemoteNode(nodeId);
    const profile = getUsableSshProfile(node.id);
    let mechanism;
    let scope = null;
    if (profile) {
      mechanism = "ssh";
      scope = await controlOverSsh(node, profile, action);
    } else if (action === "restart") {
      const health = await probeHealth(node.id).catch(() => ({ connected: false, selfRestart: false }));
      if (!health.connected || !health.selfRestart) {
        throw fail(
          "REMOTE_AGENT_LIFECYCLE_UNAVAILABLE",
          health.connected
            ? "This node's Agent cannot restart itself (update the Agent), and no SSH key profile is assigned."
            : "The Agent is not answering and no SSH key profile is assigned, so it cannot be restarted from here.",
          { nodeId: node.id },
        );
      }
      mechanism = "agent-api";
      await requestSelfRestart(node.id);
      // Give the Agent time to reply, stop and exit before checking it is back.
      await sleep(options.selfRestartSettleMs ?? 3000);
    } else {
      throw fail("REMOTE_AGENT_SSH_PROFILE_MISSING", "Assign an SSH key profile to this node to start or stop its Agent.", { nodeId: node.id });
    }
    const verified = await waitFor(node.id, action !== "stop");
    diagnostics.log?.(verified ? "info" : "warn", "remote-agent-lifecycle", action, `Remote Agent ${action} ${verified ? "confirmed" : "not confirmed"}.`, {
      nodeId: node.id,
      mechanism,
      scope,
    });
    if (!verified) {
      throw fail(
        "REMOTE_AGENT_ACTION_UNCONFIRMED",
        action === "stop"
          ? "The stop command ran, but the Agent is still answering."
          : "The command ran, but the Agent did not come back. Check the node's logs (journalctl -u anxos-agent).",
        { nodeId: node.id, mechanism, scope },
      );
    }
    return { nodeId: node.id, action, mechanism, scope, confirmed: true };
  }

  return { control };
}

let defaultService = null;
function getRemoteAgentLifecycleService() {
  if (!defaultService) defaultService = createRemoteAgentLifecycleService();
  return defaultService;
}

module.exports = {
  createRemoteAgentLifecycleService,
  getRemoteAgentLifecycleService,
  _test: { buildActionCommand, buildScopeProbeCommand, isSudoPasswordFailure, parseScopeProbe, readNodeHealthSnapshot },
};
