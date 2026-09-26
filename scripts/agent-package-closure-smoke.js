#!/usr/bin/env node
// Agent package closure smoke.
//
// Assembles the AnxOS Agent .deb payload with --stage-only (placeholder Node
// runtime), then proves the package contract without needing dpkg-deb:
//
//   - required runtime files are present and the hermetic dependency closure
//     resolves from the staged runtime root (same resolver the desktop
//     packaging uses, never the repository node_modules above it),
//   - forbidden files are absent (.env*, logs, identity/enrollment/nodes
//     state, source maps, test trees, tooling state),
//   - control fields, systemd unit targets, wrapper content/mode, and POSIX sh
//     maintainer scripts are valid,
//   - prerm/postrm provably never remove /var/lib/anxos-agent or
//     /var/log/anxos-agent,
//   - no staged text file contains token-looking material.
//
// Where dpkg-deb exists it additionally builds, inspects (-I, -c, -e) and
// extracts (-x) a real .deb into a temporary directory, then deletes it.
//
// Extra arguments are forwarded to scripts/build-agent-deb.js (for example
// --no-refresh-deps). Exits nonzero on failure; SKIP lines are printed only for
// genuinely unavailable tooling.
"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildReleaseInfo, readReleaseConfig } = require("../src/shared/releaseConfig");
const { resolveRuntimeClosure } = require("./agent-runtime-dependency-closure");

const rootDir = path.resolve(__dirname, "..");
const packagingDir = path.join(rootDir, "packaging", "agent-deb");
const artifactVersion = buildReleaseInfo(readReleaseConfig()).artifactVersion;
const stageBuildArgs = process.argv.slice(2).filter((arg) => arg !== "--help");

const RUNTIME_ROOT_PARTS = ["usr", "lib", "anxos-agent"];
const RUNTIME_ROOT_DISPLAY = "/usr/lib/anxos-agent";
const REQUIRED_RUNTIME_PATHS = [
  "agent/package.json",
  "agent/src/permissions.js",
  "agent/src/server.js",
  "config/agent.example.json",
  "config/local-agent-runtime.json",
  "config/marketplace-templates.json",
  "node/bin/node",
  "node_modules/dotenv/package.json",
  "node_modules/js-yaml/package.json",
  "node_modules/ssh2/package.json",
  "src/shared/redaction.js",
  "src/shared/releaseConfig.js",
  "src/shared/structuredLogger.js",
];
const CLOSURE_CANARIES = ["dotenv", "js-yaml", "ssh2"];

const FORBIDDEN_DIRECTORY_NAMES = new Set(["test", "tests", "__tests__", ".mimosa"]);
const FORBIDDEN_FILE_NAMES = new Set([
  ".env",
  "agent.json",
  "application-host.json",
  "device-identity.json",
  "enrollment.json",
  "long-operations.json",
  "marketplace.json",
  "nodes.json",
  "owner-accounts.json",
  "ssh-known-hosts.json",
]);
const TOKEN_PATTERNS = [
  { name: "anxos token literal", pattern: /anxos_[A-Za-z0-9_-]{20,}/ },
  { name: "x-agent-token literal value", pattern: /x-agent-token\s*["']?\s*[:=]\s*["'][A-Za-z0-9+/_=.-]{16,}["']/i },
  { name: "x-agent-token long literal", pattern: /x-agent-token\s*[:=]\s*[A-Za-z0-9+/_-]{30,}/i },
];

const skipMessages = [];
function skip(message) {
  skipMessages.push(message);
  console.log(`SKIP: ${message}`);
}

function walk(directory) {
  const entries = [];
  if (!fs.existsSync(directory)) return entries;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    entries.push(entryPath);
    if (entry.isDirectory()) entries.push(...walk(entryPath));
  }
  return entries;
}

function toDisplayPath(stageDir, filePath) {
  return path.relative(stageDir, filePath).split(path.sep).join("/");
}

let modeChecksSkipped = false;
function assertMode(filePath, expected, label) {
  if (process.platform === "win32") {
    modeChecksSkipped = true;
    return;
  }
  const mode = fs.statSync(filePath).mode & 0o777;
  assert.strictEqual(mode, expected, `${label} must have mode ${expected.toString(8)} (found ${mode.toString(8)}).`);
}

function findSh() {
  const candidates = ["sh"];
  if (process.platform === "win32") {
    candidates.push(path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "sh.exe"));
    candidates.push(path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "usr", "bin", "sh.exe"));
  }
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-c", "exit 0"], { encoding: "utf8", shell: false });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function parseControl(control) {
  const fields = {};
  let current = null;
  for (const line of control.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s/.test(line) && current) {
      fields[current] += `\n${line.trim()}`;
      continue;
    }
    const match = line.match(/^([A-Za-z0-9-]+):\s?(.*)$/);
    if (match) {
      current = match[1];
      fields[current] = match[2];
    }
  }
  return fields;
}

function unitDirective(unitContent, name) {
  const match = unitContent.match(new RegExp(`^${name}=(.*)$`, "m"));
  return match ? match[1].trim() : null;
}

// Runtime data must survive removal by contract. Any uncommented line that
// combines a delete-style command with /var/lib/anxos-agent or
// /var/log/anxos-agent fails the smoke.
function assertNoDataRemoval(scriptName, content) {
  const dataPath = /\/var\/(lib|log)\/anxos-agent/;
  const removeCommand = /(^|[\s;&|])(rm|rmdir|unlink|shred)\b/;
  content.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    if (dataPath.test(trimmed) && removeCommand.test(trimmed)) {
      throw new Error(`${scriptName}:${index + 1} appears to remove runtime data: ${trimmed}`);
    }
  });
}

// Regression legs: the safety guards must actually fail on violations, or a
// data removal or leaked token literal could pass the smoke unnoticed.
function assertGuardLegs() {
  assert.throws(
    () => assertNoDataRemoval("synthetic", "#!/bin/sh\nrm -rf /var/lib/anxos-agent\n"),
    /remove runtime data/,
    "data-removal guard must fail on rm -rf against the data root."
  );
  assert.throws(
    () => assertNoDataRemoval("synthetic", "#!/bin/sh\nshred -u /var/log/anxos-agent/agent.log\n"),
    /remove runtime data/,
    "data-removal guard must fail on delete-style commands against the log root."
  );
  assert.doesNotThrow(
    () => assertNoDataRemoval("synthetic", '#!/bin/sh\n# rm -rf /var/lib/anxos-agent\necho "kept /var/lib/anxos-agent"\n'),
    "data-removal guard must ignore comments and preservation messages."
  );
  assert(TOKEN_PATTERNS[0].pattern.test(`anxos_${"a".repeat(24)}`), "token guard must match a 20+ character anxos token literal.");
  assert(TOKEN_PATTERNS[1].pattern.test('{"x-agent-token": "abcdefghijklmnopqrstuvwxyz123456"}'), "token guard must match a literal x-agent-token value.");
}

function assertNoTokenMaterial(stageDir) {
  const violations = [];
  for (const entryPath of walk(stageDir)) {
    if (!fs.statSync(entryPath).isFile()) continue;
    if (fs.statSync(entryPath).size > 4 * 1024 * 1024) continue;
    const buffer = fs.readFileSync(entryPath);
    if (buffer.subarray(0, 8192).includes(0)) continue;
    const text = buffer.toString("utf8");
    for (const { name, pattern } of TOKEN_PATTERNS) {
      if (pattern.test(text)) {
        violations.push(`${toDisplayPath(stageDir, entryPath)} matched ${name}`);
      }
    }
  }
  assert.deepStrictEqual(violations, [], `staged files contain token-looking material:\n${violations.join("\n")}`);
}

function assertCliAndTuiStaged(stageDir, runtimeRoot) {
  const repoAgentSrc = path.join(rootDir, "agent", "src");
  const cliCandidates = fs.readdirSync(repoAgentSrc).filter((name) => /^cli.*\.js$/.test(name));
  if (cliCandidates.length) {
    for (const name of cliCandidates) {
      assert(
        fs.existsSync(path.join(runtimeRoot, "agent", "src", name)),
        `agent/src/${name} exists in the repository but not in the staged package.`
      );
    }
    console.log(`CLI entrypoint(s) verified in stage: ${cliCandidates.join(", ")}.`);
  } else {
    console.log("NOTE: agent/src/cli.js is not present in this worktree yet (concurrent workstream); CLI presence assertion is skipped for this run.");
  }

  const tuiSource = path.join(repoAgentSrc, "tui");
  if (fs.existsSync(tuiSource)) {
    const missing = [];
    for (const entryPath of walk(tuiSource)) {
      if (!fs.statSync(entryPath).isFile()) continue;
      const name = path.basename(entryPath);
      if (name.endsWith(".map") || name.endsWith(".log") || name === ".env" || name.startsWith(".env.")) continue;
      const relative = path.relative(tuiSource, entryPath);
      if (!fs.existsSync(path.join(runtimeRoot, "agent", "src", "tui", relative))) {
        missing.push(relative.split(path.sep).join("/"));
      }
    }
    assert.deepStrictEqual(missing, [], `agent/src/tui is present in the repository but these files are not staged:\n${missing.join("\n")}`);
    console.log("TUI sources verified in stage.");
  }
}

function assertForbiddenAbsent(stageDir) {
  const violations = [];
  for (const entryPath of walk(stageDir)) {
    const name = path.basename(entryPath);
    const relative = toDisplayPath(stageDir, entryPath);
    if (fs.statSync(entryPath).isDirectory()) {
      if (FORBIDDEN_DIRECTORY_NAMES.has(name)) violations.push(relative);
      continue;
    }
    if (FORBIDDEN_FILE_NAMES.has(name) || name.startsWith(".env.") || name.endsWith(".map") || name.endsWith(".log")) {
      violations.push(relative);
    }
    if (relative.startsWith(`${RUNTIME_ROOT_DISPLAY}/agent/config/`)) {
      violations.push(relative);
    }
  }
  assert.deepStrictEqual(violations, [], `staged package contains forbidden paths:\n${violations.join("\n")}`);
}

function assertControl(stageDir) {
  const controlPath = path.join(stageDir, "DEBIAN", "control");
  assert(fs.existsSync(controlPath), "staged package must contain DEBIAN/control.");
  const control = fs.readFileSync(controlPath, "utf8");
  assert(!/\{\{[A-Z_]+\}\}/.test(control), "control must not contain unresolved template placeholders.");
  const fields = parseControl(control);
  assert.strictEqual(fields.Package, "anxos-agent", "control Package must be anxos-agent.");
  assert.strictEqual(fields.Version, artifactVersion, `control Version must be ${artifactVersion}.`);
  assert.strictEqual(fields.Architecture, "amd64", "smoke stages the default amd64 architecture.");
  const installedSize = Number(fields["Installed-Size"]);
  assert(Number.isInteger(installedSize) && installedSize > 0, "control Installed-Size must be a positive integer (KiB).");
  assert(fields.Maintainer && fields.Maintainer.includes("@"), "control Maintainer must be present.");
  assert(fields.Depends && fields.Depends.includes("libc6"), "control Depends must include libc6.");
  assert(fields.Description && fields.Description.length > 20, "control Description must be present.");
}

function assertUnitAndTargets(stageDir) {
  const unitSourcePath = path.join(packagingDir, "anxos-agent.service");
  const unitSource = fs.readFileSync(unitSourcePath, "utf8");
  const unitInstalledPath = path.join(stageDir, "lib", "systemd", "system", "anxos-agent.service");
  assert(fs.existsSync(unitInstalledPath), "staged package must install /lib/systemd/system/anxos-agent.service.");
  assert.strictEqual(fs.readFileSync(unitInstalledPath, "utf8"), unitSource, "installed unit must match the packaging source.");

  assert.strictEqual(unitDirective(unitSource, "Type"), "simple");
  assert.strictEqual(unitDirective(unitSource, "User"), "anxos-agent");
  assert.strictEqual(unitDirective(unitSource, "Group"), "anxos-agent");
  assert.strictEqual(unitDirective(unitSource, "WorkingDirectory"), "/var/lib/anxos-agent");
  assert.strictEqual(unitDirective(unitSource, "Restart"), "on-failure");
  assert.strictEqual(unitDirective(unitSource, "RestartSec"), "3");
  assert.strictEqual(unitDirective(unitSource, "LimitNOFILE"), "65535");
  assert.strictEqual(unitDirective(unitSource, "WantedBy"), "multi-user.target");

  const execStart = unitDirective(unitSource, "ExecStart");
  assert.strictEqual(
    execStart,
    "/usr/lib/anxos-agent/node/bin/node /usr/lib/anxos-agent/agent/src/server.js",
    "ExecStart must run the bundled Node against agent/src/server.js."
  );
  for (const token of execStart.split(/\s+/)) {
    if (!token.startsWith("/")) continue;
    const mapped = path.join(stageDir, ...token.split("/").filter(Boolean));
    assert(fs.existsSync(mapped), `ExecStart target ${token} does not exist in the staged tree.`);
  }

  const environmentDefaults = {
    ANXHUB_CONFIG_DIR: "/var/lib/anxos-agent/config",
    AGENT_HOST: "127.0.0.1",
    AGENT_PORT: "47131",
    AGENT_INSTANCE_ROOT: "/var/lib/anxos-agent/instances",
    AGENT_BACKUP_ROOT: "/var/lib/anxos-agent/backups",
    ANXOS_LOG_DIR: "/var/log/anxos-agent",
    NODE_ENV: "production",
  };
  for (const [key, value] of Object.entries(environmentDefaults)) {
    assert(unitSource.includes(`Environment=${key}=${value}`), `unit must set Environment=${key}=${value}.`);
  }
  const environmentFileLine = "EnvironmentFile=-/etc/anxos-agent/agent.env";
  assert(unitSource.includes(environmentFileLine), "unit must read the optional operator env file.");
  assert(
    unitSource.indexOf(environmentFileLine) > unitSource.lastIndexOf("Environment="),
    "EnvironmentFile must appear after the Environment defaults so operators can override them."
  );
}

function assertWrapper(stageDir) {
  const wrapperPath = path.join(stageDir, "usr", "bin", "anxos-agent");
  assert(fs.existsSync(wrapperPath), "staged package must contain /usr/bin/anxos-agent.");
  const lines = fs.readFileSync(wrapperPath, "utf8").split(/\r?\n/);
  assert.strictEqual(lines[0], "#!/bin/sh", "wrapper must use the POSIX sh shebang.");
  assert.strictEqual(
    lines[1],
    'exec /usr/lib/anxos-agent/node/bin/node /usr/lib/anxos-agent/agent/src/cli.js "$@"',
    "wrapper must exec the bundled Node against agent/src/cli.js."
  );
  assertMode(wrapperPath, 0o755, "wrapper");
}

function assertMaintainerScripts(stageDir, sh) {
  for (const script of ["postinst", "prerm", "postrm"]) {
    const sourcePath = path.join(packagingDir, script);
    const stagedPath = path.join(stageDir, "DEBIAN", script);
    assert(fs.existsSync(stagedPath), `staged package must contain DEBIAN/${script}.`);
    const content = fs.readFileSync(stagedPath, "utf8");
    assert.strictEqual(content, fs.readFileSync(sourcePath, "utf8"), `${script} must be installed verbatim.`);
    assert.strictEqual(content.split(/\r?\n/)[0], "#!/bin/sh", `${script} must start with #!/bin/sh.`);
    assert(content.includes("set -eu"), `${script} must use set -eu.`);
    assert(!/\[\[/.test(content), `${script} must not use bash [[ tests.`);
    assert(!/\bfunction\s+\w+\s*\(/.test(content), `${script} must not use bash function syntax.`);
    assertNoDataRemoval(script, content);
    if (sh) {
      const syntax = spawnSync(sh, ["-n", stagedPath], { encoding: "utf8", shell: false });
      assert.strictEqual(syntax.status, 0, `${script} failed 'sh -n': ${syntax.stderr || syntax.stdout}`);
    }
    assertMode(stagedPath, 0o755, script);
  }
  const postrm = fs.readFileSync(path.join(packagingDir, "postrm"), "utf8");
  assert(postrm.includes("/var/lib/anxos-agent"), "postrm must tell operators that /var/lib/anxos-agent is preserved.");
}

function assertDpkgDebBuild(stageDir, outputDir, tempRoot, wrapperPath) {
  const probe = spawnSync("dpkg-deb", ["--version"], { encoding: "utf8", shell: false });
  if (probe.error || probe.status !== 0) {
    skip("dpkg-deb is not available; the real .deb build/extract verification runs on a Debian/Ubuntu host (node scripts/build-agent-deb.js --download-node).");
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const debPath = path.join(outputDir, `AnxOS-Agent-${artifactVersion}-smoke.deb`);
  const build = spawnSync("dpkg-deb", ["--build", "--root-owner-group", stageDir, debPath], { encoding: "utf8", shell: false });
  assert.strictEqual(build.status, 0, `dpkg-deb --build failed: ${build.stderr || build.stdout}`);

  const info = spawnSync("dpkg-deb", ["-I", debPath], { encoding: "utf8", shell: false });
  assert.strictEqual(info.status, 0, `dpkg-deb -I failed: ${info.stderr || info.stdout}`);
  assert(info.stdout.includes("Package: anxos-agent"), "dpkg-deb -I must report Package: anxos-agent.");
  assert(info.stdout.includes(`Version: ${artifactVersion}`), `dpkg-deb -I must report Version: ${artifactVersion}.`);
  assert(info.stdout.includes("Architecture: amd64"), "dpkg-deb -I must report Architecture: amd64.");
  assert(/Installed-Size: \d+/.test(info.stdout), "dpkg-deb -I must report Installed-Size.");

  const contents = spawnSync("dpkg-deb", ["-c", debPath], { encoding: "utf8", shell: false });
  assert.strictEqual(contents.status, 0, `dpkg-deb -c failed: ${contents.stderr || contents.stdout}`);
  const listingLines = contents.stdout.split(/\r?\n/).filter(Boolean);
  assert(
    listingLines.some((line) => /^-rwxr-xr-x\s+root\/root\s+\d+\s+.*\.\/usr\/bin\/anxos-agent$/.test(line)),
    "deb listing must install ./usr/bin/anxos-agent mode 0755 owned by root."
  );
  for (const relative of [
    "usr/lib/anxos-agent/agent/src/server.js",
    "usr/lib/anxos-agent/config/agent.example.json",
    "usr/lib/anxos-agent/node/bin/node",
    "lib/systemd/system/anxos-agent.service",
    "etc/anxos-agent/agent.env.example",
  ]) {
    assert(listingLines.some((line) => line.endsWith(`./${relative}`)), `deb listing must include ./${relative}.`);
  }
  assert(!listingLines.some((line) => line.endsWith(".map")), "deb listing must not contain source maps.");
  assert(!contents.stdout.includes("./usr/lib/anxos-agent/agent/config/"), "deb must not install agent/config runtime state.");

  const extractDir = path.join(tempRoot, "extract");
  const extract = spawnSync("dpkg-deb", ["-x", debPath, extractDir], { encoding: "utf8", shell: false });
  assert.strictEqual(extract.status, 0, `dpkg-deb -x failed: ${extract.stderr || extract.stdout}`);
  const extractedWrapper = path.join(extractDir, "usr", "bin", "anxos-agent");
  assert.strictEqual(fs.readFileSync(extractedWrapper, "utf8"), fs.readFileSync(wrapperPath, "utf8"), "extracted wrapper content must match.");
  assert.strictEqual(fs.statSync(extractedWrapper).mode & 0o777, 0o755, "extracted wrapper must be executable (0755).");
  for (const relative of ["usr/lib/anxos-agent/node/bin/node", "usr/lib/anxos-agent/agent/src/server.js"]) {
    assert(fs.existsSync(path.join(extractDir, ...relative.split("/"))), `extracted deb must contain ${relative}.`);
  }

  const controlDir = path.join(tempRoot, "control");
  const extractControl = spawnSync("dpkg-deb", ["-e", debPath, controlDir], { encoding: "utf8", shell: false });
  assert.strictEqual(extractControl.status, 0, `dpkg-deb -e failed: ${extractControl.stderr || extractControl.stdout}`);
  for (const script of ["postinst", "prerm", "postrm"]) {
    const controlScript = path.join(controlDir, script);
    assert(fs.existsSync(controlScript), `deb control archive must contain ${script}.`);
    assert.strictEqual(fs.statSync(controlScript).mode & 0o777, 0o755, `${script} inside the deb must be 0755.`);
    assert.strictEqual(fs.readFileSync(controlScript, "utf8"), fs.readFileSync(path.join(packagingDir, script), "utf8"), `${script} inside the deb must match the source.`);
  }

  console.log(`dpkg-deb real build verified: ${path.basename(debPath)} (${fs.statSync(debPath).size} bytes).`);
}

function main() {
  assertGuardLegs();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-agent-deb-smoke-"));
  try {
    const stageDir = path.join(tempRoot, "stage");
    const outputDir = path.join(tempRoot, "out");
    const runtimeRoot = path.join(stageDir, ...RUNTIME_ROOT_PARTS);

    const build = spawnSync(
      process.execPath,
      [path.join(rootDir, "scripts", "build-agent-deb.js"), "--stage-only", "--stage-dir", stageDir, "--output-dir", outputDir, ...stageBuildArgs],
      { encoding: "utf8", cwd: rootDir, shell: false }
    );
    assert.strictEqual(build.status, 0, `stage-only build failed (exit ${build.status}):\n${build.stdout}\n${build.stderr}`);
    assert(fs.existsSync(stageDir), "stage-only build did not produce a stage directory.");
    console.log("stage-only assembly ok.");

    for (const relative of REQUIRED_RUNTIME_PATHS) {
      const target = path.join(runtimeRoot, ...relative.split("/"));
      assert(fs.existsSync(target), `staged runtime is missing ${RUNTIME_ROOT_DISPLAY}/${relative}.`);
    }
    assertCliAndTuiStaged(stageDir, runtimeRoot);

    const closure = resolveRuntimeClosure(runtimeRoot);
    assert.strictEqual(closure.filesWalked > 0, true, "dependency closure walk did not visit any staged source file.");
    assert.deepStrictEqual(
      closure.relativeMissing,
      [],
      `staged runtime has missing relative requires:\n${closure.relativeMissing.map((entry) => `- ${entry.chain}`).join("\n")}`
    );
    assert.deepStrictEqual(
      closure.missing,
      [],
      `staged runtime is missing required modules:\n${closure.missing.map((entry) => `- ${entry.name} (${entry.chain})`).join("\n")}`
    );
    const closedPackages = new Set(closure.packages.map((entry) => entry.name));
    for (const canary of CLOSURE_CANARIES) {
      assert(closedPackages.has(canary), `staged dependency closure lost required package ${canary}.`);
    }
    console.log(`dependency closure ok: ${closure.packages.map((entry) => `${entry.name}@${entry.version}`).join(", ")}.`);

    assertForbiddenAbsent(stageDir);
    console.log("forbidden-file scan ok.");

    assertControl(stageDir);
    assertUnitAndTargets(stageDir);
    assertWrapper(stageDir);
    console.log("control, unit and wrapper checks ok.");

    const sh = findSh();
    if (!sh) {
      skip("sh is not available on this host; maintainer scripts were verified by shebang and POSIX-inspection only (sh -n runs on Linux).");
    }
    assertMaintainerScripts(stageDir, sh);
    console.log("maintainer script checks ok (data paths never removed).");

    assertNoTokenMaterial(stageDir);
    console.log("token-material scan ok.");

    assertDpkgDebBuild(stageDir, outputDir, tempRoot, path.join(stageDir, "usr", "bin", "anxos-agent"));

    if (modeChecksSkipped) {
      skip("POSIX file modes (wrapper, maintainer scripts, node 0755) are not observable on Windows; covered by the dpkg-deb leg on Linux.");
    }

    console.log(`AGENT PACKAGE CLOSURE SMOKE: PASS (${artifactVersion}; ${skipMessages.length} SKIP, ${walk(stageDir).length} staged paths).`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

try {
  main();
} catch (error) {
  console.error(`AGENT PACKAGE CLOSURE SMOKE: FAIL\n${error.stack || error.message}`);
  process.exitCode = 1;
}
