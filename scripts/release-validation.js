#!/usr/bin/env node
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
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
    ["node", ["scripts/instance-runtime-smoke.js"]],
    ["git", ["diff", "--check"]],
  ],
  release: [
    ["node", ["--check", "app.js"]],
    ["node", ["--check", "main.js"]],
    ["node", ["--check", "preload.js"]],
    ["node", ["scripts/game-server-config-smoke.js"]],
    ["node", ["scripts/stabilization-ui-qa.js"]],
    ["node", ["scripts/qa-acceptance.js"]],
    ["node", ["scripts/agent-game-config-route-smoke.js"]],
    ["node", ["scripts/agent-game-config-compat-smoke.js"]],
    ["node", ["scripts/curseforge-server-pack-resolution-smoke.js"]],
    ["node", ["scripts/instance-runtime-smoke.js"]],
    ["git", ["diff", "--check"]],
  ],
};

function redact(value) {
  return String(value || "").replace(/(authorization|token|password|secret|api[_-]?key|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function formatCommand(command, commandArgs) {
  return [command, ...commandArgs].join(" ");
}

function run(command, commandArgs) {
  return spawnSync(command, commandArgs, {
    cwd: root,
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
  const checkStarted = Date.now();
  console.log(`[qa] start ${label}`);
  const result = run(command, commandArgs);
  const elapsedMs = Date.now() - checkStarted;
  timings.push({ label, elapsedMs, status: result.status });

  if (result.stdout) process.stdout.write(redact(result.stdout));
  if (result.stderr) process.stderr.write(redact(result.stderr));

  const after = gitStatusShort();
  if (after !== before) failDirtyTree(label, before, after);

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
