#!/usr/bin/env node
// Security hardening regression: the Agent request layer must not trust a
// caller-supplied Host header, and it must not become cross-origin readable.
//
// Proven precondition this pins (independent security review, 2026-09):
//   Host: rebind.attacker.test:47131  ->  200 OK
//   { "agentUrl": "http://rebind.attacker.test:47131", ... }   <- attacker Host echoed
//   no Access-Control-Allow-Origin on any response
// A page on an attacker-controlled origin could therefore read Agent responses
// once DNS rebinding made it same-origin with the loopback-bound Agent.
//
// Legs:
//   A. Policy level  — Host parsing/allowlist and the Origin comparison, with no
//      process spawn: malformed and missing Hosts fail closed, a DNS-rebinding
//      name is not allowlisted on a concrete bind, and the policy module adds no
//      DNS resolution to the request path.
//   B. Concrete bind (127.0.0.1) — a real spawned Agent refuses a
//      rebinding-shaped Host with HOST_NOT_ALLOWED on the pairing routes AND on
//      an ordinary authenticated route, echoes nothing back, and still serves
//      loopback / configured-address / machine-interface Hosts.
//   C. Wildcard bind (0.0.0.0) — documented gap: a name is accepted, but the
//      pairing payload's agentUrl never reflects the attacker-supplied Host.
//   D. Origin — a cross-origin Origin receives no Access-Control-Allow-Origin and
//      is refused on state changes and preflights, while the Agent's own browser
//      UI origin (same-origin) completes the real bootstrap -> session -> page
//      flow end to end.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");

const root = path.resolve(__dirname, "..");
const smokeRoot = pinAgentRoots("anx-host-trust-");

const policy = require("../agent/src/services/hostTrustPolicy");
const { HOST_NOT_ALLOWED, CROSS_ORIGIN_DENIED } = policy;
const { parsePairingCode } = require("../src/shared/agentPairing");

const TOKEN = "anxos_host-trust-smoke-credential-0123456789";
const REBIND_HOST = "rebind.attacker.test:47131";
const CONCRETE_AGENT_URL = "http://configured-agent.test:47131";
const WILDCARD_AGENT_URL = "http://wildcard-configured.test:47131";

// ---------------------------------------------------------------------------
// Raw HTTP: only a hand-built request can carry a hostile Host header.
// ---------------------------------------------------------------------------
function rawRequest({ port, method = "GET", pathname = "/", host, headers = {}, body, omitHost = false }) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    if (!omitHost) finalHeaders.Host = host;
    if (body !== undefined) finalHeaders["Content-Length"] = Buffer.byteLength(body);
    const request = http.request(
      { host: "127.0.0.1", port, method, path: pathname, headers: finalHeaders, setHost: false },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function errorCodeOf(response) {
  try {
    return JSON.parse(response.body || "{}")?.error?.code || null;
  } catch {
    return null;
  }
}

function assertNoAllowOriginHeader(response, label) {
  assert.strictEqual(
    response.headers["access-control-allow-origin"],
    undefined,
    `${label}: the Agent must never emit Access-Control-Allow-Origin.`,
  );
}

function assertNoHostEcho(response, hostile, label) {
  const serialized = `${JSON.stringify(response.headers)}\n${response.body}`;
  assert(
    !serialized.includes("rebind.attacker.test"),
    `${label}: the response must not echo the hostile host (${hostile}).`,
  );
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

async function waitForAgent(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await rawRequest({ port, pathname: "/api/v1/health", host: `127.0.0.1:${port}` });
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Spawned Agent did not become reachable.");
}

async function spawnAgent({ name, bindHost, agentUrl }) {
  const home = path.join(smokeRoot, name);
  const configDir = path.join(home, "config");
  const configPath = path.join(configDir, "agent.json");
  const logDir = path.join(home, "logs");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ backendMode: "agent", agentUrl, agentToken: TOKEN }, null, 2)}\n`, { mode: 0o600 });
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(root, "agent", "src", "server.js")], {
    cwd: path.join(root, "agent"),
    env: {
      ...process.env,
      ANXHUB_CONFIG_DIR: configDir,
      ANXHUB_AGENT_CONFIG_PATH: configPath,
      AGENT_ENROLLMENT_PATH: path.join(configDir, "enrollment.json"),
      AGENT_HOST: bindHost,
      AGENT_PORT: String(port),
      AGENT_TOKEN: TOKEN,
      AGENT_IDENTITY_PATH: path.join(home, "identity.json"),
      AGENT_INSTANCE_ROOT: path.join(home, "instances"),
      AGENT_FILE_ROOTS: smokeRoot,
      ANXOS_LOG_DIR: logDir,
      AGENT_API_RATE_LIMIT_PER_MINUTE: "5000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  await waitForAgent(port);
  return {
    port,
    logDir,
    output: () => output,
    stop: () => new Promise((resolve) => {
      if (!child || child.killed) return resolve();
      child.once("exit", resolve);
      child.kill("SIGTERM");
      setTimeout(resolve, 2000).unref?.();
    }),
  };
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

// ---------------------------------------------------------------------------
// Leg A: policy level, no process spawn.
// ---------------------------------------------------------------------------
function runPolicyLegs() {
  const concrete = { host: "127.0.0.1", port: 47131, agentUrl: CONCRETE_AGENT_URL };

  // A1: rebinding-shaped name is refused on a concrete bind.
  const rebind = policy.evaluateHost(REBIND_HOST, concrete);
  assert.strictEqual(rebind.allowed, false, "A1: a rebinding-shaped Host must not be allowed on a concrete bind.");
  assert.strictEqual(rebind.reason, "host-not-in-allowlist", "A1: the refusal reason must be the allowlist miss.");

  // A2: every loopback spelling is accepted, with and without a port.
  for (const value of ["127.0.0.1:47131", "127.0.0.1", "localhost:47131", "localhost", "[::1]:47131", "::1"]) {
    assert.strictEqual(policy.evaluateHost(value, concrete).allowed, true, `A2: loopback Host ${value} must be allowed.`);
  }

  // A3: the configured agentUrl host is accepted.
  assert.strictEqual(policy.evaluateHost("configured-agent.test:47131", concrete).allowed, true, "A3: the configured agentUrl host must be allowed.");

  // A4: missing / malformed Hosts fail closed without throwing.
  for (const [value, reason] of [
    [undefined, "missing-host-header"],
    ["", "missing-host-header"],
    ["a b", "malformed-host-header"],
    ["127.0.0.1:0", "malformed-host-header"],
    ["[::1", "malformed-host-header"],
    ["evil.test/path", "malformed-host-header"],
    ["user@evil.test", "malformed-host-header"],
    [["dup.test", "dup.test"], "duplicate-host-header"],
  ]) {
    const result = policy.evaluateHost(value, concrete);
    assert.strictEqual(result.allowed, false, `A4: Host ${JSON.stringify(value)} must fail closed.`);
    assert.strictEqual(result.reason, reason, `A4: Host ${JSON.stringify(value)} must report ${reason}.`);
  }

  // A5: assertTrustedRequest throws typed errors, and never echoes the Host.
  assert.throws(
    () => policy.assertTrustedRequest({ method: "GET", headers: { host: REBIND_HOST } }, concrete),
    (error) => {
      assert.strictEqual(error.code, HOST_NOT_ALLOWED, "A5: a hostile Host must refuse with HOST_NOT_ALLOWED.");
      assert.strictEqual(error.statusCode, 421, "A5: Host refusals must use 421 Misdirected Request.");
      assert(!JSON.stringify({ message: error.message, details: error.details }).includes("rebind.attacker.test"), "A5: the refusal must not echo the Host.");
      return true;
    },
  );
  assert.throws(
    () => policy.assertTrustedRequest({ method: "POST", headers: { host: "127.0.0.1:47131", origin: "http://rebind.attacker.test:47131" } }, concrete),
    (error) => {
      assert.strictEqual(error.code, CROSS_ORIGIN_DENIED, "A5: a cross-origin state change must refuse with CROSS_ORIGIN_DENIED.");
      assert.strictEqual(error.statusCode, 403, "A5: CORS refusals must use 403.");
      return true;
    },
  );
  assert.throws(
    () => policy.assertTrustedRequest({ method: "OPTIONS", headers: { host: "127.0.0.1:47131", origin: "http://rebind.attacker.test:47131" } }, concrete),
    (error) => error.code === CROSS_ORIGIN_DENIED,
    "A5: a cross-origin preflight must be refused explicitly.",
  );
  // Same-origin, and Origin-less clients (the desktop main process), stay allowed.
  for (const request of [
    { method: "POST", headers: { host: "127.0.0.1:47131", origin: "http://127.0.0.1:47131" } },
    { method: "POST", headers: { host: "127.0.0.1:47131" } },
    { method: "GET", headers: { host: "127.0.0.1:47131", origin: "http://127.0.0.1:47131" } },
    { method: "DELETE", headers: { host: "localhost:47131", origin: "http://localhost:47131" } },
  ]) {
    assert.doesNotThrow(() => policy.assertTrustedRequest(request, concrete), `A5: ${request.method} from ${JSON.stringify(request.headers.origin)} must stay allowed.`);
  }

  // A6: the pairing agentUrl refuses a rebinding-shaped name even under a
  // wildcard bind, while an IP literal (a legitimate remote Agent address) is
  // still echoable.
  const wildcard = { host: "0.0.0.0", port: 47131, agentUrl: WILDCARD_AGENT_URL };
  assert.strictEqual(policy.isEchoableAgentHost(REBIND_HOST, wildcard), false, "A6: a rebinding-shaped name must never be echoable as the Agent address.");
  assert.strictEqual(policy.isEchoableAgentHost("192.168.1.134:47131", wildcard), true, "A6: a legitimate LAN address must stay echoable.");
  assert.strictEqual(policy.isEchoableAgentHost("127.0.0.1:47131", wildcard), true, "A6: loopback must stay echoable.");
  assert.strictEqual(policy.trustedAgentAuthority(wildcard), "wildcard-configured.test:47131", "A6: the fallback authority must be the configured agentUrl.");

  // A7: no DNS resolution was added to the request path.
  const policySource = fs.readFileSync(path.join(root, "agent", "src", "services", "hostTrustPolicy.js"), "utf8");
  assert(!/require\(\s*["'](?:node:)?dns["']\s*\)/.test(policySource), "A7: the request-trust policy must not require a DNS module.");
  assert(!/\.lookup\(|\bresolve4\(|\bresolve6\(/.test(policySource), "A7: the request-trust policy must not resolve names.");

  // A8: the validation/use mismatch the frozen security audit found. The parser
  // strips an IPv6 zone from EVERY host, so `127.0.0.1%2fevil.com` validated as
  // `127.0.0.1` while the caller echoed the raw header — a hostile host
  // reflected into a value the client then trusts. A `%` outside a bracketed
  // IPv6 literal must now be refused outright.
  for (const hostile of ["127.0.0.1%2fevil.com:47131", "localhost%2fevil.com:47131", "127.0.0.1%00.evil.com:47131"]) {
    assert.strictEqual(policy.isEchoableAgentHost(hostile, wildcard), false, `A8: ${hostile} must not be echoable as the Agent address.`);
    assert.strictEqual(policy.isEchoableAgentHost(hostile, concrete), false, `A8: ${hostile} must not be echoable under a concrete bind either.`);
  }
  assert.strictEqual(policy.isEchoableAgentHost("127.0.0.1:47131", concrete), true, "A8: the plain loopback form stays echoable.");

  // A9: a duplicated Host must be refused from the RAW header list. Node folds
  // duplicate `host` headers into a single first-value string, so the
  // `Array.isArray` branch in evaluateHost can never fire on a real request and
  // the documented duplicate refusal had to be driven from `rawHeaders`.
  assert.strictEqual(policy.countRawHostHeaders(["Host", "127.0.0.1:47131"]), 1, "A9: one Host header counts once.");
  assert.strictEqual(policy.countRawHostHeaders(["host", "127.0.0.1:47131", "HOST", "evil.test"]), 2, "A9: duplicate Host headers are counted case-insensitively.");
  assert.strictEqual(policy.countRawHostHeaders(undefined), 0, "A9: a missing raw header list counts zero and must not throw.");
  assert.throws(
    () => policy.assertTrustedRequest({ method: "GET", headers: { host: "127.0.0.1:47131" }, rawHeaders: ["Host", "127.0.0.1:47131", "Host", "evil.test"] }, concrete),
    (error) => error?.code === policy.HOST_NOT_ALLOWED && error?.statusCode === 421 && error?.details?.reason === "duplicate-host-header",
    "A9: a request carrying two Host headers must be refused with the duplicate reason.",
  );
  assert.doesNotThrow(
    () => policy.assertTrustedRequest({ method: "GET", headers: { host: "127.0.0.1:47131" }, rawHeaders: ["Host", "127.0.0.1:47131"] }, concrete),
    "A9: a single Host header must still be accepted.",
  );

  console.log("leg A passed: the request-trust policy fails closed, adds no DNS, and never echoes a rebinding-shaped or zone-smuggled name");
}

// ---------------------------------------------------------------------------
// Leg B: concrete bind, real spawned Agent.
// ---------------------------------------------------------------------------
async function runConcreteBindLegs() {
  const agent = await spawnAgent({ name: "concrete-agent", bindHost: "127.0.0.1", agentUrl: CONCRETE_AGENT_URL });
  const auth = { Authorization: `Bearer ${TOKEN}` };
  try {
    const loopbackHost = `127.0.0.1:${agent.port}`;

    // B1: the rebinding-shaped Host is refused on the pairing routes.
    for (const [method, pathname] of [["GET", "/api/v1/pairing/status"], ["POST", "/api/v1/pairing/start"], ["POST", "/api/v1/pairing/cancel"]]) {
      const response = await rawRequest({ port: agent.port, method, pathname, host: REBIND_HOST, body: method === "POST" ? "{}" : undefined, headers: method === "POST" ? { "Content-Type": "application/json" } : {} });
      assert.strictEqual(response.status, 421, `B1: ${method} ${pathname} with a hostile Host must be 421 (got ${response.status}).`);
      assert.strictEqual(errorCodeOf(response), HOST_NOT_ALLOWED, `B1: ${method} ${pathname} must refuse with ${HOST_NOT_ALLOWED}.`);
      assertNoHostEcho(response, REBIND_HOST, `B1 ${method} ${pathname}`);
      assertNoAllowOriginHeader(response, `B1 ${method} ${pathname}`);
      assert(!response.body.includes("pairingCode"), `B1: ${method} ${pathname} must not serve a pairing session to a hostile Host.`);
    }
    console.log("leg B1 passed: a rebinding-shaped Host is refused with HOST_NOT_ALLOWED on the pairing routes");

    // B2: an ordinary AUTHENTICATED route is refused too, before auth runs, so
    // the gate cannot be bypassed by holding a valid credential.
    for (const target of ["/api/v1/instances", "/api/v1/stats", "/api/v1/health", "/api/v1/ui/bootstrap"]) {
      const response = await rawRequest({ port: agent.port, pathname: target, host: REBIND_HOST, headers: auth });
      assert.strictEqual(response.status, 421, `B2: GET ${target} with a hostile Host must be 421 (got ${response.status}).`);
      assert.strictEqual(errorCodeOf(response), HOST_NOT_ALLOWED, `B2: GET ${target} must refuse with ${HOST_NOT_ALLOWED}.`);
      assertNoHostEcho(response, REBIND_HOST, `B2 GET ${target}`);
    }
    console.log("leg B2 passed: the host gate refuses a rebinding-shaped Host on ordinary authenticated routes");

    // B3: a missing Host fails closed and the Agent keeps serving.
    const noHost = await rawRequest({ port: agent.port, pathname: "/api/v1/instances", omitHost: true, headers: auth });
    assert(noHost.status >= 400 && noHost.status < 500, `B3: a request with no Host header must fail closed (got ${noHost.status}).`);
    if (errorCodeOf(noHost) !== null) {
      assert.strictEqual(errorCodeOf(noHost), HOST_NOT_ALLOWED, "B3: any structured Host-less refusal must be HOST_NOT_ALLOWED.");
    }
    const afterNoHost = await rawRequest({ port: agent.port, pathname: "/api/v1/health", host: loopbackHost });
    assert.strictEqual(afterNoHost.status, 200, "B3: the Agent must keep serving after a Host-less request.");
    console.log("leg B3 passed: a request with no Host header fails closed and the Agent stays healthy");

    // B4: legitimate Hosts keep working end to end (authenticated read).
    const interfaceHost = Object.values(os.networkInterfaces())
      .flat()
      .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;
    const legitHosts = [loopbackHost, `localhost:${agent.port}`, `configured-agent.test:${agent.port}`];
    if (interfaceHost) legitHosts.push(`${interfaceHost}:${agent.port}`);
    for (const host of legitHosts) {
      const response = await rawRequest({ port: agent.port, pathname: "/api/v1/instances", host, headers: auth });
      assert.strictEqual(response.status, 200, `B4: Host ${host} must be served (got ${response.status}).`);
      assertNoAllowOriginHeader(response, `B4 ${host}`);
    }
    console.log(`leg B4 passed: legitimate Hosts still work (${legitHosts.length} forms${interfaceHost ? ", incl. a machine interface address" : ", no non-internal interface on this host"})`);

    // B5: nothing about the hostile Host reached the logs.
    const logs = readAllLogs(agent.logDir);
    assert(logs.includes("request-trust"), "B5: the refusals must be audited.");
    assert(!logs.includes("rebind.attacker.test"), "B5: Agent logs must not contain the hostile Host.");
    assert(!agent.output().includes("rebind.attacker.test"), "B5: Agent stdout/stderr must not contain the hostile Host.");
    console.log("leg B5 passed: refusals are audited without logging the hostile Host");
  } finally {
    await agent.stop();
  }
}

// ---------------------------------------------------------------------------
// Leg C: wildcard bind (documented gap) — the pairing payload must still not
// reflect an attacker-supplied Host.
// ---------------------------------------------------------------------------
async function runWildcardBindLegs() {
  const agent = await spawnAgent({ name: "wildcard-agent", bindHost: "0.0.0.0", agentUrl: WILDCARD_AGENT_URL });
  try {
    // C1: documented accepted gap — a wildcard bind cannot tell an operator's DNS
    // name from an attacker's without a request-path DNS lookup, so a name is
    // accepted here. The pairing payload is still hardened below.
    const hostileStart = await rawRequest({
      port: agent.port,
      method: "POST",
      pathname: "/api/v1/pairing/start",
      host: REBIND_HOST,
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.strictEqual(hostileStart.status, 200, "C1: a wildcard bind accepts any syntactically valid Host (documented gap).");
    const session = JSON.parse(hostileStart.body);
    assert(session.pairingCode, "C1: the wildcard bind still serves a pairing session.");

    // C2: the payload the client trusts no longer carries the hostile Host.
    const expectedFallback = `http://wildcard-configured.test:${agent.port}`;
    assert.notStrictEqual(session.agentUrl, `http://${REBIND_HOST}`, "C2: the pairing agentUrl must not be the attacker-supplied Host.");
    assert.strictEqual(session.agentUrl, expectedFallback, "C2: the pairing agentUrl must fall back to the configured Agent address.");
    assert(!hostileStart.body.includes("rebind.attacker.test"), "C2: the pairing response must not contain the hostile Host.");
    const decoded = parsePairingCode(session.pairingCode);
    assert.strictEqual(decoded.agentUrl, expectedFallback, "C2: the encoded pairing payload must carry the trusted Agent address.");
    console.log("leg C2 passed: the pairing agentUrl no longer reflects an attacker-supplied Host");

    // C3: the same wildcard Agent still echoes an address it may legitimately be
    // addressed by (the configured agentUrl host, and a machine interface IP).
    const configured = await rawRequest({ port: agent.port, method: "POST", pathname: "/api/v1/pairing/start", host: `wildcard-configured.test:${agent.port}`, headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.strictEqual(configured.status, 200, "C3: the configured agentUrl host must be served.");
    assert.strictEqual(JSON.parse(configured.body).agentUrl, `http://wildcard-configured.test:${agent.port}`, "C3: a trusted configured Host must still be echoed as the Agent address.");

    const interfaceHost = Object.values(os.networkInterfaces())
      .flat()
      .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;
    if (interfaceHost) {
      const lan = await rawRequest({ port: agent.port, method: "POST", pathname: "/api/v1/pairing/start", host: `${interfaceHost}:${agent.port}`, headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.strictEqual(lan.status, 200, "C3: a machine interface address must be served.");
      assert.strictEqual(JSON.parse(lan.body).agentUrl, `http://${interfaceHost}:${agent.port}`, "C3: a legitimate LAN address must still be echoed.");
    }
    console.log("leg C3 passed: legitimate addresses are still served and echoed under a wildcard bind");
  } finally {
    await agent.stop();
  }
}

// ---------------------------------------------------------------------------
// Leg D: Origin / CORS. Cross-origin is refused and never readable; the
// Agent's own browser origin works end to end.
// ---------------------------------------------------------------------------
async function runOriginLegs() {
  const agent = await spawnAgent({ name: "origin-agent", bindHost: "127.0.0.1", agentUrl: CONCRETE_AGENT_URL });
  const loopbackHost = `127.0.0.1:${agent.port}`;
  const sameOrigin = `http://${loopbackHost}`;
  const foreignOrigin = "http://rebind.attacker.test:47131";
  const auth = { Authorization: `Bearer ${TOKEN}` };
  try {
    // D1: a cross-origin Origin gets no Access-Control-Allow-Origin anywhere,
    // and cannot change state or run a preflight.
    const crossRead = await rawRequest({ port: agent.port, pathname: "/api/v1/health", host: loopbackHost, headers: { Origin: foreignOrigin } });
    assert.strictEqual(crossRead.status, 200, "D1: a cross-origin simple GET is answered (it stays unreadable to the page).");
    assertNoAllowOriginHeader(crossRead, "D1 cross-origin GET");
    for (const [method, pathname] of [
      ["POST", "/api/v1/ui/session/bootstrap"],
      ["POST", "/api/v1/pairing/start"],
      ["POST", "/api/v1/enroll/start"],
      ["OPTIONS", "/api/v1/instances"],
    ]) {
      const response = await rawRequest({ port: agent.port, method, pathname, host: loopbackHost, headers: { Origin: foreignOrigin, "Content-Type": "application/json", ...auth }, body: "{}" });
      assert.strictEqual(response.status, 403, `D1: ${method} ${pathname} from a foreign Origin must be 403 (got ${response.status}).`);
      assert.strictEqual(errorCodeOf(response), CROSS_ORIGIN_DENIED, `D1: ${method} ${pathname} must refuse with ${CROSS_ORIGIN_DENIED}.`);
      assertNoAllowOriginHeader(response, `D1 ${method} ${pathname}`);
      assert(!response.body.includes("rebind.attacker.test"), `D1: ${method} ${pathname} must not echo the foreign Origin.`);
    }
    console.log("leg D1 passed: a cross-origin Origin is refused with CROSS_ORIGIN_DENIED and never receives Access-Control-Allow-Origin");

    // D2: the Agent's own browser origin completes the real UI flow.
    const codeResponse = await rawRequest({ port: agent.port, method: "POST", pathname: "/api/v1/ui/bootstrap-code", host: loopbackHost, headers: { ...auth, Origin: sameOrigin, "Content-Type": "application/json" }, body: "{}" });
    assert.strictEqual(codeResponse.status, 200, `D2: the desktop must be able to mint a bootstrap code (got ${codeResponse.status}).`);
    const bootstrapCode = JSON.parse(codeResponse.body).code;
    assert(bootstrapCode, "D2: a bootstrap code must be issued.");

    const bootstrap = await rawRequest({ port: agent.port, method: "POST", pathname: "/api/v1/ui/session/bootstrap", host: loopbackHost, headers: { Origin: sameOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ code: bootstrapCode }) });
    assert.strictEqual(bootstrap.status, 200, `D2: the browser bootstrap POST from the Agent's own origin must succeed (got ${bootstrap.status}).`);
    assertNoAllowOriginHeader(bootstrap, "D2 bootstrap");
    const setCookie = bootstrap.headers["set-cookie"]?.[0] || "";
    assert(setCookie.includes("anxos_ui_session="), "D2: the bootstrap must set the UI session cookie.");
    const cookie = setCookie.split(";")[0];

    const session = await rawRequest({ port: agent.port, pathname: "/api/v1/ui/session", host: loopbackHost, headers: { Origin: sameOrigin, Cookie: cookie } });
    assert.strictEqual(session.status, 200, `D2: the same-origin UI session validation must succeed (got ${session.status}).`);
    assert.strictEqual(JSON.parse(session.body).status, "active", "D2: the UI session must be active.");

    const page = await rawRequest({ port: agent.port, pathname: "/api/v1/ui", host: loopbackHost, headers: { Origin: sameOrigin, Cookie: cookie } });
    assert.strictEqual(page.status, 200, `D2: the same-origin management page must be served (got ${page.status}).`);
    assert(page.body.includes("<html"), "D2: the management page must be HTML.");
    assertNoAllowOriginHeader(page, "D2 UI page");

    const renew = await rawRequest({ port: agent.port, method: "POST", pathname: "/api/v1/ui/session", host: loopbackHost, headers: { ...auth, Origin: sameOrigin, "Content-Type": "application/json" }, body: "{}" });
    assert.strictEqual(renew.status, 200, `D2: a same-origin session renewal must succeed (got ${renew.status}).`);
    console.log("leg D2 passed: the Agent's own browser origin completes bootstrap -> session -> page end to end");

    // D3: the Origin-less desktop client (no Origin header at all) is unaffected.
    const desktopWrite = await rawRequest({ port: agent.port, method: "POST", pathname: "/api/v1/ui/session", host: loopbackHost, headers: { ...auth, "Content-Type": "application/json" }, body: "{}" });
    assert.strictEqual(desktopWrite.status, 200, `D3: an Origin-less client must stay unaffected (got ${desktopWrite.status}).`);
    console.log("leg D3 passed: Origin-less clients (the desktop main process) are unaffected");
  } finally {
    await agent.stop();
  }
}

async function main() {
  runPolicyLegs();
  await runConcreteBindLegs();
  await runWildcardBindLegs();
  await runOriginLegs();
  console.log("agent:host-trust:smoke passed");
}

main().catch((error) => {
  console.error("agent:host-trust:smoke FAILED:", error.stack || error.message);
  process.exitCode = 1;
});
