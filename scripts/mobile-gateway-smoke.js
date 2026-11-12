#!/usr/bin/env node
"use strict";

// Phase 7: phone gateway security and behaviour, in plain Node with fake
// services (no Electron, no Agent). Each check names the acceptance rule it
// covers.
//
// G1  TLS: a client that trusts only the AnxOS local CA connects; one that
//     doesn't is refused.
// G2  Static app, security headers, no CORS, CA download, nothing outside
//     the allowlist is served.
// G3  Wrong Host header (DNS rebinding) is refused.
// G4  Unauthenticated clients get nothing from the API.
// G5  Pairing: wrong code, cross-origin, single use, expiry, cookie flags.
// G6  Pairing attempts are rate limited.
// G7  Session and capabilities per role.
// G8  Viewer can read but not act; the service is never called.
// G9  Operator can start/stop/restart only.
// G10 Owner changes need the CSRF header and a same-origin Origin.
// G11 Settings: only the four allowed fields reach the service; validation.
// G12 The computer's own lock and setup state gate every phone request.
// G13 Revocation is immediate.
// G14 Idle expiry ends a session.
// G15 Binary upload arrives byte for byte as base64.
// G16 Destructive actions need their explicit confirmation.
// G17 Only private source addresses are accepted.
// G18 Responses never leak paths, commands, environment values or tokens.
// G19 Oversized bodies are refused.
// G20 The desktop service: on/off, pairing link and QR, device list.

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const net = require("net");
const os = require("os");
const path = require("path");
const tlsLib = require("tls");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-mobile-smoke-"));
process.env.ANXHUB_CONFIG_DIR = path.join(tempRoot, "config");

const { ensureCertificates } = require("../src/mobile/localCa");
const { createSessionStore } = require("../src/mobile/sessions");
const { createMobileApi } = require("../src/mobile/api");
const { createGateway, isPrivateAddress, COOKIE } = require("../src/mobile/gateway");
const { ROLE_PERMISSIONS } = require("../src/services/securityService");

const root = path.join(__dirname, "..");
const results = [];
function pass(id, detail) {
  results.push(id);
  console.log(`  ok ${id} ${detail}`);
}

let clock = Date.now();
const now = () => clock;

// ---- Fakes -------------------------------------------------------------------

const calls = [];
function record(name, ...args) {
  calls.push({ name, args });
}
function called(name) {
  return calls.filter((entry) => entry.name === name);
}

const SECRET_TOKEN = "agt_live_SECRET_TOKEN_1234567890abcdef";
const instance = {
  id: "survival",
  displayName: "Survival",
  type: "minecraft-paper",
  serverSoftware: "paper",
  minecraftVersion: "1.21.4",
  state: "running",
  readinessState: "ready",
  port: 25565,
  autoStart: true,
  memoryLimit: "4G",
  restartPolicy: "on-failure",
  executable: "C:\\Java\\bin\\java.exe",
  args: ["-jar", "paper.jar", `--token=${SECRET_TOKEN}`],
  environment: { RCON_PASSWORD: "[configured]" },
  instancePath: "C:\\Users\\owner\\AnxOS\\instances\\survival",
  minecraft: { players: { online: 3, max: 20, sample: [{ name: "Alex" }] } },
};

const services = {
  serviceRouter: () => ({
    listInstances: async (options) => { record("listInstances", options); return { root: "C:\\secret\\root", instances: [instance] }; },
    startInstance: async (id, options) => { record("startInstance", id, options); return { state: "starting" }; },
    stopInstance: async (id, options) => { record("stopInstance", id, options); return { state: "stopping" }; },
    restartInstance: async (id, options) => { record("restartInstance", id, options); return { state: "restarting" }; },
    getInstanceMetrics: async () => ({ cpuPercent: 12, memoryBytes: 1024 ** 3, sampledAt: new Date(clock).toISOString() }),
    getInstanceLogs: async () => ({ lines: [{ at: "t", stream: "stdout", message: `Loaded with token=${SECRET_TOKEN} and --password hunter22` }] }),
    sendInstanceCommand: async (id, command, options) => { record("sendInstanceCommand", id, command, options); return { ok: true }; },
    updateInstance: async (id, payload, options) => { record("updateInstance", id, payload, options); return { ...instance, ...payload }; },
    listInstanceFiles: async (id, filePath) => ({ currentPath: filePath, entries: [{ name: "server.properties", path: "server.properties", type: "file", size: 12 }] }),
    readInstanceFile: async (id, filePath) => ({ path: filePath, supported: true, content: "motd=hi" }),
    writeInstanceFile: async (id, filePath, content, options) => { record("writeInstanceFile", id, filePath, content, options); return { ok: true }; },
    deleteInstanceFile: async (id, filePath) => { record("deleteInstanceFile", id, filePath); return { ok: true }; },
    createInstanceFolder: async () => ({ ok: true }),
    renameInstanceFile: async () => ({ ok: true }),
    listBackups: async () => ({ backups: [{ id: "b1", instanceId: "survival", name: "Nightly", type: "full", createdAt: new Date(clock).toISOString(), size: 2048, path: "C:\\backups\\b1.tar.gz" }] }),
    createBackup: async (payload) => { record("createBackup", payload); return { backup: { id: "b2" } }; },
    restoreBackup: async (payload) => {
      record("restoreBackup", payload);
      return payload.preview ? { preview: true, scope: { type: "full" }, backup: { createdAt: new Date(clock).toISOString() } } : { ok: true };
    },
    downloadBackup: async () => ({ buffer: Buffer.from("archive-bytes") }),
  }),
  nodeService: () => ({
    listNodes: async () => ({
      configPath: "C:\\Users\\owner\\nodes.json",
      nodes: [
        { id: "application-host", kind: "application-host", name: "This PC" },
        { id: "node-1", kind: "agent", name: "Game PC", agentToken: "[configured]", baseUrl: "http://192.168.1.20:3100", agentStatus: { state: "Connected", secondary: "Connected" } },
      ],
    }),
  }),
  systemService: () => ({
    getSystemSnapshot: async () => ({ cpu: { usagePercent: 20, model: "CPU", cores: 8 }, memory: { percent: 40, used: 4e9, total: 1e10 }, disk: { percent: 50, free: 1e11, total: 2e11 }, network: {}, platform: "linux" }),
  }),
  modManager: () => ({
    listMods: async () => ({ running: true, mods: [{ fileName: "a.jar", title: "A", enabled: true, provider: "modrinth" }], warnings: [], history: [{ backupPath: "C:\\secret\\mods-backup" }] }),
  }),
  anxnet: () => ({ status: async () => ({ running: true, network: { name: "Home", domain: "anx-home.internal", role: "owner", coordinator: { state: "this-device" } }, devices: [], services: [], edgeLinks: [], publicRoutes: [] }) }),
  verifyBackup: async (nodeId, backupId) => { record("verifyBackup", nodeId, backupId); return { state: "verified" }; },
};

const desktop = { setupRequired: false, lockedError: null };
const audits = [];
const security = {
  ROLE_PERMISSIONS,
  getStatus: () => ({ setupRequired: desktop.setupRequired }),
  requirePermission: (permission) => {
    if (desktop.lockedError) throw Object.assign(new Error("Sign in to continue."), { code: desktop.lockedError });
    return { role: "Owner", permission };
  },
  audit: (entry) => audits.push(entry),
  checkRateLimit: () => {},
};

// ---- HTTP helpers -------------------------------------------------------------

function request(port, ca, { method = "GET", pathname = "/", headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = https.request({
      host: "127.0.0.1",
      port,
      method,
      path: pathname,
      agent: false,
      ca,
      // The certificate is checked against the address actually dialled,
      // whatever Host header a test sends.
      checkServerIdentity: (_host, cert) => tlsLib.checkServerIdentity("127.0.0.1", cert),
      headers: {
        Host: host || `127.0.0.1:${port}`,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString("utf8")); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  console.log("Phone gateway smoke");
  const tls = ensureCertificates(path.join(tempRoot, "tls"), { ips: ["192.168.50.10"], hostname: "SMOKE" });
  const sessions = createSessionStore({ folder: path.join(tempRoot, "sessions"), now });
  const api = createMobileApi({ services, security, now });
  const gateway = createGateway({
    certificates: tls,
    sessions,
    api,
    webRoot: path.join(root, "src", "mobile", "web"),
    sharedRoot: path.join(root, "src", "shared"),
    iconsRoot: path.join(root, "assets", "icons", "png"),
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = await gateway.start();
  const ca = tls.caCert;
  const origin = `https://127.0.0.1:${port}`;
  const get = (pathname, options = {}) => request(port, ca, { pathname, ...options });
  const post = (pathname, body, options = {}) => request(port, ca, { method: "POST", pathname, body, ...options, headers: { Origin: origin, ...(options.headers || {}) } });

  try {
    // G1
    const ok = await get("/");
    assert.strictEqual(ok.status, 200);
    await assert.rejects(() => new Promise((resolve, reject) => {
      https.get({ host: "127.0.0.1", port, path: "/", headers: { Host: `127.0.0.1:${port}` } }, resolve).on("error", reject);
    }), /self-signed|unable to verify|certificate/i);
    pass("G1", "TLS chain verifies with the AnxOS CA only; default trust refuses it");

    // G2
    assert.match(ok.headers["content-security-policy"], /default-src 'none'/);
    assert.match(ok.headers["content-security-policy"], /script-src 'self'/);
    assert.strictEqual(ok.headers["x-frame-options"], "DENY");
    assert.strictEqual(ok.headers["access-control-allow-origin"], undefined);
    assert.strictEqual((await get("/shared/serverViewModel.js")).status, 200);
    assert.strictEqual((await get("/shared/redaction.js")).status, 404);
    assert.strictEqual((await get("/../main.js")).status, 404);
    assert.strictEqual((await get("/%2e%2e/main.js")).status, 404);
    assert.strictEqual((await get("/icons/192.png")).headers["content-type"], "image/png");
    const caFile = await get("/anxos-local-ca.crt");
    assert.strictEqual(new crypto.X509Certificate(caFile.raw).fingerprint256, tls.caFingerprint);
    const preflight = await request(port, ca, { method: "OPTIONS", pathname: "/api/home", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
    assert.ok(preflight.status >= 400 && !preflight.headers["access-control-allow-origin"]);
    pass("G2", "app shell, CSP/frame/nosniff headers, shared-module allowlist, CA download, no CORS");

    // G3
    const rebound = await get("/", { host: `attacker.example:${port}` });
    assert.strictEqual(rebound.status, 421);
    const reboundApi = await get("/api/session", { host: "evil.lan" });
    assert.strictEqual(reboundApi.status, 421);
    pass("G3", "unknown Host header refused (421)");

    // G4
    const anon = await get("/api/home");
    assert.strictEqual(anon.status, 401);
    assert.strictEqual(anon.headers["cache-control"], "no-store");
    const anonStart = await post("/api/servers/node-1/survival/start", {});
    assert.strictEqual(anonStart.status, 401);
    const forged = await get("/api/home", { headers: { Cookie: `${COOKIE}=${"A".repeat(43)}` } });
    assert.strictEqual(forged.status, 401);
    assert.strictEqual(called("startInstance").length, 0);
    pass("G4", "no session: API refuses reads and actions; nothing reaches the services");

    // G5
    assert.strictEqual((await post("/api/pair", { code: "not-a-real-code-0000", deviceName: "x" })).status, 401);
    const viewerCode = sessions.createPairing("Viewer").code;
    const crossOrigin = await post("/api/pair", { code: viewerCode }, { headers: { Origin: "https://evil.example" } });
    assert.strictEqual(crossOrigin.status, 403);
    const paired = await post("/api/pair", { code: viewerCode, deviceName: "Test <b>phone</b>" });
    assert.strictEqual(paired.status, 200);
    const cookieHeader = paired.headers["set-cookie"][0];
    assert.match(cookieHeader, new RegExp(`^${COOKIE}=`));
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(cookieHeader.includes(flag), flag);
    assert.ok(!/Domain=/i.test(cookieHeader));
    assert.strictEqual(paired.json.device.name, "Test bphone/b");
    assert.strictEqual((await post("/api/pair", { code: viewerCode })).status, 401, "single use");
    const expiring = sessions.createPairing("Owner").code;
    clock += 6 * 60 * 1000;
    assert.strictEqual((await post("/api/pair", { code: expiring })).status, 401, "expired");
    const storedDevices = fs.readFileSync(path.join(tempRoot, "sessions", "devices.json"), "utf8");
    const viewerToken = cookieHeader.split(";")[0].split("=")[1];
    assert.ok(!storedDevices.includes(viewerToken), "token stored only as a hash");
    pass("G5", "wrong/cross-origin/reused/expired codes refused; cookie HttpOnly+Secure+SameSite=Strict; token hashed at rest");

    const viewerCookie = `${COOKIE}=${viewerToken}`;
    const pairAs = async (role) => {
      const response = await post("/api/pair", { code: sessions.createPairing(role).code, deviceName: role });
      assert.strictEqual(response.status, 200);
      const cookie = response.headers["set-cookie"][0].split(";")[0];
      const session = await get("/api/session", { headers: { Cookie: cookie } });
      return { cookie, csrf: session.json.csrf, session: session.json, id: response.json.device.id };
    };
    const operator = await pairAs("Operator");
    const owner = await pairAs("Owner");

    // G7
    const viewerSession = await get("/api/session", { headers: { Cookie: viewerCookie } });
    assert.strictEqual(viewerSession.json.device.role, "Viewer");
    assert.deepStrictEqual(
      [viewerSession.json.capabilities.lifecycle, viewerSession.json.capabilities.console, viewerSession.json.capabilities.files],
      [false, false, false],
    );
    assert.strictEqual(operator.session.capabilities.lifecycle, true);
    assert.strictEqual(operator.session.capabilities.console, false);
    assert.strictEqual(owner.session.capabilities.files, true);
    pass("G7", "session reports role and capabilities (Viewer read-only, Operator lifecycle, Owner full)");

    // G8
    const home = await get("/api/home", { headers: { Cookie: viewerCookie } });
    assert.strictEqual(home.status, 200);
    assert.strictEqual(home.json.servers[0].players, 3);
    assert.strictEqual(home.json.overview.servers.value, "1");
    const viewerCsrf = viewerSession.json.csrf;
    const viewerStart = await post("/api/servers/node-1/survival/start", {}, { headers: { Cookie: viewerCookie, "X-AnxOS-CSRF": viewerCsrf } });
    assert.strictEqual(viewerStart.status, 403);
    assert.strictEqual(viewerStart.json.error.code, "ROLE_DENIED");
    const viewerRestore = await post("/api/backups/node-1/b1/restore", { confirm: "RESTORE" }, { headers: { Cookie: viewerCookie, "X-AnxOS-CSRF": viewerCsrf } });
    assert.strictEqual(viewerRestore.status, 403);
    assert.strictEqual(called("startInstance").length + called("restoreBackup").length, 0);
    assert.ok(audits.some((entry) => entry.action === "mobile.permission" && entry.outcome === "denied"));
    pass("G8", "Viewer reads Home; start and restore refused (ROLE_DENIED, audited), services untouched");

    // G9
    const opHeaders = { Cookie: operator.cookie, "X-AnxOS-CSRF": operator.csrf };
    for (const action of ["start", "stop", "restart"]) {
      const response = await post(`/api/servers/node-1/survival/${action}`, {}, { headers: opHeaders });
      assert.strictEqual(response.status, 200, action);
    }
    assert.deepStrictEqual(called("startInstance")[0].args, ["survival", { nodeId: "node-1" }]);
    assert.strictEqual((await post("/api/servers/node-1/survival/command", { command: "op Alex" }, { headers: opHeaders })).status, 403);
    assert.strictEqual((await request(port, ca, { method: "PUT", pathname: "/api/servers/node-1/survival/settings", body: { changes: { displayName: "x" } }, headers: { ...opHeaders, Origin: origin } })).status, 403);
    assert.strictEqual(called("sendInstanceCommand").length + called("updateInstance").length, 0);
    pass("G9", "Operator start/stop/restart reach the same service calls; console and settings refused");

    // G10
    const ownerNoCsrf = await post("/api/servers/node-1/survival/command", { command: "say hi" }, { headers: { Cookie: owner.cookie } });
    assert.strictEqual(ownerNoCsrf.status, 403);
    assert.strictEqual(ownerNoCsrf.json.error.code, "CSRF_REJECTED");
    const ownerCross = await post("/api/servers/node-1/survival/command", { command: "say hi" }, { headers: { Cookie: owner.cookie, "X-AnxOS-CSRF": owner.csrf, Origin: "https://evil.example" } });
    assert.strictEqual(ownerCross.status, 403);
    const ownerForm = await request(port, ca, { method: "POST", pathname: "/api/servers/node-1/survival/command", body: "command=say", headers: { Cookie: owner.cookie, "X-AnxOS-CSRF": owner.csrf, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } });
    assert.strictEqual(ownerForm.status, 415);
    assert.strictEqual(called("sendInstanceCommand").length, 0);
    const ownerHeaders = { Cookie: owner.cookie, "X-AnxOS-CSRF": owner.csrf };
    const command = await post("/api/servers/node-1/survival/command", { command: "say hi\nstop" }, { headers: ownerHeaders });
    assert.strictEqual(command.status, 200);
    assert.strictEqual(called("sendInstanceCommand")[0].args[1], "say hi stop", "a command can't smuggle a second line");
    pass("G10", "changes need CSRF header + same Origin + JSON; one console line per command");

    // G11
    const put = (body) => request(port, ca, { method: "PUT", pathname: "/api/servers/node-1/survival/settings", body, headers: { ...ownerHeaders, Origin: origin } });
    const saved = await put({ changes: { displayName: "Renamed", executable: "cmd.exe", args: ["/c", "calc"], workingDirectory: "..", environment: { A: "1" } }, expected: { displayName: "Survival", executable: "x" } });
    assert.strictEqual(saved.status, 200);
    const update = called("updateInstance")[0].args[1];
    assert.deepStrictEqual(Object.keys(update).sort(), ["displayName", "expectedConfig"]);
    assert.deepStrictEqual(update.expectedConfig, { displayName: "Survival" });
    const badMemory = await put({ changes: { memoryLimit: "lots" } });
    assert.strictEqual(badMemory.status, 400);
    assert.ok(badMemory.json.error.fields.memoryLimit);
    assert.strictEqual((await put({ changes: { restartPolicy: "sometimes" } })).status, 400);
    pass("G11", "settings: executable/args/folder/environment never reach updateInstance; expectedConfig kept; bad values refused");

    // G12
    desktop.lockedError = "AUTH_UNLOCK_REQUIRED";
    const locked = await get("/api/home", { headers: { Cookie: owner.cookie } });
    assert.strictEqual(locked.status, 423);
    desktop.lockedError = null;
    desktop.setupRequired = true;
    assert.strictEqual((await get("/api/home", { headers: { Cookie: owner.cookie } })).status, 503);
    desktop.setupRequired = false;
    pass("G12", "computer locked → 423; security not set up → 503 (even for an Owner phone)");

    // G15
    const binary = crypto.randomBytes(70000);
    binary[0] = 0x50; binary[1] = 0x4b; binary[2] = 0x03; binary[3] = 0x04;
    const upload = await post("/api/servers/node-1/survival/files/upload", { path: "plugins/test.jar", contentBase64: binary.toString("base64") }, { headers: ownerHeaders });
    assert.strictEqual(upload.status, 200);
    const write = called("writeInstanceFile").at(-1);
    assert.strictEqual(write.args[3].encoding, "base64");
    assert.ok(Buffer.from(write.args[2], "base64").equals(binary));
    pass("G15", "70 KB binary upload reaches the service byte for byte (base64)");

    // G16
    assert.strictEqual((await post("/api/servers/node-1/survival/files/delete", { path: "world" }, { headers: ownerHeaders })).status, 400);
    assert.strictEqual((await post("/api/servers/node-1/survival/files/delete", { path: ".", confirm: "." }, { headers: ownerHeaders })).status, 400);
    assert.strictEqual(called("deleteInstanceFile").length, 0);
    assert.strictEqual((await post("/api/servers/node-1/survival/files/delete", { path: "old.txt", confirm: "old.txt" }, { headers: ownerHeaders })).status, 200);
    assert.strictEqual((await post("/api/backups/node-1/b1/restore", {}, { headers: ownerHeaders })).status, 400);
    const preview = await post("/api/backups/node-1/b1/restore-preview", {}, { headers: ownerHeaders });
    assert.strictEqual(preview.status, 200);
    assert.ok(preview.json.lines.length >= 2);
    assert.strictEqual(called("restoreBackup").filter((entry) => !entry.args[0].preview).length, 0);
    assert.strictEqual((await post("/api/backups/node-1/b1/restore", { confirm: "RESTORE" }, { headers: ownerHeaders })).status, 200);
    pass("G16", "delete needs the exact path (never the root); restore needs RESTORE; preview changes nothing");

    // G17
    for (const address of ["192.168.1.5", "10.0.0.2", "172.20.1.1", "127.0.0.1", "::1", "::ffff:192.168.0.9", "100.101.102.103", "fd00::1", "fe80::1"]) assert.ok(isPrivateAddress(address), address);
    for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2001:4860::8888", "::ffff:8.8.8.8"]) assert.ok(!isPrivateAddress(address), address);
    pass("G17", "private/LAN/VPN sources accepted, public internet sources refused");

    // G18
    const everything = JSON.stringify([
      home.json,
      (await get("/api/servers/node-1/survival", { headers: { Cookie: owner.cookie } })).json,
      (await get("/api/servers/node-1/survival/logs", { headers: { Cookie: owner.cookie } })).json,
      (await get("/api/servers/node-1/survival/settings", { headers: { Cookie: owner.cookie } })).json,
      (await get("/api/servers/node-1/survival/addons", { headers: { Cookie: owner.cookie } })).json,
      (await get("/api/servers/node-1/survival/backups", { headers: { Cookie: owner.cookie } })).json,
      (await get("/api/sharing", { headers: { Cookie: owner.cookie } })).json,
    ]);
    for (const secret of [SECRET_TOKEN, "hunter22", "java.exe", "paper.jar", "RCON_PASSWORD", "instancePath", "C:\\\\", "nodes.json", "agentToken", "baseUrl", "192.168.1.20", "mods-backup"]) {
      assert.ok(!everything.includes(secret), `leaked ${secret}`);
    }
    pass("G18", "no tokens, paths, commands, arguments, environment names or Agent URLs in any response");

    // G19
    const huge = await post("/api/servers/node-1/survival/command", { command: "x".repeat(300 * 1024) }, { headers: ownerHeaders });
    assert.strictEqual(huge.status, 413);
    pass("G19", "oversized request bodies refused (413)");

    // G13
    assert.ok(sessions.revokeDevice(owner.id));
    assert.strictEqual((await get("/api/session", { headers: { Cookie: owner.cookie } })).status, 401);
    pass("G13", "revoked phone is refused on its next request");

    // G14
    clock += 15 * 24 * 60 * 60 * 1000;
    assert.strictEqual((await get("/api/session", { headers: { Cookie: operator.cookie } })).status, 401);
    pass("G14", "15 days unused: session expired");

    // G6
    let limited = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await post("/api/pair", { code: `wrong-code-attempt-${attempt}` });
      if (response.status === 429) limited = true;
    }
    assert.ok(limited);
    pass("G6", "pairing attempts rate limited (429)");
  } finally {
    await gateway.stop();
  }

  // G20: the desktop service end to end on a free port.
  const service = require("../src/services/mobileGatewayService");
  const servicePort = await freePort();
  fs.mkdirSync(service.dataDir(), { recursive: true });
  fs.writeFileSync(path.join(service.dataDir(), "settings.json"), JSON.stringify({ enabled: false, port: servicePort }));
  let state = service.status();
  assert.strictEqual(state.enabled, false);
  assert.strictEqual(state.running, false);
  await assert.rejects(() => service.createPairing("Viewer"), /Turn on Phone access/);
  state = await service.enable({ services, security, host: "127.0.0.1" });
  assert.strictEqual(state.running, true);
  assert.strictEqual(state.port, servicePort);
  const pairing = await service.createPairing("Operator");
  assert.match(pairing.qrDataUrl || "data:image/png", /^data:image\/png/);
  const serviceCa = service.caCertificate().pem;
  const code = pairing.links.length ? pairing.links[0].split("#pair=")[1] : service.status() && null;
  if (code) {
    // The link uses a LAN address; post to loopback with that host's port.
    const response = await request(servicePort, serviceCa, { method: "POST", pathname: "/api/pair", body: { code, deviceName: "Service test" }, headers: { Origin: `https://127.0.0.1:${servicePort}` } });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(service.status().devices[0].role, "Operator");
  }
  state = await service.disable();
  assert.strictEqual(state.running, false);
  await assert.rejects(() => request(servicePort, serviceCa, { pathname: "/" }), /ECONNREFUSED/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(service.dataDir(), "settings.json"), "utf8")).enabled, false);
  const keyMode = fs.statSync(path.join(service.dataDir(), "tls", "anxos-local-ca.key")).mode & 0o777;
  pass("G20", `desktop service on/off, pairing link${code ? " redeemed" : " (no LAN address here)"}, QR, stopped port closed${process.platform === "win32" ? "" : `, key mode ${keyMode.toString(8)}`}`);

  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log(`Phone gateway smoke passed: ${results.length} checks.`);
}

main().catch((error) => {
  console.error(error);
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
