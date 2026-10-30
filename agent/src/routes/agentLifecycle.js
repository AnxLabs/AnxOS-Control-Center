// Remote Agent lifecycle: lets Control Center restart this Agent without SSH.
// The Agent can only restart itself when a supervisor will start it again, so
// this is offered only when systemd started this very process: INVOCATION_ID
// is set for every unit, and SYSTEMD_EXEC_PID names the unit's main process.
// Both are inherited by children, so the PID check keeps an Agent launched by
// some other systemd-run process (a CI runner, a desktop session) from
// claiming a supervisor it does not have. The Agent replies first, then shuts down with
// AGENT_SELF_RESTART_EXIT_CODE: a failure code, so both Restart=always and
// Restart=on-failure units bring it back. Without a supervisor the request is
// refused, because "restart" would just stop the Agent.

const AGENT_SELF_RESTART_EXIT_CODE = 75;
const AGENT_SELF_RESTART_DELAY_MS = 500;

function getSelfRestartCapability(env = process.env, platform = process.platform, pid = process.pid) {
  const supervised = platform === "linux"
    && Boolean(String(env.INVOCATION_ID || "").trim())
    && String(env.SYSTEMD_EXEC_PID || "").trim() === String(pid);
  return supervised
    ? { supported: true, mechanism: "systemd" }
    : { supported: false, mechanism: null };
}

function handleAgentRestart(request, options = {}) {
  if (String(request.method || "GET").toUpperCase() !== "POST") {
    return { statusCode: 405, body: { error: { code: "METHOD_NOT_ALLOWED", message: "Request failed." } } };
  }
  const capability = options.capability || getSelfRestartCapability();
  if (!capability.supported) {
    return {
      statusCode: 409,
      body: {
        error: {
          code: "AGENT_SELF_RESTART_UNSUPERVISED",
          message: "This Agent is not running under systemd, so it cannot restart itself. Restart it on the node, or over SSH from Control Center.",
        },
      },
    };
  }
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : AGENT_SELF_RESTART_DELAY_MS;
  options.scheduleRestart?.(delayMs);
  return {
    statusCode: 202,
    body: { restarting: true, mechanism: capability.mechanism, pid: process.pid, delayMs },
  };
}

module.exports = {
  AGENT_SELF_RESTART_DELAY_MS,
  AGENT_SELF_RESTART_EXIT_CODE,
  getSelfRestartCapability,
  handleAgentRestart,
};
