// V2-H reverse-proxy + certificate lifecycle smoke (hermetic).
//
// Proves the bounded slice added for the V2-H bullet "Add service domains,
// reverse proxy routes and certificate lifecycle for supported web workloads":
//
//   1. Unsafe route definitions are refused with the right typed codes:
//      a local socket path, a URL, a non-allowlisted upstream host, an
//      out-of-range port, a traversal-shaped hostname, and an ungranted
//      wildcard. A valid definition is accepted and normalised.
//   2. The certificate lifecycle state machine reports "unknown" — never
//      "issued"/valid — when expiry cannot be determined, and lands an
//      in-window certificate in "expiring".
//   3. The service records a route and reports upstream reachability, but
//      never claims the route is activated; a managed TLS request is reported
//      pending with issuance plainly unsupported.
//   4. The real Agent handler is reachable with the right permission tier:
//      401 unauthenticated, 403 restricted profile, 200 full profile, and a
//      fail-closed 400/403 for an unsafe definition.
//
// The reachability probe is injected for the service-level assertions; the
// HTTP-level assertions use a loopback listener started by this smoke, so no
// external network is touched. Ends with "reverse-proxy-smoke passed".
const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
// Pin runtime roots BEFORE requiring any src/ service, or registry/service
// layers can write into the real machine root.
const smokeRoot = pinAgentRoots("anx-reverse-proxy-smoke-");

const root = path.resolve(__dirname, "..");
const policy = require("../src/shared/reverseProxyPolicy");
const service = require("../agent/src/services/reverseProxyService");
const agentRoute = require("../agent/src/routes/publicAccess");

const agentRouteSource = fs.readFileSync(path.join(root, "agent", "src", "routes", "publicAccess.js"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "agent", "src", "server.js"), "utf8");

// ---------------------------------------------------------------------------
// 1. Route policy: fail closed with typed codes; accept and normalise a valid
//    definition.
// ---------------------------------------------------------------------------
function refusalCode(input, options) {
  try {
    policy.normalizeReverseProxyRoute(input, options);
    return null;
  } catch (error) {
    return error?.code || "NO_CODE";
  }
}

assert.strictEqual(
  refusalCode({ hostname: "", upstream: "127.0.0.1:8080" }),
  "REVERSE_PROXY_HOSTNAME_REQUIRED",
  "A route without a hostname must be refused.",
);
assert.strictEqual(
  refusalCode({ hostname: "app.example.com", upstream: "/var/run/app.sock" }),
  "REVERSE_PROXY_UPSTREAM_INVALID",
  "An upstream that is a local socket path must be refused, never dialed.",
);
assert.strictEqual(
  refusalCode({ hostname: "app.example.com", upstream: "http://127.0.0.1:8080" }),
  "REVERSE_PROXY_UPSTREAM_INVALID",
  "An upstream that is a URL must be refused.",
);
assert.strictEqual(
  refusalCode({ hostname: "app.example.com", upstream: "10.20.30.40:8080" }),
  "REVERSE_PROXY_UPSTREAM_HOST_NOT_ALLOWED",
  "An upstream outside the allowed host space must be refused by default.",
);
assert.strictEqual(
  refusalCode({ hostname: "app.example.com", upstream: "127.0.0.1:0" }),
  "REVERSE_PROXY_UPSTREAM_PORT_INVALID",
  "An out-of-range upstream port must be refused.",
);
assert.strictEqual(
  refusalCode({ hostname: "../etc/passwd", upstream: "127.0.0.1:8080" }),
  "REVERSE_PROXY_HOSTNAME_INVALID",
  "A traversal-shaped hostname must be refused.",
);
assert.strictEqual(
  refusalCode({ hostname: "evil..com", upstream: "127.0.0.1:8080" }),
  "REVERSE_PROXY_HOSTNAME_INVALID",
  "A hostname with an empty label must be refused.",
);
assert.strictEqual(
  refusalCode({ hostname: "*.example.com", upstream: "127.0.0.1:8080" }),
  "REVERSE_PROXY_WILDCARD_NOT_GRANTED",
  "A wildcard hostname without an explicit grant must be refused.",
);
assert.strictEqual(
  refusalCode({ hostname: "app.example.com", upstream: "127.0.0.1:8080", tlsMode: "bogus" }),
  "REVERSE_PROXY_TLS_MODE_INVALID",
  "An unknown TLS mode must be refused.",
);
assert.strictEqual(
  refusalCode({ hostname: "app.example.com", upstream: "127.0.0.1:8080", upstreamProtocol: "ftp" }),
  "REVERSE_PROXY_UPSTREAM_PROTOCOL_INVALID",
  "An unsupported upstream protocol must be refused.",
);
assert.strictEqual(
  refusalCode({ hostname: "app.example.com", upstream: "127.0.0.1:8080", pathPrefix: "/a/../b" }),
  "REVERSE_PROXY_PATH_INVALID",
  "A traversal-shaped path prefix must be refused.",
);

const goodRoute = policy.normalizeReverseProxyRoute({ hostname: "App.Example.com.", upstream: "127.0.0.1:8080" });
assert.strictEqual(goodRoute.hostname, "app.example.com", "A valid hostname must be normalised to lowercase without a trailing dot.");
assert.deepStrictEqual(goodRoute.upstream, { host: "127.0.0.1", port: 8080 }, "A valid upstream must be parsed into host and port.");
assert.strictEqual(goodRoute.pathPrefix, "/", "An omitted path prefix must default to root.");
assert(/^proxy-[a-z0-9]{16}$/.test(goodRoute.id), "A valid route must get a stable derived id.");

const grantedWildcard = policy.normalizeReverseProxyRoute({ hostname: "*.example.com", upstream: "127.0.0.1:8080" }, { grantedWildcardHosts: ["*.example.com"] });
assert.strictEqual(grantedWildcard.hostname, "*.example.com", "A wildcard with an explicit grant must be accepted.");
assert.throws(
  () => policy.normalizeReverseProxyRoute({ hostname: `${"a".repeat(250)}.example.com`, upstream: "127.0.0.1:8080" }),
  (error) => error?.code === "REVERSE_PROXY_HOSTNAME_INVALID",
  "An over-long hostname must be refused.",
);

// ---------------------------------------------------------------------------
// 2. Certificate lifecycle state machine.
// ---------------------------------------------------------------------------
function certState(certificate, options) {
  return policy.evaluateCertificateState(certificate, options).state;
}

assert.strictEqual(certState(null), "none", "No certificate must report state none.");
const undeterminable = policy.evaluateCertificateState({ subject: "app.example.com" });
assert.strictEqual(undeterminable.state, "unknown", "A certificate without a readable expiry must report unknown.");
assert.notStrictEqual(undeterminable.state, "issued", "An unverifiable certificate must never be reported as issued.");
assert.strictEqual(undeterminable.verified, false, "An unverifiable certificate must not be marked verified.");
assert.strictEqual(undeterminable.reason, "EXPIRY_UNDETERMINABLE", "The unknown reason must be explicit.");
assert.strictEqual(certState({ notAfter: "not-a-date" }), "unknown", "A malformed expiry must report unknown.");
assert.strictEqual(
  certState({ notAfter: new Date(Date.now() + 5 * 86400000).toISOString() }),
  "expiring",
  "A certificate inside the warning window must land in expiring.",
);
assert.strictEqual(
  certState({ notAfter: new Date(Date.now() - 86400000).toISOString() }),
  "expired",
  "A certificate past its expiry must report expired.",
);
assert.strictEqual(
  certState({ notAfter: new Date(Date.now() + 300 * 86400000).toISOString() }),
  "issued",
  "A certificate well inside validity must report issued.",
);
assert.strictEqual(
  certState({ notBefore: new Date(Date.now() + 86400000).toISOString(), notAfter: new Date(Date.now() + 300 * 86400000).toISOString() }),
  "pending",
  "A certificate whose validity starts in the future must report pending.",
);
assert.strictEqual(certState({ failureCode: "ACME_FAILED" }), "failed", "A recorded issuance failure must report failed.");
assert.strictEqual(certState({ state: "pending" }), "pending", "An explicitly pending record must report pending.");

const lifecycle = policy.summarizeCertificateLifecycle([
  { notAfter: new Date(Date.now() + 300 * 86400000).toISOString() },
  { notAfter: new Date(Date.now() + 3 * 86400000).toISOString() },
  {},
]);
assert.strictEqual(lifecycle.overall, "unknown", "A set containing an unverifiable certificate must not summarise as healthy.");
assert.strictEqual(lifecycle.counts.expiring, 1, "The summary must count the expiring certificate.");
assert.strictEqual(lifecycle.counts.unknown, 1, "The summary must count the unverifiable certificate.");

// ---------------------------------------------------------------------------
// 3. Service: record a route, report reachability, never claim activation.
// ---------------------------------------------------------------------------
function fakeConnect(outcome) {
  return () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    setImmediate(() => {
      if (outcome === "connect") socket.emit("connect");
      else socket.emit("error", new Error("ECONNREFUSED"));
    });
    return socket;
  };
}

async function assertServiceSlice() {
  const configDir = path.join(smokeRoot, "service-config");
  fs.mkdirSync(configDir, { recursive: true });

  const applied = await service.applyReverseProxyRoute(
    { hostname: "web.example.com", upstream: "127.0.0.1:9101", tlsMode: "managed" },
    { configDir, connect: fakeConnect("connect") },
  );
  assert.strictEqual(applied.success, true, "A valid route must be recorded.");
  assert.strictEqual(applied.applied, false, "Recording a route must not claim it was activated.");
  assert.strictEqual(applied.activation.supported, false, "Activation must be reported unsupported in this build.");
  assert.strictEqual(applied.activation.code, "REVERSE_PROXY_ACTIVATION_UNAVAILABLE", "The activation block must carry the honest code.");
  assert.strictEqual(applied.upstreamReachability.reachable, true, "A reachable upstream must be reported reachable.");
  assert.strictEqual(applied.certificate.state, "pending", "A managed TLS request with no certificate must be pending.");
  assert.notStrictEqual(applied.certificate.state, "issued", "A managed TLS request must never be reported as issued.");
  assert.strictEqual(applied.certificate.issuanceSupported, false, "Certificate issuance must be reported unsupported.");
  assert.strictEqual(applied.certificate.code, "REVERSE_PROXY_TLS_ISSUANCE_UNAVAILABLE", "The certificate block must carry the honest code.");

  const unreachable = await service.applyReverseProxyRoute(
    { hostname: "down.example.com", upstream: "127.0.0.1:9102" },
    { configDir, connect: fakeConnect("error") },
  );
  assert.strictEqual(unreachable.upstreamReachability.reachable, false, "An unreachable upstream must be reported unreachable.");
  assert.strictEqual(unreachable.upstreamReachability.code, "REVERSE_PROXY_UPSTREAM_UNREACHABLE", "An unreachable upstream must carry its code.");

  await assert.rejects(
    () => service.applyReverseProxyRoute({ hostname: "dup.example.com", upstream: "127.0.0.1:9101" }, { configDir, connect: fakeConnect("connect") })
      .then(() => service.applyReverseProxyRoute({ hostname: "dup.example.com", upstream: "127.0.0.1:9102" }, { configDir, connect: fakeConnect("connect") })),
    (error) => error?.code === "REVERSE_PROXY_ROUTE_CONFLICT",
    "A second route for the same hostname and path must be refused.",
  );

  // Certificate metadata recorded externally (never issued by AnxOS) drives the
  // lifecycle report. An expiring record lands the route in expiring.
  fs.writeFileSync(path.join(configDir, service.CERTIFICATES_FILE_NAME), `${JSON.stringify({
    schemaVersion: 1,
    certificates: [{ hostname: "manual.example.com", subject: "manual.example.com", notAfter: new Date(Date.now() + 4 * 86400000).toISOString() }],
  })}\n`);
  const manual = await service.applyReverseProxyRoute(
    { hostname: "manual.example.com", upstream: "127.0.0.1:9103", tlsMode: "manual" },
    { configDir, connect: fakeConnect("connect") },
  );
  assert.strictEqual(manual.certificate.state, "expiring", "A recorded certificate inside the window must report expiring.");
  assert.strictEqual(manual.certificate.expiryVerified, true, "A determinable expiry must be flagged verified.");

  const snapshot = await service.getReverseProxySnapshot({ configDir });
  assert.strictEqual(snapshot.ok, true, "The snapshot must resolve ok.");
  assert(snapshot.routeCount >= 3, "The snapshot must report the recorded routes.");
  assert.strictEqual(snapshot.activation.supported, false, "The snapshot must report activation unsupported.");
  assert.strictEqual(snapshot.certificateIssuance.supported, false, "The snapshot must report issuance unsupported.");
  assert.strictEqual(snapshot.certificateLifecycle.overall, "expiring", "The snapshot lifecycle must fold in the recorded certificate.");
}

// ---------------------------------------------------------------------------
// 4. Real Agent HTTP slice: permission tiers + fail-closed refusal end to end.
// ---------------------------------------------------------------------------
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

function startUpstreamListener() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function probe(baseUrl, method, routePath, token, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  let payload = null;
  try { payload = await response.json(); } catch {}
  return { status: response.status, code: payload?.error?.code || null, body: payload };
}

async function assertAgentHttpSlice() {
  const { waitForAgentReady } = require("./test-helpers/agent-readiness");
  const fullDir = path.join(smokeRoot, "http-full");
  const restrictedDir = path.join(smokeRoot, "http-restricted");
  fs.mkdirSync(fullDir, { recursive: true });
  fs.mkdirSync(restrictedDir, { recursive: true });
  const upstream = await startUpstreamListener();
  const tokenFull = "reverse-proxy-smoke-agent-token";
  const tokenRestricted = "reverse-proxy-smoke-restricted-token";
  const portFull = await getFreePort();
  const portRestricted = await getFreePort();
  const urlFull = `http://127.0.0.1:${portFull}`;
  const urlRestricted = `http://127.0.0.1:${portRestricted}`;

  const spawnAgent = (configDir, port, token, agentUrl, extraEnv = {}) => {
    fs.writeFileSync(path.join(configDir, "agent.json"), JSON.stringify({ backendMode: "agent", agentUrl, agentToken: token }));
    return spawn(process.execPath, [path.join(root, "agent", "src", "server.js")], {
      cwd: path.join(root, "agent"),
      env: {
        ...process.env,
        AGENT_HOST: "127.0.0.1",
        AGENT_PORT: String(port),
        AGENT_TOKEN: token,
        AGENT_FILE_ROOTS: smokeRoot,
        AGENT_INSTANCE_ROOT: path.join(configDir, "instances"),
        AGENT_BACKUP_ROOT: path.join(configDir, "backups"),
        ANXHUB_CONFIG_DIR: configDir,
        ANXHUB_AGENT_CONFIG_PATH: path.join(configDir, "agent.json"),
        AGENT_API_RATE_LIMIT_PER_MINUTE: "5000",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  const fullAgent = spawnAgent(fullDir, portFull, tokenFull, urlFull, {});
  const restrictedAgent = spawnAgent(restrictedDir, portRestricted, tokenRestricted, urlRestricted, {
    AGENT_PERMISSION_PROFILE: "restricted",
    AGENT_API_PERMISSIONS: "",
  });
  const stderr = { value: "" };
  fullAgent.stderr.on("data", (chunk) => { stderr.value += String(chunk); });
  restrictedAgent.stderr.on("data", (chunk) => { stderr.value += String(chunk); });

  try {
    await Promise.all([
      waitForAgentReady({
        label: "Reverse-proxy smoke full Agent",
        child: fullAgent,
        stderr: () => stderr.value,
        probe: async () => (await fetch(`${urlFull}/api/v1/health`, { redirect: "manual" })).ok,
      }),
      waitForAgentReady({
        label: "Reverse-proxy smoke restricted Agent",
        child: restrictedAgent,
        stderr: () => stderr.value,
        probe: async () => (await fetch(`${urlRestricted}/api/v1/health`, { redirect: "manual" })).ok,
      }),
    ]);

    const listPath = "/api/v1/public-access/reverse-proxy";
    const applyPath = "/api/v1/public-access/reverse-proxy/routes";

    const unauthList = await probe(urlFull, "GET", listPath, null);
    assert.strictEqual(unauthList.code, "UNAUTHORIZED", "An unauthenticated read must be refused 401.");
    assert.strictEqual(unauthList.status, 401, "An unauthenticated read must use the 401 bearer gate.");

    const restrictedList = await probe(urlRestricted, "GET", listPath, tokenRestricted);
    assert.strictEqual(restrictedList.code, "API_PERMISSION_DENIED", "A restricted-profile actor must be refused 403 on read.");
    assert.strictEqual(restrictedList.status, 403, "The restricted read must use the 403 permission gate.");

    const fullList = await probe(urlFull, "GET", listPath, tokenFull);
    assert.strictEqual(fullList.status, 200, "The full-profile credential must read the snapshot.");
    assert.strictEqual(fullList.body.ok, true, "The snapshot must resolve ok.");
    assert.strictEqual(fullList.body.activation.supported, false, "The read must state activation is unsupported.");

    const unauthApply = await probe(urlFull, "POST", applyPath, null, {});
    assert.strictEqual(unauthApply.status, 401, "An unauthenticated apply must be refused 401.");

    const restrictedApply = await probe(urlRestricted, "POST", applyPath, tokenRestricted, {});
    assert.strictEqual(restrictedApply.code, "API_PERMISSION_DENIED", "A restricted-profile actor must be refused 403 on apply.");
    assert.strictEqual(restrictedApply.status, 403, "The restricted apply must use the 403 permission gate.");

    const unsafeApply = await probe(urlFull, "POST", applyPath, tokenFull, { hostname: "unsafe.example.com", upstream: "10.20.30.40:8080" });
    assert.strictEqual(unsafeApply.code, "REVERSE_PROXY_UPSTREAM_HOST_NOT_ALLOWED", "A non-allowlisted upstream must be refused 403 by the handler.");
    assert.strictEqual(unsafeApply.status, 403, "The upstream-host refusal must use 403.");

    const wildcardApply = await probe(urlFull, "POST", applyPath, tokenFull, { hostname: "*.example.com", upstream: `127.0.0.1:${upstream.port}` });
    assert.strictEqual(wildcardApply.code, "REVERSE_PROXY_WILDCARD_NOT_GRANTED", "An ungranted wildcard must be refused end to end.");

    const applied = await probe(urlFull, "POST", applyPath, tokenFull, { hostname: "smoke.example.com", upstream: `127.0.0.1:${upstream.port}`, tlsMode: "managed" });
    assert.strictEqual(applied.status, 200, "A valid apply must succeed through the real handler.");
    assert.strictEqual(applied.body.success, true, "A valid apply must record the route.");
    assert.strictEqual(applied.body.applied, false, "A valid apply must not claim activation.");
    assert.strictEqual(applied.body.activation.code, "REVERSE_PROXY_ACTIVATION_UNAVAILABLE", "The apply must carry the honest activation code.");
    assert.strictEqual(applied.body.upstreamReachability.reachable, true, "The smoke's loopback listener must be observed as reachable.");
    assert.strictEqual(applied.body.certificate.state, "pending", "A managed TLS request must be pending, never issued.");
    assert.strictEqual(applied.body.certificate.issuanceSupported, false, "Issuance must be reported unsupported.");

    const afterApply = await probe(urlFull, "GET", listPath, tokenFull);
    assert.strictEqual(afterApply.status, 200, "The snapshot must still read after apply.");
    assert(afterApply.body.routes.some((route) => route.hostname === "smoke.example.com"), "The applied route must appear in the snapshot.");
  } finally {
    for (const agent of [fullAgent, restrictedAgent]) {
      agent.kill("SIGTERM");
    }
    await Promise.all([fullAgent, restrictedAgent].map((agent) => new Promise((resolve) => agent.once("exit", resolve))));
    await new Promise((resolve) => upstream.server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// 5. Wiring: the route handlers and the dispatch clause exist.
// ---------------------------------------------------------------------------
assert(agentRouteSource.includes("/api/v1/public-access/reverse-proxy"), "The Agent route must serve the reverse-proxy snapshot path.");
assert(agentRouteSource.includes("applyReverseProxyRoute") && agentRouteSource.includes("getReverseProxySnapshot"), "The Agent route must delegate to the reverse-proxy service.");
assert(serverSource.includes("/api/v1/public-access/reverse-proxy"), "The Agent dispatcher must route reverse-proxy paths to the public-access handler.");
assert.strictEqual(typeof agentRoute._test.applyReverseProxyRoute, "function", "The route must expose the apply handler for tests.");

(async () => {
  await assertServiceSlice();
  await assertAgentHttpSlice();
  console.log("reverse-proxy-smoke passed");
})().catch((error) => {
  console.error(error);
  try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
});