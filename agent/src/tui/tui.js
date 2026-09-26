"use strict";

// Interactive TUI for the headless Agent. It renders the pure views from
// ./render and drives the same runtime modules the CLI subcommands use, so the
// TUI is a presentation layer — never a second agent implementation.
//
// Automation seam (documented in --help): when ANXOS_TUI_KEYS is set, the TUI
// processes each key in order, renders after each key into stdout, and exits 0.
// No TTY or raw mode is required in that mode, which makes the screen text
// assertable from scripts.

const { renderScreen, sanitizeText } = require("./render");
const { createAgentCliClient } = require("../services/agentCliClient");
const { createServiceManager, detectPrimaryNonInternalIpv4 } = require("../services/agentServiceManager");
const { checkForUpdate, getCurrentVersion } = require("../services/agentUpdateCheck");
const { readAgentLogTail } = require("../services/agentLogService");
const { createPairingFlow } = require("./pairing-flow");

const REFRESH_INTERVAL_MS = 5000;
const CLIENT_TIMEOUT_MS = 5000;
const LOG_TAIL_LINES = 200;
const ACTIONS = ["pair", "refresh", "restart", "logs", "update", "help", "quit"];

function parseKeys(chunk) {
  const text = String(chunk || "");
  const keys = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "\u001b") {
      keys.push(text[index]);
      index += 1;
      continue;
    }
    const match = text.slice(index).match(/^\u001b\[[0-9;]*[A-Za-z~]/);
    if (match) {
      keys.push(match[0]);
      index += match[0].length;
    } else {
      keys.push("\u001b");
      index += 1;
    }
  }
  return keys;
}

function createTuiState(env) {
  return {
    view: "status",
    width: 80,
    height: 24,
    unicode: env.ANXOS_TUI_ASCII !== "1",
    selectedAction: 0,
    message: null,
    confirm: null,
    connection: null,
    effectiveBaseUrl: null,
    health: null,
    healthError: null,
    enrollment: null,
    pairingStatus: null,
    service: null,
    system: null,
    systemError: null,
    logs: null,
    update: null,
    pairing: null,
    networkCandidate: null,
    cliVersion: getCurrentVersion(),
    nowMs: Date.now(),
    quit: false,
  };
}

async function runTui(options = {}) {
  const env = options.env || process.env;
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const automationKeys = typeof env.ANXOS_TUI_KEYS === "string" ? env.ANXOS_TUI_KEYS : "";
  const automation = automationKeys.length > 0;
  const interactive = !automation && Boolean(input.isTTY && output.isTTY);

  const client = options.client || createAgentCliClient({ env, timeoutMs: CLIENT_TIMEOUT_MS });
  const serviceManager = options.serviceManager || createServiceManager({ env });
  const state = createTuiState(env);
  // Test seam: callers may override initial state fields (the TUI smoke injects
  // a malformed value to prove a render failure cannot kill the TUI).
  if (options.state && typeof options.state === "object") Object.assign(state, options.state);
  let refreshTimer = null;
  let processing = false;
  const pendingKeys = [];
  let cleanedUp = false;

  // Reports a runtime error in the state AND on the screen: when the renderer
  // itself failed, a state-only message would never become visible.
  function reportRuntimeError(error, label) {
    let message = "";
    try {
      message = `${label}: ${error?.message || String(error)}`;
    } catch {
      message = `${label}: unknown error`;
    }
    try {
      state.message = message;
    } catch {
      // A malformed injected state must not make error reporting fatal.
    }
    try {
      // Same control-sequence stripping the renderer applies, so an error
      // message can never inject raw ESC sequences into the TTY.
      output.write(`${sanitizeText(message)}\n`);
    } catch {
      // The output stream may already be gone.
    }
    return message;
  }

  function render() {
    try {
      state.width = Number.parseInt(output.columns, 10) || state.width || 80;
      state.height = Number.parseInt(output.rows, 10) || state.height || 24;
      state.nowMs = Date.now();
      const screen = renderScreen(state, { width: state.width, height: state.height, unicode: state.unicode });
      if (interactive) {
        output.write(`\u001b[2J\u001b[H${screen}\n`);
      } else {
        output.write(`${screen}\n`);
      }
    } catch (error) {
      // Same handling as a key-processing failure: surface it and keep the
      // loop alive instead of dying on an unhandled rejection.
      reportRuntimeError(error, "Render error");
    }
  }

  async function refreshStatus({ full }) {
    state.connection = client.resolveConnection();
    state.effectiveBaseUrl = state.connection.primary;
    state.networkCandidate = state.connection.loopbackOnly ? detectPrimaryNonInternalIpv4() : null;

    const health = await client.health().catch((error) => error);
    if (health && health.ok) {
      state.health = health.body;
      state.healthError = null;
      state.effectiveBaseUrl = health.baseUrl || state.effectiveBaseUrl;
    } else {
      state.health = null;
      state.healthError = health?.code || health?.message || "AGENT_UNREACHABLE";
    }

    const enrollment = await client.enrollStatus().catch(() => null);
    state.enrollment = enrollment?.body || null;

    const pairingStatus = await client.pairingStatus().catch(() => null);
    state.pairingStatus = pairingStatus?.body || null;

    state.service = await Promise.resolve(serviceManager.status()).catch((error) => ({
      supported: false,
      mode: "unsupported",
      state: "unknown",
      reason: error?.message || "Service status unavailable.",
    }));

    if (full) {
      const stats = await client.stats().catch((error) => error);
      if (stats && stats.ok) {
        state.system = stats.body;
        state.systemError = null;
      } else {
        state.system = null;
        state.systemError = stats?.code || stats?.message || "STATS_UNAVAILABLE";
      }
      state.logs = readAgentLogTail({ env, lines: LOG_TAIL_LINES });
    }
  }

  async function refreshLight() {
    if (state.view === "pairing" && state.pairingFlow) {
      await state.pairingFlow.refresh();
      state.pairing = state.pairingFlow.getState();
      return;
    }
    await refreshStatus({ full: false });
  }

  async function startPairing({ regenerate = false } = {}) {
    if (!state.pairingFlow) {
      state.pairingFlow = createPairingFlow({ client, pollIntervalMs: 2000 });
    }
    state.view = "pairing";
    if (regenerate) {
      await state.pairingFlow.regenerate();
    } else {
      await state.pairingFlow.start();
    }
    state.pairing = state.pairingFlow.getState();
    if (state.pairing.baseUrl) state.effectiveBaseUrl = state.pairing.baseUrl;
  }

  async function loadLogs() {
    state.logs = readAgentLogTail({ env, lines: LOG_TAIL_LINES });
  }

  async function runUpdateCheck() {
    state.message = "Checking for updates...";
    state.update = await checkForUpdate({ env });
    if (state.update.state === "update-available") {
      state.message = `Update available: ${state.update.latestVersion}. Install with: sudo apt install ./${state.update.assetName || ""}`.trimEnd();
    } else if (state.update.state === "current") {
      state.message = `The installed version (${state.update.currentVersion}) is current.`;
    } else {
      state.message = `Update state unknown: ${state.update.reason || "no reason reported"}`;
    }
  }

  async function runConfirm(confirm) {
    if (confirm.id === "restart") {
      try {
        const result = await serviceManager.restart();
        state.message = `Agent service restarted (${result.state || "ok"}).`;
      } catch (error) {
        state.message = `Restart failed: ${error.message}`;
      }
      return;
    }
    if (confirm.id === "network-access") {
      try {
        const result = serviceManager.setBindingOverride(confirm.host);
        process.env.AGENT_HOST = confirm.host;
        state.connection = client.resolveConnection();
        state.networkCandidate = null;
        const service = await Promise.resolve(serviceManager.status()).catch(() => null);
        if (service?.installed) {
          await serviceManager.restart();
          state.message = `Network access enabled on ${result.host}. Service restarted — press p to generate a code for that address.`;
        } else {
          state.message = `Network access enabled on ${result.host}. Restart the Agent process to apply the new bind address.`;
        }
      } catch (error) {
        state.message = error.message;
      }
    }
  }

  async function activateAction(action) {
    if (action === "pair") return startPairing();
    if (action === "refresh") {
      await refreshStatus({ full: true });
      state.message = "Status refreshed.";
      return undefined;
    }
    if (action === "restart") {
      state.confirm = { id: "restart", prompt: "Restart the AnxOS Agent service now?" };
      return undefined;
    }
    if (action === "logs") {
      await loadLogs();
      state.view = "logs";
      return undefined;
    }
    if (action === "update") return runUpdateCheck();
    if (action === "help") {
      state.view = "help";
      return undefined;
    }
    if (action === "quit") {
      state.quit = true;
      return undefined;
    }
    return undefined;
  }

  async function handleKey(key) {
    if (state.confirm) {
      if (key === "y" || key === "Y") {
        const confirm = state.confirm;
        state.confirm = null;
        await runConfirm(confirm);
      } else {
        state.confirm = null;
        state.message = "Cancelled.";
      }
      return;
    }
    const isEscape = key === "\u001b";
    const isEnter = key === "\r" || key === "\n";
    const isUp = key === "k" || key === "\u001b[A";
    const isDown = key === "j" || key === "\u001b[B";
    const isCtrlC = key === "\u0003";
    if (key === "q" || key === "Q" || isCtrlC) {
      state.quit = true;
      return;
    }

    if (state.view === "pairing") {
      if (isEscape) {
        state.view = "status";
        return;
      }
      if (key === "p") return startPairing({ regenerate: true });
      if (key === "n" && state.connection?.loopbackOnly && state.networkCandidate) {
        state.confirm = {
          id: "network-access",
          host: state.networkCandidate,
          prompt: `Allow the Agent to listen on ${state.networkCandidate} and restart it?`,
        };
        return undefined;
      }
      if (key === "r" && state.pairingFlow) {
        await state.pairingFlow.refresh();
        state.pairing = state.pairingFlow.getState();
      }
      return undefined;
    }

    if (state.view === "help") {
      if (isEscape || key === "?") state.view = "status";
      return;
    }

    if (state.view === "logs") {
      if (isEscape) {
        state.view = "status";
        return;
      }
      if (key === "r") await loadLogs();
      return;
    }

    // status view
    if (isEscape) {
      state.message = null;
      return;
    }
    if (key === "?" || key === "h") {
      state.view = "help";
      return;
    }
    if (isUp) {
      state.selectedAction = (state.selectedAction - 1 + ACTIONS.length) % ACTIONS.length;
      return;
    }
    if (isDown) {
      state.selectedAction = (state.selectedAction + 1) % ACTIONS.length;
      return;
    }
    if (isEnter) return activateAction(ACTIONS[state.selectedAction]);
    if (key === "p") return activateAction("pair");
    if (key === "r") return activateAction("refresh");
    if (key === "s") return activateAction("restart");
    if (key === "l") return activateAction("logs");
    if (key === "u") return activateAction("update");
    return undefined;
  }

  async function drainKeys() {
    processing = true;
    pauseRefresh();
    try {
      while (pendingKeys.length) {
        const key = pendingKeys.shift();
        try {
          await handleKey(key);
        } catch (error) {
          state.message = error?.message || String(error);
        }
        render();
        if (state.quit) break;
      }
    } finally {
      processing = false;
      if (!state.quit) resumeRefresh();
    }
  }

  function enqueueKeys(keys) {
    if (!keys.length) return;
    pendingKeys.push(...keys);
    if (!processing) {
      drainKeys()
        .catch((error) => reportRuntimeError(error, "TUI error"))
        .then(() => { if (state.quit) shutdown(); });
    }
  }

  function pauseRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function resumeRefresh() {
    if (!interactive || state.quit) return;
    pauseRefresh();
    refreshTimer = setInterval(() => {
      if (processing || state.quit) return;
      refreshLight().then(render).catch(() => {});
    }, REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  }

  function shutdown() {
    if (cleanedUp) return;
    cleanedUp = true;
    pauseRefresh();
    removeFatalHandlers();
    process.removeListener("SIGINT", onSigint);
    if (typeof output.removeListener === "function") output.removeListener("resize", onResize);
    if (interactive) {
      try {
        input.setRawMode(false);
      } catch {
        // Stream may already be released.
      }
      try {
        input.pause();
      } catch {
        // Same.
      }
      try {
        output.write("\u001b[?25h\u001b[2J\u001b[H");
      } catch {
        // The terminal restore is best effort and must never throw.
      }
    }
    process.exitCode = 0;
  }

  // Last-resort guard: an error that escaped every other handler must still
  // restore the terminal and print a clear message instead of leaving a broken
  // TTY behind (or exiting silently).
  function fatalRuntimeError(error, label) {
    reportRuntimeError(error, `anxos-agent TUI ${label}`);
    try {
      state.quit = true;
    } catch {
      // shutdown() still restores the terminal.
    }
    shutdown();
    try {
      // A stack can embed untrusted text (paths, messages); strip control
      // sequences before it reaches the TTY.
      if (error?.stack) process.stderr.write(`${sanitizeText(error.stack)}\n`);
    } catch {
      // Best effort only.
    }
    process.exitCode = 1;
    process.exit(1);
  }

  const onUncaughtException = (error) => fatalRuntimeError(error, "unexpected error");
  const onUnhandledRejection = (reason) => fatalRuntimeError(
    reason instanceof Error ? reason : new Error(String(reason)),
    "unhandled rejection",
  );

  function installFatalHandlers() {
    process.on("uncaughtException", onUncaughtException);
    process.on("unhandledRejection", onUnhandledRejection);
  }

  function removeFatalHandlers() {
    process.removeListener("uncaughtException", onUncaughtException);
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }

  const onData = (chunk) => enqueueKeys(parseKeys(chunk));
  const onResize = () => render();
  const onSigint = () => {
    shutdown();
    process.exit(0);
  };

  installFatalHandlers();
  if (interactive) {
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    output.on("resize", onResize);
    process.once("SIGINT", onSigint);
    output.write("\u001b[?25l");
  }

  await refreshStatus({ full: true });
  render();

  if (automation) {
    for (const key of automationKeys) {
      try {
        await handleKey(key);
      } catch (error) {
        state.message = error?.message || String(error);
      }
      render();
      if (state.quit) break;
    }
    removeFatalHandlers();
    return 0;
  }

  resumeRefresh();
  return 0;
}

module.exports = {
  ACTIONS,
  REFRESH_INTERVAL_MS,
  createTuiState,
  parseKeys,
  runTui,
};
