const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, dialog, shell } = require("electron");
const packageJson = require("../../package.json");
const { sanitizeForDiagnostics } = require("../shared/redaction");
const { StructuredLogger, safeWriteJson } = require("../shared/structuredLogger");
const { buildEnvironmentReadinessSummary } = require("./readinessService");
const { getReleaseInfo } = require("../shared/releaseConfig");
const { getBundledLocalAgentVersion } = require("./localAgentRuntimeService");

function isDevelopment() { return app?.isPackaged === false || process.env.NODE_ENV === "development"; }
function getDirectory() {
  if (process.env.ANXOS_LOG_DIR) return process.env.ANXOS_LOG_DIR;
  if (process.env.ANXHUB_CONFIG_DIR) return path.join(path.dirname(process.env.ANXHUB_CONFIG_DIR), "logs");
  try { return isDevelopment() ? path.join(app.getAppPath(), ".dev-logs") : path.join(app.getPath("userData"), "logs"); }
  catch { return path.join(process.cwd(), ".dev-logs"); }
}
const releaseInfo = getReleaseInfo();
const bundledAgentVersion = getBundledLocalAgentVersion("unavailable");
const logger = new StructuredLogger({ directory: getDirectory(), source: "desktop", processName: "main", appVersion: releaseInfo.compactLabel, agentVersion: bundledAgentVersion });
let runtimeState = { applicationRunning: true, appVersion: releaseInfo.compactLabel, release: releaseInfo, packageVersion: packageJson.version, agentVersion: bundledAgentVersion, platform: process.platform, architecture: process.arch, currentWorkspace: "startup" };

function buildReadinessFromRuntime(state = runtimeState) {
  const base = { ...state };
  delete base.readinessSummary;
  return buildEnvironmentReadinessSummary({
    runtimeState: base,
    publicAccessSnapshot: base.publicAccessSnapshot || null,
    dependencyCheck: base.dependencyCheck || null,
    dependencyPlan: base.dependencyPlan || null,
  });
}

function updateRuntimeState(patch = {}) {
  const next = sanitizeForDiagnostics({ ...runtimeState, ...patch, updatedAt: new Date().toISOString() });
  runtimeState = sanitizeForDiagnostics({ ...next, readinessSummary: buildReadinessFromRuntime(next) });
  logger.snapshot("runtime-state.json", runtimeState);
  return runtimeState;
}

function log(level, source, operation, message, context = {}, options = {}) {
  const entry = logger.write(level, operation, message, context, { ...options, source, file: options.file || source });
  if (entry && (level === "error" || level === "fatal")) writeLatestError(entry, options.file || source);
  return entry;
}

function writeLatestError(entry, source) {
  safeWriteJson(path.join(getDirectory(), "latest-error.json"), { ...entry, runtimeState, recentRelatedEntries: readLogs({ sources: [source, "live"], limit: 25 }).entries, suggestedDiagnosticChecks: ["Check runtime-state.json", `Inspect ${source}.log`, "Confirm the selected node and provider", "Retry once and compare correlation IDs"] });
}

function logError(source, operation, error, context = {}, options = {}) {
  const entry = logger.error(operation, error, context, { ...options, source, file: options.file || source });
  if (entry) writeLatestError(entry, options.file || source);
  return entry;
}

function parseLines(filePath, limit) {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function readLogs(options = {}) {
  const sources = Array.isArray(options.sources) && options.sources.length ? options.sources : ["desktop", "renderer", "agent", "auth", "ipc", "service-manager", "updater", "live"];
  const limit = Math.min(1000, Math.max(1, Number(options.limit || 200)));
  const entries = sources.flatMap((source) => parseLines(logger.getPath(String(source).replace(/[^a-z0-9_-]/gi, "-")), limit))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).slice(-limit);
  return { directory: getDirectory(), entries };
}

async function openFolder() { await shell.openPath(getDirectory()); return { opened: true }; }
async function copySummary() {
  const latest = (() => { try { return JSON.parse(fs.readFileSync(path.join(getDirectory(), "latest-error.json"), "utf8")); } catch { return null; } })();
  return JSON.stringify(sanitizeForDiagnostics({ runtimeState, readinessSummary: buildReadinessFromRuntime(), latestError: latest, recent: readLogs({ sources: ["live"], limit: 30 }).entries }), null, 2);
}

async function exportBundle(parentWindow = null) {
  const result = await dialog.showSaveDialog(parentWindow || undefined, { title: "Export AnxOS Diagnostic Bundle", defaultPath: `anxos-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  const release = getReleaseInfo();
  const bundle = sanitizeForDiagnostics({ generatedAt: new Date().toISOString(), application: { name: "AnxOS Control Center", version: release.versionLabel, build: release.buildLabel, channel: release.channel, releaseLabel: release.compactLabel, packageVersion: packageJson.version, platform: os.platform(), release: os.release(), architecture: os.arch() }, agentVersion: getBundledLocalAgentVersion("unavailable"), readinessSummary: buildReadinessFromRuntime(), runtimeState, latestError: (() => { try { return JSON.parse(fs.readFileSync(path.join(getDirectory(), "latest-error.json"), "utf8")); } catch { return null; } })(), logs: readLogs({ limit: 500 }).entries });
  fs.writeFileSync(result.filePath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  log("info", "diagnostics", "export", "Sanitized diagnostic bundle exported", { destinationType: "user-selected-json" });
  return { canceled: false, exported: true };
}

function captureSnapshot(extra = {}) {
  updateRuntimeState(extra);
  logger.cleanup();
  return { runtimeState, readinessSummary: buildReadinessFromRuntime(), latestErrorExists: fs.existsSync(path.join(getDirectory(), "latest-error.json")), logDirectory: getDirectory() };
}

function correlationId(prefix = "diag") { return `${prefix}-${crypto.randomUUID()}`; }

module.exports = { buildReadinessFromRuntime, captureSnapshot, correlationId, exportBundle, getDirectory, log, logError, logger, openFolder, readLogs, copySummary, updateRuntimeState };
