#!/usr/bin/env node
// Agent DNS-rebinding trust-boundary harness.
//
// WHY THIS EXISTS
// The 2026-09 security review of the Agent request layer recorded browser
// exploitation of the Host/CORS boundary as UNPROVEN prose: a page on an
// attacker-controlled origin *might* read Agent responses once DNS rebinding
// made it same-origin with the loopback-bound Agent, and Chrome's
// Local/Private Network Access gate might block it. This harness replaces that
// prose with a reproducible test against real spawned Agents at the HTTP
// layer, so every claim below is a pinned, re-runnable observation.
//
// It complements scripts/agent-host-trust-smoke.js (which keeps its policy-leg
// and browser-UI-flow scope): this harness is the dedicated rebinding evidence
// run, spawns its own Agents, prints a machine-readable summary and is safe to
// run twice in a row.
//
// WHAT IT PINS (see the run*Legs functions for the exact assertions)
//   L1 concrete bind (AGENT_HOST=127.0.0.1): a DNS-rebinding-shaped Host is
//      refused 421 HOST_NOT_ALLOWED on health, pairing, enrollment and an
//      authenticated API route; the refusal never echoes the hostile value,
//      carries no details, creates no pairing session, and the Agent stays
//      healthy afterwards.
//   L2 wildcard bind (AGENT_HOST=0.0.0.0): the documented accepted gap is
//      pinned — the rebinding-shaped Host is accepted (matched
//      "wildcard-permissive") — together with its mitigations: no
//      Access-Control-Allow-Origin is ever emitted, the pairing payload and its
//      encoded agentUrl never reflect the hostile Host, and cross-origin state
//      changes/preflights are refused 403 CROSS_ORIGIN_DENIED. (Within the
//      accepted gap itself, the same-origin read after a successful rebinding
//      remains gated upstream by browser Local/Private Network Access, which
//      stays UNPROVEN — no-ACAO only proves the cross-origin variant.)
//   L3 Origin-less vs cross-origin: the Origin-less desktop/Node client stays
//      allowed; a cross-origin request is answered without
//      Access-Control-Allow-Origin and its state changes are refused.
//   L4 no second socket surface: no upgrade/WebSocket handler exists — an HTTP
//      Upgrade request is routed through the SAME host/origin gate (answered as
//      an ordinary request; no 101/websocket headers, ever), and agent/src
//      contains no upgrade listener, no WebSocket usage and exactly one
//      server-creating call.
//   L5 host parsing edge cases over real HTTP: missing Host (HTTP/1.1 ->
//      transport 400; HTTP/1.0 -> 421 missing-host-header), duplicate Host raw
//      headers -> 421 duplicate-host-header, malformed Host (space, "/", "@",
//      or a bare `%` outside brackets) -> 421 malformed-host-header. Exact
//      reasons are asserted from the Agent's own request-trust audit lines.
//      "%"-smuggling (127.0.0.1%2fevil.com, localhost%2fevil.com) fails closed
//      with 421 HOST_NOT_ALLOWED: `evaluateHost` refuses any host carrying a
//      `%` outside a bracketed IPv6 literal, so the IPv6-zone strip can no
//      longer turn a non-bracketed value into an allowlisted loopback name.
//      Bracketed IPv6 literals keep their zone support (`[fe80::1%25eth0]`),
//      and WHATWG URL parsing cannot form the smuggled shapes (asserted
//      below), so no legitimate URL client is affected by the stricter
//      refusal.
//
// SAFETY / HERMETICITY
//   * Real Agents are spawned exactly like scripts/agent-host-trust-smoke.js
//     and scripts/permission-matrix-smoke.js: the real agent/src/server.js entry
//     point with every runtime root pinned inside one temp tree
//     (pinAgentRoots) and readied through the shared waitForAgentReady helper.
//   * No DNS is required or performed: the proxy for "rebinding" is a raw Host
//     header, which is all a rebinding attacker controls; the harness speaks to
//     loopback and one wildcard Agent on ephemeral ports.
//   * No machine state changes: all writes go to the temp tree, which is
//     removed on exit, and repo-root leak canaries are asserted absent before
//     and after the run.
//   * Deterministic and self-cleaning: every child is stopped and its PID is
//     proven gone, and no package.json registration is needed (run it directly
//     with `node scripts/agent-rebinding-harness.js`).
//
// Output: leg progress on stdout, the final line
// `REBINDING_HARNESS_SUMMARY <json>` with the run summary, and exit code 0 when
// every leg passed / 1 when any assertion failed.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");

const root = path.resolve(__dirname, "..");
// Pin every runtime root a spawned Agent could write to inside one per-run temp
// tree (removed on exit), BEFORE anything that starts a process.
const smokeRoot = pinAgentRoots("anx-rebinding-harness-");

const { waitForAgentReady } = require("./test-helpers/agent-readiness");
const policy = require("../agent/src/services/hostTrustPolicy");
const { parsePairingCode } = require("../src/shared/agentPairing");

const { CROSS_ORIGIN_DENIED, HOST_NOT_ALLOWED } = policy;

const TOKEN = "anxos_rebinding-harness-credential-0123456789";
const CONCRETE_AGENT_URL = "http://configured-agent.test:47131";
const WILDCARD_AGENT_URL = "http://wildcard-configured.test:47131";
// Never resolved, never dialled: this string only ever exists inside a Host or
// Origin header, which is exactly the input a DNS-rebinding page controls.
const HOSTILE_NAME = "rebind.attacker.test";
const hostileHost = (port) => `${HOSTILE_NAME}:${port}`;
const foreignOrigin = `http://${HOSTILE_NAME}:47131`;

// Repo-root leak canaries: any rooted Agent that fell back to a default root
// would create these. They must be absent before and after the run.
const LEAK_CANARIES = [
  path.join(root, "instances"),
  path.join(root, "logs"),
  path.join(root, "agent", "instances"),
  path.join(root, "agent", "logs"),
];

const startedAt = Date.now();
let assertionCount = 0;
let requestCount = 0;
const responses = [];
const agents = [];
const legs = {};

// ---------------------------------------------------------------------------
// Assertion + response helpers. Every response the harness ever observes is
// recorded here, which is what makes "no Access-Control-Allow-Origin is ever
// emitted" and "no upgrade handshake is ever accepted" whole-run invariants
// rather than per-request claims.
// ---------------------------------------------------------------------------
function check(value, message) {
  assertionCount += 1;
  if (!value) throw new Error(message);
}

function checkEqual(actual, expected, message) {
  check(
    actual === expected,
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

function checkNoAllowOrigin(label, headers) {
  check(
    headers["access-control-allow-origin"] === undefined,
    `${label}: the Agent must never emit Access-Control-Allow-Origin.`,
  );
}

function checkNoHostEcho(label, response, value) {
  const serialized = `${JSON.stringify(response.headers)}\n${response.body}`;
  check(!serialized.includes(value), `${label}: the response must not echo ${value}.`);
}

function recordResponse(label, response) {
  requestCount += 1;
  const record = {
    label,
    status: response.status,
    allowOrigin: response.headers["access-control-allow-origin"] ?? null,
    upgradeHeader: response.headers.upgrade ?? null,
    websocketAccept: response.headers["sec-websocket-accept"] ?? null,
  };
  responses.push(record);
  checkNoAllowOrigin(label, response.headers);
  return record;
}

function errorCodeOf(response) {
  try {
    return JSON.parse(response.body || "{}")?.error?.code || null;
  } catch {
    return null;
  }
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

function requestTrustEntries(logDirectory) {
  const entries = [];
  for (const line of readAllLogs(logDirectory).split(/\r?\n/)) {
    if (!line.includes("request-trust")) continue;
    try {
      const parsed = JSON.parse(line);
      entries.push({
        errorCode: parsed.errorCode || null,
        reason: parsed.context?.reason || parsed.reason || parsed.meta?.reason || null,
      });
    } catch {}
  }
  return entries;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// HTTP client paths. apiRequest is a normal client with a hand-set Host (the
// way curl/Node/Electron talk to the Agent); socketRequest is the raw-socket
// path needed for Host header shapes a normal client cannot produce (missing,
// duplicated, malformed).
// ---------------------------------------------------------------------------
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

function apiRequest({ port, method = "GET", pathname = "/", host, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    finalHeaders.Host = host !== undefined ? host : `127.0.0.1:${port}`;
    finalHeaders.Connection = "close";
    if (body !== undefined) finalHeaders["Content-Length"] = Buffer.byteLength(body);
    const request = http.request(
      { host: "127.0.0.1", port, method, path: pathname, headers: finalHeaders, setHost: false, agent: false },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const result = {
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          };
          recordResponse(`${method} ${pathname}`, result);
          resolve(result);
        });
      },
    );
    request.setTimeout(10000, () => request.destroy(new Error(`${method} ${pathname}: request timed out`)));
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function parseHttpResponse(raw) {
  const separator = raw.indexOf("\r\n\r\n");
  const head = separator === -1 ? raw : raw.slice(0, separator);
  const body = separator === -1 ? "" : raw.slice(separator + 4);
  const lines = head.split("\r\n");
  const status = Number((lines[0] || "").match(/^HTTP\/\d\.\d (\d{3})/)?.[1] || 0);
  const headers = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return { status, headers, body };
}

function socketRequest({ port, payload, label, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let raw = "";
    let timedOut = false;
    socket.setTimeout(timeoutMs, () => {
      timedOut = true;
      socket.destroy();
    });
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      const parsed = parseHttpResponse(raw);
      const result = { ...parsed, raw, timedOut };
      recordResponse(label, result);
      resolve(result);
    });
  });
}

// A real websocket handshake request. If any 101 upgrade handler ever existed,
// Node's client would emit "upgrade"; we surface that as an explicit failure
// instead of a timeout.
function upgradeRequest({ port, host, pathname = "/api/v1/health", label }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: pathname,
      agent: false,
      setHost: false,
      headers: {
        Host: host,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      recordResponse(label, result);
      resolve(result);
      request.destroy();
    };
    request.setTimeout(10000, () => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new Error(`${label}: upgrade-shaped request timed out (no ordinary HTTP response arrived).`));
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      finish({ status: response.statusCode, headers: response.headers, body: "", upgradeEvent: true });
    });
    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => finish({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        upgradeEvent: false,
      }));
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Spawning a real Agent, mirroring the spawn contract of
// scripts/agent-host-trust-smoke.js and scripts/permission-matrix-smoke.js.
// ---------------------------------------------------------------------------
async function spawnAgent({ name, label, bindHost, agentUrl }) {
  const home = path.join(smokeRoot, name);
  const configDir = path.join(home, "config");
  const configPath = path.join(configDir, "agent.json");
  const logDir = path.join(home, "logs");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ backendMode: "agent", agentUrl, agentToken: TOKEN }, null, 2)}\n`,
    { mode: 0o600 },
  );
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

  let stopped = false;
  const agent = {
    name,
    label,
    bindHost,
    port,
    logDir,
    child,
    output: () => output,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await Promise.race([exited, delay(5000)]);
      }
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGKILL");
        await Promise.race([exited, delay(5000)]);
      }
      check(
        child.exitCode !== null || child.signalCode !== null,
        `${label}: the spawned Agent process must exit during cleanup.`,
      );
      check(!processIsAlive(child.pid), `${label}: PID ${child.pid} must be gone after cleanup.`);
    },
  };
  agents.push(agent);
  await waitForAgentReady({
    label,
    child,
    stderr: () => output,
    attempts: 300,
    intervalMs: 100,
    probe: async () => (await apiRequest({ port, pathname: "/api/v1/health", host: `127.0.0.1:${port}` })).status === 200,
  });
  return agent;
}

// ---------------------------------------------------------------------------
// L4 source half: the Agent must not own a second listener surface.
// ---------------------------------------------------------------------------
function walkSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkSourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

function assertNoSecondSocketSurfaceSource() {
  let createServerCount = 0;
  let listenCount = 0;
  for (const file of walkSourceFiles(path.join(root, "agent", "src"))) {
    const source = fs.readFileSync(file, "utf8");
    const relative = path.relative(root, file);
    check(!/\.on\(\s*["']upgrade["']/.test(source), `L4 source: ${relative} must not register an upgrade listener.`);
    check(!/\bWebSocket\b/.test(source), `L4 source: ${relative} must not use WebSocket.`);
    check(!/require\(\s*["'](?:ws|websocket|socket\.io)["']\s*\)/.test(source), `L4 source: ${relative} must not require a websocket library.`);
    check(!/\bSec-WebSocket-Accept\b/i.test(source), `L4 source: ${relative} must not handle a websocket handshake.`);
    createServerCount += (source.match(/createServer\s*\(/g) || []).length;
    listenCount += (source.match(/\bserver\.listen\s*\(/g) || []).length;
  }
  checkEqual(createServerCount, 1, "L4 source: agent/src must contain exactly one server-creating call.");
  checkEqual(listenCount, 1, "L4 source: agent/src must contain exactly one listener start.");
}

// ---------------------------------------------------------------------------
// L1 + L3 + L4 runtime + L5, all against one real concrete-bound Agent.
// ---------------------------------------------------------------------------
async function runConcreteLegs() {
  const agent = await spawnAgent({
    name: "concrete",
    label: "concrete-bound Agent",
    bindHost: "127.0.0.1",
    agentUrl: CONCRETE_AGENT_URL,
  });
  const port = agent.port;
  const loopbackHost = `127.0.0.1:${port}`;
  const hostile = hostileHost(port);
  const auth = { Authorization: `Bearer ${TOKEN}` };
  try {
    // ----- L1: rebinding-shaped Host refused on every route family ---------
    const hostileTargets = [
      { method: "GET", pathname: "/api/v1/health", family: "health" },
      { method: "GET", pathname: "/api/v1/pairing/status", family: "pairing" },
      { method: "POST", pathname: "/api/v1/pairing/start", family: "pairing", body: "{}" },
      { method: "POST", pathname: "/api/v1/pairing/cancel", family: "pairing", body: "{}" },
      { method: "POST", pathname: "/api/v1/pairing/complete", family: "pairing", body: "{}" },
      { method: "GET", pathname: "/api/v1/enroll/status", family: "enrollment" },
      { method: "POST", pathname: "/api/v1/enroll/start", family: "enrollment", body: "{}" },
      { method: "POST", pathname: "/api/v1/enroll/complete", family: "enrollment", body: "{}" },
      { method: "GET", pathname: "/api/v1/instances", family: "authenticated", auth: true },
      { method: "GET", pathname: "/api/v1/stats", family: "authenticated", auth: true },
    ];
    for (const target of hostileTargets) {
      const label = `L1 ${target.method} ${target.pathname} (${target.family})`;
      const response = await apiRequest({
        port,
        method: target.method,
        pathname: target.pathname,
        host: hostile,
        headers: {
          ...(target.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(target.auth ? auth : {}),
        },
        body: target.body,
      });
      // 421 (not 401/403) proves the gate runs before authentication, so a
      // valid credential cannot buy a hostile-Host request passage.
      checkEqual(response.status, 421, `${label}: a rebinding-shaped Host must be refused with 421.`);
      checkEqual(errorCodeOf(response), HOST_NOT_ALLOWED, `${label}: the refusal code must be ${HOST_NOT_ALLOWED}.`);
      checkNoHostEcho(label, response, HOSTILE_NAME);
      check(!response.body.includes("pairingCode"), `${label}: no pairing session may be served to a hostile Host.`);
      let payload = null;
      try {
        payload = JSON.parse(response.body);
      } catch {}
      checkEqual(payload?.error?.details, undefined, `${label}: the hardened refusal must carry no details object.`);
    }
    const statusAfterHostile = await apiRequest({ port, pathname: "/api/v1/pairing/status", host: loopbackHost });
    checkEqual(statusAfterHostile.status, 200, "L1: pairing status with a trusted Host must still be served.");
    checkEqual(JSON.parse(statusAfterHostile.body).active, false, "L1: a refused hostile pairing start must not have created a session.");
    console.log("L1 passed: 421 HOST_NOT_ALLOWED on health/pairing/enrollment/authenticated, no echo, no session created");

    // ----- L3: Origin-less vs cross-origin ---------------------------------
    const originlessRead = await apiRequest({ port, pathname: "/api/v1/instances", host: loopbackHost, headers: auth });
    checkEqual(originlessRead.status, 200, "L3: an Origin-less authenticated read must be allowed.");
    const originlessPairing = await apiRequest({
      port, method: "POST", pathname: "/api/v1/pairing/start", host: loopbackHost,
      headers: { "Content-Type": "application/json" }, body: "{}",
    });
    checkEqual(originlessPairing.status, 200, "L3: an Origin-less pairing start must be allowed.");
    await apiRequest({
      port, method: "POST", pathname: "/api/v1/pairing/cancel", host: loopbackHost,
      headers: { "Content-Type": "application/json" }, body: "{}",
    });

    const crossRead = await apiRequest({ port, pathname: "/api/v1/health", host: loopbackHost, headers: { Origin: foreignOrigin } });
    checkEqual(crossRead.status, 200, "L3: a cross-origin simple GET is answered but stays unreadable (no ACAO).");
    checkNoHostEcho("L3 cross-origin GET", crossRead, HOSTILE_NAME);

    for (const target of [
      { method: "POST", pathname: "/api/v1/pairing/start", body: "{}" },
      { method: "POST", pathname: "/api/v1/enroll/start", body: "{}" },
      { method: "POST", pathname: "/api/v1/ui/session/bootstrap", body: "{}" },
      { method: "OPTIONS", pathname: "/api/v1/instances" },
    ]) {
      const label = `L3 ${target.method} ${target.pathname}`;
      const response = await apiRequest({
        port,
        method: target.method,
        pathname: target.pathname,
        host: loopbackHost,
        headers: {
          Origin: foreignOrigin,
          "Content-Type": "application/json",
          ...(target.method === "OPTIONS" ? { "Access-Control-Request-Method": "GET" } : {}),
        },
        body: target.body,
      });
      checkEqual(response.status, 403, `${label}: a cross-origin state change/preflight must be refused with 403.`);
      checkEqual(errorCodeOf(response), CROSS_ORIGIN_DENIED, `${label}: the refusal code must be ${CROSS_ORIGIN_DENIED}.`);
      checkNoHostEcho(label, response, HOSTILE_NAME);
    }
    const sameOriginCancel = await apiRequest({
      port, method: "POST", pathname: "/api/v1/pairing/cancel", host: loopbackHost,
      headers: { Origin: `http://${loopbackHost}`, "Content-Type": "application/json" }, body: "{}",
    });
    checkEqual(sameOriginCancel.status, 200, "L3: a same-origin state change must stay allowed (targeted refusal, not blanket).");
    console.log("L3 passed: Origin-less clients allowed; cross-origin reads unreadable and state changes refused 403 CROSS_ORIGIN_DENIED");

    // ----- L4 runtime: no upgrade/websocket surface ------------------------
    const upgradeHostile = await upgradeRequest({ port, host: hostile, label: "L4 upgrade with hostile Host" });
    checkEqual(upgradeHostile.status, 421, "L4: an upgrade-shaped request is an ordinary request on the same gate (hostile Host -> 421).");
    checkEqual(errorCodeOf(upgradeHostile), HOST_NOT_ALLOWED, "L4: the same request-trust refusal must apply.");
    checkEqual(upgradeHostile.upgradeEvent, false, "L4: no 101 Switching Protocols may ever be emitted.");
    check(
      upgradeHostile.headers.upgrade === undefined && upgradeHostile.headers["sec-websocket-accept"] === undefined,
      "L4: no websocket handshake headers may ever be emitted.",
    );
    const upgradeValid = await upgradeRequest({ port, host: loopbackHost, label: "L4 upgrade with trusted Host" });
    checkEqual(upgradeValid.status, 200, "L4: an upgrade-shaped request from a trusted Host is served as an ordinary request.");
    checkEqual(upgradeValid.upgradeEvent, false, "L4: no 101 Switching Protocols may ever be emitted.");
    check(
      upgradeValid.headers.upgrade === undefined && upgradeValid.headers["sec-websocket-accept"] === undefined,
      "L4: no websocket handshake headers may ever be emitted.",
    );
    assertNoSecondSocketSurfaceSource();
    console.log("L4 passed: no upgrade listener/WebSocket anywhere; upgrade-shaped requests go through the same host/origin gate");

    // ----- L5: Host parsing edge cases over real HTTP ----------------------
    // Missing Host, HTTP/1.1 (what a browser or proxy sends): refused by the
    // transport parser before any application work.
    const missing11 = await socketRequest({
      port, label: "L5 HTTP/1.1 missing Host",
      payload: "GET /api/v1/health HTTP/1.1\r\nConnection: close\r\n\r\n",
    });
    checkEqual(missing11.status, 400, "L5: an HTTP/1.1 request without Host must be refused with 400 at the transport.");
    checkEqual(missing11.headers.connection, "close", "L5: the transport refusal must close the connection.");
    checkEqual(errorCodeOf(missing11), null, "L5: the transport refusal must never reach an application route.");
    checkNoHostEcho("L5 HTTP/1.1 missing Host", missing11, HOSTILE_NAME);

    // Missing Host, HTTP/1.0 (where the protocol allows it): reaches the gate
    // and fails closed there under the missing-host-header reason.
    const missing10 = await socketRequest({
      port, label: "L5 HTTP/1.0 missing Host",
      payload: "GET /api/v1/health HTTP/1.0\r\nConnection: close\r\n\r\n",
    });
    checkEqual(missing10.status, 421, "L5: an HTTP/1.0 request without Host must fail closed at the application gate.");
    checkEqual(errorCodeOf(missing10), HOST_NOT_ALLOWED, `L5: the HTTP/1.0 refusal code must be ${HOST_NOT_ALLOWED}.`);

    // Duplicate Host headers: Node folds them before the app sees headers.host,
    // so the refusal is driven from the raw header list.
    const duplicateHost = await socketRequest({
      port, label: "L5 duplicate Host",
      payload: `GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: ${HOSTILE_NAME}\r\nConnection: close\r\n\r\n`,
    });
    checkEqual(duplicateHost.status, 421, "L5: a request with two Host headers must be refused 421.");
    checkEqual(errorCodeOf(duplicateHost), HOST_NOT_ALLOWED, `L5: the duplicate-Host refusal code must be ${HOST_NOT_ALLOWED}.`);
    checkNoHostEcho("L5 duplicate Host", duplicateHost, HOSTILE_NAME);

    // Malformed Host values fail closed; a "%"-smuggled value is malformed
    // regardless of its pre-% prefix, because that prefix is exactly what the
    // zone strip would have extracted as the name.
    const malformedCases = [
      ["a b", "space"],
      ["evil.test/path", "slash"],
      ["user@evil.test", "userinfo"],
      [`evil.test%2f.attacker:${port}`, "percent-smuggling"],
    ];
    for (const [rawHost, shape] of malformedCases) {
      const label = `L5 malformed Host (${shape})`;
      const response = await socketRequest({
        port, label,
        payload: `GET /api/v1/health HTTP/1.1\r\nHost: ${rawHost}\r\nConnection: close\r\n\r\n`,
      });
      checkEqual(response.status, 421, `${label}: must fail closed with 421.`);
      checkEqual(errorCodeOf(response), HOST_NOT_ALLOWED, `${label}: must fail closed with ${HOST_NOT_ALLOWED}.`);
      check(!response.raw.includes(rawHost), `${label}: the raw Host value must not be echoed.`);
      check(!response.raw.includes(HOSTILE_NAME), `${label}: the response must not contain the hostile name.`);
    }

    // Requirement-5: "%"-smuggling now fails closed. `parseHostValue` strips an
    // IPv6 zone from every value it parses, so `127.0.0.1%2fevil.com` used to
    // validate as the loopback name while another component could read the raw
    // header as a different host — a fail-open in a security predicate.
    // `evaluateHost` refuses any host carrying a `%` outside a bracketed IPv6
    // literal, before the allowlist is consulted, so neither a loopback
    // spelling nor any other prefix can be smuggled through.
    for (const smuggled of [`127.0.0.1%2fevil.com:${port}`, `localhost%2fevil.com:${port}`]) {
      const label = `L5 percent-smuggling refused (${smuggled})`;
      const response = await apiRequest({ port, pathname: "/api/v1/health", host: smuggled });
      checkEqual(response.status, 421, `${label}: a "%"-smuggled Host must fail closed with 421.`);
      checkEqual(errorCodeOf(response), HOST_NOT_ALLOWED, `${label}: the refusal code must be ${HOST_NOT_ALLOWED}.`);
      check(!response.body.includes("evil.com"), `${label}: the raw smuggled value must never be echoed in the body.`);
      check(!JSON.stringify(response.headers).includes("evil.com"), `${label}: the raw smuggled value must never be echoed in headers.`);
    }
    // Policy-level pin of the same rule, and of the preserved bracketed-zone
    // support: a non-bracketed `%` is malformed, while a bracketed IPv6
    // literal keeps the zone handling the parser already had.
    const smuggledDecision = policy.evaluateHost(`127.0.0.1%2fevil.com:${port}`, { host: "127.0.0.1", port, agentUrl: CONCRETE_AGENT_URL });
    checkEqual(smuggledDecision.allowed, false, "L5 policy: a zone-smuggled loopback host must not be allowed.");
    checkEqual(smuggledDecision.reason, "malformed-host-header", "L5 policy: a zone-smuggled host must be refused as malformed.");
    const bracketedZoneDecision = policy.evaluateHost(`[::1%25eth0]:${port}`, { host: "127.0.0.1", port, agentUrl: CONCRETE_AGENT_URL });
    checkEqual(bracketedZoneDecision.allowed, true, "L5 policy: a bracketed IPv6 literal with a zone keeps its existing support.");
    const smuggledPairing = await apiRequest({
      port, method: "POST", pathname: "/api/v1/pairing/start", host: `localhost%2fevil.com:${port}`,
      headers: { "Content-Type": "application/json" }, body: "{}",
    });
    checkEqual(smuggledPairing.status, 421, "L5: a \"%\"-smuggled Host must not start a pairing session.");
    checkEqual(errorCodeOf(smuggledPairing), HOST_NOT_ALLOWED, "L5: the pairing refusal code must be HOST_NOT_ALLOWED.");
    check(!smuggledPairing.body.includes("evil.com"), "L5: the pairing refusal must not reflect the raw smuggled Host.");
    check(!smuggledPairing.body.includes("pairingCode"), "L5: no pairing session may be served to a smuggled Host.");
    const statusAfterSmuggled = await apiRequest({ port, pathname: "/api/v1/pairing/status", host: loopbackHost });
    checkEqual(statusAfterSmuggled.status, 200, "L5: pairing status with a trusted Host must still be served.");
    checkEqual(JSON.parse(statusAfterSmuggled.body).active, false, "L5: a refused smuggle must not have created a pairing session.");
    // Supporting evidence that no legitimate client is affected: the WHATWG
    // URL parser (browsers and Node share its host rules) cannot form these
    // shapes, so the stricter refusal narrows only the raw-HTTP path.
    for (const url of ["http://127.0.0.1%2fevil.com:1234/", "http://localhost%2fevil.com:1234/"]) {
      let formable = false;
      try {
        formable = new URL(url).host.length > 0;
      } catch {
        formable = false;
      }
      check(!formable, `L5: ${url} must not be formable by a WHATWG URL client (supporting evidence).`);
    }
    console.log("L5 passed: missing/duplicate/malformed/% Hosts fail closed with the exact codes; bracketed IPv6 zones keep their support");

    // ----- Log evidence: exact reasons, no hostile value anywhere ----------
    const trustEntries = requestTrustEntries(agent.logDir);
    for (const reason of ["missing-host-header", "duplicate-host-header", "malformed-host-header", "host-not-in-allowlist"]) {
      check(
        trustEntries.some((entry) => entry.reason === reason && entry.errorCode === HOST_NOT_ALLOWED),
        `Logs: a request-trust refusal with reason ${reason} and errorCode ${HOST_NOT_ALLOWED} must be audited.`,
      );
    }
    const logs = readAllLogs(agent.logDir);
    check(!logs.includes(HOSTILE_NAME), "Logs: the hostile value must never be written to the Agent logs.");
    check(!agent.output().includes(HOSTILE_NAME), "Logs: the hostile value must never reach Agent stdout/stderr.");

    // ----- Agent health after the hostile barrage --------------------------
    const finalHealth = await apiRequest({ port, pathname: "/api/v1/health", host: loopbackHost });
    checkEqual(finalHealth.status, 200, "L1: the Agent must stay healthy after the hostile requests.");
    const finalAuthRead = await apiRequest({ port, pathname: "/api/v1/instances", host: loopbackHost, headers: auth });
    checkEqual(finalAuthRead.status, 200, "L1: authenticated reads must still work after the hostile requests.");
    console.log("logs passed: exact refusal reasons audited, hostile value absent from logs and stdout");
  } finally {
    await agent.stop();
  }
}

// ---------------------------------------------------------------------------
// L2: wildcard bind — pin the documented accepted gap and its mitigations.
// ---------------------------------------------------------------------------
async function runWildcardLeg() {
  const agent = await spawnAgent({
    name: "wildcard",
    label: "wildcard-bound Agent",
    bindHost: "0.0.0.0",
    agentUrl: WILDCARD_AGENT_URL,
  });
  const port = agent.port;
  const loopbackHost = `127.0.0.1:${port}`;
  const hostile = hostileHost(port);
  const trustedUrl = `http://wildcard-configured.test:${port}`;
  try {
    // The accepted gap, pinned at the decision layer and on the wire. The
    // decision layer is where `matched: "wildcard-permissive"` exists; the wire
    // can only expose its effect (an accepted request).
    const decision = policy.evaluateHost(hostile, { host: "0.0.0.0", port, agentUrl: WILDCARD_AGENT_URL });
    checkEqual(decision.allowed, true, "L2: a wildcard bind accepts a rebinding-shaped Host (documented accepted gap).");
    checkEqual(decision.matched, "wildcard-permissive", "L2: the policy must classify the acceptance as wildcard-permissive.");
    checkEqual(decision.wildcard, true, "L2: the decision must report the wildcard bind.");

    const hostileHealth = await apiRequest({ port, pathname: "/api/v1/health", host: hostile });
    checkEqual(hostileHealth.status, 200, "L2: the wire accepts the rebinding-shaped Host on a wildcard bind (documented gap).");
    checkNoHostEcho("L2 wildcard health", hostileHealth, HOSTILE_NAME);

    // Mitigation (b): the pairing payload and its encoded form never reflect
    // the attacker-supplied Host.
    const hostilePairing = await apiRequest({
      port, method: "POST", pathname: "/api/v1/pairing/start", host: hostile,
      headers: { "Content-Type": "application/json" }, body: "{}",
    });
    checkEqual(hostilePairing.status, 200, "L2: the wildcard bind still serves the pairing handshake.");
    const pairingPayload = JSON.parse(hostilePairing.body);
    checkEqual(pairingPayload.agentUrl, trustedUrl, "L2: the pairing agentUrl must fall back to the configured address, never the hostile Host.");
    check(!hostilePairing.body.includes(HOSTILE_NAME), "L2: the pairing payload must not contain the hostile Host.");
    checkEqual(
      parsePairingCode(pairingPayload.pairingCode).agentUrl,
      trustedUrl,
      "L2: the encoded pairing payload must carry the trusted address.",
    );
    await apiRequest({
      port, method: "POST", pathname: "/api/v1/pairing/cancel", host: loopbackHost,
      headers: { "Content-Type": "application/json" }, body: "{}",
    });

    // Mitigation: cross-origin state changes and preflights are refused. The
    // no-ACAO half of this mitigation is asserted on EVERY response by
    // recordResponse and swept again at the end of the run.
    for (const target of [
      { method: "POST", pathname: "/api/v1/pairing/start", body: "{}" },
      { method: "POST", pathname: "/api/v1/enroll/start", body: "{}" },
      { method: "POST", pathname: "/api/v1/ui/session/bootstrap", body: "{}" },
      { method: "OPTIONS", pathname: "/api/v1/instances" },
    ]) {
      const label = `L2 ${target.method} ${target.pathname}`;
      const response = await apiRequest({
        port,
        method: target.method,
        pathname: target.pathname,
        host: loopbackHost,
        headers: {
          Origin: foreignOrigin,
          "Content-Type": "application/json",
          ...(target.method === "OPTIONS" ? { "Access-Control-Request-Method": "GET" } : {}),
        },
        body: target.body,
      });
      checkEqual(response.status, 403, `${label}: a cross-origin state change/preflight must be refused with 403.`);
      checkEqual(errorCodeOf(response), CROSS_ORIGIN_DENIED, `${label}: the refusal code must be ${CROSS_ORIGIN_DENIED}.`);
      checkNoHostEcho(label, response, HOSTILE_NAME);
    }

    // A cross-origin simple GET is answered but unreadable (no ACAO), and the
    // Origin-less desktop/Node client is unaffected.
    const crossRead = await apiRequest({ port, pathname: "/api/v1/health", host: loopbackHost, headers: { Origin: foreignOrigin } });
    checkEqual(crossRead.status, 200, "L2: a cross-origin simple GET is answered but stays unreadable (no ACAO).");
    const originlessRead = await apiRequest({ port, pathname: "/api/v1/instances", host: loopbackHost, headers: { Authorization: `Bearer ${TOKEN}` } });
    checkEqual(originlessRead.status, 200, "L2: an Origin-less authenticated read must stay allowed under a wildcard bind.");

    // No reflection into logs for the accepted-but-hostile requests either.
    const logs = readAllLogs(agent.logDir);
    check(!logs.includes(HOSTILE_NAME), "L2: the hostile value must never be written to the Agent logs.");
    check(!agent.output().includes(HOSTILE_NAME), "L2: the hostile value must never reach Agent stdout/stderr.");
    console.log("L2 passed: wildcard-permissive gap pinned; no ACAO ever; pairing payload never reflects the hostile Host; cross-origin state changes refused 403");
  } finally {
    await agent.stop();
  }
}

async function main() {
  for (const canary of LEAK_CANARIES) {
    check(!fs.existsSync(canary), `repo-root leak canary exists before the run (investigate, do not mask): ${canary}`);
  }

  await runConcreteLegs();
  legs["L1-concrete-bind"] = "passed";
  legs["L3-originless-vs-cross-origin"] = "passed";
  legs["L4-no-second-socket-surface"] = "passed";
  legs["L5-host-parsing-edge-cases"] = "passed";

  await runWildcardLeg();
  legs["L2-wildcard-bind"] = "passed";

  // Whole-run invariants, now that every response has been observed.
  const withAllowOrigin = responses.filter((response) => response.allowOrigin !== null);
  checkEqual(withAllowOrigin.length, 0, "No response anywhere in the run may carry Access-Control-Allow-Origin.");
  const upgraded = responses.filter(
    (response) => response.status === 101 || response.upgradeHeader !== null || response.websocketAccept !== null,
  );
  checkEqual(upgraded.length, 0, "No response anywhere in the run may be an upgrade/websocket handshake.");

  // Repo-root residue and child-process liveness are asserted by the canary
  // check below and by every agent.stop() (exit + PID gone).
  for (const canary of LEAK_CANARIES) {
    check(!fs.existsSync(canary), `repo-root residue was created by the run: ${canary}`);
  }

  const sourcesSha256 = {};
  for (const file of ["agent/src/server.js", "agent/src/services/hostTrustPolicy.js", "agent/src/routes/pairing.js"]) {
    sourcesSha256[file] = sha256(fs.readFileSync(path.join(root, file)));
  }
  const summary = {
    harness: "agent-rebinding-harness",
    result: "passed",
    legs,
    assertions: assertionCount,
    requests: requestCount,
    responsesWithoutAcao: responses.length - withAllowOrigin.length,
    responsesWithAcao: withAllowOrigin.length,
    upgradeHandshakes: upgraded.length,
    hostileValue: HOSTILE_NAME,
    agents: agents.map((agent) => ({
      name: agent.name,
      pid: agent.child.pid,
      bind: agent.bindHost,
      port: agent.port,
      exited: agent.child.exitCode !== null || agent.child.signalCode !== null,
    })),
    sourcesSha256,
    node: process.version,
    durationMs: Date.now() - startedAt,
  };
  console.log(`REBINDING_HARNESS_SUMMARY ${JSON.stringify(summary)}`);
  console.log("agent:rebinding:harness passed");
}

main().catch(async (error) => {
  for (const agent of agents) {
    try {
      await agent.stop();
    } catch {}
  }
  const summary = {
    harness: "agent-rebinding-harness",
    result: "failed",
    assertions: assertionCount,
    requests: requestCount,
    error: error?.message || String(error),
    node: process.version,
    durationMs: Date.now() - startedAt,
  };
  console.error("agent:rebinding:harness FAILED:", error?.stack || error?.message || String(error));
  console.log(`REBINDING_HARNESS_SUMMARY ${JSON.stringify(summary)}`);
  process.exitCode = 1;
});
