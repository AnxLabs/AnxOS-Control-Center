#!/usr/bin/env node
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const packageJson = require("../package.json");

// qa:smoke drives a real Electron via playwright with its own 180s internal
// timeout — over this suite runner's 120s cap, so it can stall the whole gate
// at position 4. It remains available standalone and in the qa:release tier.
const excluded = new Set(["rc:validate", "artifacts:validate", "qa:smoke"]);
const commands = Object.keys(packageJson.scripts)
  .filter((name) => name.endsWith(":smoke") && !excluded.has(name));

// Regression tripwire (eb13b83 class): a cwd-relative instance root means a
// smoke minted jobs/instances outside its temp tree and into the repo.
const residueRoots = ["instances", "anxos-instances"].map((name) => path.join(process.cwd(), name));
const residue = residueRoots.filter((root) => fs.existsSync(root));

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npmInvocation(scriptName, env = process.env, platform = process.platform) {
  const npmExecPath = env.npm_execpath;
  if (npmExecPath) {
    return { command: process.execPath, args: [npmExecPath, "run", scriptName], shell: false };
  }
  if (platform === "win32") {
    const shell = env.ComSpec || "cmd.exe";
    return { command: shell, args: ["/d", "/s", "/c", `npm.cmd run "${scriptName}"`], shell: false };
  }
  return { command: npmCommand(), args: ["run", scriptName], shell: false };
}

function classifySubprocessResult(result = {}) {
  const exitCode = Number.isInteger(result.status) ? result.status : null;
  return {
    status: exitCode === 0 ? "PASS" : "FAIL",
    exitCode,
    spawnError: result.error?.message || null,
    stderr: String(result.stderr || ""),
  };
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    try { child.kill("SIGTERM"); } catch {}
  }
}

function runSuite(command, timeoutMs = Number(process.env.RC_SUITE_TIMEOUT_MS || 120000)) {
  const invocation = npmInvocation(command);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      env: process.env,
      detached: process.platform !== "win32",
      shell: invocation.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (target, chunk) => target.length > 2_000_000 ? target : target + chunk.toString();
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); process.stdout.write(chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); process.stderr.write(chunk); });
    const timer = setTimeout(() => {
      const elapsedMs = Date.now() - startedAt;
      terminateProcessTree(child);
      resolve({ command, status: "FAIL", exitCode: null, signalCode: "TIMEOUT", elapsedMs, pid: child.pid, stdout, stderr, timeoutMs });
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ command, status: "FAIL", exitCode: null, signalCode: null, elapsedMs: Date.now() - startedAt, pid: child.pid || null, stdout, stderr, spawnError: error.message });
    });
    child.once("close", (exitCode, signalCode) => {
      clearTimeout(timer);
      const result = { command, status: exitCode === 0 ? "PASS" : "FAIL", exitCode, signalCode, elapsedMs: Date.now() - startedAt, pid: child.pid, stdout, stderr };
      // Hollow-green guard (P0-2 lesson): a suite that exits 0 without ever
      // printing a success marker silently skipped its own assertions. Every
      // registered smoke prints either "passed" or "PASS" on success.
      if (result.status === "PASS" && !/pass/i.test(stdout)) {
        result.status = "FAIL";
        result.failureReason = "exit 0 without a success marker (hollow green)";
      }
      resolve(result);
    });
  });
}

async function runValidation() {
const results = [];
if (residue.length > 0) {
  const message = `Repo-root instance-root residue detected (${residue.join(", ")}). A smoke minted jobs/instances outside its temp tree; fix the smoke's AGENT_INSTANCE_ROOT pinning before running the gate.`;
  console.error(`[RC] FAIL ${message}`);
  console.log(JSON.stringify({ status: "FAIL", suite: "private-alpha-rc-source-validation", completed: 0, total: commands.length, failed: "rc:root-residue-tripwire", residue: residue.map((root) => path.relative(process.cwd(), root)) }, null, 2));
  process.exitCode = 1;
  return { results, failed: { command: "rc:root-residue-tripwire", status: "FAIL" } };
}
// RC_FAIL_FAST=0 keeps running after failures and reports an aggregate —
// for audit runs where the full failure list matters more than fast exit.
const failFast = process.env.RC_FAIL_FAST !== "0";
for (let index = 0; index < commands.length; index += 1) {
  const command = commands[index];
  console.error(`[RC] suite ${index + 1}/${commands.length} start ${command} ${new Date().toISOString()}`);
  const result = await runSuite(command);
  console.error(`[RC] suite ${index + 1}/${commands.length} ${result.status} ${command} pid=${result.pid || "-"} elapsedMs=${result.elapsedMs} exitCode=${result.exitCode} signalCode=${result.signalCode || "-"}`);
  if (result.status === "FAIL" && result.stderr) console.error(`[RC] ${command} stderr:\n${result.stderr}`);
  results.push(result);
  if (result.status !== "PASS" && failFast) break;
}

const failed = results.find((result) => result.status === "FAIL");
console.log(JSON.stringify({
  status: failed ? "FAIL" : "PASS",
  suite: "private-alpha-rc-source-validation",
  completed: results.length,
  total: commands.length,
  failed: failed?.command || null,
  failedCount: results.filter((result) => result.status === "FAIL").length,
}, null, 2));
process.exitCode = failed ? 1 : 0;
return { results, failed };
}

if (require.main === module) runValidation().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { classifySubprocessResult, npmCommand, npmInvocation, runValidation, runSuite, terminateProcessTree };
