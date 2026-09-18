const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// V2-I bullet 3 hermetic smoke: scoped service/API credentials.
//
// Pins, against a REAL spawned agent:
//   1. unscoped token behaves exactly as before (regression baseline),
//   2. a family-scoped token is allowed in-family and denied out-of-family
//      with API_SCOPE_DENIED naming only the lacked family,
//   3. a node-scoped token is allowed on its node and denied for another node
//      with API_SCOPE_DENIED naming the target node,
//   4. scopes persist in the enrollment record and are cleared on re-pair
//      without scopes,
//   5. denial audit entries are present in the agent logs,
//   6. no token material appears in any denial response or captured log line.
//
// Roots are pinned into one temp tree (test-helpers/pin-agent-roots.js) and
// the agent's log directory is redirected into that tree so no run can leak
// job records, enrollment state, or logs into the developer machine.

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");

const rootDir = path.resolve(__dirname, "..");
const smokeRoot = pinAgentRoots("anx-agent-scope-enforcement-");
const configDirectory = path.join(smokeRoot, "config");
const logDirectory = path.join(smokeRoot, "logs");
const instanceRoot = path.join(smokeRoot, "instances");

const bootstrapToken = `anxos_scope-bootstrap-token-${"b".repeat(48)}`;
const enrolledToken = `anxos_scope-enrolled-token-${"a".repeat(48)}`;
const otherNodeId = "agent-other-node-0001";

const capturedStderr = [];
const capturedDenialBodies = [];

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

async function waitForAgent(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Scope-enforcement agent did not become ready.");
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { response, text, body };
}

async function enroll(url, scopes) {
  const start = await jsonFetch(`${url}/api/v1/enroll/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ minProtocolVersion: 1, maxProtocolVersion: 1 }),
  });
  assert.strictEqual(start.response.status, 200, "Enrollment start must succeed.");
  assert.ok(start.body?.enrollNonce, "Enrollment start must return a nonce.");
  const payload = {
    enrollNonce: start.body.enrollNonce,
    agentToken: enrolledToken,
    agentUrl: url,
    instanceRoot,
  };
  if (scopes !== undefined) payload.scopes = scopes;
  const complete = await jsonFetch(`${url}/api/v1/enroll/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.strictEqual(complete.response.status, 200, `Enrollment complete must succeed (scopes=${JSON.stringify(scopes)}).`);
  return complete.body;
}

async function expectAllowed(url, pathname, token, expectedStatus = 200) {
  const { response, body } = await jsonFetch(`${url}${pathname}`, { headers: authHeaders(token) });
  assert.strictEqual(
    response.status,
    expectedStatus,
    `${pathname} must be allowed (expected ${expectedStatus}, got ${response.status}${body?.error ? ` ${body.error.code}` : ""}).`,
  );
  return body;
}

async function expectDenied(url, pathname, token, expectedCode, expectedScope = null) {
  const { response, text, body } = await jsonFetch(`${url}${pathname}`, { headers: authHeaders(token) });
  capturedDenialBodies.push({ pathname, text });
  assert.strictEqual(response.status, 403, `${pathname} must be denied with 403 (got ${response.status}).`);
  assert.strictEqual(body?.error?.code, expectedCode, `${pathname} expected ${expectedCode}, got ${body?.error?.code}.`);
  if (expectedScope) {
    assert.strictEqual(body.error.details?.scope?.type, expectedScope.type, `${pathname} denial must name the lacked scope type.`);
    assert.strictEqual(body.error.details?.scope?.value, expectedScope.value, `${pathname} denial must name the lacked scope value.`);
  }
  return { text, body };
}

function readEnrollmentRecord() {
  return JSON.parse(fs.readFileSync(path.join(configDirectory, "enrollment.json"), "utf8"));
}

function readCapturedLogs() {
  const parts = [];
  for (const entry of fs.readdirSync(logDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    parts.push(fs.readFileSync(path.join(logDirectory, entry.name), "utf8"));
  }
  return parts.join("\n");
}

async function main() {
  await fsp.mkdir(configDirectory, { recursive: true });
  await fsp.mkdir(instanceRoot, { recursive: true });
  // Pin the agent config path explicitly so the agent never falls back to a
  // repo/global config file (which would silently change the credential).
  await fsp.writeFile(path.join(configDirectory, "agent.json"), JSON.stringify({
    backendMode: "agent",
    agentToken: bootstrapToken,
  }));
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;

  const agent = spawn(process.execPath, [path.join(rootDir, "agent", "src", "server.js")], {
    cwd: path.join(rootDir, "agent"),
    env: {
      ...process.env,
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: String(port),
      AGENT_TOKEN: bootstrapToken,
      // Explicit least-privilege set: system:read + files:read are granted, so
      // a scope denial can only come from scoping, and console:read stays
      // denied at the permission layer (the unscoped regression control).
      AGENT_API_PERMISSIONS: "system:read,files:read",
      AGENT_FILE_ROOTS: smokeRoot,
      AGENT_INSTANCE_ROOT: instanceRoot,
      AGENT_BACKUP_ROOT: path.join(smokeRoot, "backups"),
      ANXHUB_CONFIG_DIR: configDirectory,
      ANXHUB_AGENT_CONFIG_PATH: path.join(configDirectory, "agent.json"),
      ANXOS_LOG_DIR: logDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  agent.stderr.on("data", (chunk) => capturedStderr.push(chunk.toString("utf8")));

  try {
    await waitForAgent(url);

    // --- 1. Public/auth behavior unchanged -----------------------------------
    await expectAllowed(url, "/api/v1/health", bootstrapToken);
    const unauthenticated = await jsonFetch(`${url}/api/v1/stats`);
    assert.strictEqual(unauthenticated.response.status, 401, "Non-public APIs must still require authentication.");

    // --- 2. Unscoped token regression baseline -------------------------------
    // No enrollment record yet => unscoped context => profile permissions
    // apply exactly as before (grant in-profile, deny out-of-profile).
    await expectAllowed(url, "/api/v1/stats", bootstrapToken);
    await expectAllowed(url, "/api/v1/files/identity", bootstrapToken);
    await expectDenied(url, "/api/v1/console/commands", bootstrapToken, "API_PERMISSION_DENIED");

    // --- 3. Family-scoped token ----------------------------------------------
    await enroll(url, { families: ["system"] });
    let record = readEnrollmentRecord();
    assert.deepStrictEqual(
      record.scopes,
      { nodeIds: [], families: ["system"] },
      "Family scopes must persist on the enrollment record.",
    );
    await expectAllowed(url, "/api/v1/stats", enrolledToken);
    const familyDenial = await expectDenied(url, "/api/v1/files/identity", enrolledToken, "API_SCOPE_DENIED", {
      type: "family",
      value: "files",
    });
    assert.match(familyDenial.body.error.message, /scoped/i, "Scope denial must carry a scope-aware message.");
    // Combined scopes prove the denial names ONLY the lacked family: the node
    // scope contents must never be echoed.
    const nodeId = await resolveCurrentNodeId(url);
    await enroll(url, { nodeIds: [nodeId], families: ["system"] });
    const combinedDenial = await expectDenied(url, "/api/v1/files/identity", enrolledToken, "API_SCOPE_DENIED", {
      type: "family",
      value: "files",
    });
    assert.ok(!combinedDenial.text.includes(nodeId), "A family denial must not leak the credential's node scope.");
    assert.ok(!combinedDenial.text.includes("nodeIds"), "A family denial must not echo the scope schema.");
    await expectAllowed(url, "/api/v1/stats", enrolledToken);

    // --- 4. Node-scoped token -------------------------------------------------
    await enroll(url, { nodeIds: [otherNodeId] });
    record = readEnrollmentRecord();
    assert.deepStrictEqual(
      record.scopes,
      { nodeIds: [otherNodeId], families: [] },
      "Node scopes must persist on the enrollment record.",
    );
    // A credential scoped to a different node is denied everywhere on this node.
    // The denial names the target node it would need to cover (this agent's
    // node id) and never the credential's own scope entry.
    const nodeDenial = await expectDenied(url, "/api/v1/stats", enrolledToken, "API_SCOPE_DENIED", { type: "node", value: nodeId });
    assert.ok(!nodeDenial.text.includes(otherNodeId), "A node denial must not leak the credential's own node scope.");
    await expectDenied(url, "/api/v1/files/identity", enrolledToken, "API_SCOPE_DENIED", { type: "node", value: nodeId });

    // --- 5. Re-pair without scopes clears them --------------------------------
    await enroll(url, undefined);
    record = readEnrollmentRecord();
    assert.strictEqual(record.scopes, undefined, "Re-pairing without scopes must clear the persisted scopes.");
    await expectAllowed(url, "/api/v1/stats", enrolledToken);
    await expectAllowed(url, "/api/v1/files/identity", enrolledToken);
    // Unscoped is NOT a wildcard grant: out-of-profile capabilities stay denied.
    await expectDenied(url, "/api/v1/console/commands", enrolledToken, "API_PERMISSION_DENIED");

    // --- 6. Denial audit entries + secret hygiene -----------------------------
    const logs = readCapturedLogs();
    assert.ok(
      logs.includes('"errorCode":"API_SCOPE_DENIED"'),
      "Scope denials must produce audit entries carrying the API_SCOPE_DENIED code.",
    );
    for (const token of [bootstrapToken, enrolledToken]) {
      assert.ok(!logs.includes(token), "Captured logs must never contain token material.");
      for (const denial of capturedDenialBodies) {
        assert.ok(!denial.text.includes(token), `Denial response for ${denial.pathname} must never contain token material.`);
      }
    }
    const stderr = capturedStderr.join("");
    assert.ok(!stderr.includes(enrolledToken), "Agent stderr must never contain token material.");

    console.log("agent-scope-enforcement-smoke passed");
  } finally {
    agent.kill("SIGTERM");
    await new Promise((resolve) => agent.once("exit", resolve));
    await fsp.rm(smokeRoot, { recursive: true, force: true });
  }
}

// The node this agent serves, using the same derivation as nodeService.
async function resolveCurrentNodeId(url) {
  const status = await jsonFetch(`${url}/api/v1/enroll/status`);
  assert.strictEqual(status.response.status, 200, "Enrollment status must be readable.");
  const deviceId = status.body?.identity?.deviceId;
  assert.ok(deviceId, "Enrollment status must expose the device identity.");
  return `agent-${String(deviceId).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 56)}`;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
