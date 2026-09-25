#!/usr/bin/env node
const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const asar = require("@electron/asar");
const { buildReleaseInfo, readReleaseConfig } = require("../src/shared/releaseConfig");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const releaseConfig = readReleaseConfig();
const releaseInfo = buildReleaseInfo(releaseConfig);
const artifactVersion = releaseInfo.artifactVersion;

const platformTargets = {
  win: {
    artifacts: [
      `AnxOS-Control-Center-Setup-${artifactVersion}.exe`,
      `AnxOS-Control-Center-${artifactVersion}-portable.exe`,
    ],
    asarArchives: [path.join(distDir, "win-unpacked", "resources", "app.asar")],
    requiredPaths: [
      path.join(distDir, "win-unpacked", "AnxOS Control Center.exe"),
      path.join(distDir, "win-unpacked", "resources", "app.asar.unpacked"),
      path.join(distDir, "win-unpacked", "resources", "local-agent-runtime", "agent", "package.json"),
      path.join(distDir, "win-unpacked", "resources", "local-agent-runtime", "agent", "src", "server.js"),
      path.join(distDir, "win-unpacked", "resources", "local-agent-runtime", "src", "services", "ampService.js"),
      path.join(distDir, "win-unpacked", "resources", "local-agent-runtime", "node_modules", "dotenv", "package.json"),
      path.join(distDir, "win-unpacked", "resources", "local-agent-runtime", "config", "agent.example.json"),
      path.join(distDir, "win-unpacked", "resources", "local-agent-runtime", "config", "marketplace-templates.json"),
      path.join(distDir, "win-unpacked", "resources", "local-agent-runtime", "local-agent-runtime.json"),
    ],
  },
  linux: {
    artifacts: [
      `AnxOS-Control-Center-${artifactVersion}.AppImage`,
      `AnxOS-Control-Center-${artifactVersion}.deb`,
    ],
    asarArchives: [path.join(distDir, "linux-unpacked", "resources", "app.asar")],
    requiredPaths: [
      path.join(distDir, "linux-unpacked", "anxos-control-center"),
      path.join(distDir, "linux-unpacked", "resources", "app.asar.unpacked"),
      path.join(distDir, "linux-unpacked", "resources", "local-agent-runtime", "agent", "package.json"),
      path.join(distDir, "linux-unpacked", "resources", "local-agent-runtime", "agent", "src", "server.js"),
      path.join(distDir, "linux-unpacked", "resources", "local-agent-runtime", "src", "services", "ampService.js"),
      path.join(distDir, "linux-unpacked", "resources", "local-agent-runtime", "node_modules", "dotenv", "package.json"),
      path.join(distDir, "linux-unpacked", "resources", "local-agent-runtime", "config", "agent.example.json"),
      path.join(distDir, "linux-unpacked", "resources", "local-agent-runtime", "config", "marketplace-templates.json"),
      path.join(distDir, "linux-unpacked", "resources", "local-agent-runtime", "local-agent-runtime.json"),
    ],
  },
};

function parseTargets() {
  const platformArg = process.argv.find((arg) => arg.startsWith("--platform="));
  // Default to the host platform. A hardcoded "win,linux" default made the whole
  // check skip (exit 0, PRECONDITION_NOT_MET) whenever the other platform's
  // artifacts were absent, so rc:validate's packaging:smoke step never validated
  // a local candidate and Windows packaging stayed ungated. Explicit --platform
  // or ANXOS_PACKAGING_SMOKE_TARGETS still select any combination.
  const defaultTargets = process.platform === "win32" ? "win" : "linux";
  const raw = (platformArg ? platformArg.slice("--platform=".length) : process.env.ANXOS_PACKAGING_SMOKE_TARGETS || defaultTargets)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const targets = raw.map((entry) => entry === "windows" ? "win" : entry);
  for (const target of targets) {
    assert(platformTargets[target], `Unknown packaging smoke platform target: ${target}`);
  }
  return [...new Set(targets)];
}

const selectedTargets = parseTargets();
const selectedTargetConfigs = selectedTargets.map((target) => platformTargets[target]);
const requireArtifacts = process.argv.includes("--require-artifacts");

const requiredEntries = [
  "/main.js",
  "/preload.js",
  "/app.js",
  "/index.html",
  "/release.json",
  "/release-build.json",
  "/assets/icon.ico",
  "/assets/icons/png/512x512.png",
  "/config/agent.example.json",
  "/config/marketplace-templates.json",
  "/config/ssh-profiles.json",
  "/src/shared/redaction.js",
  "/src/shared/structuredLogger.js",
  "/src/shared/releaseConfig.js",
  "/src/shared/longOperationService.js",
  "/src/shared/dockerService.js",
  "/src/services/agentControlService.js",
  "/src/services/diagnosticsService.js",
  "/src/services/providers/curseforgeProvider.js",
];

const forbiddenEntries = [
  "/agent/.env",
  "/agent/agent.log",
  "/agent/config/device-identity.json",
  "/config/agent.json",
  "/config/application-host.json",
  "/config/device-identity.json",
  "/config/marketplace.json",
  "/config/nodes.json",
  "/config/owner-accounts.json",
];

const forbiddenRuntimeNames = new Set([
  ".env",
  ".git",
  "agent.log",
  "device-identity.json",
  "application-host.json",
  "nodes.json",
  "owner-accounts.json",
]);

// @electron/asar v3 listPackage() emits entries with a leading backslash on
// Windows (e.g. "\main.js") while the expected lists use "/main.js", so every
// asar entry and expected entry must be separator-normalized before comparison.
function normalizeAsarEntry(entry) {
  return String(entry).replace(/\\/g, "/").replace(/^\/+/, "");
}

// Regression leg: a synthetic Windows-style listing must normalize to the
// slash-delimited names and still match the required/forbidden entries, so the
// path-separator fix cannot silently regress on Windows.
function assertAsarEntryNormalization() {
  const normalized = ["\\main.js", "/app.js"].map(normalizeAsarEntry);
  assert.deepStrictEqual(normalized, ["main.js", "app.js"], "asar entry normalization must convert separators and strip leading separators.");
  const requiredEntryNames = new Set(requiredEntries.map(normalizeAsarEntry));
  for (const entry of normalized) {
    assert(requiredEntryNames.has(entry), `asar entry normalization must still match required entry ${entry}`);
  }
  const forbiddenEntryNames = new Set(forbiddenEntries.map(normalizeAsarEntry));
  assert(forbiddenEntryNames.has("agent/.env"), "asar entry normalization must apply to forbidden entry comparison.");
}

assertAsarEntryNormalization();

function walkFiles(directory) {
  const entries = [];
  if (!fs.existsSync(directory)) return entries;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    entries.push(entryPath);
    if (entry.isDirectory()) {
      entries.push(...walkFiles(entryPath));
    }
  }
  return entries;
}

// The desktop dependency scan must read code, not documentation: a
// `require("...")` that appears only inside a comment is not a loadable
// dependency, but a plain regex would report it as missing. Strip line and
// block comments while preserving string literals so URLs ("https://...") and
// other string content are not truncated.
function stripSourceComments(source) {
  const output = [];
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") { state = "line"; index += 1; continue; }
      if (char === "/" && next === "*") { state = "block"; index += 1; continue; }
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";
      output.push(char);
    } else if (state === "line") {
      if (char === "\n") { state = "code"; output.push(char); }
    } else if (state === "block") {
      if (char === "*" && next === "/") { state = "code"; index += 1; }
      else if (char === "\n") output.push(char);
    } else {
      output.push(char);
      if (char === "\\") { output.push(next || ""); index += 1; }
      else if ((state === "single" && char === "'") || (state === "double" && char === '"') || (state === "template" && char === "`")) state = "code";
    }
  }
  return output.join("");
}

function localRequireRequests(source) {
  return [...stripSourceComments(source).matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
}

// Regression leg: commented requires must not be treated as loadable
// dependencies, so this cannot silently regress into the comment false-positive.
function assertDependencyScanIgnoresComments() {
  const sample = 'const kept = require("./kept"); // require("./line-comment")\n/* require("./block-comment") */';
  assert.deepStrictEqual(localRequireRequests(sample), ["./kept"], "desktop dependency scan must ignore requires inside comments.");
}

assertDependencyScanIgnoresComments();

function assertDesktopDependencyGraph(archivePath) {
  const extractedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-desktop-runtime-"));
  const visited = new Set();
  const missing = [];
  function resolveLocal(fromFile, request) {
    const base = path.resolve(path.dirname(fromFile), request);
    return [base, `${base}.js`, `${base}.json`, path.join(base, "index.js")]
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
  }
  function visit(filePath) {
    const resolvedPath = path.resolve(filePath);
    if (visited.has(resolvedPath)) return;
    visited.add(resolvedPath);
    if (path.extname(resolvedPath) === ".json") return;
    const source = fs.readFileSync(resolvedPath, "utf8");
    for (const request of localRequireRequests(source)) {
      if (!request.startsWith(".")) continue;
      const dependency = resolveLocal(resolvedPath, request);
      if (dependency) visit(dependency);
      else missing.push(`${path.relative(extractedRoot, resolvedPath)} -> ${request}`);
    }
  }
  try {
    asar.extractAll(archivePath, extractedRoot);
    visit(path.join(extractedRoot, "main.js"));
    visit(path.join(extractedRoot, "preload.js"));
    assert.deepStrictEqual(missing, [], `${path.relative(rootDir, archivePath)} has missing local desktop dependencies:\n${missing.join("\n")}`);
    assert([...visited].some((entry) => entry.includes(`${path.sep}src${path.sep}services${path.sep}`)), `${path.relative(rootDir, archivePath)} desktop dependency graph did not resolve src/services.`);
  } finally {
    fs.rmSync(extractedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const expectedArtifactPaths = selectedTargetConfigs
  .flatMap((target) => target.artifacts)
  .map((artifact) => path.join(distDir, artifact));
const missingArtifacts = expectedArtifactPaths.filter((artifactPath) => !fs.existsSync(artifactPath));
if (missingArtifacts.length && !requireArtifacts) {
  console.log(JSON.stringify({
    status: "PRECONDITION_NOT_MET",
    check: "packaging-artifacts",
    artifactVersion,
    targets: selectedTargets,
    missing: missingArtifacts.map((artifactPath) => path.relative(rootDir, artifactPath)),
    nextCommand: `npm run artifacts:validate -- --platform=${selectedTargets.join(",")}`,
  }, null, 2));
  process.exit(0);
}

for (const artifact of selectedTargetConfigs.flatMap((target) => target.artifacts)) {
  const artifactPath = path.join(distDir, artifact);
  assert(fs.existsSync(artifactPath), `Missing packaged artifact: ${artifact}`);
  assert(fs.statSync(artifactPath).size > 1024 * 1024, `Packaged artifact is unexpectedly small: ${artifact}`);
}

for (const archivePath of selectedTargetConfigs.flatMap((target) => target.asarArchives)) {
  assert(fs.existsSync(archivePath), `Missing app.asar: ${path.relative(rootDir, archivePath)}`);
  const entries = new Set(asar.listPackage(archivePath).map(normalizeAsarEntry));

  for (const entry of requiredEntries) {
    assert(entries.has(normalizeAsarEntry(entry)), `${path.relative(rootDir, archivePath)} is missing ${entry}`);
  }

  for (const entry of forbiddenEntries) {
    assert(!entries.has(normalizeAsarEntry(entry)), `${path.relative(rootDir, archivePath)} must not include runtime file ${entry}`);
  }

  const release = JSON.parse(asar.extractFile(archivePath, "release.json").toString("utf8"));
  assert.strictEqual(release.version, releaseConfig.version, `${path.relative(rootDir, archivePath)} has unexpected release version`);
  assert.strictEqual(release.build, releaseConfig.build, `${path.relative(rootDir, archivePath)} has unexpected build number`);
  assert.strictEqual(release.channel, releaseConfig.channel, `${path.relative(rootDir, archivePath)} has unexpected release channel`);

  const buildMetadata = JSON.parse(asar.extractFile(archivePath, "release-build.json").toString("utf8"));
  assert.strictEqual(buildMetadata.version, releaseConfig.version, `${path.relative(rootDir, archivePath)} has unexpected release metadata version`);
  assert.strictEqual(buildMetadata.build, releaseConfig.build, `${path.relative(rootDir, archivePath)} has unexpected release metadata build`);
  assert.strictEqual(buildMetadata.channel, releaseConfig.channel, `${path.relative(rootDir, archivePath)} has unexpected release metadata channel`);
  assert(buildMetadata.buildDate, `${path.relative(rootDir, archivePath)} release metadata must include a build date`);
  assert(buildMetadata.gitCommit, `${path.relative(rootDir, archivePath)} release metadata must include a git commit`);
  assert.strictEqual(buildMetadata.releaseRepository?.repo, "AnxOS-Control-Center-Releases", `${path.relative(rootDir, archivePath)} release metadata must use the public release repository`);
  assertDesktopDependencyGraph(archivePath);
}

for (const requiredPath of selectedTargetConfigs.flatMap((target) => target.requiredPaths)) {
  assert(fs.existsSync(requiredPath), `Missing packaged path: ${path.relative(rootDir, requiredPath)}`);
}

for (const target of selectedTargets) {
  const resourcesDir = target === "win"
    ? path.join(distDir, "win-unpacked", "resources")
    : path.join(distDir, "linux-unpacked", "resources");
  const runtimeRoot = path.join(resourcesDir, "local-agent-runtime");
  if (!fs.existsSync(runtimeRoot)) continue;
  assert.notStrictEqual(runtimeRoot, path.join(resourcesDir, "app.asar"), "Desktop and Local Agent runtime roots must remain separate.");
  for (const entryPath of walkFiles(runtimeRoot)) {
    const name = path.basename(entryPath);
    assert(!forbiddenRuntimeNames.has(name), `Local Agent runtime must not include ${path.relative(rootDir, entryPath)}`);
    assert(!entryPath.endsWith(".map"), `Local Agent runtime must not include source maps: ${path.relative(rootDir, entryPath)}`);
  }
}

const linuxResources = path.join(distDir, "linux-unpacked", "resources");
if (fs.existsSync(linuxResources)) {
  assert((fs.statSync(linuxResources).mode & 0o755) === 0o755, "Linux resources directory must be readable and traversable after packaging.");
  assert((fs.statSync(path.join(linuxResources, "app.asar")).mode & 0o644) === 0o644, "Linux app.asar must be readable after installation.");
  assert((fs.statSync(path.join(linuxResources, "app.asar.unpacked")).mode & 0o755) === 0o755, "Linux app.asar.unpacked must be readable and traversable after packaging.");
}

// The packaged Agent runtime requires shared modules via relative paths
// (e.g. "../../../src/shared/longOperationService.js") that only resolve
// correctly at the real packaged directory depth. Actually require them
// from the unpacked runtime, rather than only asserting file presence, to
// prove the packaged Agent can genuinely load its shared dependencies.
for (const target of selectedTargets) {
  const resourcesDir = target === "win"
    ? path.join(distDir, "win-unpacked", "resources")
    : path.join(distDir, "linux-unpacked", "resources");
  const runtimeRoot = path.join(resourcesDir, "local-agent-runtime");
  if (!fs.existsSync(runtimeRoot)) continue;
  const script = `
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    process.env.ANXHUB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "packaging-smoke-agent-config-"));
    process.env.AGENT_INSTANCE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "packaging-smoke-agent-instances-"));
    process.env.AGENT_BACKUP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "packaging-smoke-agent-backups-"));
    const dockerService = require(${JSON.stringify(path.join(runtimeRoot, "agent", "src", "services", "dockerService.js"))});
    const backupService = require(${JSON.stringify(path.join(runtimeRoot, "agent", "src", "services", "backupService.js"))});
    if (typeof dockerService.pullImage !== "function") throw new Error("Packaged Agent dockerService did not load pullImage.");
    if (typeof backupService.createBackup !== "function") throw new Error("Packaged Agent backupService did not load createBackup.");
    console.log("packaged-agent-shared-require-ok");
  `;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.strictEqual(result.status, 0, `Packaged Agent runtime (${target}) failed to require its shared modules: ${result.stderr || result.stdout}`);
  assert(String(result.stdout).includes("packaged-agent-shared-require-ok"), `Packaged Agent runtime (${target}) shared-module require check did not confirm success.`);
}

const debPath = path.join(distDir, `AnxOS-Control-Center-${artifactVersion}.deb`);
const dpkgDeb = selectedTargets.includes("linux") && fs.existsSync(debPath)
  ? spawnSync("dpkg-deb", ["--contents", debPath], { encoding: "utf8" })
  : { status: null };
if (dpkgDeb.status === 0) {
  const contents = dpkgDeb.stdout;
  assert(/-rw-r--r--\s+0\/0\s+\d+.*\/usr\/share\/applications\/anxos-control-center\.desktop/.test(contents), "Linux desktop entry must install with world-readable permissions.");
  assert(/-rw-r--r--\s+0\/0\s+\d+.*\/opt\/AnxOS Control Center\/resources\/app\.asar/.test(contents), "Linux app.asar must install with world-readable permissions.");
  assert(/drwxr-xr-x\s+0\/0\s+0.*\/opt\/AnxOS Control Center\/resources\/app\.asar\.unpacked\//.test(contents), "Linux unpacked resources must install with traversable directory permissions.");
}

console.log(`Packaging artifact smoke passed for ${artifactVersion} (${selectedTargets.join(", ")}).`);
