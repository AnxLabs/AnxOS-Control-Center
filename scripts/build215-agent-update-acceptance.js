#!/usr/bin/env node
"use strict";

// Build 215 real Agent update acceptance against DISPOSABLE Docker nodes.
//
// It drives the shipped Desktop code (SshService.setUpKeyAuthentication,
// remoteAgentUpdateService.updateRemoteAgent, agentUpdateManager's
// updateAllAgents and runAutoUpdateTick) over real OpenSSH into systemd
// containers that run official anxos-agent release packages, with the
// update helper and its sudoers rule installed as a Build 215 package would.
// Packages come from the real GitHub release; health comes from each node's
// real Agent (/api/v1/health, read inside the container).
//
// It refuses to run against anything but containers named anx215-* on
// 127.0.0.1. Never point it at a real computer.
//
//   node scripts/build215-agent-update-acceptance.js
//
// Environment: ANX215_NODES="anx215-a:2221,anx215-b:2222" (default),
// ANX215_PASSWORD (the containers' disposable test password),
// ANX215_FROM=2.0-build213, ANX215_TO=2.0-build214.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const FROM = process.env.ANX215_FROM || "2.0-build213";
const TO = process.env.ANX215_TO || "2.0-build214";
const PASSWORD = process.env.ANX215_PASSWORD || "anx215-disposable-pw";
const NODES = (process.env.ANX215_NODES || "anx215-a:2221,anx215-b:2222").split(",").map((entry) => {
  const [container, port] = entry.split(":");
  if (!/^anx215-[a-z0-9-]+$/.test(container) || !/^\d+$/.test(port)) throw new Error(`Refusing node "${entry}": only anx215-* containers on 127.0.0.1.`);
  return { container, port: Number(port), nodeId: container };
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx215-acceptance-"));
process.env.ANXHUB_CONFIG_DIR = root;
process.env.ANXOS_SELECTED_NODE_ID = NODES[0].nodeId;

const remoteServicePath = path.join(__dirname, "..", "src", "services", "remoteAgentUpdateService.js");
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { app: { getPath: () => root, isPackaged: false } };
  if (parent?.filename === remoteServicePath) {
    if (request === "./diagnosticsService") return { log: () => {}, logError: () => {} };
    if (request === "./nodeService") return { getNode: () => null };
    if (request === "./applicationHostService") return { APPLICATION_HOST_NODE_ID: "application-host" };
    if (request === "./localAgentRuntimeService") return { getBundledLocalAgentRuntime: () => ({ exists: false }), getBundledLocalAgentVersion: () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { updateRemoteAgent } = require(remoteServicePath);
Module._load = originalLoad;
const { SshService, _test: sshTest } = require("../src/services/sshService");
const manager = require("../src/services/agentUpdateManager");
const { Client } = require("ssh2");

const results = [];
const record = (id, title, outcome) => {
  results.push({ id, title, ...outcome });
  console.log(`${outcome.passed ? "PASS" : "FAIL"} ${id} ${title}${outcome.note ? ` — ${outcome.note}` : ""}`);
};

function dockerExec(container, script) {
  return execFileSync("docker", ["exec", container, "bash", "-c", script], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
}

// The node's real Agent, read inside the container (the token stays there).
async function healthProbe(nodeId) {
  try {
    const raw = dockerExec(nodeId, 'T=$(python3 -c "import json; print(json.load(open(\'/var/lib/anxos-agent/config/agent.json\'))[\'agentToken\'])"); curl -s --max-time 5 -H "Authorization: Bearer $T" 127.0.0.1:47131/api/v1/health');
    const health = JSON.parse(raw);
    const identity = health.identity || {};
    return { connected: health.ok === true, networkInventoryOk: true, agentVersion: identity.agentVersion || null, agentArtifactVersion: identity.agentArtifactVersion || null, deviceId: identity.deviceId || null };
  } catch (error) {
    return { connected: false, probeError: "unreachable" };
  }
}

const installed = (container) => dockerExec(container, "dpkg-query -W -f='${Version}' anxos-agent").trim();
const groups = (container) => dockerExec(container, "id -nG anx").trim();

// Pins the host key the way an owner would: the fingerprint the SSH client
// sees must be one of the container's own host keys (ssh-keygen -l inside).
async function approveHostKey(node) {
  const seen = await new Promise((resolve, reject) => {
    const client = new Client();
    let fingerprint = null;
    client.on("error", (error) => (fingerprint ? resolve(fingerprint) : reject(error)));
    client.connect({ host: "127.0.0.1", port: node.port, username: "nobody-probe", password: "x", tryKeyboard: false, hostVerifier: (key) => {
      fingerprint = `SHA256:${require("crypto").createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
      return true;
    } });
    client.on("ready", () => { client.end(); resolve(fingerprint); });
  });
  const local = dockerExec(node.container, "for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $f | cut -d' ' -f2; done").split(/\s+/).filter(Boolean);
  assert(local.includes(seen), `host key ${seen} is not one of ${node.container}'s keys`);
  const known = fs.existsSync(path.join(root, "ssh-known-hosts.json")) ? JSON.parse(fs.readFileSync(path.join(root, "ssh-known-hosts.json"), "utf8")) : {};
  known[`127.0.0.1:${node.port}`] = { fingerprint: seen, approvedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(root, "ssh-known-hosts.json"), JSON.stringify(known, null, 2));
  return seen;
}

function nodeRecord(node, health) {
  return { id: node.nodeId, displayName: node.container, platform: "linux", hostname: node.container, agentIdentity: { deviceId: health?.deviceId || null }, connection: { status: health?.connected ? "online" : "offline", agentArtifactVersion: health?.agentArtifactVersion || null } };
}

function updateOptions(ssh, extra = {}) {
  return {
    sshService: ssh,
    resolveNode: async (id) => nodeRecord(NODES.find((node) => node.nodeId === id), await healthProbe(id)),
    healthProbe,
    bundledBuild: TO,
    bundledVersion: "0.1.0",
    updateDir: path.join(root, "agent-updates"),
    verifyAttempts: 16,
    verifyDelayMs: 2500,
    ...extra,
  };
}

async function attempt(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

async function helperRollbackTo(container, build) {
  const out = dockerExec(container, `su - anx -c "sudo -n /usr/lib/anxos-agent/update-helper rollback ${build}"`);
  assert(/RESULT=rolled-back/.test(out), out);
}

(async () => {
  const started = Date.now();
  const ssh = new SshService();
  for (const node of NODES) {
    assert.strictEqual(installed(node.container), FROM, `${node.container} must start on ${FROM}`);
  }

  // A1 key sign-in against real OpenSSH, from a password profile.
  for (const node of NODES) {
    const fingerprint = await approveHostKey(node);
    ssh.saveProfile({ displayName: node.container, host: "127.0.0.1", port: node.port, username: "anx", authType: "password", nodeId: node.nodeId });
    const passwordProfile = ssh.listProfiles().profiles.find((profile) => profile.host === "127.0.0.1" && Number(profile.port) === node.port && profile.authType === "password");
    const t0 = Date.now();
    const setup = await ssh.setUpKeyAuthentication(passwordProfile.id, { password: PASSWORD, keyDirectory: path.join(root, "keys") });
    const keyLines = dockerExec(node.container, "cat /home/anx/.ssh/authorized_keys").trim().split("\n");
    const proof = await ssh.runCommand(setup.profile.id, "whoami");
    record(`A1-${node.container}`, "Key sign-in set up against real OpenSSH (host key pinned)", {
      passed: proof.stdout.trim() === "anx" && keyLines.length === 1 && ssh.getProfileForNode(node.nodeId).authType === "privateKey",
      note: `host ${fingerprint}, key ${setup.publicKeyFingerprint}, ${Date.now() - t0} ms; password profile kept`,
    });
  }
  const A = NODES[0];
  const B = NODES[1];

  // A2 password sudo, not in anxos-update: stops with the exact command.
  dockerExec(A.container, "gpasswd -d anx anxos-update >/dev/null");
  {
    const run = await attempt(updateRemoteAgent(A.nodeId, updateOptions(ssh)));
    const ok = !run.ok && run.error.code === "REMOTE_AGENT_UPDATE_SUDO_REQUIRED" && /usermod -aG anxos-update anx/.test(run.error.message) && installed(A.container) === FROM;
    record("A2", "Password sudo without anxos-update: package verified, not installed, exact command and helper hint", { passed: ok, note: run.ok ? "unexpectedly updated" : `${run.error.code}: ${run.error.details?.manualCommand || ""}` });
  }
  dockerExec(A.container, "usermod -aG anxos-update anx");

  // A3 a server running under the Agent: refused, nothing installed.
  {
    dockerExec(A.container, 'CG=$(systemctl show anxos-agent -p ControlGroup --value); nohup sleep 900 >/dev/null 2>&1 & echo $! > /root/fake-server.pid; echo $(cat /root/fake-server.pid) > /sys/fs/cgroup$CG/cgroup.procs');
    const run = await attempt(updateRemoteAgent(A.nodeId, updateOptions(ssh)));
    dockerExec(A.container, "kill $(cat /root/fake-server.pid) 2>/dev/null; true");
    record("A3", "Refused while a server runs under the Agent", { passed: !run.ok && run.error.code === "REMOTE_AGENT_UPDATE_SERVERS_RUNNING" && installed(A.container) === FROM, note: run.ok ? "unexpectedly updated" : run.error.code });
  }

  // A4 rollback drill: the real package is installed through the helper, the
  // verification is made to fail (the probe reports the old build for 3
  // checks), and the Desktop rolls back through the helper for real.
  {
    let lies = 0;
    const lyingProbe = async (id) => {
      const health = await healthProbe(id);
      if (health.agentArtifactVersion === TO && lies < 3) { lies += 1; return { ...health, agentArtifactVersion: FROM }; }
      return health;
    };
    const t0 = Date.now();
    const run = await attempt(updateRemoteAgent(A.nodeId, updateOptions(ssh, { healthProbe: lyingProbe, verifyAttempts: 3, verifyDelayMs: 1000 })));
    const after = await healthProbe(A.nodeId);
    const ok = !run.ok && run.error.code === "REMOTE_AGENT_UPDATE_VERIFY_FAILED" && /through the update helper and it is healthy again/.test(run.error.message) && installed(A.container) === FROM && after.agentArtifactVersion === FROM && after.connected;
    record("A4", "Rollback drill: helper installs the real package, failed verification, real helper rollback, healthy on the old build", { passed: ok, note: `${run.ok ? "no failure" : run.error.code}; ${Math.round((Date.now() - t0) / 1000)} s; Agent reports ${after.agentArtifactVersion}` });
  }

  // A5 the real update through the helper, no sudo password.
  {
    const pidBefore = dockerExec(A.container, "systemctl show anx-disposable -p MainPID --value 2>/dev/null || true").trim();
    const t0 = Date.now();
    const run = await attempt(updateRemoteAgent(A.nodeId, updateOptions(ssh)));
    const after = await healthProbe(A.nodeId);
    const pidAfter = dockerExec(A.container, "systemctl show anx-disposable -p MainPID --value 2>/dev/null || true").trim();
    record("A5", `Real ${FROM} -> ${TO} package update through the helper (no sudo password)`, {
      passed: run.ok && run.value.updated === true && run.value.privilege === "update-helper" && installed(A.container) === TO && after.agentArtifactVersion === TO,
      note: `${run.ok ? "" : `${run.error.code}: ${run.error.message} `}${Math.round((Date.now() - t0) / 1000)} s; unrelated service PID ${pidBefore || "n/a"} -> ${pidAfter || "n/a"}; deferred: ${(run.value?.deferredRestarts || []).join(", ") || "none"}; anx groups: ${groups(A.container)}`,
    });
  }
  await helperRollbackTo(A.container, FROM);

  // A6 Update all over both nodes.
  {
    const nodes = await Promise.all(NODES.map(async (node) => nodeRecord(node, await healthProbe(node.nodeId))));
    const overview = await manager.getAgentUpdateOverview({ listNodes: async () => nodes, desktopBuild: TO, getProfileForNode: (id) => ssh.getProfileForNode(id) });
    const history = [];
    const t0 = Date.now();
    const summary = await manager.updateAllAgents({ overview, updateAgent: (id) => updateRemoteAgent(id, updateOptions(ssh)), record: (entry, outcome) => history.push({ node: entry.nodeId, status: outcome.status }) });
    const ok = summary.ok && summary.updated === 2 && NODES.every((node) => installed(node.container) === TO);
    record("A6", "Update all: both nodes updated one at a time", { passed: ok, note: `${Math.round((Date.now() - t0) / 1000)} s; ${history.map((entry) => `${entry.node}:${entry.status}`).join(", ")}` });
  }
  for (const node of NODES) await helperRollbackTo(node.container, FROM);

  // A7 automatic maintenance window: outside the window nothing runs,
  // "notify" only records, "apply" inside the window updates the chosen
  // computers (only those).
  {
    const now = new Date();
    const start = `${String(now.getHours()).padStart(2, "0")}:${String(Math.floor(now.getMinutes() / 15) * 15).padStart(2, "0")}`;
    const getOverview = async () => manager.getAgentUpdateOverview({ listNodes: async () => Promise.all(NODES.map(async (node) => nodeRecord(node, await healthProbe(node.nodeId)))), desktopBuild: TO, getProfileForNode: (id) => ssh.getProfileForNode(id) });
    const outside = await manager.runAutoUpdateTick({ policy: manager.normalizeAutoUpdatePolicy({ enabled: true, mode: "apply", nodeIds: [A.nodeId], days: [(now.getDay() + 3) % 7], start, durationMinutes: 60 }), now, state: {}, getOverview, updateAgent: () => { throw new Error("must not run"); } });
    const notified = [];
    const notify = await manager.runAutoUpdateTick({ policy: manager.normalizeAutoUpdatePolicy({ enabled: true, mode: "notify", nodeIds: [A.nodeId, B.nodeId], days: [now.getDay()], start, durationMinutes: 60 }), now, state: {}, getOverview, updateAgent: () => { throw new Error("must not run"); }, notify: (entry) => notified.push(entry.nodeId) });
    const t0 = Date.now();
    const apply = await manager.runAutoUpdateTick({ policy: manager.normalizeAutoUpdatePolicy({ enabled: true, mode: "apply", nodeIds: [A.nodeId], days: [now.getDay()], start, durationMinutes: 60 }), now, state: {}, getOverview, updateAgent: (id) => updateRemoteAgent(id, updateOptions(ssh)) });
    const ok = outside.reason === "outside-window" && notify.reason === "notified" && notified.length === 2 && installed(B.container) === FROM
      && apply.reason === "updated" && apply.result.updated === 1 && installed(A.container) === TO && installed(B.container) === FROM;
    record("A7", "Maintenance window: outside = nothing, notify = record only, apply = only the chosen computer", { passed: ok, note: `outside:${outside.reason} notify:${notify.reason}(${notified.length}) apply:${apply.reason} in ${Math.round((Date.now() - t0) / 1000)} s; A=${installed(A.container)} B=${installed(B.container)}` });
  }

  // Audit trail on a node.
  const audit = dockerExec(A.container, "tail -n 3 /var/log/anxos-agent-update.log");
  record("A8", "Every helper call is in the root-only audit log", { passed: /"result":"installed"/.test(audit) && /"caller":"anx"/.test(audit), note: `${audit.trim().split("\n").length} recent entries` });

  const report = { at: new Date().toISOString(), from: FROM, to: TO, nodes: NODES.map((node) => node.container), durationSeconds: Math.round((Date.now() - started) / 1000), results };
  const out = path.join(os.tmpdir(), "anx215-agent-update-acceptance.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
  const failed = results.filter((result) => !result.passed).length;
  console.log(`\n${results.length - failed}/${results.length} passed in ${report.durationSeconds} s. Report: ${out}`);
  if (failed) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
