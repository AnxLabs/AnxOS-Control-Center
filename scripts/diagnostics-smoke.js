const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { sanitize, redactString } = require("../src/shared/redaction");
const { StructuredLogger } = require("../src/shared/structuredLogger");
const readiness = require("../src/services/readinessService");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-diagnostics-"));
process.env.ANXHUB_CONFIG_DIR = path.join(temp, "desktop-config");
process.env.ANXOS_LOG_DIR = path.join(temp, "desktop-logs");

function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
async function waitFor(url) { for (let index = 0; index < 200; index += 1) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 75)); } throw new Error("Agent did not start within 15 seconds."); }

async function main() {
  console.log("Checking redaction and local log rotation...");
  const secret = "super-secret-password";
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.abcdefghijklmnopqrstuvwxyz123456";
  const clean = sanitize({ password: secret, agentToken: "agent-secret", nested: { authorization: "Bearer abc.def.ghi", safe: "ok" }, message: `password=${secret} Authorization: Bearer ${jwt}` });
  assert.strictEqual(clean.password, "[redacted]");
  assert.strictEqual(clean.agentToken, "[redacted]");
  assert.strictEqual(clean.nested.authorization, "[redacted]");
  assert.strictEqual(clean.nested.safe, "ok");
  assert(!JSON.stringify(clean).includes(secret) && !JSON.stringify(clean).includes(jwt));
  assert(!redactString(`Bearer ${jwt}`).includes(jwt));
  assert.strictEqual(redactString(`payload=${"A".repeat(180)}`), "payload=[redacted-base64]");
  assert.strictEqual(redactString(`open /home/private-user/Projects/AnxOS-Control-Center/config/agent.json`), "open [redacted-path]");
  assert.strictEqual(redactString(`C:\\Users\\private-user\\AppData\\Roaming\\AnxOS\\config.json`), "[redacted-path]");
  assert.strictEqual(sanitize({ privateKey: "private-material" }).privateKey, "[redacted]");
  const pem = "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----";
  assert.strictEqual(redactString(pem), "[redacted-private-key]");
  const seededSecrets = {
    commandLine: "provider --token cli-secret --client-secret provider-secret",
    cookieHeader: "Cookie: session=cookie-secret",
    credentialUrl: "https://user:url-secret@example.test/path",
    environment: { CURSEFORGE_API_KEY: "provider-api-secret", AGENT_TOKEN: "agent-env-secret" },
    privateKey: pem,
  };
  const seededOutput = JSON.stringify(sanitize(seededSecrets));
  for (const seededSecret of ["cli-secret", "provider-secret", "cookie-secret", "url-secret", "provider-api-secret", "agent-env-secret", "private-material"]) {
    assert(!seededOutput.includes(seededSecret), `Diagnostics redaction must remove seeded secret ${seededSecret}.`);
  }
  const agentControl = require("../src/services/agentControlService");
  const desktopDiagnostics = require("../src/services/diagnosticsService");
  const validatedConfig = agentControl.validateConfig({ name: "Local Test Agent", host: "127.0.0.1", port: 48131, allowedFolders: [temp] });
  assert.strictEqual(validatedConfig.port, 48131);
  assert.throws(() => agentControl.validateConfig({ name: "Agent", host: "example.com", port: 80 }), /listening address|Port/i, "Agent configuration must reject unsafe host/port values.");
  const diagnosticRuntimeState = desktopDiagnostics.updateRuntimeState({
    currentWorkspace: "agent-control",
    ownerAuthorized: true,
    localPath: "C:\\Users\\Runtime User\\AnxOS Control Center\\runtime.json",
  });
  assert.strictEqual(diagnosticRuntimeState.localPath, "[redacted-path]", "Diagnostic runtime state must fully redact allowlisted path fields.");
  const untestedReadiness = desktopDiagnostics.captureSnapshot({ dependencyCheck: null, dependencyPlan: null });
  assert.strictEqual(untestedReadiness.readinessSummary.items.find((item) => item.id === "dependencies").state, "not-tested", "Diagnostics must not mark dependencies ready before a real check runs.");
  const dependencySummary = readiness.summarizeDependencyReadiness({
    ok: false,
    dependencies: [{ id: "steamcmd", state: "unsupported", supported: false, errorCode: "DEPENDENCY_OS_UNSUPPORTED" }],
  }, {
    manualActions: [{ dependencyId: "steamcmd", reason: "Manual install required." }],
    installableActions: [],
  });
  assert.strictEqual(dependencySummary.state, "blocked", "Unsupported/manual dependencies must block readiness.");
  assert(dependencySummary.context.errorCodes.includes("DEPENDENCY_OS_UNSUPPORTED"), "Dependency readiness must preserve stable error codes.");
  const tailnetOnly = readiness.summarizePublicAccessReadiness({
    providers: [{ id: "tailscale", name: "Tailscale", connected: true, installed: true, exposureScope: "tailnet-only", tailnetAddress: "100.64.0.1", capabilities: {} }],
    services: [],
    activeTunnels: 0,
    exposureScope: "tailnet-only",
  });
  assert.strictEqual(tailnetOnly.state, "degraded", "Tailnet-only Tailscale must not be marked public-ready.");
  assert.strictEqual(tailnetOnly.context.providerCapabilities[0].publicInternet, false, "Tailnet-only provider capability summary must not claim public internet exposure.");
  desktopDiagnostics.log("error", "renderer", "smoke-error", `Failed password=${secret}`, {
    providerMode: "agent",
    accessToken: "hidden",
    backupRoot: "/opt/AnxOS Control Center/Backups/Nested Folder",
  }, { file: "renderer" });
  const latestSnapshot = JSON.parse(fs.readFileSync(path.join(process.env.ANXOS_LOG_DIR, "latest-error.json"), "utf8"));
  assert.strictEqual(latestSnapshot.runtimeState.currentWorkspace, "agent-control");
  assert(Array.isArray(latestSnapshot.recentRelatedEntries) && Array.isArray(latestSnapshot.suggestedDiagnosticChecks));
  assert(latestSnapshot.runtimeState.readinessSummary?.items?.some((item) => item.id === "desktop"), "Latest error snapshot must include readiness context.");
  assert.strictEqual(latestSnapshot.context.backupRoot, "[redacted-path]", "Latest-error snapshots must fully redact diagnostic path fields.");
  assert.strictEqual(latestSnapshot.runtimeState.localPath, "[redacted-path]", "Latest-error runtime state must retain complete path-field redaction.");
  assert(!JSON.stringify(latestSnapshot).includes(secret), "Latest error snapshot must redact secrets before writing.");

  const logDir = path.join(temp, "logs");
  const logger = new StructuredLogger({ directory: logDir, source: "smoke", processName: "test", maxBytes: 500, retainedFiles: 2, retentionMs: 1000 });
  const structuredEntry = logger.info("write", "Structured event", {
    password: secret,
    safe: true,
    remotePath: "/srv/Game Servers/Palworld/config.ini",
  });
  assert.strictEqual(structuredEntry.context.remotePath, "[redacted-path]", "Structured logger entries must fully redact diagnostic path fields.");
  logger.error("failure", Object.assign(new Error(`Failed with token=${jwt}`), { code: "SMOKE_FAILED" }), { apiKey: "hidden" });
  assert(fs.existsSync(path.join(logDir, "smoke.log")));
  assert(fs.existsSync(path.join(logDir, "live.log")));
  assert(fs.existsSync(path.join(logDir, "latest-error.json")));
  logger.snapshot("runtime-state.json", { applicationRunning: true, authorization: "private", executablePath: "/var/lib/AnxOS Data/bin/server" });
  const persistedRuntimeState = JSON.parse(fs.readFileSync(path.join(logDir, "runtime-state.json"), "utf8"));
  assert.strictEqual(persistedRuntimeState.authorization, "[redacted]");
  assert.strictEqual(persistedRuntimeState.executablePath, "[redacted-path]", "Persisted diagnostic snapshots must fully redact path fields.");
  for (let index = 0; index < 30; index += 1) logger.info("rotation", `event-${index}-${"x".repeat(100)}`, {});
  assert(fs.existsSync(path.join(logDir, "smoke.log.1")), "Log rotation should retain bounded history.");
  const blockedPath = path.join(temp, "not-a-directory");
  fs.writeFileSync(blockedPath, "blocked");
  const unavailable = new StructuredLogger({ directory: path.join(blockedPath, "logs"), source: "failure-safe" });
  assert.doesNotThrow(() => unavailable.error("write", new Error("ignored")), "Logging failures must not crash the app.");

  const port = await freePort();
  console.log("Checking authenticated Agent diagnostics...");
  const token = "diagnostics-smoke-agent-token";
  const agentRoot = path.join(temp, "agent");
  fs.mkdirSync(agentRoot, { recursive: true });
  const child = spawn(process.execPath, [path.join(root, "agent", "src", "server.js")], { cwd: agentRoot, env: { ...process.env, AGENT_HOST: "127.0.0.1", AGENT_PORT: String(port), AGENT_TOKEN: token, AGENT_FILE_ROOTS: agentRoot, AGENT_INSTANCE_ROOT: path.join(agentRoot, "instances"), AGENT_IDENTITY_PATH: path.join(agentRoot, "identity.json"), ANXOS_LOG_DIR: path.join(temp, "agent-logs") }, stdio: "ignore" });
  try {
    await waitFor(`http://127.0.0.1:${port}/api/v1/health`);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/v1/diagnostics`);
    assert.strictEqual(unauthorized.status, 401, "Remote diagnostics must require Agent authentication.");
    const authorized = await fetch(`http://127.0.0.1:${port}/api/v1/diagnostics`, { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(authorized.status, 200);
    const bundle = await authorized.json();
    assert(bundle.identity?.deviceId && Array.isArray(bundle.logs));
    assert(!JSON.stringify(bundle).includes(token), "Remote diagnostic bundle must not expose the Agent token.");
  } finally { child.kill("SIGTERM"); }

  const combined = [logDir, path.join(temp, "agent-logs")].flatMap((directory) => { try { return fs.readdirSync(directory).map((entry) => path.join(directory, entry)); } catch { return []; } }).filter((filePath) => /\.(log|json)(\.\d+)?$/.test(filePath)).map((filePath) => { try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; } }).join("\n");
  assert(!combined.includes(secret) && !combined.includes(jwt) && !combined.includes(token), "Generated diagnostics must not contain test secrets.");

  const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
  const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  const controlIpc = fs.readFileSync(path.join(root, "src", "ipc", "agentControlIpc.js"), "utf8");
  const externalUrlService = fs.readFileSync(path.join(root, "src", "services", "externalUrlService.js"), "utf8");
  const desktopSources = [
    "main.js",
    "src/ipc/marketplaceIpc.js",
    "src/services/accountAuthService.js",
    "src/services/updateManager.js",
    "src/services/developerGitUpdater.js",
  ].map((relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8")).join("\n");
  assert(main.includes('process.on("uncaughtException"') && main.includes('process.on("unhandledRejection"'));
  assert(externalUrlService.includes("isSafeExternalUrl") && externalUrlService.includes("external-url-blocked"), "Electron external navigation must be allowlisted and logged when blocked.");
  assert(!desktopSources.includes("shell.openExternal"), "Desktop code must route browser handoff through externalUrlService instead of direct shell.openExternal calls.");
  assert(preload.includes("forwardPreloadError") && app.includes('window.addEventListener("unhandledrejection"'));
  assert(controlIpc.includes('authorize("remote-diagnostics")') && controlIpc.includes("requireOwner"), "Remote diagnostic capture must be owner-gated in the main process.");
  assert(index.includes("data-diagnostics-overview") && index.includes("data-diagnostics-issue-list") && index.includes("data-agent-log-source"), "Diagnostics workspace must expose overview, grouped issues, and source filtering controls.");
  assert(styles.includes(".diagnostics-overview") && styles.includes(".diagnostics-issue") && styles.includes(".diagnostics-support-preview"), "Diagnostics production UI styles must be present.");
  assert(app.includes("KNOWN_DIAGNOSTIC_EXPLANATIONS") && app.includes("AGENT_PORT_IN_USE") && app.includes("MAINTENANCE_PARTIAL_CLEANUP"), "Known deterministic diagnostics must have controlled explanations.");
  assert(app.includes("groupDiagnosticIssues") && app.includes("DIAGNOSTIC_OCCURRENCE_LIMIT"), "Diagnostics must group repeated issues with bounded occurrences.");
  assert(app.includes("DIAGNOSTIC_BASE64_PATTERN") && app.includes("[redacted-base64]") && app.includes("boundDiagnosticText"), "Diagnostics renderer must defensively redact and bound long log content.");
  assert(app.includes("publicAccessSnapshot") && app.includes("snapshot.readiness"), "Public Access refresh should feed sanitized readiness into diagnostics snapshots.");
  assert(fs.readFileSync(path.join(root, "src", "services", "diagnosticsService.js"), "utf8").includes("buildReadinessFromRuntime"), "Diagnostics summaries must include environment readiness.");
  assert(app.includes("confirmDiagnosticsSupportBundleExport") && app.includes("getDiagnosticsSupportBundleCategories"), "Support bundle export must preview included categories before export.");
  assert(app.includes('id: `diagnostics.${action}`') && app.includes('health: "Run Health Checks"'), "Command Palette must expose real Diagnostics health-check action.");
  assert(app.includes("diagnosticsIssueGroups") && app.includes("issueResults"), "Global Search must include grouped diagnostic issues without duplicating diagnostics logic.");
  assert(app.includes('agentLogSource?.addEventListener("change", renderAgentLogs)'), "Diagnostics source filter must rerender logs and issue groups.");
  assert(/function buildDiagnosticsHealthChecks\(\) \{[\s\S]*const desktopApiState = getDesktopApiState\(\);[\s\S]*desktopApiState\.hasBridge/.test(app), "Diagnostics health rendering must read desktop API state from the scoped accessor before use.");
  console.log("Diagnostics smoke checks passed.");
}

main().finally(() => fs.rmSync(temp, { recursive: true, force: true })).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
