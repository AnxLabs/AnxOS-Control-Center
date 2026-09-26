#!/usr/bin/env node
// Headless Agent unpair smoke.
//
// Real runtime, isolated env: an enrolled Agent (enrollment recorded through the
// real /enroll API) with sentinel files in the instance and backup roots.
//
//   1. `unpair` in a non-TTY without --yes must refuse safely and change
//      nothing (enrollment record and stored credential byte-identical).
//   2. `unpair --yes --json` must revoke the enrollment on the live Agent,
//      clear the stored credential, report that data is preserved, and leave
//      every sentinel untouched.
//   3. The revoked Agent must refuse authenticated routes with the typed
//      REVOKED state while health stays reachable.
//   4. Re-pairing the revoked node over the network must recover it to a fresh
//      `enrolled` record bound to the new credential (authenticated stats 200,
//      not 410), and a restart must keep exactly that one enrolled record.
//   5. Where POSIX: a root-equivalent rewrite of the config and enrollment
//      files must preserve their uid/gid and 0600 mode. Windows has no uid/gid
//      to preserve, so that leg is an explicit SKIP there.
// No token material may appear in any captured output, log, or the config file.
"use strict";

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const { generateAgentToken, tokenFingerprint } = require("../src/shared/agentTokenStore");
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const { waitForAgentReady } = require("./test-helpers/agent-readiness");

const rootDir = path.resolve(__dirname, "..");
const cliPath = path.join(rootDir, "agent", "src", "cli.js");
const agentEntry = path.join(rootDir, "agent", "src", "server.js");

const smokeRoot = pinAgentRoots("anx-agent-unpair-smoke-");
const configDir = process.env.ANXHUB_CONFIG_DIR;
const logDir = path.join(smokeRoot, "logs");
const instanceRoot = process.env.AGENT_INSTANCE_ROOT;
const backupRoot = path.join(smokeRoot, "backups");
const enrollmentPath = path.join(configDir, "enrollment.json");
const agentConfigPath = path.join(configDir, "agent.json");
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(instanceRoot, { recursive: true });
fs.mkdirSync(backupRoot, { recursive: true });

const AGENT_TOKEN = `anxos_${"f".repeat(40)}`;
const agentChildren = new Set();
const cliChildren = new Set();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function agentEnv(port, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.AGENT_URL;
  delete env.ANXOS_AGENT_RUNTIME_CONFIG;
  return {
    ...env,
    ANXHUB_CONFIG_DIR: configDir,
    ANXHUB_AGENT_CONFIG_PATH: agentConfigPath,
    AGENT_ENROLLMENT_PATH: enrollmentPath,
    AGENT_IDENTITY_PATH: path.join(smokeRoot, "device-identity.json"),
    AGENT_HOST: "127.0.0.1",
    AGENT_PORT: String(port),
    AGENT_INSTANCE_ROOT: instanceRoot,
    AGENT_BACKUP_ROOT: backupRoot,
    ANXOS_LOG_DIR: logDir,
    ANXOS_TEST_SHUTDOWN_IPC: "1",
  };
}

function seedAgentConfigFile(port) {
  fs.writeFileSync(
    agentConfigPath,
    `${JSON.stringify({ backendMode: "agent", agentUrl: `http://127.0.0.1:${port}`, agentToken: AGENT_TOKEN }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function runCli(args, env, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: smokeRoot,
      env: agentEnv(port, env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    cliChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdin.end();
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 30000);
    child.once("close", (code) => {
      clearTimeout(timer);
      cliChildren.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    if (child.connected) child.send({ type: "shutdown" });
    else child.kill("SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
  const finished = await Promise.race([exited.then(() => true), wait(8000).then(() => false)]);
  if (!finished) {
    try { child.kill("SIGKILL"); } catch {}
    await Promise.race([exited, wait(3000)]);
  }
}

async function postJson(baseUrl, pathname, body, token) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

function assertNoTokenMaterial(text, label) {
  assert(!text.includes(AGENT_TOKEN), `${label} must not contain the Agent credential.`);
  assert(!text.includes("anxos_"), `${label} must not contain any credential-looking literal.`);
}

async function main() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  seedAgentConfigFile(port);
  let childOutput = "";
  const spawnSmokeAgent = () => {
    const spawned = spawn(process.execPath, [agentEntry], {
      cwd: path.join(rootDir, "agent"),
      env: agentEnv(port, { AGENT_TOKEN }),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    agentChildren.add(spawned);
    spawned.stdout.on("data", (chunk) => { childOutput += String(chunk); });
    spawned.stderr.on("data", (chunk) => { childOutput += String(chunk); });
    return spawned;
  };
  let child = spawnSmokeAgent();

  const sentinelPaths = [path.join(instanceRoot, "sentinel-instance.txt"), path.join(backupRoot, "sentinel-backup.txt")];
  sentinelPaths.forEach((sentinel) => fs.writeFileSync(sentinel, "preserve-me", "utf8"));

  try {
    await waitForAgentReady({
      label: "unpair smoke Agent",
      child,
      stderr: () => childOutput,
      probe: async () => (await fetch(`${baseUrl}/api/v1/health`)).ok,
    });

    const enrollStart = await postJson(baseUrl, "/api/v1/enroll/start", {}, null);
    assert.strictEqual(enrollStart.status, 200, "enroll/start must serve the handshake.");
    const enrollComplete = await postJson(baseUrl, "/api/v1/enroll/complete", { enrollNonce: enrollStart.body.enrollNonce, agentToken: AGENT_TOKEN }, null);
    assert.strictEqual(enrollComplete.status, 200, `enroll/complete must record the enrollment (got ${enrollComplete.status}).`);
    assert.strictEqual((await (await fetch(`${baseUrl}/api/v1/enroll/status`)).json()).state, "enrolled", "the Agent must be enrolled before unpair.");

    // --- refusal leg: non-TTY without --yes -------------------------------
    const enrollmentBytes = fs.readFileSync(enrollmentPath, "utf8");
    const configBytes = fs.readFileSync(agentConfigPath, "utf8");
    const refusal = await runCli(["unpair"], {}, port);
    assert.strictEqual(refusal.code, 1, "unpair without --yes in a non-TTY must exit non-zero.");
    assert(refusal.stderr.includes("Refusing to unpair"), `the refusal must explain itself (stderr: ${refusal.stderr}).`);
    assert(refusal.stderr.includes("--yes"), "the refusal must name the required flag.");
    assertNoTokenMaterial(refusal.stdout + refusal.stderr, "the unpair refusal output");
    assert.strictEqual(fs.readFileSync(enrollmentPath, "utf8"), enrollmentBytes, "the refusal must not change the enrollment record.");
    assert.strictEqual(fs.readFileSync(agentConfigPath, "utf8"), configBytes, "the refusal must not change the stored credential.");
    assert.strictEqual((await (await fetch(`${baseUrl}/api/v1/enroll/status`)).json()).state, "enrolled", "the refusal must not change the Agent's enrollment state.");
    assert.strictEqual((await fetch(`${baseUrl}/api/v1/instances`, { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } })).status, 200, "the credential must still authorize after a refused unpair.");

    // --- POSIX ownership invariant (B1) ------------------------------------
    // A root-run unpair rewrites files owned by the service user. When running
    // as root we simulate the packaged install by chowning the config and
    // enrollment files to a foreign uid/gid, then assert the rewrite preserves
    // it; a non-root POSIX run checks the same-owner invariant and says the
    // foreign-owner simulation was skipped. Windows has no uid/gid to
    // preserve, so the whole leg is an explicit SKIP there.
    const ownership = { skipped: false, simulated: false, uid: null, gid: null, enrollUid: null, enrollGid: null };
    if (process.platform === "win32" || typeof process.getuid !== "function") {
      ownership.skipped = true;
      console.log("SKIP (win32): config/enrollment file ownership preservation is POSIX-only and cannot be asserted on this platform.");
    } else {
      ownership.uid = fs.statSync(agentConfigPath).uid;
      ownership.gid = fs.statSync(agentConfigPath).gid;
      ownership.enrollUid = fs.statSync(enrollmentPath).uid;
      ownership.enrollGid = fs.statSync(enrollmentPath).gid;
      if (process.getuid() === 0) {
        try {
          fs.chownSync(agentConfigPath, 12345, 12345);
          fs.chownSync(enrollmentPath, 12345, 12345);
          ownership.uid = 12345;
          ownership.gid = 12345;
          ownership.enrollUid = 12345;
          ownership.enrollGid = 12345;
          ownership.simulated = true;
        } catch {
          // Cannot simulate a foreign owner from this process; the same-owner
          // assertions below still run.
        }
      }
    }

    // --- unpair --yes: revoke + clear, preserve data ----------------------
    const unpair = await runCli(["unpair", "--yes", "--json"], {}, port);
    assert.strictEqual(unpair.code, 0, `unpair --yes must exit 0 (stderr: ${unpair.stderr}).`);
    const result = JSON.parse(unpair.stdout);
    assert.strictEqual(result.ok, true, "unpair must report ok.");
    assert.strictEqual(result.revoked, true, "unpair must revoke the enrollment.");
    assert.strictEqual(result.localCredentialCleared, true, "unpair must clear the stored credential.");
    assert.strictEqual(result.configPath, agentConfigPath, "unpair must report the config file it cleared.");
    assert.strictEqual(result.dataPreserved, true, "unpair must report data preserved.");
    assert.strictEqual(result.instancesPreserved, true, "unpair must report instances preserved.");
    assert.strictEqual(result.backupsPreserved, true, "unpair must report backups preserved.");
    assert(/in-memory credential until it restarts/i.test(result.restartNote || ""), "unpair must warn that the running Agent keeps its in-memory credential until restart.");
    assertNoTokenMaterial(unpair.stdout + unpair.stderr, "the unpair output");

    const enrollmentAfter = JSON.parse(fs.readFileSync(enrollmentPath, "utf8"));
    assert.strictEqual(enrollmentAfter.state, "revoked", "the enrollment record must be revoked.");
    assert(!enrollmentAfter.tokenFingerprint, "the revoked record must not keep a credential fingerprint.");
    const configAfter = JSON.parse(fs.readFileSync(agentConfigPath, "utf8"));
    assert.strictEqual(configAfter.agentToken, "", "the stored credential must be cleared.");
    assert(!fs.readFileSync(agentConfigPath, "utf8").includes(AGENT_TOKEN), "the config file must not retain credential material.");

    sentinelPaths.forEach((sentinel) => assert.strictEqual(fs.readFileSync(sentinel, "utf8"), "preserve-me", `${path.basename(sentinel)} must be untouched by unpair.`));
    assert(fs.readdirSync(instanceRoot).includes("sentinel-instance.txt"), "the instance root must survive unpair.");
    assert(fs.readdirSync(backupRoot).includes("sentinel-backup.txt"), "the backup root must survive unpair.");

    if (!ownership.skipped) {
      const configStat = fs.statSync(agentConfigPath);
      assert.strictEqual(configStat.uid, ownership.uid, `unpair must preserve the config owner uid (${ownership.uid}), got ${configStat.uid}.`);
      assert.strictEqual(configStat.gid, ownership.gid, `unpair must preserve the config owner gid (${ownership.gid}), got ${configStat.gid}.`);
      assert.strictEqual(configStat.mode & 0o777, 0o600, "unpair must preserve the config file mode 0600.");
      const enrollmentStat = fs.statSync(enrollmentPath);
      assert.strictEqual(enrollmentStat.uid, ownership.enrollUid, `unpair must preserve the enrollment owner uid (${ownership.enrollUid}), got ${enrollmentStat.uid}.`);
      assert.strictEqual(enrollmentStat.gid, ownership.enrollGid, `unpair must preserve the enrollment owner gid (${ownership.enrollGid}), got ${enrollmentStat.gid}.`);
      assert.strictEqual(enrollmentStat.mode & 0o777, 0o600, "unpair must preserve the enrollment file mode 0600.");
      if (ownership.simulated) {
        console.log(`ownership leg passed: root-equivalent unpair preserved uid=${ownership.uid} gid=${ownership.gid} mode=0600 on config and enrollment`);
      } else {
        console.log("SKIP (posix non-root): foreign-owner simulation requires root; same-owner uid/gid and mode 0600 preservation were asserted instead.");
      }
    }

    // --- the live Agent now refuses authenticated routes with REVOKED ------
    const revokedStatus = await (await fetch(`${baseUrl}/api/v1/enroll/status`)).json();
    assert.strictEqual(revokedStatus.state, "revoked", "the Agent must report the revoked state.");
    const revoked = await fetch(`${baseUrl}/api/v1/instances`, { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } });
    assert.strictEqual(revoked.status, 410, "a revoked Agent must refuse authenticated routes with 410.");
    assert.strictEqual((await revoked.json()).error?.code, "REVOKED", "the refusal must use the typed REVOKED code.");
    const health = await fetch(`${baseUrl}/api/v1/health`);
    assert.strictEqual(health.status, 200, "health must stay reachable after revocation so Control Center can detect it.");

    // --- B3: re-pair the revoked node and verify the recovery end state ----
    const rePairToken = generateAgentToken();
    const rePairStart = await postJson(baseUrl, "/api/v1/pairing/start", {}, null);
    assert.strictEqual(rePairStart.status, 200, `pairing/start after revocation must succeed (got ${rePairStart.status}).`);
    const rePairComplete = await postJson(baseUrl, "/api/v1/pairing/complete", {
      pairingCode: rePairStart.body.pairingCode,
      permanentToken: rePairToken,
    }, null);
    assert.strictEqual(rePairComplete.status, 200, `pairing/complete after revocation must succeed (got ${rePairComplete.status}: ${JSON.stringify(rePairComplete.body)}).`);
    assert.strictEqual(rePairComplete.body?.status, "paired", "the re-pair must report the paired state.");
    assert.strictEqual(rePairComplete.body?.enrollment?.state, "enrolled", "the re-pair must reflect the recovered enrolled state.");
    assert.strictEqual(rePairComplete.body?.enrollment?.recoveredFromRevocation, true, "the re-pair must report recovery from revocation.");
    assert(!JSON.stringify(rePairComplete.body).includes(rePairToken), "the re-pair response must not leak the credential.");

    const statsAfterRepair = await fetch(`${baseUrl}/api/v1/stats`, { headers: { Authorization: `Bearer ${rePairToken}` } });
    assert.strictEqual(statsAfterRepair.status, 200, `authenticated stats must return 200 after re-pairing a revoked node (got ${statsAfterRepair.status}).`);
    const oldCredentialAfterRepair = await fetch(`${baseUrl}/api/v1/stats`, { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } });
    assert.strictEqual(oldCredentialAfterRepair.status, 401, "the pre-unpair credential must not authorize after re-pairing.");
    assert.strictEqual((await (await fetch(`${baseUrl}/api/v1/enroll/status`)).json()).state, "enrolled", "enroll/status must report enrolled after re-pair.");

    const repairedRecord = JSON.parse(fs.readFileSync(enrollmentPath, "utf8"));
    assert.strictEqual(repairedRecord.state, "enrolled", "the persisted record must be enrolled after re-pair.");
    assert.strictEqual(repairedRecord.tokenFingerprint, tokenFingerprint(rePairToken), "the recovered record must bind the newly paired credential.");
    assert.strictEqual(repairedRecord.recoveredFromRevocation, true, "the recovered record must record that it came from revocation.");
    assert(repairedRecord.enrollmentId && repairedRecord.enrollmentId !== enrollmentAfter.enrollmentId, "the recovery must mint a fresh enrollment id.");
    assertNoTokenMaterial(JSON.stringify(rePairComplete.body), "the re-pair response");

    // --- restart: the recovered enrollment persists exactly once ------------
    await stopChild(child);
    child = spawnSmokeAgent();
    await waitForAgentReady({
      label: "restarted unpair smoke Agent",
      child,
      stderr: () => childOutput,
      probe: async () => (await fetch(`${baseUrl}/api/v1/health`)).ok,
    });
    const restartedStats = await fetch(`${baseUrl}/api/v1/stats`, { headers: { Authorization: `Bearer ${rePairToken}` } });
    assert.strictEqual(restartedStats.status, 200, "the re-paired credential must authorize after an Agent restart.");
    assert.strictEqual((await (await fetch(`${baseUrl}/api/v1/enroll/status`)).json()).state, "enrolled", "the recovered enrollment must survive an Agent restart.");
    const restartedRecord = JSON.parse(fs.readFileSync(enrollmentPath, "utf8"));
    assert.strictEqual(restartedRecord.state, "enrolled", "the restarted record must still be enrolled.");
    assert.strictEqual(restartedRecord.tokenFingerprint, tokenFingerprint(rePairToken), "the restarted record must still bind the paired credential.");
    const enrollmentFiles = fs.readdirSync(configDir).filter((name) => name === "enrollment.json" || name.startsWith("enrollment.json."));
    assert.deepStrictEqual(enrollmentFiles, ["enrollment.json"], `exactly one enrollment record must exist after the restart, got ${JSON.stringify(enrollmentFiles)}.`);

    assertNoTokenMaterial(childOutput, "the Agent process output");
    const logText = fs.readdirSync(logDir).filter((name) => name.endsWith(".log")).map((name) => fs.readFileSync(path.join(logDir, name), "utf8")).join("\n");
    assert(!logText.includes(AGENT_TOKEN), "the Agent logs must not contain credential material.");

    console.log("agent:unpair:smoke passed — safe refusal, revoke + credential clear, data preserved, typed REVOKED refusal, revoked-node re-pair recovery, restart persistence");
  } finally {
    await stopChild(child);
  }
}

main().catch((error) => {
  console.error("agent:unpair:smoke FAILED:", error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  for (const cliChild of cliChildren) {
    try { cliChild.kill("SIGKILL"); } catch {}
  }
  for (const agentChild of agentChildren) {
    try { agentChild.kill("SIGKILL"); } catch {}
  }
  try { fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
});
