#!/usr/bin/env node
// Second-machine acceptance wrapper.
//
// Runs the three interactive Electron acceptance harnesses in a fixed order and
// packages their machine-readable outcome into one self-contained directory so a
// second Windows machine can produce independent replication evidence:
//
//   qa:acceptance  scripts/qa-acceptance.js
//   qa:onboarding  scripts/onboarding-fresh-install-smoke.js
//   qa:responsive  scripts/responsive-mobile-ui-qa.js
//
// Each harness is launched exactly like its npm alias does (`node <script>` with
// cwd = repository root) and is never modified by this wrapper. The wrapper:
//   - records commit, node version, platform and (optionally) the packaged
//     executable SHA-256,
//   - copies each harness artifact directory into <out>/<harness>/ and removes
//     the checkout copy afterwards so the repository keeps no run residue,
//   - redacts token-like strings from captured harness output,
//   - always writes <out>/summary.json, including when a harness crashes or
//     times out (a crash/timeout is a FAIL entry, never a hang),
//   - exits non-zero unless every selected harness passed.
//
// Usage:
//   node scripts/second-machine-acceptance.js --out <dir> [--executable <path>]
//     [--skip-onboarding] [--skip-responsive] [--label <machine-label>]

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const HARNESS_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 15 * 1000;
const MAX_SUMMARY_ENTRIES = 50;
const TIMESTAMP_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const RESPONSIVE_PREFIX = "responsive-mobile-";

const HARNESSES = [
  {
    key: "qaAcceptance",
    dirName: "qa-acceptance",
    script: "scripts/qa-acceptance.js",
    artifactParent: () => path.join(root, "artifacts", "qa"),
    isArtifactName: (name) => TIMESTAMP_DIR.test(name),
    skip: () => false,
  },
  {
    key: "onboarding",
    dirName: "onboarding",
    script: "scripts/onboarding-fresh-install-smoke.js",
    artifactParent: () => path.join(root, "artifacts", "onboarding"),
    isArtifactName: (name) => TIMESTAMP_DIR.test(name),
    skip: (options) => options.skipOnboarding,
  },
  {
    key: "responsive",
    dirName: "responsive",
    script: "scripts/responsive-mobile-ui-qa.js",
    artifactParent: () => path.join(root, "artifacts", "qa"),
    isArtifactName: (name) => name.startsWith(RESPONSIVE_PREFIX) && TIMESTAMP_DIR.test(name.slice(RESPONSIVE_PREFIX.length)),
    skip: (options) => options.skipResponsive,
  },
];

const USAGE = [
  "Usage: node scripts/second-machine-acceptance.js --out <dir> [options]",
  "",
  "Options:",
  "  --out <dir>          Required. Fresh output directory for summary.json and copied artifacts.",
  "  --executable <path>  Optional packaged build; sets ANXOS_QA_EXECUTABLE for qa:acceptance and records its SHA-256.",
  "  --label <label>      Machine label recorded in summary.json (default: this machine's hostname).",
  "  --skip-onboarding    Skip the onboarding fresh-install harness.",
  "  --skip-responsive    Skip the responsive mobile UI harness.",
  "  --help               Show this help.",
].join("\n");

// Mirrors the redaction the harnesses apply to their own artifacts. The Bearer
// rule runs first so a dangling "Bearer <value>" fragment is not left behind by
// the key/value rule, which stops at the first whitespace.
function redact(value) {
  return String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(authorization|token|password|secret|api[_-]?key|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function nextValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseArgs(argv) {
  const options = { out: null, executable: null, label: null, skipOnboarding: false, skipResponsive: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") options.out = nextValue(argv, ++index, "--out");
    else if (arg === "--executable") options.executable = nextValue(argv, ++index, "--executable");
    else if (arg === "--label") options.label = nextValue(argv, ++index, "--label");
    else if (arg === "--skip-onboarding") options.skipOnboarding = true;
    else if (arg === "--skip-responsive") options.skipResponsive = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && !options.out) throw new Error("--out <dir> is required.");
  return options;
}

function prepareOutDir(outDir) {
  if (fs.existsSync(outDir)) {
    if (!fs.statSync(outDir).isDirectory()) throw new Error(`--out is not a directory: ${outDir}`);
    if (fs.readdirSync(outDir).length > 0) {
      throw new Error(`--out directory is not empty: ${outDir}. Use a fresh directory so the summary cannot mix runs.`);
    }
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
}

function readGitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status === 0 && result.stdout) return result.stdout.trim();
  return null;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function listArtifactDirectories(harness) {
  try {
    return fs.readdirSync(harness.artifactParent(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && harness.isArtifactName(entry.name))
      .map((entry) => path.join(harness.artifactParent(), entry.name));
  } catch {
    return [];
  }
}

function killProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  try { process.kill(child.pid, "SIGKILL"); } catch {}
}

// Launches one harness with the same contract as its npm alias: `node <script>`
// from the repository root. A timeout kills the whole process tree (the harness
// itself may have spawned an Electron app) and is reported as a FAIL entry.
function runHarnessProcess(harness, options) {
  return new Promise((resolve) => {
    const before = new Set(listArtifactDirectories(harness));
    const child = spawn(process.execPath, [harness.script], {
      cwd: root,
      env: {
        ...process.env,
        ANXOS_QA_MODE: "1",
        ...(options.executable ? { ANXOS_QA_EXECUTABLE: options.executable } : {}),
      },
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let graceTimer = null;

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ exitCode, signal: signal || null, timedOut, stdout, stderr, before });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      graceTimer = setTimeout(() => finish(null, "SIGKILL"), KILL_GRACE_MS);
    }, HARNESS_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      stderr += `\n[wrapper] unable to start harness: ${error.message}\n`;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

// The harnesses print their machine-readable result as the final JSON object on
// stdout (`console.log(JSON.stringify(...))`), so the last line that opens a JSON
// object is the safest extraction point when extra log lines surround it.
function extractHarnessJson(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith("{")) continue;
    try {
      return JSON.parse(lines.slice(index).join("\n").trim());
    } catch {}
  }
  return null;
}

function resolveArtifactDir(harness, before, parsed) {
  const parsedDir = parsed && typeof parsed.artifactDir === "string" ? path.resolve(parsed.artifactDir) : null;
  if (parsedDir && fs.existsSync(parsedDir)
    && path.resolve(path.dirname(parsedDir)) === path.resolve(harness.artifactParent())
    && harness.isArtifactName(path.basename(parsedDir))) {
    return parsedDir;
  }
  const fresh = listArtifactDirectories(harness).filter((dir) => !before.has(dir));
  fresh.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return fresh[0] || null;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function capSummaryList(list) {
  return list.slice(0, MAX_SUMMARY_ENTRIES);
}

// Copies the harness artifact directory into <out>/<harness>/ and removes the
// checkout copy only after every top-level entry is present in the destination.
// If the copy is incomplete the source is retained and reported in the summary.
function stashArtifactDirectory(harness, sourceDir, outDir) {
  const dest = path.join(outDir, harness.dirName);
  fs.mkdirSync(dest, { recursive: true });
  if (!sourceDir || !fs.existsSync(sourceDir)) return { artifactDir: null, copied: false, sourceRetained: null };
  const sourceEntries = fs.readdirSync(sourceDir);
  fs.cpSync(sourceDir, dest, { recursive: true });
  const copiedEntries = new Set(fs.readdirSync(dest));
  const missing = sourceEntries.filter((name) => !copiedEntries.has(name));
  if (missing.length > 0) return { artifactDir: dest, copied: false, sourceRetained: sourceDir, missing };
  try {
    fs.rmSync(sourceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
  return { artifactDir: dest, copied: true, sourceRetained: fs.existsSync(sourceDir) ? sourceDir : null };
}

function writeRunnerConsole(dest, harness, run) {
  if (!dest) return;
  const sections = [
    `# second-machine-acceptance // ${harness.key}`,
    `# script: ${harness.script}`,
    `# exitCode=${run.exitCode} signal=${run.signal || "none"} timedOut=${run.timedOut}`,
    "",
    "# stdout",
    redact(run.stdout).trimEnd(),
    "",
    "# stderr",
    redact(run.stderr).trimEnd(),
    "",
  ];
  fs.writeFileSync(path.join(dest, "runner-console.log"), sections.join("\n"));
}

function failedNames(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item.name === "string") return item.name;
    return JSON.stringify(item);
  });
}

function buildQaAcceptanceEntry({ run, parsed, results, rendererErrorLines, stash }) {
  const failedResults = results && Array.isArray(results.failedResults)
    ? failedNames(results.failedResults)
    : failedNames(parsed && parsed.failedResults);
  const rendererErrors = rendererErrorLines.length
    ? rendererErrorLines
    : (parsed && Array.isArray(parsed.rendererErrors) ? parsed.rendererErrors : []);
  const reportedPass = results ? results.pass === true : parsed ? parsed.pass === true : false;
  const pass = run.exitCode === 0 && reportedPass && !run.timedOut;
  const entry = {
    pass,
    artifactDir: stash.artifactDir,
    failedResults: capSummaryList(failedResults),
    rendererErrors: capSummaryList(rendererErrors.map(redact)),
  };
  if (run.timedOut) entry.reason = "timeout";
  else if (!results && !parsed) entry.reason = "no-result-data";
  if (stash.sourceRetained) entry.sourceRetained = stash.sourceRetained;
  return entry;
}

function buildOnboardingEntry({ run, parsed, checks, stash }) {
  let status = "FAIL";
  let checkCount = null;
  let failed = [];
  if (checks) {
    checkCount = checks.length;
    failed = checks.filter((entry) => entry?.pass !== true).map((entry) => entry?.name || JSON.stringify(entry));
    status = run.exitCode === 0 && failed.length === 0 && !run.timedOut ? "PASS" : "FAIL";
  } else if (parsed && typeof parsed.status === "string") {
    status = run.exitCode === 0 && !run.timedOut && parsed.status === "PASS" ? "PASS" : "FAIL";
    checkCount = Number.isFinite(parsed.checks) ? parsed.checks : null;
    failed = Array.isArray(parsed.failed) ? parsed.failed.map(String) : [];
  }
  const entry = { status, checks: checkCount, failed: capSummaryList(failed), artifactDir: stash.artifactDir };
  if (run.timedOut) entry.reason = "timeout";
  else if (!checks && !parsed) entry.reason = "no-result-data";
  if (stash.sourceRetained) entry.sourceRetained = stash.sourceRetained;
  return entry;
}

function normalizeResponsiveList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      const label = [item?.viewport, item?.page].filter(Boolean).join("/");
      return label || JSON.stringify(item);
    });
  }
  if (typeof value === "number" && Number.isFinite(value)) return [`${value} reported (detail unavailable)`];
  return [];
}

function buildResponsiveEntry({ run, parsed, results, stash }) {
  const source = results && typeof results === "object" ? results : parsed && typeof parsed === "object" ? parsed : null;
  const reportedPass = source ? source.pass === true : null;
  const pass = run.exitCode === 0 && reportedPass === true && !run.timedOut;
  const entry = {
    pass,
    artifactDir: stash.artifactDir,
    checks: source && Number.isFinite(source.checks) ? source.checks : null,
    failures: capSummaryList(normalizeResponsiveList(source && source.failures)),
    rendererErrors: capSummaryList(normalizeResponsiveList(source && source.rendererErrors).map(redact)),
  };
  if (run.timedOut) entry.reason = "timeout";
  else if (reportedPass === null) entry.reason = "no-result-data";
  if (stash.sourceRetained) entry.sourceRetained = stash.sourceRetained;
  return entry;
}

async function executeHarness(harness, options, outDir) {
  process.stdout.write(`[second-machine] ${harness.key}: running ${harness.script} (timeout ${Math.round(HARNESS_TIMEOUT_MS / 60000)}m)\n`);
  const run = await runHarnessProcess(harness, options);
  const parsed = extractHarnessJson(run.stdout);
  const sourceDir = resolveArtifactDir(harness, run.before, parsed);
  const stash = stashArtifactDirectory(harness, sourceDir, outDir);
  writeRunnerConsole(stash.artifactDir, harness, run);
  const resultsFile = stash.artifactDir ? readJsonFile(path.join(stash.artifactDir, "results.json")) : null;

  let entry;
  if (harness.key === "qaAcceptance") {
    const rendererLines = stash.artifactDir ? readLines(path.join(stash.artifactDir, "renderer-console.log")) : [];
    entry = buildQaAcceptanceEntry({
      run,
      parsed,
      results: resultsFile && !Array.isArray(resultsFile) ? resultsFile : null,
      rendererErrorLines: rendererLines,
      stash,
    });
  } else if (harness.key === "onboarding") {
    entry = buildOnboardingEntry({ run, parsed, checks: Array.isArray(resultsFile) ? resultsFile : null, stash });
  } else {
    entry = buildResponsiveEntry({ run, parsed, results: resultsFile && !Array.isArray(resultsFile) ? resultsFile : null, stash });
  }

  const verdict = harness.key === "onboarding" ? entry.status : entry.pass ? "PASS" : "FAIL";
  process.stdout.write(`[second-machine] ${harness.key}: ${verdict}${entry.reason ? ` (${entry.reason})` : ""}${stash.artifactDir ? ` artifacts=${stash.artifactDir}` : ""}\n`);
  return entry;
}

function harnessPassed(entry) {
  if (entry?.skipped) return true;
  if (typeof entry?.status === "string") return entry.status === "PASS";
  return entry?.pass === true;
}

function writeSummary(outDir, summary) {
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[second-machine] ${error.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const outDir = path.resolve(options.out);
  try {
    prepareOutDir(outDir);
  } catch (error) {
    process.stderr.write(`[second-machine] ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  const summary = {
    commit: readGitCommit(),
    label: options.label || os.hostname(),
    platform: process.platform,
    node: process.version,
    executableSha256: null,
    startedAt: new Date().toISOString(),
    harnesses: {},
    status: "FAIL",
  };

  if (options.executable) {
    const executablePath = path.resolve(options.executable);
    if (!fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile()) {
      summary.harnesses = Object.fromEntries(HARNESSES.map((harness) => [harness.key, { status: "SKIPPED", reason: "not-run" }]));
      summary.error = `--executable not found: ${executablePath}`;
      writeSummary(outDir, summary);
      process.stderr.write(`[second-machine] ${summary.error}\n`);
      process.exitCode = 2;
      return;
    }
    summary.executableSha256 = await sha256File(executablePath);
  }

  for (const harness of HARNESSES) {
    if (harness.skip(options)) {
      summary.harnesses[harness.key] = { skipped: true, status: "SKIPPED" };
      process.stdout.write(`[second-machine] ${harness.key}: SKIPPED\n`);
      continue;
    }
    try {
      summary.harnesses[harness.key] = await executeHarness(harness, options, outDir);
    } catch (error) {
      summary.harnesses[harness.key] = { pass: false, reason: "wrapper-error", error: redact(error?.message || String(error)) };
    }
  }

  summary.status = Object.values(summary.harnesses).every(harnessPassed) ? "PASS" : "FAIL";
  writeSummary(outDir, summary);
  process.stdout.write(`[second-machine] status: ${summary.status}\n[second-machine] summary: ${path.join(outDir, "summary.json")}\n`);
  process.exitCode = summary.status === "PASS" ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`[second-machine] fatal: ${redact(error?.stack || error?.message || error)}\n`);
  process.exitCode = 2;
});