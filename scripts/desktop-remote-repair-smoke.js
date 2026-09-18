#!/usr/bin/env node
// Security P1 follow-up regression: the desktop's own REMOTE repair path must
// keep working against an ALREADY ENROLLED node now that the Agent pairing
// surface requires proof of an existing credential.
//
// The gate (agent/src/routes/pairing.js: assertPairingAuthorization) refuses
// /pairing/start|complete|status|cancel for an enrolled node reached from a
// non-loopback address unless the caller presents a credential the Agent already
// trusts. The desktop legitimately holds that credential in the node credential
// store (src/services/nodeCredentialStore.js), so:
//   - startPairingSession() must send it as the `x-agent-token` header, and
//   - postPairingComplete() must send it as the `previousAgentToken` body field.
// When the desktop holds NO credential the request must stay unchanged so that
// first pairing of an unenrolled Agent still bootstraps remotely and an enrolled
// Agent is still refused (fail-closed).
//
// A real TCP connection to a 127.0.0.1-bound Agent always reports a loopback
// remoteAddress, so a plain spawned Agent cannot reproduce the refusal. This
// smoke therefore runs the desktop's REAL service functions
// (agentControlService.startPairingSession -> nodeService.pairNodeFromCode ->
// nodeService.postPairingComplete) against a faithfully stubbed HTTP surface
// that drives the REAL agent route handler with a synthetic non-loopback
// remoteAddress. The Agent-side authorization code under test is the shipped
// one, not a copy.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");

const smokeRoot = pinAgentRoots("anx-desktop-remote-repair-");
const configDir = path.join(smokeRoot, "config");
const enrollmentPath = path.join(configDir, "enrollment.json");
const logDir = path.join(smokeRoot, "logs");
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
process.env.ANXHUB_CONFIG_DIR = configDir;
process.env.AGENT_ENROLLMENT_PATH = enrollmentPath;
// Pin the desktop's backend mode so its legacy global agent config (which the
// app persists during pairing) is never migrated into the node record. Without
// this, `getEffectiveAgentSettings().agentToken` is copied onto the node and
// re-synced into the credential store, making "no credential" impossible to
// model deterministically.
process.env.BACKEND_MODE = "local";
// Must be set before the shared structured logger modules resolve their
// directory (they do this once at require time). Points both the Agent refusal
// audit line and the desktop service lines at one temp tree so the
// no-token-logged assertion can read them all.
process.env.ANXOS_LOG_DIR = logDir;

const pairingRoute = require("../agent/src/routes/pairing");
const agentControl = require("../src/services/agentControlService");
const nodeService = require("../src/services/nodeService");
const credentials = require("../src/services/nodeCredentialStore");
const { tokenFingerprint } = require("../src/shared/agentTokenStore");

const REMOTE_ADDRESS = "198.51.100.9"; // TEST-NET-2: definitively not loopback
const LOOPBACK_ADDRESS = "127.0.0.1";
const NODE_ID = "anxlab";
const DEVICE_ID = "device-anxlab";
const LIVE_TOKEN = "anxos_remote-repair-live-credential-0123456789";
const NEW_TOKEN = "anxos_remote-repair-new-credential-0123456789";
const secrets = [LIVE_TOKEN, NEW_TOKEN];

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function writeNodeState(agentUrl) {
  writeJson(nodeService.getNodesPath(), {
    schemaVersion: nodeService.NODE_SCHEMA_VERSION,
    selectedNodeId: NODE_ID,
    nodes: [{
      id: NODE_ID,
      kind: "agent",
      name: "Anxlab",
      displayName: "Anxlab",
      baseUrl: agentUrl,
      agentUrl,
      enabled: true,
      agentIdentity: { deviceId: DEVICE_ID, hostname: "Anxlab" },
    }],
    removedLocalAgents: [],
  });
}

function writeEnrolledRecord(token) {
  writeJson(enrollmentPath, {
    schemaVersion: 1,
    state: "enrolled",
    enrollmentId: "enr-desktop-remote-repair-0001",
    identityPath: path.join(configDir, "identity.json"),
    instanceRoot: path.join(smokeRoot, "agent-instances"),
    protocolVersion: 1,
    apiMajorVersion: 1,
    tokenFingerprint: tokenFingerprint(token),
    previousFingerprints: [],
    scopes: [],
    enrolledAtIso: "2026-01-01T00:00:00.000Z",
  });
}

function clearEnrollmentRecord() {
  try { fs.rmSync(enrollmentPath, { force: true }); } catch {}
}

// "The desktop holds no credential for this node" means BOTH the protected
// credential store entry and the legacy `agentToken` persisted on the node
// record are absent: nodeService.readNodeState() re-syncs a node's legacy
// agentToken back into the credential store, so clearing only the store would
// self-heal on the next read.
function clearNodeCredential(agentUrl) {
  writeNodeState(agentUrl);
  credentials.deleteNodeToken(NODE_ID);
}

function readAllLogs(directory) {
  let text = "";
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) text += `${fs.readFileSync(full, "utf8")}\n`;
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return text;
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body ?? {}));
}

// A faithful stand-in for the Agent HTTP surface: the real route handler runs
// with a synthetic non-loopback caller, so the shipped authorization rule is
// what decides every pairing request.
function createGateServer() {
  const state = {
    config: {
      token: LIVE_TOKEN,
      instanceRoot: path.join(smokeRoot, "agent-instances"),
      tokenStatus: { configured: true, source: "shared-config", configPath: path.join(configDir, "agent.json") },
    },
    startRequests: [],
    completeRequests: [],
  };

  const relay = async (method, rawUrl, headers, rawBody) => {
    const routeUrl = new URL(String(rawUrl).split("?")[0], "http://127.0.0.1");
    const request = { method, url: rawUrl, socket: { remoteAddress: REMOTE_ADDRESS }, headers, body: rawBody };
    try {
      const result = await pairingRoute.handlePairing(request, routeUrl, state.config);
      return { statusCode: result.statusCode || 200, body: result.body };
    } catch (error) {
      return { statusCode: error.statusCode || 500, body: { error: { code: error.code || "INTERNAL_ERROR", message: error.message } } };
    }
  };

  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", async () => {
      const pathname = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`).pathname;
      if (request.method === "POST" && pathname === "/api/v1/pairing/start") {
        state.startRequests.push({ headers: request.headers, body: raw });
        const result = await relay(request.method, request.url, request.headers, raw);
        sendJson(response, result.statusCode, result.body);
        return;
      }
      if (request.method === "POST" && pathname === "/api/v1/pairing/complete") {
        state.completeRequests.push({ headers: request.headers, body: raw });
        const result = await relay(request.method, request.url, request.headers, raw);
        sendJson(response, result.statusCode, result.body);
        return;
      }
      if (request.method === "GET" && pathname === "/api/v1/health") {
        const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "") || request.headers["x-agent-token"] || "";
        const ok = Boolean(token) && token === state.config.token;
        sendJson(response, ok ? 200 : 401, {
          ok,
          apiVersion: "1",
          protocolVersion: 1,
          agentVersion: "1.0.0",
          identity: { deviceId: DEVICE_ID, hostname: "Anxlab", platform: "linux", architecture: "x64", agentVersion: "1.0.0", apiVersion: "1" },
          capabilities: [],
        });
        return;
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
    });
  });

  return { server, state };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function lastHeader(request, name) {
  return request?.headers?.[name];
}

async function main() {
  const { server, state } = createGateServer();
  const port = await listen(server);
  const agentUrl = `http://127.0.0.1:${port}`;
  try {
    // Keep the global agent runtime config out of this test's credential
    // decisions: a "local" mode has no legacy agent URL/token to migrate into
    // the node state, so "the desktop holds no credential" is deterministic.
    writeJson(path.join(configDir, "agent.json"), { backendMode: "local" });
    writeNodeState(agentUrl);

    // -----------------------------------------------------------------------
    // Leg 1: remote ENROLLED node whose credential the desktop holds.
    // startPairingSession + pairNodeFromCode (postPairingComplete) must succeed
    // end to end. Without the client change the Agent gate refuses both calls.
    // -----------------------------------------------------------------------
    writeEnrolledRecord(LIVE_TOKEN);
    credentials.setNodeToken(NODE_ID, LIVE_TOKEN);
    state.config.token = LIVE_TOKEN;
    pairingRoute._test.reset();

    const session = await agentControl.startPairingSession({ nodeId: NODE_ID });
    assert(session.pairingCode, "Leg 1: a remote enrolled node must open a pairing session when the desktop holds its credential.");
    secrets.push(session.pairingCode);
    assert.strictEqual(
      lastHeader(state.startRequests.at(-1), "x-agent-token"),
      LIVE_TOKEN,
      "Leg 1: startPairingSession must present the stored node credential as x-agent-token.",
    );

    const repaired = await nodeService.pairNodeFromCode({ id: NODE_ID, pairingCode: session.pairingCode });
    assert.strictEqual(repaired.paired, true, "Leg 1: the remote repair must complete end to end.");
    const completeBody = JSON.parse(state.completeRequests.at(-1).body || "{}");
    assert.strictEqual(completeBody.previousAgentToken, LIVE_TOKEN, "Leg 1: postPairingComplete must present the stored node credential as previousAgentToken.");
    assert(completeBody.permanentToken && completeBody.permanentToken !== LIVE_TOKEN, "Leg 1: the repair must install a fresh credential.");
    secrets.push(completeBody.permanentToken);
    assert.strictEqual(state.config.token, completeBody.permanentToken, "Leg 1: the Agent must adopt the new credential.");
    assert.strictEqual(credentials.getNodeToken(NODE_ID), completeBody.permanentToken, "Leg 1: the desktop must persist the rotated credential.");
    console.log("leg 1 passed: remote repair of an enrolled node succeeds with the credential the desktop holds");

    // -----------------------------------------------------------------------
    // Leg 2: node the desktop has NO credential for, Agent UNENROLLED.
    // Bootstrap / first pairing must still work remotely, with no credential
    // header invented.
    // -----------------------------------------------------------------------
    clearEnrollmentRecord();
    clearNodeCredential(agentUrl);
    pairingRoute._test.reset();
    state.config.token = "";
    state.startRequests.length = 0;

    const bootstrapSession = await agentControl.startPairingSession({ nodeId: NODE_ID });
    assert(bootstrapSession.pairingCode, "Leg 2: remote first pairing of an unenrolled Agent must still open a session.");
    secrets.push(bootstrapSession.pairingCode);
    assert.strictEqual(
      lastHeader(state.startRequests.at(-1), "x-agent-token"),
      undefined,
      "Leg 2: no credential header may be sent when the desktop holds none.",
    );
    const bootstrapPaired = await nodeService.pairNodeFromCode({ id: NODE_ID, pairingCode: bootstrapSession.pairingCode });
    assert.strictEqual(bootstrapPaired.paired, true, "Leg 2: remote first pairing of an unenrolled Agent must still complete.");
    const bootstrapCompleteBody = JSON.parse(state.completeRequests.at(-1).body || "{}");
    assert.strictEqual(bootstrapCompleteBody.previousAgentToken, undefined, "Leg 2: no previousAgentToken may be sent when the desktop holds none.");
    const currentToken = state.config.token;
    assert(currentToken, "Leg 2: the bootstrap pairing must install a credential.");
    secrets.push(currentToken);
    console.log("leg 2 passed: remote first pairing of an unenrolled Agent still bootstraps with no credential");

    // -----------------------------------------------------------------------
    // Leg 3: node the desktop has NO credential for, Agent ENROLLED.
    // The desktop's start must be refused (fail-closed), and postPairingComplete
    // must be refused even when a session was opened by the on-host operator.
    // -----------------------------------------------------------------------
    writeEnrolledRecord(currentToken);
    clearNodeCredential(agentUrl);
    pairingRoute._test.reset();
    state.startRequests.length = 0;
    state.completeRequests.length = 0;

    await assert.rejects(
      () => agentControl.startPairingSession({ nodeId: NODE_ID }),
      (error) => {
        assert.strictEqual(error.code, "PAIRING_REQUIRES_EXISTING_CREDENTIAL", `Leg 3: the enrolled refusal must surface PAIRING_REQUIRES_EXISTING_CREDENTIAL (got ${error.code || error.message}).`);
        return true;
      },
      "Leg 3: a remote enrolled node with no stored credential must be refused.",
    );
    assert.strictEqual(pairingRoute._test.safeSession().active, false, "Leg 3: a refused start must not create a pairing session.");

    const loopbackSession = await pairingRoute.handlePairing(
      { method: "POST", url: "/api/v1/pairing/start", socket: { remoteAddress: LOOPBACK_ADDRESS }, headers: { host: `127.0.0.1:${port}` }, body: "" },
      new URL("/api/v1/pairing/start", "http://127.0.0.1"),
      state.config,
    );
    assert.strictEqual(loopbackSession.statusCode, 200, "Leg 3 setup: an on-host (loopback) session must open on an enrolled node.");
    const onHostCode = loopbackSession.body.pairingCode;
    secrets.push(onHostCode);
    const tokenBeforeRefusal = state.config.token;
    await assert.rejects(
      () => nodeService._test.postPairingComplete(agentUrl, { pairingCode: onHostCode, permanentToken: NEW_TOKEN }, { nodeId: NODE_ID }),
      (error) => {
        assert.strictEqual(error.code, "PAIRING_REQUIRES_EXISTING_CREDENTIAL", `Leg 3: postPairingComplete must be refused with PAIRING_REQUIRES_EXISTING_CREDENTIAL (got ${error.code || error.message}).`);
        assert.strictEqual(error.status, 403, "Leg 3: the refusal must use HTTP 403.");
        return true;
      },
      "Leg 3: postPairingComplete with no credential must be refused on an enrolled node.",
    );
    assert.strictEqual(state.config.token, tokenBeforeRefusal, "Leg 3: a refused complete must not rotate the Agent credential.");
    console.log("leg 3 passed: enrolled node with no stored credential is refused on start and on complete (fail-closed)");

    // -----------------------------------------------------------------------
    // Leg 4: no token material in the desktop or Agent log output.
    // -----------------------------------------------------------------------
    const logs = readAllLogs(logDir);
    assert(logs.length > 0, "Leg 4: the refusal must produce an audit line in the log tree.");
    assert(logs.includes("Pairing request refused"), "Leg 4: the enrolled refusal must be audited.");
    for (const secret of secrets) {
      assert(!logs.includes(secret), `Leg 4: logs must not contain token material or a pairing code (${secret.slice(0, 12)}...).`);
    }
    console.log("leg 4 passed: no token material or pairing code appears in the log output");

    console.log("desktop:remote-repair:smoke passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    clearEnrollmentRecord();
    pairingRoute._test.reset();
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("desktop:remote-repair:smoke FAILED:", error.stack || error.message);
  process.exitCode = 1;
});
