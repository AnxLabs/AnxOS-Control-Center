const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { SshService } = require("./sshService");
const { enumerateRuntimePayload } = require("../shared/agentRuntimePayload");
const { createTarGz } = require("../shared/agentRuntimeTar");
const { getBundledLocalAgentRuntime, getBundledLocalAgentVersion } = require("./localAgentRuntimeService");
const { getNode } = require("./nodeService");
const { APPLICATION_HOST_NODE_ID } = require("./applicationHostService");
const diagnostics = require("./diagnosticsService");

// Remote Agent push update: the Desktop is the runtime authority. It stages its
// own bundled Agent runtime (the same file set the local Agent runs from) over
// SSH, backs up the live runtime, publishes the staged copy, restarts the
// managed systemd user unit, and verifies the node answers the new routes.
// Any failure after the swap restores the backup and restarts the previous
// runtime. The operation requires an approved SSH host identity and key
// authentication; password profiles stay interactive-only by design.
const LINUX_AGENT_UNIT_NAME = "anxos-agent";
const REMOTE_STAGE_DIRNAME = ".anxos-agent-update";
const DEFAULT_SWAP_TIMEOUT_MS = 240000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120000;
const DEFAULT_VERIFY_ATTEMPTS = 12;
const DEFAULT_VERIFY_DELAY_MS = 2500;
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;

let defaultSshService = null;
function getDefaultSshService() {
  if (!defaultSshService) defaultSshService = new SshService();
  return defaultSshService;
}

function installerStep(id, label) {
  return { id, label, state: "pending", message: null, at: null };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Minimal semantic-version comparison for the downgrade guard: accepts
// "major.minor.patch" with an optional leading "v" and optional prerelease or
// build metadata suffix. Returns null when either side is unknown or not a
// version, so the caller fails open and the update path keeps working.
function parseAgentVersion(value) {
  const match = String(value ?? "").trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function compareAgentVersions(left, right) {
  const a = parseAgentVersion(left);
  const b = parseAgentVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function normalizeIncludedPaths(includedPaths) {
  return (Array.isArray(includedPaths) ? includedPaths : []).filter((entry) => typeof entry === "string" && entry && !entry.includes("..") && !entry.startsWith("/"));
}

// `systemctl --user show <unit> -p ExecStart --value` prints
// `{ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/anxos/agent/src/server.js ; ... }`.
function parseExecStartValue(output = "") {
  const text = String(output || "");
  const argvMatch = text.match(/argv\[\]=(?:"([^"]*)"|(\S+))((?:\s+(?:"[^"]*"|\S+))*)/);
  if (!argvMatch) return null;
  const tokens = [];
  const rest = (argvMatch[3] || "").trim();
  const tokenPattern = /"([^"]*)"|(\S+)/g;
  let token;
  while ((token = tokenPattern.exec(rest)) !== null) tokens.push(token[1] ?? token[2]);
  const entrypoint = tokens.find((candidate) => candidate.endsWith("agent/src/server.js") || candidate.endsWith("agent\\src\\server.js"));
  if (!entrypoint) return null;
  return { nodePath: argvMatch[1] || argvMatch[2] || null, entrypoint };
}

function parsePsEntrypoint(output = "") {
  const text = String(output || "");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/(\S*agent\/src\/server\.js)/);
    if (match) return { nodePath: null, entrypoint: match[1] };
  }
  return null;
}

// Discovery output is sectioned by literal `--- label ---` markers. Extraction
// is marker-driven (not a regex between two fixed markers) so the system-unit
// probes can be added without ever being misread as the desktop-managed user
// unit; a user unit and a system unit are parsed independently.
function parseDiscoverySections(output = "") {
  const sections = new Map();
  const text = String(output || "");
  const markerPattern = /^--- ([a-z][a-z0-9-]*) ---[^\S\r\n]*$/gm;
  const matches = [...text.matchAll(markerPattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const valueStart = matches[index].index + matches[index][0].length;
    const valueEnd = index + 1 < matches.length ? matches[index + 1].index : text.length;
    sections.set(matches[index][1], text.slice(valueStart, valueEnd).trim());
  }
  return sections;
}

function runtimeRootFromEntrypoint(entrypoint) {
  const normalized = String(entrypoint || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const suffix = "/agent/src/server.js";
  if (!normalized.endsWith(suffix)) return null;
  const root = normalized.slice(0, -suffix.length);
  if (!root || root === "/" || !root.startsWith("/")) return null;
  return root;
}

function buildDiscoveryCommand(unitName = LINUX_AGENT_UNIT_NAME) {
  return [
    "set -eu",
    'echo "--- exec ---"',
    `systemctl --user show ${shellQuote(unitName)} -p ExecStart --value 2>/dev/null || true`,
    'echo "--- system-exec ---"',
    `systemctl show ${shellQuote(unitName)} -p ExecStart --value 2>/dev/null || true`,
    'echo "--- system-active ---"',
    `systemctl is-active ${shellQuote(unitName)} 2>/dev/null || true`,
    'echo "--- system-enabled ---"',
    `systemctl is-enabled ${shellQuote(unitName)} 2>/dev/null || true`,
    'echo "--- ps ---"',
    "ps -eo args= 2>/dev/null | grep -F 'agent/src/server.js' | grep -v grep | head -n 3 || true",
    'echo "--- node ---"',
    "command -v node || true",
  ].join("\n");
}

function buildStageCommand(stagedDir) {
  return [
    "set -eu",
    `rm -rf ${shellQuote(stagedDir)}`,
    `mkdir -p ${shellQuote(stagedDir)}`,
    `tar -xzf - -C ${shellQuote(stagedDir)}`,
    'echo "STAGE_OK"',
    `du -sk ${shellQuote(stagedDir)} 2>/dev/null | cut -f1`,
  ].join("\n");
}

// Backup-before-publish swap. The live paths are copied aside while the Agent
// still runs, the unit is stopped, the staged payload replaces the live paths,
// and the unit is restarted. A failed start restores the backup and restarts
// the previous runtime, so the node is never left with a half-published tree.
function buildSwapScript({ runtimeRoot, stagedDir, backupDir, unitName = LINUX_AGENT_UNIT_NAME, includedPaths }) {
  const paths = normalizeIncludedPaths(includedPaths);
  const pathList = paths.map(shellQuote).join(" ");
  return [
    "set -eu",
    ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"',
    "export XDG_RUNTIME_DIR",
    `ROOT=${shellQuote(runtimeRoot)}`,
    `STAGE=${shellQuote(stagedDir)}`,
    `BACKUP=${shellQuote(backupDir)}`,
    `UNIT=${shellQuote(unitName)}`,
    'test -d "$STAGE" || { echo "STAGE_MISSING"; exit 4; }',
    'mkdir -p "$BACKUP"',
    `for p in ${pathList}; do if [ -e "$ROOT/$p" ]; then mkdir -p "$BACKUP/$(dirname "$p")"; rm -rf "$BACKUP/$p"; cp -a "$ROOT/$p" "$BACKUP/$p"; fi; done`,
    'echo "BACKUP_OK"',
    'systemctl --user stop "$UNIT" || { echo "STOP_FAILED"; exit 2; }',
    'echo "STOP_OK"',
    `for p in ${pathList}; do rm -rf "$ROOT/$p"; mkdir -p "$ROOT/$(dirname "$p")"; cp -a "$STAGE/$p" "$ROOT/$p"; done`,
    'echo "PUBLISH_OK"',
    'if systemctl --user start "$UNIT"; then echo "SWAP_OK"; else echo "START_FAILED"; ' +
      `for p in ${pathList}; do if [ -e "$BACKUP/$p" ]; then rm -rf "$ROOT/$p"; mkdir -p "$ROOT/$(dirname "$p")"; cp -a "$BACKUP/$p" "$ROOT/$p"; fi; done; ` +
      'systemctl --user start "$UNIT" || true; echo "SWAP_ROLLED_BACK"; exit 3; fi',
  ].join("\n");
}

function buildRollbackScript({ runtimeRoot, backupDir, unitName = LINUX_AGENT_UNIT_NAME, includedPaths }) {
  const paths = normalizeIncludedPaths(includedPaths);
  const pathList = paths.map(shellQuote).join(" ");
  return [
    "set -eu",
    ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"',
    "export XDG_RUNTIME_DIR",
    `ROOT=${shellQuote(runtimeRoot)}`,
    `BACKUP=${shellQuote(backupDir)}`,
    `UNIT=${shellQuote(unitName)}`,
    'test -d "$BACKUP" || { echo "BACKUP_MISSING"; exit 5; }',
    'systemctl --user stop "$UNIT" || true',
    `for p in ${pathList}; do if [ -e "$BACKUP/$p" ]; then rm -rf "$ROOT/$p"; mkdir -p "$ROOT/$(dirname "$p")"; cp -a "$BACKUP/$p" "$ROOT/$p"; fi; done`,
    'echo "ROLLBACK_PUBLISHED"',
    'systemctl --user start "$UNIT" || { echo "ROLLBACK_START_FAILED"; exit 6; }',
    'echo "ROLLBACK_OK"',
  ].join("\n");
}

async function defaultHealthProbe(nodeId) {
  const { checkNodeHealth } = require("./nodeService");
  const { getNetworkInventory } = require("./serviceRouter");
  const health = await checkNodeHealth(nodeId).catch((error) => ({ connected: false, probeError: error?.code || "health-failed" }));
  let networkInventoryOk = false;
  let networkInventoryError = null;
  try {
    const inventory = await getNetworkInventory({ nodeId });
    networkInventoryOk = inventory?.ok !== false;
  } catch (error) {
    networkInventoryError = error?.code || error?.message || "network-inventory-failed";
  }
  return {
    connected: health?.connected === true || health?.ok === true || health?.status === "connected",
    agentVersion: health?.agentVersion || health?.version || null,
    networkInventoryOk,
    networkInventoryError,
  };
}

function getRemoteUpdateDirectory() {
  return path.join(app.getPath("userData"), "agent-updates");
}

function writeUpdateRecord(updateDir, record) {
  try {
    fs.mkdirSync(updateDir, { recursive: true });
    const filePath = path.join(updateDir, "remote-last-update.json");
    fs.writeFileSync(filePath, `${JSON.stringify({ ...record, recordedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    return filePath;
  } catch {
    return null;
  }
}

async function updateRemoteAgent(nodeId, options = {}) {
  const ssh = options.sshService || getDefaultSshService();
  const resolveNode = options.resolveNode || ((id) => getNode(id));
  const readPayload = options.payloadReader || (() => {
    const runtime = getBundledLocalAgentRuntime();
    if (!runtime.exists) {
      throw Object.assign(new Error("The bundled Agent runtime is missing or incomplete on this Desktop."), { code: "AGENT_RUNTIME_PAYLOAD_MISSING" });
    }
    return { runtime, payload: enumerateRuntimePayload(runtime.runtimeRoot) };
  });
  const run = options.runner || ((profileId, command, runOptions) => ssh.runCommand(profileId, command, runOptions));
  const healthProbe = options.healthProbe || ((id) => defaultHealthProbe(id));
  const bundledVersion = options.bundledVersion ?? getBundledLocalAgentVersion(null);
  const updateDir = options.updateDir || getRemoteUpdateDirectory();
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const verifyAttempts = Number.isFinite(options.verifyAttempts) ? Math.max(1, Math.floor(options.verifyAttempts)) : DEFAULT_VERIFY_ATTEMPTS;
  const verifyDelayMs = Number.isFinite(options.verifyDelayMs) ? Math.max(0, Math.floor(options.verifyDelayMs)) : DEFAULT_VERIFY_DELAY_MS;
  const unitName = options.unitName || LINUX_AGENT_UNIT_NAME;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const steps = [
    installerStep("check", "Check the node and its SSH access"),
    installerStep("health", "Confirm the node's Agent is healthy before updating"),
    installerStep("discover", "Locate the Agent unit and runtime root"),
    installerStep("stage", "Upload the bundled Agent runtime"),
    installerStep("swap", "Back up the live runtime and publish the update"),
    installerStep("verify", "Verify the updated Agent on the node"),
    installerStep("rollback", "Restore the previous runtime"),
  ];
  const mark = (id, state, message) => {
    const step = steps.find((entry) => entry.id === id);
    if (step) {
      step.state = state;
      step.message = message || step.message;
      step.at = new Date().toISOString();
    }
    return step;
  };
  const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, steps, details });
  const record = {
    action: "remote-agent-update",
    nodeId,
    unitName,
    stamp,
    bundledVersion,
    runtimeRoot: null,
    backupDir: null,
    stagedDir: null,
    payloadFiles: 0,
    payloadBytes: 0,
    status: "failed",
    verification: null,
  };

  mark("check", "running");
  const node = await resolveNode(nodeId);
  if (!node) throw fail("NODE_NOT_FOUND", "The node does not exist.", { nodeId });
  record.nodeName = node.displayName || node.name || node.id;
  if (node.id === APPLICATION_HOST_NODE_ID) {
    throw fail("REMOTE_AGENT_UPDATE_LOCAL_TARGET", "The application-host Agent is updated from Agent Control, not over SSH.");
  }
  const platform = node.platform || node.connection?.platform || node.agentIdentity?.platform || null;
  if (platform !== "linux") {
    throw fail("REMOTE_AGENT_UPDATE_PLATFORM_UNSUPPORTED", "Only Linux nodes can be updated over SSH from this Desktop.", { platform });
  }
  const profile = ssh.getProfileForNode(nodeId);
  if (!profile) {
    throw fail("REMOTE_AGENT_UPDATE_SSH_PROFILE_MISSING", "Assign an SSH profile to this node before updating its Agent.", { nodeId });
  }
  if (profile.authType !== "privateKey") {
    throw fail("REMOTE_AGENT_UPDATE_SSH_KEY_REQUIRED", "The node's SSH profile must use key authentication for an unattended update.");
  }
  mark("check", "complete", `Node ${record.nodeName} and SSH profile ${profile.displayName || profile.id} selected.`);

  // Pre-flight health: the swap restarts the Agent, so the runtime that is live
  // right now must already be able to boot. If the node is unhealthy before the
  // update, replacing its runtime only deepens the problem — and worse, a
  // rollback would restore a runtime that cannot start, which is exactly how a
  // schema-mismatched node was left unhealthy on 2026-09-24.
  mark("health", "running");
  const healthBefore = await healthProbe(nodeId).catch((error) => ({ connected: false, probeError: error?.code || "probe-failed" }));
  record.healthBefore = healthBefore;
  if (healthBefore.connected !== true) {
    mark("health", "failed", "The node's Agent is not healthy before the update.");
    throw fail("REMOTE_AGENT_UPDATE_NODE_UNHEALTHY", "The node's Agent is not healthy right now. Fix or re-pair the node before updating it: replacing the runtime of a broken Agent can leave the node unable to start.", { healthBefore });
  }
  mark("health", "complete", healthBefore.agentVersion ? `Agent ${healthBefore.agentVersion} healthy before the update.` : "Agent healthy before the update.");

  // Downgrade guard: this Desktop is the runtime authority, but the docs tell
  // users to update Control Center instead of rolling a node's Agent back. If
  // the node already reports a newer Agent than the bundled runtime, refuse
  // before any file is staged. Unknown versions fail open so updates still work.
  const nodeAgentVersion = healthBefore.agentVersion || null;
  if (compareAgentVersions(nodeAgentVersion, bundledVersion) > 0) {
    throw fail("AGENT_DOWNGRADE_REFUSED", `The node's Agent (${nodeAgentVersion}) is newer than the bundled Agent runtime (${bundledVersion}) in this Desktop. Update AnxOS Control Center to a newer release instead of downgrading the node's Agent.`, { nodeAgentVersion, bundledVersion });
  }

  mark("discover", "running");
  const discovery = await run(profile.id, buildDiscoveryCommand(unitName), { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS }).catch((error) => {
    throw fail(error.code || "REMOTE_AGENT_UPDATE_SSH_FAILED", error.message, { sshOutput: error.sshOutput || null });
  });
  const sections = parseDiscoverySections(discovery.stdout);
  const userUnit = parseExecStartValue(sections.get("exec") || "");
  const systemExecOutput = sections.get("system-exec") || "";
  const systemUnit = parseExecStartValue(systemExecOutput);
  const systemActive = (sections.get("system-active") || "").trim().toLowerCase();
  const systemEnabled = (sections.get("system-enabled") || "").trim().toLowerCase();
  // Positive evidence only: a parsed ExecStart, an active unit, or an explicit
  // is-enabled existence state. "disabled"/"not-found"/"" are ambiguous across
  // systemd versions and must not by themselves classify a node.
  const systemUnitFound = Boolean(systemUnit)
    || ["active", "activating", "reloading", "deactivating"].includes(systemActive)
    || ["enabled", "enabled-runtime", "static", "alias", "indirect", "masked", "generated", "linked"].includes(systemEnabled);
  if (!userUnit && systemUnitFound) {
    mark("discover", "failed", "The node's Agent is package-managed (systemd system unit).");
    throw fail(
      "REMOTE_AGENT_UPDATE_PACKAGE_MANAGED",
      "The node's Agent is package-managed: it runs from the systemd system unit `anxos-agent` installed by the .deb package. Update it on the node instead of pushing runtime files — run `sudo anxos-agent update --check` and install the newer package per the node's install guide, or reinstall the package. Desktop push updates apply only to nodes whose Agent runs from a systemd user unit.",
      {
        unitName,
        systemUnit: systemUnit ? { entrypoint: systemUnit.entrypoint, nodePath: systemUnit.nodePath } : null,
        systemActive: systemActive || null,
        systemEnabled: systemEnabled || null,
        discovery: discovery.stdout.slice(0, 2000),
      }
    );
  }
  const located = userUnit || parsePsEntrypoint(sections.get("ps") || "");
  const runtimeRoot = located ? runtimeRootFromEntrypoint(located.entrypoint) : null;
  if (!runtimeRoot) {
    throw fail("REMOTE_AGENT_UPDATE_UNIT_NOT_FOUND", "The Agent systemd user unit or runtime root could not be located on the node.", { discovery: discovery.stdout.slice(0, 2000) });
  }
  record.runtimeRoot = runtimeRoot;
  mark("discover", "complete", `Runtime root ${runtimeRoot} (unit ${unitName}).`);

  mark("stage", "running");
  const { runtime, payload } = readPayload();
  if (!payload.files.length) {
    throw fail("REMOTE_AGENT_UPDATE_PAYLOAD_EMPTY", "The bundled Agent runtime payload contains no files.");
  }
  record.payloadFiles = payload.files.length;
  record.payloadBytes = payload.totalBytes;
  const stageRoot = `${runtimeRoot}/${REMOTE_STAGE_DIRNAME}/${stamp}`;
  const stagedDir = `${stageRoot}/staged`;
  const backupDir = `${stageRoot}/backup`;
  record.stagedDir = stagedDir;
  record.backupDir = backupDir;
  const archive = createTarGz(payload.files.map((file) => ({
    relativePath: file.relativePath,
    content: fs.readFileSync(file.absolutePath),
    mode: file.mode,
  })));
  const staged = await run(profile.id, buildStageCommand(stagedDir), { timeoutMs: DEFAULT_UPLOAD_TIMEOUT_MS, stdin: archive }).catch((error) => {
    throw fail(error.code || "REMOTE_AGENT_UPDATE_STAGE_FAILED", error.message, { sshOutput: error.sshOutput || null });
  });
  if (staged.code !== 0 || !staged.stdout.includes("STAGE_OK")) {
    throw fail("REMOTE_AGENT_UPDATE_STAGE_FAILED", "The runtime payload could not be staged on the node.", { stdout: staged.stdout, stderr: staged.stderr, code: staged.code });
  }
  mark("stage", "complete", `${payload.files.length} files (${Math.round(payload.totalBytes / 1024)} KiB) staged from ${runtime.packaged ? "the packaged runtime" : "the development runtime"}.`);

  mark("swap", "running");
  const swap = await run(profile.id, buildSwapScript({
    runtimeRoot,
    stagedDir,
    backupDir,
    unitName,
    includedPaths: payload.includedPaths,
  }), { timeoutMs: DEFAULT_SWAP_TIMEOUT_MS }).catch((error) => {
    throw fail(error.code || "REMOTE_AGENT_UPDATE_SWAP_FAILED", error.message, { sshOutput: error.sshOutput || null });
  });
  if (swap.stdout.includes("SWAP_ROLLED_BACK") || swap.code !== 0) {
    mark("swap", "failed", "The Agent did not start after the swap; the previous runtime was restored.");
    throw fail("REMOTE_AGENT_UPDATE_SWAP_FAILED", "The remote Agent did not restart with the staged runtime; the previous runtime was restored.", { stdout: swap.stdout, stderr: swap.stderr, code: swap.code, backupDir });
  }
  if (!swap.stdout.includes("SWAP_OK")) {
    throw fail("REMOTE_AGENT_UPDATE_SWAP_UNCONFIRMED", "The swap script did not confirm a successful restart.", { stdout: swap.stdout, stderr: swap.stderr, code: swap.code, backupDir });
  }
  mark("swap", "complete", `Runtime published; previous runtime preserved at ${backupDir}.`);

  mark("verify", "running");
  let verification = null;
  for (let attempt = 0; attempt < verifyAttempts; attempt += 1) {
    verification = await healthProbe(nodeId).catch((error) => ({ connected: false, probeError: error?.code || "probe-failed" }));
    record.verification = verification;
    if (verification.connected && verification.networkInventoryOk) break;
    if (attempt < verifyAttempts - 1) await sleep(verifyDelayMs);
  }
  if (!verification?.connected || !verification?.networkInventoryOk) {
    mark("verify", "failed", "The updated Agent did not answer the expected routes.");
    mark("rollback", "running");
    const rollback = await run(profile.id, buildRollbackScript({
      runtimeRoot,
      backupDir,
      unitName,
      includedPaths: payload.includedPaths,
    }), { timeoutMs: DEFAULT_SWAP_TIMEOUT_MS }).catch((error) => ({ code: null, stdout: "", stderr: error.message, sshError: error.code || "ROLLBACK_SSH_FAILED" }));
    record.status = "rolled-back";
    record.rollback = { ok: rollback.stdout.includes("ROLLBACK_OK"), stdout: rollback.stdout, stderr: rollback.stderr, backupDir };
    // A rollback is only trustworthy when the restored runtime answers again;
    // the script's marker alone proves nothing about node health.
    const healthAfterRollback = await healthProbe(nodeId).catch((error) => ({ connected: false, probeError: error?.code || "probe-failed" }));
    record.healthAfterRollback = healthAfterRollback;
    record.rollback.verified = healthAfterRollback.connected === true;
    mark("rollback", record.rollback.ok && record.rollback.verified ? "complete" : "failed", record.rollback.ok && record.rollback.verified
      ? "Previous runtime restored and healthy."
      : "Rollback could not be confirmed healthy; inspect the node and the backup before retrying.");
    record.steps = steps;
    const recordPath = writeUpdateRecord(updateDir, record);
    throw fail("REMOTE_AGENT_UPDATE_VERIFY_FAILED", record.rollback.verified
      ? "The updated Agent did not verify; the previous runtime was restored and is healthy again."
      : "The updated Agent did not verify and the rollback did not restore a healthy Agent. Inspect the node.", { verification, rollback: record.rollback, backupDir, recordPath });
  }
  mark("verify", "complete", verification.agentVersion ? `Agent ${verification.agentVersion} answered health and network inventory.` : "Agent answered health and network inventory.");
  record.status = "updated";
  record.steps = steps;
  const recordPath = writeUpdateRecord(updateDir, record);
  diagnostics.log("info", "remote-agent-update", "update", "Remote Agent updated from the Desktop bundle.", {
    nodeId,
    runtimeRoot,
    backupDir,
    bundledVersion,
    payloadFiles: record.payloadFiles,
    verification,
  }, { file: "service-manager" });
  return {
    ok: true,
    updated: true,
    nodeId,
    nodeName: record.nodeName,
    runtimeRoot,
    unitName,
    backupDir,
    stagedDir,
    recordPath,
    bundledVersion,
    payloadFiles: record.payloadFiles,
    payloadBytes: record.payloadBytes,
    steps,
    verification,
  };
}

module.exports = {
  _test: {
    LINUX_AGENT_UNIT_NAME,
    buildDiscoveryCommand,
    buildRollbackScript,
    buildStageCommand,
    buildSwapScript,
    parseDiscoverySections,
    parseExecStartValue,
    parsePsEntrypoint,
    runtimeRootFromEntrypoint,
    shellQuote,
  },
  getRemoteUpdateDirectory,
  updateRemoteAgent,
};