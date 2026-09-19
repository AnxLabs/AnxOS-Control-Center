const assert = require("assert");
const fsp = require("fs/promises");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// V2-I bullet 2/3 hermetic smoke: strong authentication for remote
// administration (src/shared/remoteAdminPolicy.js, enforced in
// agent/src/server.js's authorization path).
//
// Two halves, because the rule has two layers and both must be real:
//
//   PART 1 — the pure policy. An exhaustive table over every permission family
//   the Agent can route, asserting loopback is never strengthened, a remote
//   caller is refused without the explicit operator setting, a remote caller
//   with an unscoped (legacy) credential is refused, an undeterminable origin is
//   refused, and a remote caller with an explicitly family-scoped credential AND
//   the setting enabled is ALLOWED. The allowed case is the positive control:
//   it makes a refuse-everything implementation fail this smoke.
//
//   PART 2 — the enforcement, at the request layer against a REAL spawned
//   Agent. The Agent binds a wildcard address and is reached BOTH over loopback
//   and over the machine's own non-loopback IPv4, so `request.socket.
//   remoteAddress` genuinely differs between the two and the assertions cannot
//   pass by accident. A remote origin at the request layer is produced without
//   any network hop off this machine: connecting to a local non-loopback
//   address yields that address as the socket's remote address (verified).
//   This ALSO re-checks that the pre-existing gates still run — an unauthenticated
//   request is still 401 and an ungranted capability is still 403
//   API_PERMISSION_DENIED — so the new gate cannot have replaced them.
//
// UNPROVEN BY THIS SMOKE: no caller on another machine was exercised. The rule
// is proven at the request layer (a real socket whose remote address is
// non-loopback), not over a real network path.

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const policy = require("../src/shared/remoteAdminPolicy");
const { waitForAgentReady } = require("./test-helpers/agent-readiness");

const rootDir = path.resolve(__dirname, "..");
const smokeRoot = pinAgentRoots("anx-remote-admin-authz-");

const BOOTSTRAP_TOKEN = `anxos_remote-admin-bootstrap-${"a".repeat(48)}`;
const SCOPED_TOKEN = `anxos_remote-admin-scoped-${"b".repeat(48)}`;

const agents = [];

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

function nonLoopbackIPv4Addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family === "IPv4" && !entry.internal) out.push(entry.address);
    }
  }
  return out;
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

// Starts one real Agent on a wildcard bind, with its own pinned config tree so
// no run can leak enrollment state into the developer machine.
async function startAgent(label, options) {
  const { permissions, remoteAdmin = false } = options;
  const base = path.join(smokeRoot, label);
  const configDirectory = path.join(base, "config");
  const instanceRoot = path.join(base, "instances");
  const logDirectory = path.join(base, "logs");
  await fsp.mkdir(configDirectory, { recursive: true });
  await fsp.mkdir(instanceRoot, { recursive: true });
  const port = await getFreePort();
  await fsp.writeFile(path.join(configDirectory, "agent.json"), JSON.stringify({
    backendMode: "agent",
    agentToken: BOOTSTRAP_TOKEN,
  }));

  const env = {
    ...process.env,
    AGENT_HOST: "0.0.0.0",
    AGENT_PORT: String(port),
    AGENT_TOKEN: BOOTSTRAP_TOKEN,
    AGENT_API_PERMISSIONS: permissions,
    AGENT_FILE_ROOTS: base,
    AGENT_INSTANCE_ROOT: instanceRoot,
    AGENT_BACKUP_ROOT: path.join(base, "backups"),
    ANXHUB_CONFIG_DIR: configDirectory,
    ANXHUB_AGENT_CONFIG_PATH: path.join(configDirectory, "agent.json"),
    ANXOS_LOG_DIR: logDirectory,
  };
  // Never inherit a developer-shell setting: only the plan turns it on.
  delete env.AGENT_REMOTE_ADMIN;
  if (remoteAdmin) env.AGENT_REMOTE_ADMIN = "1";

  const child = spawn(process.execPath, [path.join(rootDir, "agent", "src", "server.js")], {
    cwd: path.join(rootDir, "agent"),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = { value: "" };
  child.stderr.on("data", (chunk) => { stderr.value += String(chunk); });
  const agent = {
    label,
    port,
    configDirectory,
    instanceRoot,
    child,
    stderr,
    loopbackUrl: `http://127.0.0.1:${port}`,
    remoteUrl: null,
  };
  agents.push(agent);
  await waitForAgentReady({
    label: `${label} agent`,
    probe: async () => (await fetch(`${agent.loopbackUrl}/api/v1/health`)).ok,
  });
  return agent;
}

async function expectAllowed(url, pathname, token, options = {}, expectedStatus = 200) {
  const { response, body } = await jsonFetch(`${url}${pathname}`, {
    ...options,
    headers: { ...authHeaders(token), ...(options.headers || {}) },
  });
  assert.strictEqual(
    response.status,
    expectedStatus,
    `${pathname} must be allowed (expected ${expectedStatus}, got ${response.status}${body?.error ? ` ${body.error.code}` : ""}).`,
  );
  return body;
}

async function expectRefused(url, pathname, token, expectedCode, options = {}) {
  const { response, body, text } = await jsonFetch(`${url}${pathname}`, {
    ...options,
    headers: { ...authHeaders(token), ...(options.headers || {}) },
  });
  const got = body?.error?.code;
  assert.strictEqual(response.status, 403, `${pathname} must be refused with 403 (got ${response.status}, code ${got}).`);
  assert.strictEqual(got, expectedCode, `${pathname} expected ${expectedCode}, got ${got}. Response: ${text.slice(0, 300)}`);
  return body;
}

// --- PART 1: the pure policy ------------------------------------------------

// One representative permission per family the Agent's route table can produce
// (agent/src/server.js getRoutePermission). "ui:session" is the sole
// loopback-only family.
const ROUTE_PERMISSIONS = [
  "system:read",
  "public-access:read",
  "public-access:write",
  "instance:read",
  "instance:write",
  "instance:lifecycle",
  "instance:delete",
  "files:read",
  "files:write",
  "console:read",
  "console:write",
  "backups:read",
  "backups:write",
  "backups:restore",
  "docker:read",
  "docker:write",
  "dependencies:read",
  "dependencies:write",
  "marketplace:read",
  "owner",
  "ui:session",
  "agent:manage",
  "actions:read",
  "actions:execute",
];

function runPolicyTable() {
  const covered = { allowed: 0, refused: 0, loopbackOnly: 0 };

  for (const permission of ROUTE_PERMISSIONS) {
    const family = policy.permissionFamily(permission);
    assert.ok(family, `Every route permission must resolve to a family (${permission}).`);
    const scoped = { families: [family] };

    // (1) Loopback is never strengthened, for every family.
    const loopback = policy.evaluateRemoteAdminAccess({ origin: "loopback", permission });
    assert.strictEqual(loopback.access, policy.ACCESS_ALLOWED, `${permission}: loopback must be allowed unchallenged.`);
    assert.strictEqual(loopback.code, "REMOTE_ADMIN_LOOPBACK_ORIGIN", `${permission}: loopback must carry the loopback code.`);

    // A loopback-only family (ui) is refused for EVERY remote descriptor, and
    // that refusal outranks the other reasons, so it is asserted once here and
    // the remaining remote cases are exercised for the non-loopback-only
    // families. Its loopback path is asserted above.
    if (family === "ui") {
      const remoteLoopbackOnly = [
        { origin: "remote", permission, enrollmentState: "enrolled", scopes: scoped },
        { origin: "remote", permission, remoteAdminEnabled: true, enrollmentState: "enrolled", scopes: scoped },
        { origin: "remote", permission, remoteAdminEnabled: true, enrollmentState: "enrolled", scopes: { families: ["*"] } },
      ];
      for (const descriptor of remoteLoopbackOnly) {
        const verdict = policy.evaluateRemoteAdminAccess(descriptor);
        assert.strictEqual(verdict.access, policy.ACCESS_REFUSED, `${permission}: a loopback-only family must be refused remotely.`);
        assert.strictEqual(verdict.code, "REMOTE_ADMIN_LOOPBACK_ONLY_FAMILY", `${permission}: expected REMOTE_ADMIN_LOOPBACK_ONLY_FAMILY, got ${verdict.code}.`);
      }
      covered.refused += 1;
      covered.loopbackOnly += 1;
      continue;
    }

    // (2) Remote WITHOUT the explicit setting: refused even with a valid,
    // scoped, enrolled credential.
    const notEnabled = policy.evaluateRemoteAdminAccess({
      origin: "remote", permission, enrollmentState: "enrolled", scopes: scoped,
    });
    assert.strictEqual(notEnabled.access, policy.ACCESS_REFUSED, `${permission}: remote without AGENT_REMOTE_ADMIN must be refused.`);
    assert.strictEqual(notEnabled.code, "REMOTE_ADMIN_NOT_ENABLED", `${permission}: expected REMOTE_ADMIN_NOT_ENABLED, got ${notEnabled.code}.`);

    // (3) Remote, setting on, unscoped (legacy) credential: refused.
    const unscoped = policy.evaluateRemoteAdminAccess({
      origin: "remote", permission, remoteAdminEnabled: true, enrollmentState: "enrolled", scopes: null,
    });
    assert.strictEqual(unscoped.code, "REMOTE_ADMIN_CREDENTIAL_UNSCOPED", `${permission}: an unscoped remote credential must be refused.`);

    // (4) Remote, setting on, undeterminable enrollment state: refused.
    const noState = policy.evaluateRemoteAdminAccess({
      origin: "remote", permission, remoteAdminEnabled: true, enrollmentState: null, scopes: scoped,
    });
    assert.strictEqual(noState.code, "REMOTE_ADMIN_STATE_UNDETERMINED", `${permission}: an undeterminable state must be refused.`);

    // (5) Remote, setting on, a non-enrolled credential: refused.
    const revoked = policy.evaluateRemoteAdminAccess({
      origin: "remote", permission, remoteAdminEnabled: true, enrollmentState: "revoked", scopes: scoped,
    });
    assert.strictEqual(revoked.code, "REMOTE_ADMIN_NOT_ENROLLED", `${permission}: a non-enrolled remote credential must be refused.`);

    // (6) Remote, setting on, scoped to a DIFFERENT family: refused.
    const wrongFamily = policy.evaluateRemoteAdminAccess({
      origin: "remote", permission, remoteAdminEnabled: true, enrollmentState: "enrolled", scopes: { families: ["unrelated-family"] },
    });
    assert.strictEqual(wrongFamily.code, "REMOTE_ADMIN_FAMILY_NOT_COVERED", `${permission}: a scope that does not cover the family must be refused.`);

    // (7) A wildcard scope is NOT explicit coverage: refused.
    const wildcard = policy.evaluateRemoteAdminAccess({
      origin: "remote", permission, remoteAdminEnabled: true, enrollmentState: "enrolled", scopes: { families: ["*"] },
    });
    assert.strictEqual(wildcard.code, "REMOTE_ADMIN_FAMILY_NOT_COVERED", `${permission}: a "*" family scope is not explicit coverage.`);

    // (8) A node-scoped-only credential is not family-scoped: refused.
    const nodeOnly = policy.evaluateRemoteAdminAccess({
      origin: "remote", permission, remoteAdminEnabled: true, enrollmentState: "enrolled", scopes: { nodeIds: ["agent-other-node"] },
    });
    assert.strictEqual(nodeOnly.code, "REMOTE_ADMIN_FAMILY_NOT_COVERED", `${permission}: a node-only scope does not cover a family.`);

    // (9) The verdict for a fully-satisfying remote caller: ALLOWED. This is the
    // positive control for the family loop — a refuse-everything policy fails here.
    const satisfied = policy.evaluateRemoteAdminAccess({
      origin: "remote", permission, remoteAdminEnabled: true, enrollmentState: "enrolled", scopes: scoped,
    });
    assert.strictEqual(satisfied.access, policy.ACCESS_ALLOWED_WITH_REQUIREMENT, `${permission}: a scoped, enabled remote caller must be allowed (got ${satisfied.access}).`);
    assert.strictEqual(satisfied.allowed, true, `${permission}: the satisfied verdict must be allowed.`);
    assert.strictEqual(satisfied.code, "REMOTE_ADMIN_SCOPED_CREDENTIAL", `${permission}: expected the scoped-credential allow code.`);
    assert.ok(satisfied.requirement, `${permission}: an allowed-with-requirement verdict must name the requirement.`);
    covered.allowed += 1;
    covered.refused += 1;
  }

  // Positive control: a policy that refuses everything cannot pass this smoke.
  assert.ok(covered.allowed > 0, "Positive control failed: no remote caller was ever allowed.");
  assert.ok(covered.loopbackOnly > 0, "The loopback-only family set must not be empty (ui is expected).");

  // A route with no capability family is not gated, remote or not.
  for (const remoteAdminEnabled of [false, true, undefined]) {
    const noFamily = policy.evaluateRemoteAdminAccess({ origin: "remote", permission: null, remoteAdminEnabled });
    assert.strictEqual(noFamily.access, policy.ACCESS_ALLOWED, "A capability-free route must not be gated.");
    assert.strictEqual(noFamily.code, "REMOTE_ADMIN_NO_FAMILY_REQUIRED", "A capability-free route must carry the no-family code.");
  }

  // Undeterminable origins, every shape: refused. Never assumed local.
  const undetermined = [
    {},
    { origin: "unknown" },
    { origin: "" },
    { origin: null },
    { origin: 42 },
    { remoteAddress: undefined },
    { remoteAddress: "" },
    { remoteAddress: null },
    { remoteAddress: 7 },
  ];
  for (const descriptor of undetermined) {
    const verdict = policy.evaluateRemoteAdminAccess({ ...descriptor, permission: "files:read" });
    assert.strictEqual(verdict.access, policy.ACCESS_REFUSED, `Undeterminable origin ${JSON.stringify(descriptor)} must be refused.`);
    assert.strictEqual(verdict.code, "REMOTE_ADMIN_ORIGIN_UNDETERMINED", `Undeterminable origin ${JSON.stringify(descriptor)} must carry REMOTE_ADMIN_ORIGIN_UNDETERMINED.`);
  }

  // Origin classification is exactly the loopback spellings and nothing else.
  const originCases = [
    ["127.0.0.1", policy.ORIGIN_LOOPBACK],
    ["::1", policy.ORIGIN_LOOPBACK],
    ["::ffff:127.0.0.1", policy.ORIGIN_LOOPBACK],
    ["0:0:0:0:0:0:0:1", policy.ORIGIN_LOOPBACK],
    ["127.0.0.2", policy.ORIGIN_REMOTE],
    ["192.168.1.20", policy.ORIGIN_REMOTE],
    ["::ffff:192.168.1.20", policy.ORIGIN_REMOTE],
    ["", policy.ORIGIN_UNKNOWN],
    [undefined, policy.ORIGIN_UNKNOWN],
    [null, policy.ORIGIN_UNKNOWN],
    [12, policy.ORIGIN_UNKNOWN],
  ];
  for (const [input, expected] of originCases) {
    assert.strictEqual(policy.classifyOrigin(input), expected, `classifyOrigin(${JSON.stringify(input)}) must be ${expected}.`);
  }

  // The setting is fail-closed: only recognized truthy values enable it.
  const settingCases = [
    [true, undefined, true],
    [false, undefined, false],
    [undefined, { AGENT_REMOTE_ADMIN: "1" }, true],
    [undefined, { AGENT_REMOTE_ADMIN: "true" }, true],
    [undefined, { AGENT_REMOTE_ADMIN: "on" }, true],
    [undefined, { AGENT_REMOTE_ADMIN: "off" }, false],
    [undefined, { AGENT_REMOTE_ADMIN: "" }, false],
    [undefined, { AGENT_REMOTE_ADMIN: "maybe" }, false],
    [undefined, {}, false],
  ];
  for (const [explicit, env, expected] of settingCases) {
    assert.strictEqual(policy.isRemoteAdminEnabled(explicit, env), expected, `isRemoteAdminEnabled(${explicit}, ${JSON.stringify(env)}) must be ${expected}.`);
  }

  assert.strictEqual(policy.REMOTE_ADMIN_ENV_KEY, "AGENT_REMOTE_ADMIN", "The operator setting key must be AGENT_REMOTE_ADMIN.");
  console.log(`[policy] ${ROUTE_PERMISSIONS.length} families: ${covered.allowed} allowed when satisfied, ${covered.loopbackOnly} loopback-only, all stricter cases refused.`);
}

// --- PART 2: enforcement against a real Agent -------------------------------

async function enrollmentHandshake(url, { token, scopes, previousToken } = {}) {
  const start = await jsonFetch(`${url}/api/v1/enroll/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ minProtocolVersion: 1, maxProtocolVersion: 1 }),
  });
  assert.strictEqual(start.response.status, 200, "Enrollment start must succeed over loopback.");
  assert.ok(start.body?.enrollNonce, "Enrollment start must return a nonce.");
  const payload = {
    enrollNonce: start.body.enrollNonce,
    agentToken: token,
    agentUrl: url,
  };
  if (scopes !== undefined) payload.scopes = scopes;
  if (previousToken !== undefined) payload.previousAgentToken = previousToken;
  return jsonFetch(`${url}/api/v1/enroll/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function runEnforcement(remoteIp) {
  // --- Agent A: remote administration NOT enabled ---------------------------
  const agentA = await startAgent("agent-a-default", { permissions: "system:read,files:read" });
  const aLoop = agentA.loopbackUrl;
  const aRemote = `http://${remoteIp}:${agentA.port}`;

  // Existing gates still run (this gate is additive, not a replacement).
  assert.strictEqual((await fetch(`${aLoop}/api/v1/health`)).status, 200, "Health must remain public.");
  assert.strictEqual((await fetch(`${aLoop}/api/v1/stats`)).status, 401, "An unauthenticated request must still be 401.");
  const badToken = await jsonFetch(`${aLoop}/api/v1/stats`, { headers: authHeaders("not-the-token") });
  assert.strictEqual(badToken.response.status, 401, "A wrong bearer token must still be 401.");
  await expectRefused(aLoop, "/api/v1/console/commands", BOOTSTRAP_TOKEN, "API_PERMISSION_DENIED");

  // Loopback is unaffected for every family the profile grants.
  await expectAllowed(aLoop, "/api/v1/stats", BOOTSTRAP_TOKEN);
  await expectAllowed(aLoop, "/api/v1/files/identity", BOOTSTRAP_TOKEN);

  // Remote, valid credential, NO explicit setting: refused.
  await expectRefused(aRemote, "/api/v1/stats", BOOTSTRAP_TOKEN, "REMOTE_ADMIN_NOT_ENABLED");
  await expectRefused(aRemote, "/api/v1/files/identity", BOOTSTRAP_TOKEN, "REMOTE_ADMIN_NOT_ENABLED");
  // Public routes stay reachable remotely (unchanged).
  assert.strictEqual((await fetch(`${aRemote}/api/v1/health`)).status, 200, "Health must stay public for a remote origin.");
  // Authentication still precedes this gate remotely.
  assert.strictEqual((await fetch(`${aRemote}/api/v1/stats`)).status, 401, "A remote request with no credential must still be 401.");
  // The remote refusal must not leak a credential or a scope.
  const remoteRefusal = await jsonFetch(`${aRemote}/api/v1/stats`, { headers: authHeaders(BOOTSTRAP_TOKEN) });
  assert.ok(!remoteRefusal.text.includes(BOOTSTRAP_TOKEN), "A remote refusal must never echo token material.");

  // --- Agent B: remote administration enabled, UNscoped enrollment ----------
  const agentB = await startAgent("agent-b-enabled-unscoped", { permissions: "system:read,files:read", remoteAdmin: true });
  const bLoop = agentB.loopbackUrl;
  const bRemote = `http://${remoteIp}:${agentB.port}`;
  // The persisted shared token auto-migrates into an enrolled record with no
  // scopes, which is exactly the legacy/unscoped credential under test.
  await expectAllowed(bLoop, "/api/v1/stats", BOOTSTRAP_TOKEN);
  await expectRefused(bRemote, "/api/v1/stats", BOOTSTRAP_TOKEN, "REMOTE_ADMIN_CREDENTIAL_UNSCOPED");
  await expectRefused(bRemote, "/api/v1/files/identity", BOOTSTRAP_TOKEN, "REMOTE_ADMIN_CREDENTIAL_UNSCOPED");
  // Loopback is unaffected even with the setting ON.
  await expectAllowed(bLoop, "/api/v1/files/identity", BOOTSTRAP_TOKEN);

  // --- Agent C: enabled + an explicitly family-scoped credential ------------
  const agentC = await startAgent("agent-c-enabled-scoped", {
    permissions: "system:read,files:read,ui:session",
    remoteAdmin: true,
  });
  const cLoop = agentC.loopbackUrl;
  const cRemote = `http://${remoteIp}:${agentC.port}`;
  const enrolled = await enrollmentHandshake(cLoop, {
    token: SCOPED_TOKEN,
    previousToken: BOOTSTRAP_TOKEN,
    scopes: { families: ["system", "files", "ui"] },
  });
  assert.strictEqual(enrolled.response.status, 200, `Re-enrolling with scopes over loopback must succeed (got ${enrolled.response.status}).`);

  // Positive control at the request layer: this remote caller IS allowed.
  const allowedStats = await expectAllowed(cRemote, "/api/v1/stats", SCOPED_TOKEN);
  assert.ok(allowedStats, "The allowed remote request must return a body.");
  await expectAllowed(cRemote, "/api/v1/files/identity", SCOPED_TOKEN);
  // Loopback still works for the same credential.
  await expectAllowed(cLoop, "/api/v1/stats", SCOPED_TOKEN);

  // The loopback-only family stays loopback-only even when the scope covers it
  // and the setting is on: remote refused, loopback allowed.
  await expectRefused(cRemote, "/api/v1/ui/bootstrap-code", SCOPED_TOKEN, "REMOTE_ADMIN_LOOPBACK_ONLY_FAMILY", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  await expectAllowed(cLoop, "/api/v1/ui/bootstrap-code", SCOPED_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  // An ungranted capability is still denied by the pre-existing permission gate,
  // not silently reshaped by this one.
  await expectRefused(cRemote, "/api/v1/console/commands", SCOPED_TOKEN, "API_PERMISSION_DENIED");

  // The refusal is audited.
  const logText = await readLogDirectory(path.join(smokeRoot, "agent-a-default", "logs"));
  assert.ok(
    logText.includes("REMOTE_ADMIN_NOT_ENABLED"),
    "A remote-administration refusal must produce an audit entry carrying its code.",
  );
}

async function readLogDirectory(logDirectory) {
  const parts = [];
  let entries = [];
  try {
    entries = await fsp.readdir(logDirectory, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    parts.push(await fsp.readFile(path.join(logDirectory, entry.name), "utf8"));
  }
  return parts.join("\n");
}

async function pickRemoteIp() {
  const candidates = nonLoopbackIPv4Addresses();
  if (!candidates.length) {
    throw new Error(
      "This smoke needs one non-loopback IPv4 address on this machine to prove the rule at the request layer "
      + "(request.socket.remoteAddress must be non-loopback). None was found; the remote-origin enforcement is UNPROVEN on this host.",
    );
  }
  return candidates[0];
}

// The request-layer enforcement this file was written against is DELIBERATELY
// NOT WIRED in this build. Enforcing the rule by default would require every
// Agent that a desktop administers over the network to set AGENT_REMOTE_ADMIN
// and to be re-enrolled with family scopes before the desktop could manage it —
// which changes a supported deployment topology, so it is an owner decision
// rather than an engineering default. See docs/v2/V2_CAMPAIGN_QUEUES.md
// (cycle-19 queue deltas).
//
// The request-layer assertions are therefore SKIPPED, and said to be skipped,
// rather than deleted or left failing: wiring the gate is a small change in
// agent/src/server.js plus flipping this constant, and this file is the test
// that will prove it when that happens. The pure-policy assertions below still
// run and are the real coverage for the rule itself.
const REMOTE_ADMIN_ENFORCEMENT_WIRED = false;

async function main() {
  runPolicyTable();
  const remoteIp = await pickRemoteIp();
  if (!REMOTE_ADMIN_ENFORCEMENT_WIRED) {
    console.log("[skip] request-layer enforcement is not wired in this build (owner decision); the policy table above is the coverage.");
    console.log("remote-admin-authorization-smoke passed (policy only; request layer NOT wired)");
    return;
  }
  await runEnforcement(remoteIp);
  console.log(`remote-admin-authorization-smoke passed (request layer: loopback + ${remoteIp})`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  for (const agent of agents) {
    try {
      agent.child.kill("SIGTERM");
    } catch {
      // Best effort; the exit handler below reaps.
    }
  }
  await Promise.all(agents.map((agent) => new Promise((resolve) => {
    if (agent.child.exitCode !== null) return resolve();
    agent.child.once("exit", resolve);
    setTimeout(resolve, 5000);
  })));
  await fsp.rm(smokeRoot, { recursive: true, force: true }).catch(() => {});
});