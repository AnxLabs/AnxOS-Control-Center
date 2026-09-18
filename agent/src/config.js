const fs = require("fs");
const path = require("path");
const {
  readAgentConfigFile,
  resolveSharedAgentToken,
} = require("../../src/shared/agentTokenStore");
const { readAgentRuntimeConfig } = require("../../src/shared/agentRuntimeConfigStore");
const { logger } = require("./services/diagnosticsLogger");

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 47131;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_FILE_WRITE_TIMEOUT_MS = 300000;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_INSTANCE_ROOT = "/srv/anxos/instances";
const DEFAULT_API_RATE_LIMIT_PER_MINUTE = 20000;
const DEFAULT_FILE_WRITE_RATE_LIMIT_PER_MINUTE = 12000;
const DEFAULT_CONSOLE_RATE_LIMIT_PER_MINUTE = 120;

let environmentLoaded = false;

function readRuntimeConfig() {
  const candidates = [process.env.ANXOS_AGENT_RUNTIME_CONFIG, process.env.ANXHUB_CONFIG_DIR ? path.join(process.env.ANXHUB_CONFIG_DIR, "agent-runtime.json") : null].filter(Boolean);
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) return readAgentRuntimeConfig(filePath);
  }
  return {};
}

function readInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanEnvValue(value) {
  const text = String(value || "").trim();
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function loadEnvFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return;
      }
      const separator = trimmed.indexOf("=");
      if (separator <= 0) {
        return;
      }
      const key = trimmed.slice(0, separator).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) {
        return;
      }
      process.env[key] = cleanEnvValue(trimmed.slice(separator + 1));
    });
  } catch {
    // The agent can run fully from process environment variables.
  }
}

function getUserConfigEnvPath() {
  const base = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "anxos-control-center")
    : path.join(process.env.HOME || "", ".config", "anxos-control-center");
  return path.join(base, "agent.env");
}

const WINDOWS_FALLBACK_INSTANCE_ROOT =
  path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || process.env.HOME || "", "anxos", "instances");

// Resolve the managed-instances directory. Prefer the explicit spawn-provided
// AGENT_INSTANCE_ROOT (set by the desktop shell when it launches the agent).
// When that is missing we fall back to a platform-appropriate location and emit
// a loud, actionable diagnostic so a stray root can never silently bite again.
// The old behavior fell back to "/srv/anxos/instances" unconditionally, which on
// Windows silently resolved to C:\srv\anxos\instances.
function resolveInstanceRoot() {
  const explicit = String(process.env.AGENT_INSTANCE_ROOT || "").trim();
  if (explicit) {
    return { root: explicit, source: "env" };
  }

  const fallbackRoot = process.platform === "win32"
    ? WINDOWS_FALLBACK_INSTANCE_ROOT
    : DEFAULT_INSTANCE_ROOT;

  const diagnostic =
    "[AnxOS Agent] AGENT_INSTANCE_ROOT is not set; using the fallback managed-instances root \"" +
    `${fallbackRoot}". Instances may land in an unintended location. ` +
    "Set AGENT_INSTANCE_ROOT explicitly to the directory that should hold managed instances.";

  return { root: fallbackRoot, source: "fallback", diagnostic };
}

function loadEnvironment() {
  if (environmentLoaded) {
    return;
  }
  environmentLoaded = true;
  [
    process.env.ANXHUB_AGENT_ENV_PATH,
    process.env.ANXOS_AGENT_ENV_PATH,
    getUserConfigEnvPath(),
    path.join(process.cwd(), ".env"),
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", "..", ".env"),
  ].filter(Boolean).forEach(loadEnvFile);
}

function getConfig() {
  loadEnvironment();
  const runtime = readRuntimeConfig();
  const tokenStatus = resolveSharedAgentToken({
    cwd: process.cwd(),
    environmentToken: process.env.AGENT_TOKEN,
  });
  // The configured Agent address, used by the request-trust policy as one of the
  // authorities this Agent legitimately answers for. Read from the same config
  // file the credential came from; a corrupt file already throws above, so this
  // read can only add the address (or nothing).
  let configuredAgentUrl = "";
  try {
    configuredAgentUrl = String(readAgentConfigFile(tokenStatus.configPath)?.agentUrl || "").trim();
  } catch {
    configuredAgentUrl = "";
  }
  const instanceRoot = resolveInstanceRoot();
  if (instanceRoot.diagnostic) {
    emitInstanceRootDiagnostic(instanceRoot.diagnostic);
  }
  return {
    host: process.env.AGENT_HOST || runtime.host || DEFAULT_HOST,
    port: readInteger(process.env.AGENT_PORT || runtime.port, DEFAULT_PORT),
    agentUrl: configuredAgentUrl,
    token: tokenStatus.token || "",
    tokenStatus,
    requestTimeoutMs: readInteger(process.env.AGENT_REQUEST_TIMEOUT_MS || runtime.connectionTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    fileWriteTimeoutMs: readInteger(process.env.AGENT_FILE_WRITE_TIMEOUT_MS, DEFAULT_FILE_WRITE_TIMEOUT_MS),
    maxRequestBytes: readInteger(process.env.AGENT_MAX_REQUEST_BYTES, DEFAULT_MAX_REQUEST_BYTES),
    maxResponseBytes: readInteger(process.env.AGENT_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES),
    instanceRoot: instanceRoot.root,
    instanceRootSource: instanceRoot.source,
    allowedFolders: Array.isArray(runtime.allowedFolders) ? runtime.allowedFolders.map(String).filter(Boolean) : [],
    apiRateLimitPerMinute: readInteger(process.env.AGENT_API_RATE_LIMIT_PER_MINUTE, DEFAULT_API_RATE_LIMIT_PER_MINUTE),
    fileWriteRateLimitPerMinute: readInteger(process.env.AGENT_FILE_WRITE_RATE_LIMIT_PER_MINUTE, DEFAULT_FILE_WRITE_RATE_LIMIT_PER_MINUTE),
    consoleRateLimitPerMinute: readInteger(process.env.AGENT_CONSOLE_RATE_LIMIT_PER_MINUTE, DEFAULT_CONSOLE_RATE_LIMIT_PER_MINUTE),
  };
}

function emitInstanceRootDiagnostic(diagnostic) {
  try {
    logger.warn("instance-root", "Managed-instances fallback root in use", { diagnostic }, { file: "config" });
  } catch {
    // Logging must never break config resolution.
  }
  console.warn(diagnostic);
}

module.exports = {
  getConfig,
  loadEnvironment,
};
