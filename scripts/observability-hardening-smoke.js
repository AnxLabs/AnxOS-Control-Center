#!/usr/bin/env node
"use strict";

// Regression checks for the observability hardening round. Each check runs in
// its own Node process so environment variables and module caches never leak
// between them. Everything is hermetic: temporary folders, a stubbed electron
// module, plain `node -e` children as game servers, no network and no Agent.
//   O1 a game server's console log keeps its output order, and a line or a
//      UTF-8 character cut at a pipe chunk boundary is stored as one entry;
//   O2 the packaged desktop writes, opens, reports and enriches its logs in one
//      folder, never overwriting the Local Agent's latest-error.json, and Agent
//      Control advertises the folder the Agent really writes to;
//   O3 the diagnostics viewer, the export bundle and latest-error.json context
//      list each log entry once;
//   O4 Agent action audit records are written to the Agent's log folder, not
//      only to stdout (which a scheduled-task Agent does not have).
// Run: node scripts/observability-hardening-smoke.js

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTemp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `anxos-observability-${label}-`));
}

function removeTemp(directory) {
  try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}

// A minimal electron stand-in with Electron's getPath/setPath semantics.
function installElectronStub(options = {}) {
  const paths = { ...options.paths };
  const opened = [];
  // No packaged runtime folder: the Local Agent runtime resolves to appPath.
  process.resourcesPath = options.resourcesPath || os.tmpdir();
  const fakeElectron = {
    app: {
      isPackaged: options.isPackaged !== false,
      getPath(name) {
        if (!paths[name]) throw new Error(`No fake path for ${name}`);
        return paths[name];
      },
      setPath(name, value) { paths[name] = value; },
      getAppPath() { return options.appPath || root; },
      getName() { return "AnxOS Control Center"; },
      getVersion() { return "0.0.0"; },
      commandLine: { appendSwitch() {} },
    },
    dialog: {
      async showSaveDialog() { return { canceled: false, filePath: options.savePath }; },
    },
    shell: {
      async openPath(target) { opened.push(target); return ""; },
    },
  };
  const stubPath = path.join(root, "__observability_electron_stub__.js");
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function resolve(request, ...rest) {
    if (request === "electron") return stubPath;
    return originalResolve.call(this, request, ...rest);
  };
  const stubModule = new Module(stubPath);
  stubModule.filename = stubPath;
  stubModule.loaded = true;
  stubModule.exports = fakeElectron;
  require.cache[stubPath] = stubModule;
  return { electron: fakeElectron, opened, paths };
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// O1 -----------------------------------------------------------------------
async function checkConsoleLogOrder() {
  const temp = makeTemp("o1");
  process.env.AGENT_INSTANCE_ROOT = path.join(temp, "instances");
  // The test server runs this Node binary, wherever it is installed (on Linux
  // the default executable roots do not include it).
  process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);
  const instanceService = require(path.join(root, "agent", "src", "services", "instances", "instanceService.js"));
  const core = instanceService;
  try {
    // (a) The writer itself: unawaited appendLog calls, as the pipe handlers
    // make them, must land in call order.
    const directId = "direct-order";
    await core.createInstance({ id: directId, displayName: directId, type: "custom-command", workingDirectory: "data", executable: process.execPath, args: ["-e", "0"], restartPolicy: "never" });
    const pending = [];
    for (let index = 0; index < 300; index += 1) {
      pending.push(core._test.appendLog(directId, "stdout", `direct ${index}\n`).catch(() => {}));
      if (index % 10 === 9) await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(pending);
    const directFile = readJsonLines(core._test.logPath(directId, "stdout")).map((entry) => Number(entry.message.split(" ")[1]));
    assert.strictEqual(directFile.length, 300, `every direct line is stored (${directFile.length})`);
    assert.deepStrictEqual(directFile, [...directFile].sort((a, b) => a - b), "unawaited appendLog calls are stored in call order");
    const directAt = readJsonLines(core._test.logPath(directId, "stdout")).map((entry) => entry.at);
    assert.deepStrictEqual(directAt, [...directAt].sort(), "line timestamps follow arrival order");

    // (b) The real start path: a server that writes a burst, then a line cut
    // inside a two-byte UTF-8 character, then a last line with no newline.
    const serverScript = [
      "let i = 0;",
      "function burst() {",
      "  let text = '';",
      "  for (let k = 0; k < 10 && i < 300; k += 1, i += 1) text += 'seq ' + i + '\\n';",
      "  process.stdout.write(text);",
      "  if (i < 300) setTimeout(burst, 1); else setTimeout(cut, 30);",
      "}",
      "function cut() {",
      "  const bytes = Buffer.from('caf\\u00e9 ready\\n', 'utf8');",
      "  const at = bytes.indexOf(0xc3) + 1;",
      "  process.stdout.write(bytes.subarray(0, at));",
      "  setTimeout(() => { process.stdout.write(bytes.subarray(at)); setTimeout(last, 30); }, 60);",
      "}",
      "function last() { process.stdout.write('tail without newline', () => setTimeout(() => process.exit(0), 50)); }",
      "burst();",
    ].join("\n");
    // Instance arguments are capped at 512 characters, so the server is a file.
    const serverFile = path.join(temp, "burst-server.js");
    fs.writeFileSync(serverFile, serverScript);
    const id = "burst-order";
    await core.createInstance({ id, displayName: id, type: "custom-command", workingDirectory: "data", executable: process.execPath, args: [serverFile], restartPolicy: "never" });
    await core.startInstance(id);
    let entries = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(100);
      entries = (await core.readLogs(id, { stream: "stdout", limit: 1000 })).entries;
      if (entries.some((entry) => entry.message === "tail without newline")) break;
    }
    const sequence = entries.map((entry) => /^seq (\d+)$/.exec(entry.message)).filter(Boolean).map((match) => Number(match[1]));
    assert.strictEqual(sequence.length, 300, `every burst line is stored once (${sequence.length})`);
    const inversions = sequence.filter((value, index) => index > 0 && value < sequence[index - 1]).length;
    assert.strictEqual(inversions, 0, `the console log keeps the server's output order (${inversions} inversions)`);
    const cafe = entries.filter((entry) => /caf|ready/.test(entry.message));
    assert.deepStrictEqual(cafe.map((entry) => entry.message), ["café ready"], `a line cut mid-character is one intact entry (${JSON.stringify(cafe.map((entry) => entry.message))})`);
    assert.ok(!entries.some((entry) => entry.message.includes("�")), "no replacement characters are stored");
    assert.ok(entries.some((entry) => entry.message === "tail without newline"), "a last line without a newline is kept when the stream ends");
  } finally {
    for (const id of ["burst-order", "direct-order"]) await core.stopInstance(id).catch(() => {});
    await wait(200);
    if (typeof core.shutdownInstanceService === "function") await core.shutdownInstanceService().catch(() => {});
    removeTemp(temp);
  }
}

// O2 -----------------------------------------------------------------------
async function checkDesktopLogFolder() {
  const temp = makeTemp("o2");
  delete process.env.ANXOS_LOG_DIR;
  delete process.env.ANXHUB_CONFIG_DIR;
  delete process.env.NODE_ENV;
  const roaming = path.join(temp, "Roaming");
  const fakeRuntimeRoot = path.join(temp, "runtime");
  fs.mkdirSync(path.join(fakeRuntimeRoot, "agent", "src"), { recursive: true });
  const stub = installElectronStub({
    isPackaged: true,
    appPath: fakeRuntimeRoot,
    paths: {
      appData: roaming,
      userData: path.join(roaming, "AnxOS Control Center"),
      temp: path.join(temp, "Temp"),
    },
  });
  const agentLogDir = path.join(roaming, "AnxHub", "logs");
  fs.mkdirSync(agentLogDir, { recursive: true });
  const agentLatest = JSON.stringify({ source: "agent", message: "AGENT ORIGINAL" });
  fs.writeFileSync(path.join(agentLogDir, "latest-error.json"), agentLatest);
  try {
    // main.js order: accountAuthIpc (which requires diagnosticsService) loads
    // before configureElectronPaths moves userData to %APPDATA%\AnxHub.
    const diagnostics = require(path.join(root, "src", "services", "diagnosticsService.js"));
    const { configureElectronPaths } = require(path.join(root, "src", "services", "electronPaths.js"));
    configureElectronPaths(stub.electron.app);
    assert.strictEqual(stub.paths.userData, path.join(roaming, "AnxHub"), "the stub moved userData like Electron");

    diagnostics.log("error", "desktop", "smoke-error", "desktop failure for the smoke", {}, { file: "desktop" });
    await diagnostics.openFolder();
    const read = diagnostics.readLogs();
    const loggerDir = diagnostics.logger.directory;
    assert.strictEqual(diagnostics.getDirectory(), loggerDir, `getDirectory() is the folder the logger writes to (${diagnostics.getDirectory()} vs ${loggerDir})`);
    assert.strictEqual(stub.opened[0], loggerDir, `Open logs folder opens the desktop log folder (${stub.opened[0]})`);
    assert.strictEqual(read.directory, loggerDir, "the reported log directory is the desktop log folder");
    assert.ok(fs.existsSync(path.join(loggerDir, "desktop.log")), "desktop.log is in the reported folder");
    const desktopLatest = JSON.parse(fs.readFileSync(path.join(loggerDir, "latest-error.json"), "utf8"));
    assert.strictEqual(desktopLatest.message, "desktop failure for the smoke", "the desktop latest-error.json is in the desktop folder");
    assert.ok(desktopLatest.runtimeState, "the enriched latest-error.json is in the desktop folder");
    assert.notStrictEqual(path.resolve(loggerDir), path.resolve(agentLogDir), "the desktop does not share the Agent's log folder");
    assert.strictEqual(fs.readFileSync(path.join(agentLogDir, "latest-error.json"), "utf8"), agentLatest, "the Agent's latest-error.json is left alone");
    assert.deepStrictEqual(fs.readdirSync(agentLogDir), ["latest-error.json"], "no desktop file appears in the Agent's log folder");
    const summary = JSON.parse(await diagnostics.copySummary());
    assert.strictEqual(summary.latestError?.message, "desktop failure for the smoke", "Copy summary reports the desktop's own latest error");

    // Agent Control must advertise the folder the Agent derives for itself
    // (agent/src/services/diagnosticsLogger.js): outside a checkout that is
    // <dirname(ANXHUB_CONFIG_DIR)>\logs. AGENT_LOG_DIR and the storage
    // diagnostics both come from getAgentLogsDirectory().
    const agentControl = require(path.join(root, "src", "services", "agentControlService.js"));
    const env = agentControl._test.agentEnvironment(agentControl.readConfig());
    const agentDerived = env.ANXOS_LOG_DIR || path.join(path.dirname(env.ANXHUB_CONFIG_DIR), "logs");
    assert.strictEqual(path.resolve(env.AGENT_LOG_DIR), path.resolve(agentDerived), `Agent Control advertises the Agent's real log folder (${env.AGENT_LOG_DIR} vs ${agentDerived})`);
    assert.strictEqual(path.resolve(agentDerived), path.resolve(agentLogDir), "outside a checkout the Agent writes to %APPDATA%\\AnxHub\\logs");
  } finally {
    removeTemp(temp);
  }
}

// O3 -----------------------------------------------------------------------
async function checkNoDuplicateEntries() {
  const temp = makeTemp("o3");
  process.env.ANXOS_LOG_DIR = path.join(temp, "logs");
  process.env.ANXHUB_CONFIG_DIR = path.join(temp, "config");
  const savePath = path.join(temp, "bundle.json");
  installElectronStub({ isPackaged: true, savePath, paths: { userData: path.join(temp, "userData"), appData: temp, temp } });
  try {
    const diagnostics = require(path.join(root, "src", "services", "diagnosticsService.js"));
    for (let index = 0; index < 5; index += 1) diagnostics.log("info", "renderer", "smoke", `renderer ${index}`, {}, { file: "renderer" });
    for (let index = 0; index < 5; index += 1) diagnostics.log("info", "desktop", "smoke", `desktop ${index}`, {}, { file: "desktop" });
    for (let index = 0; index < 5; index += 1) diagnostics.log("info", "agent-control", "smoke", `agent-control ${index}`, {}, { file: "agent-control" });
    const countBy = (entries, prefix) => entries.filter((entry) => new RegExp(`^${prefix}\\d+$`).test(String(entry.message))).length;
    const viewer = diagnostics.readLogs({ limit: 400 }).entries;
    assert.strictEqual(countBy(viewer, "renderer "), 5, `the viewer lists renderer entries once (${countBy(viewer, "renderer ")})`);
    assert.strictEqual(countBy(viewer, "desktop "), 5, `the viewer lists desktop entries once (${countBy(viewer, "desktop ")})`);
    assert.strictEqual(countBy(viewer, "agent-control "), 5, "entries only in live.log are still listed");
    const paired = diagnostics.readLogs({ sources: ["desktop", "live"], limit: 400 }).entries;
    assert.strictEqual(countBy(paired, "desktop "), 5, "a subsystem plus live.log lists each entry once");

    diagnostics.log("error", "desktop", "smoke-error", "desktop failure", {}, { file: "desktop" });
    const latest = JSON.parse(fs.readFileSync(path.join(process.env.ANXOS_LOG_DIR, "latest-error.json"), "utf8"));
    assert.strictEqual(latest.recentRelatedEntries.filter((entry) => entry.message === "desktop failure").length, 1, "latest-error.json context lists the failure once");
    assert.strictEqual(countBy(latest.recentRelatedEntries, "desktop "), 5, "latest-error.json context lists earlier entries once");

    const result = await diagnostics.exportBundle();
    assert.strictEqual(result.exported, true, "the bundle is exported");
    const bundle = JSON.parse(fs.readFileSync(savePath, "utf8"));
    const keys = bundle.logs.map((entry) => JSON.stringify([entry.timestamp, entry.source, entry.operation, entry.message]));
    assert.strictEqual(new Set(keys).size, keys.length, `the export bundle has no duplicate entries (${keys.length - new Set(keys).size} duplicates)`);
  } finally {
    removeTemp(temp);
  }
}

// O4 -----------------------------------------------------------------------
async function checkAuditPersisted() {
  const temp = makeTemp("o4");
  process.env.ANXOS_LOG_DIR = path.join(temp, "logs");
  const agentDiagnostics = require(path.join(root, "agent", "src", "services", "diagnosticsLogger.js"));
  const { auditAction } = require(path.join(root, "agent", "src", "audit", "auditLogger.js"));
  const stdoutLines = [];
  const originalInfo = console.info;
  console.info = (line) => { stdoutLines.push(String(line)); };
  let scopeId = null;
  try {
    const request = { socket: { remoteAddress: "127.0.0.1" }, headers: { "user-agent": "smoke Agent/Bearer audit-secret-token" } };
    agentDiagnostics.withOperationScope("agent-action", () => {
      scopeId = agentDiagnostics.currentCorrelationId();
      auditAction(request, { actionId: "docker.restart", permission: "docker:manage", outcome: "completed", reason: null });
    });
    auditAction(request, { actionId: "agent.restart", permission: "agent:manage", outcome: "denied", reason: "PERMISSION_DENIED" });
  } finally {
    console.info = originalInfo;
  }
  try {
    assert.strictEqual(stdoutLines.length, 2, "the stdout audit line is kept for journald");
    const directory = process.env.ANXOS_LOG_DIR;
    const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith(".log") && name !== "live.log") : [];
    const records = files.flatMap((name) => readJsonLines(path.join(directory, name)))
      .filter((entry) => entry.operation === "agent-action-audit");
    assert.strictEqual(records.length, 2, `both audit records are in the Agent's log folder (${records.length} in ${files.join(", ") || "no files"})`);
    const allowed = records.find((entry) => entry.context?.actionId === "docker.restart");
    const denied = records.find((entry) => entry.context?.actionId === "agent.restart");
    assert.ok(allowed && denied, "each audit record keeps its actionId");
    assert.strictEqual(allowed.context.outcome, "completed", "the allowed record keeps its outcome");
    assert.strictEqual(denied.context.outcome, "denied", "the denied record keeps its outcome");
    assert.strictEqual(denied.context.reason, "PERMISSION_DENIED", "the denied record keeps its reason");
    assert.strictEqual(allowed.correlationId, scopeId, "the audit record carries the operation's correlation id");
    assert.ok(!JSON.stringify(records).includes("audit-secret-token"), "the persisted audit records are redacted");
  } finally {
    removeTemp(temp);
  }
}

const CHECKS = [
  ["observability-1", "game server console log keeps output order and whole lines", checkConsoleLogOrder],
  ["observability-2", "desktop diagnostics use one log folder, apart from the Agent's", checkDesktopLogFolder],
  ["observability-3", "diagnostics list each log entry once", checkNoDuplicateEntries],
  ["observability-4", "Agent action audit records are persisted in the Agent log folder", checkAuditPersisted],
];

async function runCase(id) {
  const check = CHECKS.find(([checkId]) => checkId === id);
  if (!check) throw new Error(`Unknown check ${id}`);
  await check[2]();
}

function main() {
  let failed = 0;
  CHECKS.forEach(([id, label], index) => {
    const result = childProcess.spawnSync(process.execPath, [__filename, "--case", id], {
      cwd: root,
      env: { ...process.env, AGENT_URL: process.env.AGENT_URL || "http://127.0.0.1:9" },
      encoding: "utf8",
      timeout: 120000,
    });
    if (result.status === 0) {
      console.log(`PASS O${index + 1} ${id}: ${label}`);
    } else {
      failed += 1;
      console.error(`FAIL O${index + 1} ${id}: ${label}`);
      console.error(String(result.stderr || result.error || "").trim().split(/\r?\n/).slice(0, 12).join("\n"));
    }
  });
  if (failed) {
    console.error(`Observability hardening smoke failed: ${failed} of ${CHECKS.length} checks.`);
    process.exit(1);
  }
  console.log(`Observability hardening smoke passed (${CHECKS.length} checks).`);
}

if (process.argv[2] === "--case") {
  runCase(process.argv[3]).then(() => process.exit(0), (error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
} else {
  main();
}
