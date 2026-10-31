#!/usr/bin/env node
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const repoEnvPath = path.join(root, ".env");
const repoEnvExamplePath = path.join(root, ".env.example");
const args = new Set(process.argv.slice(2));
const tierArg = process.argv.find((arg) => arg.startsWith("--tier="));
const tier = tierArg ? tierArg.slice("--tier=".length) : "release";
const dirtyCheckOnly = args.has("--dirty-check");

const TIERS = {
  fast: [
    ["node", ["--check", "app.js"]],
    ["node", ["--check", "main.js"]],
    ["node", ["--check", "preload.js"]],
    ["node", ["scripts/versioning-smoke.js"]],
    ["git", ["diff", "--check"]],
  ],
  feature: [
    ["node", ["--check", "app.js"]],
    ["node", ["--check", "main.js"]],
    ["node", ["--check", "preload.js"]],
    ["node", ["scripts/game-server-config-smoke.js"]],
    ["node", ["scripts/agent-game-config-route-smoke.js"]],
    ["node", ["scripts/agent-game-config-compat-smoke.js"]],
    ["node", ["scripts/curseforge-server-pack-resolution-smoke.js"]],
    ["node", ["scripts/marketplace-error-bridge-smoke.js"]],
    ["node", ["scripts/marketplace-readiness-smoke.js"]],
    ["node", ["scripts/instance-runtime-smoke.js"]],
    ["node", ["scripts/instance-runtime-reconciliation-smoke.js"]],
    ["node", ["scripts/service-managed-runtime-smoke.js"]],
    ["node", ["scripts/service-managed-instance-smoke.js"]],
    ["node", ["scripts/port-ownership-fail-closed-smoke.js"]],
    ["node", ["scripts/service-managed-agent-routing-smoke.js"]],
    ["node", ["scripts/service-managed-operations-smoke.js"]],
    ["node", ["scripts/service-managed-operations-agent-smoke.js"]],
    ["node", ["scripts/infra-inventory-smoke.js"]],
    ["node", ["scripts/infra-inventory-agent-smoke.js"]],
    ["node", ["scripts/windows-cpu-temperature-smoke.js"]],
    ["node", ["scripts/windows-elevation-tray-smoke.js"]],
    ["node", ["scripts/bundled-runtime-smoke.js"]],
    ["node", ["scripts/ssh-session-timeout-smoke.js"]],
    ["node", ["scripts/resource-operation-lifecycle-smoke.js"]],
    ["node", ["scripts/instance-metrics-lifecycle-smoke.js"]],
    ["node", ["scripts/instance-health-summary-smoke.js"]],
    ["node", ["scripts/instance-health-state-smoke.js"]],
    ["node", ["scripts/instance-service-url-smoke.js"]],
    ["node", ["scripts/refresh-active-workspace-smoke.js"]],
    ["node", ["scripts/restore-drill-smoke.js"]],
    ["node", ["scripts/agent-rebinding-harness.js"]],
    ["node", ["scripts/agent-cli-smoke.js"]],
    ["node", ["scripts/agent-cli-pairing-smoke.js"]],
    ["node", ["scripts/agent-service-manager-smoke.js"]],
    ["node", ["scripts/agent-update-check-smoke.js"]],
    ["node", ["scripts/agent-unpair-smoke.js"]],
    ["node", ["scripts/agent-tui-render-smoke.js"]],
    ["node", ["scripts/agent-headless-golden-path-smoke.js"]],
    ["node", ["scripts/add-computer-flow-smoke.js"]],
    ["node", ["scripts/endpoint-model-smoke.js"]],
    ["node", ["scripts/health-model-smoke.js"]],
    ["node", ["scripts/connectivity-diagnostics-model-smoke.js"]],
    ["node", ["scripts/connectivity-graph-smoke.js"]],
    ["node", ["scripts/connectivity-presentation-smoke.js"]],
    ["node", ["scripts/provider-adapter-contract-smoke.js"]],
    ["node", ["scripts/service-capability-smoke.js"]],
    ["node", ["scripts/telemetry-store-smoke.js"]],
    ["node", ["scripts/endpoint-store-smoke.js"]],
    ["node", ["scripts/endpoint-service-smoke.js"]],
    ["node", ["scripts/connectivity-diagnostics-service-smoke.js"]],
    ["node", ["scripts/provider-integration-smoke.js"]],
    ["node", ["scripts/provider-background-probe-smoke.js"]],
    ["node", ["scripts/telemetry-service-smoke.js"]],
    ["node", ["scripts/operational-notifications-smoke.js"]],
    ["node", ["scripts/backup-verification-smoke.js"]],
    ["node", ["scripts/ui-network-page-smoke.js"]],
    ["node", ["scripts/network-page-refresh-race-smoke.js"]],
    ["node", ["scripts/computer-service-smoke.js"]],
    ["node", ["scripts/instance-network-performance-ui-smoke.js"]],
    ["node", ["scripts/node-connectivity-notifications-ui-smoke.js"]],
    ["node", ["scripts/network-ipc-authorization-smoke.js"]],
    ["node", ["scripts/network-secret-boundary-smoke.js"]],
    ["node", ["scripts/endpoint-migration-e2e-smoke.js"]],
    ["node", ["scripts/connectivity-no-fake-green-smoke.js"]],
    ["node", ["scripts/node-tunnel-service-smoke.js"]],
    ["node", ["scripts/node-route-fallback-smoke.js"]],
    ["node", ["scripts/node-self-repair-smoke.js"]],
    ["node", ["scripts/node-selection-race-smoke.js"]],
    ["node", ["scripts/node-tunnel-not-local-smoke.js"]],
    ["node", ["scripts/remote-agent-lifecycle-smoke.js"]],
    ["node", ["scripts/ssh-key-passphrase-smoke.js"]],
    ["node", ["scripts/ssh-agent-auth-smoke.js"]],
    ["node", ["scripts/functional-contracts-smoke.js"]],
    ["node", ["scripts/functional-probe-service-smoke.js"]],
    ["node", ["scripts/steamclient-runtime-sync-smoke.js"]],
    ["node", ["scripts/hytale-server-smoke.js"]],
    ["node", ["scripts/steamcmd-auto-update-smoke.js"]],
    ["node", ["scripts/scheduled-update-progress-smoke.js"]],
    ["node", ["scripts/ssh-terminal-session-output-smoke.js"]],
    ["node", ["scripts/agent-self-restart-e2e-smoke.js"]],
    ["node", ["scripts/local-agent-task-stop-smoke.js"]],
    ["node", ["scripts/playit-process-detection-smoke.js"]],
    ["node", ["scripts/playit-account-service-smoke.js"]],
    ["node", ["scripts/playit-account-ipc-smoke.js"]],
    ["git", ["diff", "--check"]],
  ],
  release: [
    ["node", ["--check", "app.js"]],
    ["node", ["--check", "main.js"]],
    ["node", ["--check", "preload.js"]],
    ["node", ["scripts/game-server-config-smoke.js"]],
    ["node", ["scripts/stabilization-ui-qa.js"]],
    ["node", ["scripts/qa-acceptance.js"]],
    ["node", ["scripts/service-managed-ui-qa.js"]],
    ["node", ["scripts/agent-game-config-route-smoke.js"]],
    ["node", ["scripts/agent-game-config-compat-smoke.js"]],
    ["node", ["scripts/curseforge-server-pack-resolution-smoke.js"]],
    ["node", ["scripts/marketplace-error-bridge-smoke.js"]],
    ["node", ["scripts/marketplace-readiness-smoke.js"]],
    ["node", ["scripts/instance-runtime-smoke.js"]],
    ["node", ["scripts/instance-runtime-reconciliation-smoke.js"]],
    ["node", ["scripts/service-managed-runtime-smoke.js"]],
    ["node", ["scripts/service-managed-instance-smoke.js"]],
    ["node", ["scripts/port-ownership-fail-closed-smoke.js"]],
    ["node", ["scripts/service-managed-agent-routing-smoke.js"]],
    ["node", ["scripts/service-managed-operations-smoke.js"]],
    ["node", ["scripts/service-managed-operations-agent-smoke.js"]],
    ["node", ["scripts/infra-inventory-smoke.js"]],
    ["node", ["scripts/infra-inventory-agent-smoke.js"]],
    ["node", ["scripts/instance-service-url-smoke.js"]],
    ["node", ["scripts/refresh-active-workspace-smoke.js"]],
    ["node", ["scripts/restore-drill-smoke.js"]],
    ["node", ["scripts/agent-rebinding-harness.js"]],
    ["node", ["scripts/agent-cli-smoke.js"]],
    ["node", ["scripts/agent-cli-pairing-smoke.js"]],
    ["node", ["scripts/agent-service-manager-smoke.js"]],
    ["node", ["scripts/agent-update-check-smoke.js"]],
    ["node", ["scripts/agent-unpair-smoke.js"]],
    ["node", ["scripts/agent-tui-render-smoke.js"]],
    ["node", ["scripts/agent-headless-golden-path-smoke.js"]],
    ["node", ["scripts/agent-package-closure-smoke.js"]],
    ["node", ["scripts/add-computer-flow-smoke.js"]],
    ["node", ["scripts/windows-cpu-temperature-smoke.js"]],
    ["node", ["scripts/windows-elevation-tray-smoke.js"]],
    ["node", ["scripts/bundled-runtime-smoke.js"]],
    ["node", ["scripts/ssh-session-timeout-smoke.js"]],
    ["node", ["scripts/release-promotion-smoke.js"]],
    ["node", ["scripts/network-ipc-authorization-smoke.js"]],
    ["node", ["scripts/network-page-refresh-race-smoke.js"]],
    ["node", ["scripts/network-secret-boundary-smoke.js"]],
    ["node", ["scripts/endpoint-migration-e2e-smoke.js"]],
    ["node", ["scripts/connectivity-no-fake-green-smoke.js"]],
    ["node", ["scripts/node-tunnel-service-smoke.js"]],
    ["node", ["scripts/node-route-fallback-smoke.js"]],
    ["node", ["scripts/node-self-repair-smoke.js"]],
    ["node", ["scripts/node-selection-race-smoke.js"]],
    ["node", ["scripts/node-tunnel-not-local-smoke.js"]],
    ["node", ["scripts/remote-agent-lifecycle-smoke.js"]],
    ["node", ["scripts/ssh-key-passphrase-smoke.js"]],
    ["node", ["scripts/ssh-agent-auth-smoke.js"]],
    ["node", ["scripts/functional-contracts-smoke.js"]],
    ["node", ["scripts/functional-probe-service-smoke.js"]],
    ["node", ["scripts/steamclient-runtime-sync-smoke.js"]],
    ["node", ["scripts/hytale-server-smoke.js"]],
    ["node", ["scripts/steamcmd-auto-update-smoke.js"]],
    ["node", ["scripts/scheduled-update-progress-smoke.js"]],
    ["node", ["scripts/ssh-terminal-session-output-smoke.js"]],
    ["node", ["scripts/agent-self-restart-e2e-smoke.js"]],
    ["node", ["scripts/local-agent-task-stop-smoke.js"]],
    ["node", ["scripts/node-routes-ui-qa.js"]],
    ["node", ["scripts/playit-process-detection-smoke.js"]],
    ["node", ["scripts/playit-account-service-smoke.js"]],
    ["node", ["scripts/playit-account-ipc-smoke.js"]],
    ["node", ["scripts/playit-account-ui-qa.js"]],
    ["node", ["scripts/endpoint-service-smoke.js"]],
    ["node", ["scripts/connectivity-diagnostics-service-smoke.js"]],
    ["node", ["scripts/provider-integration-smoke.js"]],
    ["node", ["scripts/provider-background-probe-smoke.js"]],
    ["node", ["scripts/telemetry-service-smoke.js"]],
    ["node", ["scripts/operational-notifications-smoke.js"]],
    ["node", ["scripts/computer-service-smoke.js"]],
    ["git", ["diff", "--check"]],
  ],
};

function redact(value) {
  return String(value || "").replace(/(authorization|token|password|secret|api[_-]?key|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function formatCommand(command, commandArgs) {
  return [command, ...commandArgs].join(" ");
}

// ampService bootstraps a missing env file by copying .env.example to the
// repo-root .env, and the Agent always loads <repo>/.env. Checks therefore get
// a per-run env file so one smoke cannot leak the template's placeholder
// AGENT_TOKEN into later smokes. The file is seeded from the template up front
// so the bootstrap never copies a developer's real .env into the temp dir.
let isolatedEnvDir = null;
let checkEnv = process.env;

function createIsolatedEnv() {
  isolatedEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-qa-env-"));
  const isolatedEnvPath = path.join(isolatedEnvDir, ".env");
  if (fs.existsSync(repoEnvExamplePath)) {
    fs.copyFileSync(repoEnvExamplePath, isolatedEnvPath);
  } else {
    fs.writeFileSync(isolatedEnvPath, "", "utf8");
  }
  process.on("exit", () => {
    fs.rmSync(isolatedEnvDir, { recursive: true, force: true });
  });
  checkEnv = {
    ...process.env,
    ANXHUB_ENV_PATH: isolatedEnvPath,
    ANXHUB_ENV_EXAMPLE_PATH: repoEnvExamplePath,
  };
}

// Existence only: the repo-root .env may hold real secrets and is never read.
function repoEnvExists() {
  return fs.existsSync(repoEnvPath);
}

function run(command, commandArgs) {
  return spawnSync(command, commandArgs, {
    cwd: root,
    env: checkEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function gitStatusShort() {
  const result = run("git", ["status", "--short"]);
  if (result.status !== 0) {
    throw new Error(`git status --short failed: ${redact(result.stderr || result.stdout)}`);
  }
  return result.stdout.replace(/\r\n/g, "\n");
}

function printStatus(status) {
  if (!status) return "clean";
  return `\n${status.trimEnd()}`;
}

function failDirtyTree(label, before, after) {
  console.error(`[qa] Dirty working tree after ${label}.`);
  console.error(`[qa] Before: ${printStatus(before)}`);
  console.error(`[qa] After: ${printStatus(after)}`);
  process.exit(1);
}

if (dirtyCheckOnly) {
  const status = gitStatusShort();
  if (status) {
    console.error("[qa] Working tree is dirty:");
    console.error(status.trimEnd());
    process.exit(1);
  }
  console.log("[qa] Working tree clean.");
  process.exit(0);
}

if (!Object.prototype.hasOwnProperty.call(TIERS, tier)) {
  console.error(`[qa] Unknown tier "${tier}". Expected one of: ${Object.keys(TIERS).join(", ")}`);
  process.exit(1);
}

const checks = TIERS[tier];
createIsolatedEnv();
const initialStatus = gitStatusShort();
const started = Date.now();
const timings = [];

if (initialStatus) {
  console.warn("[qa] Working tree is not clean at start; dirty guard will fail only if a check changes it further.");
  console.warn(initialStatus.trimEnd());
}

console.log(`[qa] Running ${tier} tier (${checks.length} checks).`);

for (const [command, commandArgs] of checks) {
  const label = formatCommand(command, commandArgs);
  const before = gitStatusShort();
  const repoEnvBefore = repoEnvExists();
  const checkStarted = Date.now();
  console.log(`[qa] start ${label}`);
  const result = run(command, commandArgs);
  const elapsedMs = Date.now() - checkStarted;
  timings.push({ label, elapsedMs, status: result.status });

  if (result.stdout) process.stdout.write(redact(result.stdout));
  if (result.stderr) process.stderr.write(redact(result.stderr));

  const after = gitStatusShort();
  if (after !== before) failDirtyTree(label, before, after);

  // .env is gitignored, so the dirty-tree guard cannot see it being created.
  if (repoEnvExists() !== repoEnvBefore) {
    console.error(`[qa] ${label} ${repoEnvBefore ? "removed" : "created"} the repo-root .env; checks must use the isolated ANXHUB_ENV_PATH.`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`[qa] fail ${label} (${elapsedMs}ms)`);
    process.exit(result.status || 1);
  }
  console.log(`[qa] pass ${label} (${elapsedMs}ms)`);
}

const finalStatus = gitStatusShort();
if (finalStatus !== initialStatus) failDirtyTree(`${tier} tier`, initialStatus, finalStatus);

const totalMs = Date.now() - started;
console.log("[qa] Timing summary:");
for (const item of timings) {
  console.log(`[qa] ${String(item.elapsedMs).padStart(7)}ms ${item.label}`);
}
console.log(`[qa] ${tier} tier passed: ${checks.length} checks in ${totalMs}ms.`);
