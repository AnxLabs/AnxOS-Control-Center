"use strict";

// Loopback-first HTTP client for the headless Agent CLI/TUI. It talks to the
// SAME agent runtime (agent/src/server.js) the desktop uses: no second agent
// implementation, no protocol fork.
//
// Address resolution order (explicit wins, never a silent fallback):
//   1. AGENT_URL
//   2. the stored agent address (agent.json `agentUrl`) when it matches the
//      resolved port — an explicit AGENT_PORT always defines the endpoint, so a
//      stock default address can never redirect the CLI to another process
//   3. http://127.0.0.1:<port>
//   4. the configured concrete (non-wildcard, non-loopback) AGENT_HOST
//
// The stored token is attached as `x-agent-token` only when it is actually
// readable (a generated in-memory token is never sent, and token material is
// never logged, printed, or returned — only its fingerprint).

const fs = require("fs");
const path = require("path");
const { readAgentRuntimeConfig } = require("../../../src/shared/agentRuntimeConfigStore");
const { resolveAgentConfigPath, resolveSharedAgentToken } = require("../../../src/shared/agentTokenStore");
const { isWildcardBind } = require("./hostTrustPolicy");

const DEFAULT_PORT = 47131;
const DEFAULT_TIMEOUT_MS = 10000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]);
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "ECONNABORTED",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

class AgentCliError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AgentCliError";
    this.code = code;
    if (options.statusCode) this.statusCode = options.statusCode;
    if (options.baseUrl) this.baseUrl = options.baseUrl;
    if (options.details) this.details = options.details;
  }
}

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseHost(rawValue) {
  let host = trim(rawValue);
  if (!host) return "";
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  return host;
}

function isLoopbackHost(rawValue) {
  return LOOPBACK_HOSTS.has(parseHost(rawValue).toLowerCase());
}

function formatUrlHost(rawValue) {
  const host = parseHost(rawValue);
  return host.includes(":") ? `[${host}]` : host;
}

function normalizeBaseUrl(rawValue) {
  const value = trim(rawValue);
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (!parsed.hostname) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function urlPort(rawValue) {
  try {
    const parsed = new URL(rawValue);
    return parsed.port ? parsed.port : null;
  } catch {
    return null;
  }
}

function isLoopbackUrl(rawValue) {
  try {
    return isLoopbackHost(new URL(rawValue).hostname);
  } catch {
    return false;
  }
}

function isNetworkFailure(error) {
  if (!error) return null;
  if (error.name === "AbortError") return { code: "ETIMEDOUT", reason: "timeout" };
  const code = error.cause?.code || error.code;
  if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return { code, reason: code };
  if (error instanceof TypeError) return { code: "ECONNREFUSED", reason: error.message || "fetch failed" };
  return null;
}

function createAgentCliClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const defaultTimeoutMs = readInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  let preferredBaseUrl = "";

  function readRuntimeConfigSafe() {
    const candidates = [
      env.ANXOS_AGENT_RUNTIME_CONFIG,
      env.ANXHUB_CONFIG_DIR ? path.join(env.ANXHUB_CONFIG_DIR, "agent-runtime.json") : null,
    ].filter(Boolean);
    for (const filePath of candidates) {
      try {
        if (fs.existsSync(filePath)) return readAgentRuntimeConfig(filePath, { migrate: false });
      } catch {
        return {};
      }
    }
    return {};
  }

  // Read-only: parses the stored agent config directly so a status command can
  // never trigger the store's schema migration as a side effect.
  function readConfiguredAgentUrl() {
    try {
      const configPath = resolveAgentConfigPath({ cwd: process.cwd(), configDir: env.ANXHUB_CONFIG_DIR });
      if (!configPath || !fs.existsSync(configPath)) return "";
      const parsed = JSON.parse(String(fs.readFileSync(configPath, "utf8")).replace(/^\uFEFF/, ""));
      return trim(parsed?.agentUrl);
    } catch {
      return "";
    }
  }

  function resolveTokenInfo() {
    try {
      const status = resolveSharedAgentToken({
        cwd: process.cwd(),
        environmentToken: env.AGENT_TOKEN,
        write: false,
      });
      const readable = Boolean(status?.token) && status.source !== "generated";
      return {
        readable,
        token: readable ? status.token : "",
        fingerprint: status?.fingerprint || null,
        source: status?.source || null,
        configPath: status?.configPath || null,
      };
    } catch (error) {
      return {
        readable: false,
        token: "",
        fingerprint: null,
        source: null,
        configPath: null,
        errorCode: error?.code || "AGENT_TOKEN_READ_FAILED",
      };
    }
  }

  function tokenSummary() {
    const info = resolveTokenInfo();
    return {
      readable: info.readable,
      fingerprint: info.fingerprint,
      source: info.source,
      errorCode: info.errorCode || null,
    };
  }

  function resolveConnection() {
    const notes = [];
    const runtime = readRuntimeConfigSafe();
    const explicitUrl = normalizeBaseUrl(env.AGENT_URL);
    const envPort = readInteger(env.AGENT_PORT, null);
    const port = envPort || readInteger(runtime.port, DEFAULT_PORT);

    if (explicitUrl) {
      return {
        mode: "env",
        port,
        candidates: [explicitUrl],
        primary: explicitUrl,
        loopbackUrl: `http://127.0.0.1:${port}`,
        reachableUrl: isLoopbackUrl(explicitUrl) ? null : explicitUrl,
        loopbackOnly: isLoopbackUrl(explicitUrl),
        token: tokenSummary(),
        notes,
      };
    }

    const loopbackUrl = `http://127.0.0.1:${port}`;
    const candidates = [];
    const configuredUrl = normalizeBaseUrl(readConfiguredAgentUrl());
    if (configuredUrl) {
      const configuredPort = urlPort(configuredUrl);
      const matchesPort = configuredPort !== null && String(configuredPort) === String(port);
      if (!envPort || matchesPort) {
        candidates.push(configuredUrl);
      } else {
        notes.push(
          `The stored agent address ${configuredUrl} does not match AGENT_PORT ${port} and was ignored.`,
        );
      }
    }
    candidates.push(loopbackUrl);

    const bindHost = trim(env.AGENT_HOST) || trim(runtime.host);
    if (bindHost && !isWildcardBind(bindHost) && !isLoopbackHost(bindHost)) {
      candidates.push(`http://${formatUrlHost(bindHost)}:${port}`);
    }

    const unique = Array.from(new Set(candidates));
    const reachableUrl = unique.find((candidate) => !isLoopbackUrl(candidate)) || null;
    return {
      mode: configuredUrl ? "config" : "default",
      port,
      candidates: unique,
      primary: unique[0],
      loopbackUrl,
      reachableUrl,
      loopbackOnly: !reachableUrl,
      token: tokenSummary(),
      notes,
    };
  }

  function orderCandidates(candidates, preferReachable) {
    const ordered = preferredBaseUrl && candidates.includes(preferredBaseUrl)
      ? [preferredBaseUrl, ...candidates.filter((candidate) => candidate !== preferredBaseUrl)]
      : [...candidates];
    if (!preferReachable) return ordered;
    const reachable = ordered.filter((candidate) => !isLoopbackUrl(candidate));
    const loopback = ordered.filter((candidate) => isLoopbackUrl(candidate));
    return [...reachable, ...loopback];
  }

  async function request(pathname, requestOptions = {}) {
    const method = requestOptions.method || "GET";
    const timeoutMs = readInteger(requestOptions.timeoutMs, defaultTimeoutMs);
    const connection = resolveConnection();
    const ordered = orderCandidates(connection.candidates, requestOptions.preferReachable === true);
    let lastNetworkError = null;

    for (const baseUrl of ordered) {
      const tokenInfo = resolveTokenInfo();
      const headers = { accept: "application/json", ...(requestOptions.headers || {}) };
      if (tokenInfo.readable && tokenInfo.token) headers["x-agent-token"] = tokenInfo.token;
      if (requestOptions.body !== undefined) headers["content-type"] = "application/json";

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${pathname}`, {
          method,
          headers,
          body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        const network = isNetworkFailure(error);
        if (network) {
          lastNetworkError = new AgentCliError("AGENT_UNREACHABLE", `The AnxOS Agent is not reachable at ${baseUrl}.`, {
            baseUrl,
            details: { reason: network.reason, candidates: ordered },
          });
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const error = new AgentCliError(payload?.error?.code || "AGENT_REQUEST_FAILED", payload?.error?.message || `Agent request failed with HTTP ${response.status}.`, {
          statusCode: response.status,
          baseUrl,
          details: payload?.error?.details || undefined,
        });
        throw error;
      }

      preferredBaseUrl = baseUrl;
      return { ok: true, baseUrl, status: response.status, body: payload };
    }

    throw lastNetworkError || new AgentCliError("AGENT_UNREACHABLE", "The AnxOS Agent is not reachable.", {
      details: { candidates: ordered },
    });
  }

  return {
    AgentCliError,
    resolveConnection,
    getTokenInfo: tokenSummary,
    request,
    health: () => request("/api/v1/health"),
    stats: () => request("/api/v1/stats"),
    enrollStatus: () => request("/api/v1/enroll/status"),
    pairingStatus: () => request("/api/v1/pairing/status", { preferReachable: true }),
    pairingStart: () => request("/api/v1/pairing/start", { method: "POST", preferReachable: true }),
    pairingCancel: () => request("/api/v1/pairing/cancel", { method: "POST", preferReachable: true }),
    revokeEnrollment: (payload = {}) => request("/api/v1/enroll/revoke", {
      method: "POST",
      body: { confirmRevoke: true, reason: payload.reason || "cli-unpair" },
    }),
  };
}

module.exports = {
  AgentCliError,
  createAgentCliClient,
  isLoopbackUrl,
  normalizeBaseUrl,
  _test: {
    DEFAULT_PORT,
    isNetworkFailure,
    parseHost,
  },
};
