"use strict";

// Pairing state machine shared by the interactive TUI and the `pair`
// subcommand. It only talks to the authoritative runtime through
// agentCliClient (no second implementation of pairing), never busy-loops, and
// classifies the runtime's typed refusals into clear operator guidance:
// unreachable agent, expired session, PAIRING_REQUIRES_EXISTING_CREDENTIAL,
// and rate limiting.

const STATES = Object.freeze(["idle", "starting", "waiting", "paired", "expired", "cancelled", "timeout", "error"]);

class PairingFlowError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "PairingFlowError";
    this.code = code;
    if (options.hint) this.hint = options.hint;
    if (options.causeCode) this.causeCode = options.causeCode;
  }
}

function classifyPairingError(error) {
  const code = error?.code || "PAIRING_ERROR";
  const message = error?.message || "Pairing failed.";
  if (code === "PAIRING_REQUIRES_EXISTING_CREDENTIAL") {
    return new PairingFlowError(code, message, {
      hint: "This Agent is already enrolled. Pairing it from another computer requires the existing Agent credential: run this command with sudo (or as the user that owns the Agent configuration), extend sudo for root installs, or use AnxOS Control Center on this machine.",
      causeCode: code,
    });
  }
  if (code === "PAIRING_RATE_LIMITED" || error?.statusCode === 429) {
    return new PairingFlowError("PAIRING_RATE_LIMITED", message, {
      hint: "Too many pairing attempts were made from this machine. Wait about a minute and try again.",
      causeCode: code,
    });
  }
  if (code === "AGENT_UNREACHABLE") {
    return new PairingFlowError(code, message, {
      hint: "Start the Agent on this machine (`anxos-agent service start`) or verify AGENT_URL / AGENT_PORT, then try again.",
      causeCode: code,
    });
  }
  if (code === "UNAUTHORIZED" || code === "AGENT_TOKEN_MISSING") {
    return new PairingFlowError(code, message, {
      hint: "The stored Agent credential could not be presented. Run this command with sudo so the Agent configuration is readable, or repair the node from AnxOS Control Center.",
      causeCode: code,
    });
  }
  return new PairingFlowError(code, message, { causeCode: code });
}

function createPairingFlow(options = {}) {
  const client = options.client;
  if (!client || typeof client.pairingStart !== "function") {
    throw new PairingFlowError("PAIRING_CLIENT_MISSING", "The pairing flow requires an Agent client.");
  }
  const now = options.now || (() => Date.now());
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs >= 250
    ? options.pollIntervalMs
    : 2000;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  let state = {
    status: "idle",
    displayCode: null,
    pairingCode: null,
    agentUrl: null,
    expiresAt: null,
    baseUrl: null,
    startedAt: null,
    tokenFingerprintBaseline: null,
    tokenFingerprint: null,
    pollFailures: 0,
    error: null,
  };

  function remainingMs() {
    if (!state.expiresAt) return null;
    const expiresAtMs = Date.parse(state.expiresAt);
    return Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - now()) : null;
  }

  function getState() {
    return { ...state, remainingMs: remainingMs(), states: STATES };
  }

  async function start() {
    state = { ...state, status: "starting", error: null, pollFailures: 0 };
    try {
      const [session, health] = await Promise.all([
        client.pairingStart(),
        client.health().catch(() => null),
      ]);
      const body = session.body || {};
      return applySession(session, body, health);
    } catch (error) {
      state = { ...state, status: "error", error: classifyPairingError(error) };
      return getState();
    }
  }

  function applySession(session, body, health) {
    state = {
      ...state,
      status: "waiting",
      displayCode: body.displayCode || null,
      pairingCode: body.pairingCode || null,
      agentUrl: body.agentUrl || null,
      expiresAt: body.expiresAt || null,
      baseUrl: session.baseUrl || null,
      startedAt: new Date(now()).toISOString(),
      tokenFingerprintBaseline: health?.body?.tokenFingerprint || null,
      tokenFingerprint: health?.body?.tokenFingerprint || null,
      pollFailures: 0,
      error: null,
    };
    return getState();
  }

  // A waiting session becomes `not_paired` when the runtime consumes it via
  // /pairing/complete (the only mutation besides our own cancel), so a
  // waiting -> not_paired transition before expiry is the verified paired
  // signal. The health fingerprint captured at start is kept for evidence.
  async function refresh() {
    if (state.status !== "waiting") return getState();
    const remaining = remainingMs();
    if (remaining !== null && remaining <= 0) {
      state = { ...state, status: "expired", error: null };
      return getState();
    }
    try {
      const statusResult = await client.pairingStatus();
      const serverStatus = statusResult.body?.status || "unknown";
      state = { ...state, pollFailures: 0 };
      if (serverStatus === "not_paired") {
        const health = await client.health().catch(() => null);
        state = {
          ...state,
          status: "paired",
          tokenFingerprint: health?.body?.tokenFingerprint || null,
        };
      } else if (serverStatus === "expired") {
        state = { ...state, status: "expired" };
      }
      return getState();
    } catch (error) {
      const classified = classifyPairingError(error);
      const pollFailures = state.pollFailures + 1;
      state = { ...state, pollFailures, lastPollError: classified };
      if (classified.code === "AGENT_UNREACHABLE" && pollFailures >= 3) {
        state = { ...state, status: "error", error: classified };
      } else if (classified.code !== "AGENT_UNREACHABLE") {
        state = { ...state, status: "error", error: classified };
      }
      return getState();
    }
  }

  async function waitForCompletion(waitOptions = {}) {
    const timeoutMs = Number.isFinite(waitOptions.timeoutMs) && waitOptions.timeoutMs > 0
      ? waitOptions.timeoutMs
      : 10 * 60 * 1000;
    const onUpdate = typeof waitOptions.onUpdate === "function" ? waitOptions.onUpdate : null;
    const expiresAtMs = state.expiresAt ? Date.parse(state.expiresAt) : NaN;
    const deadline = Math.min(now() + timeoutMs, Number.isFinite(expiresAtMs) ? expiresAtMs : Infinity);

    while (state.status === "waiting") {
      await refresh();
      if (onUpdate) onUpdate(getState());
      if (state.status !== "waiting") break;
      const remaining = deadline - now();
      if (remaining <= 0) {
        state = { ...state, status: now() >= (Number.isFinite(expiresAtMs) ? expiresAtMs : Infinity) ? "expired" : "timeout" };
        if (onUpdate) onUpdate(getState());
        break;
      }
      await sleep(Math.max(250, Math.min(pollIntervalMs, remaining)));
    }
    return getState();
  }

  async function cancel() {
    try {
      await client.pairingCancel();
      state = { ...state, status: "cancelled", error: null };
    } catch (error) {
      state = { ...state, status: "error", error: classifyPairingError(error) };
    }
    return getState();
  }

  function regenerate() {
    return start();
  }

  return {
    PairingFlowError,
    cancel,
    getState,
    refresh,
    regenerate,
    start,
    waitForCompletion,
  };
}

function formatRemaining(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "expired";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

module.exports = {
  PairingFlowError,
  STATES,
  classifyPairingError,
  createPairingFlow,
  formatRemaining,
};
