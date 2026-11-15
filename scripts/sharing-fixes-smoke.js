#!/usr/bin/env node
"use strict";

// Regression checks for the Sharing area (Playit detection, tunnels, the
// Share dialog, Network & addresses and Phone Access layout). One numbered
// check per finding id. Run from the repository root:
//   node scripts/sharing-fixes-smoke.js
//
// Hermetic: the Playit services are loaded with child_process.execFile,
// net.createConnection and fs/promises replaced (only for those modules), and
// process.platform forced per scenario. No process is started, no socket or
// Agent is contacted, and no file outside a temp folder is written. Renderer
// functions are cut out of app.js and run in a vm with fake DOM seams.
//
// What it does not prove: the real Playit IPC layout (the IPC v2 shape used
// here follows the Agent's own notes), or a pixel-exact layout in Electron
// (the CSS checks read the rules that decide the layout).

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const { EventEmitter } = require("events");

const ROOT = path.resolve(__dirname, "..");
const APP_SOURCE = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const STYLES = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const SERVER_VIEW_SOURCE = fs.readFileSync(path.join(ROOT, "src", "renderer", "serverView.js"), "utf8");

process.exitCode = 1;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-sharing-fixes-"));
for (const key of ["ANXHUB_CONFIG_DIR", "ANXOS_CONFIG_DIR", "ANXOS_LOG_DIR", "AGENT_INSTANCE_ROOT", "AGENT_BACKUP_ROOT", "AGENT_TEMP_DIR", "AGENT_LOG_DIR"]) {
  process.env[key] = tempRoot;
}
for (const key of ["PLAYIT_ADDRESS", "PLAYIT_TUNNEL_ADDRESS", "PLAYIT_DOMAIN", "PLAYIT_LOG_PATH", "PLAYIT_CONFIG_PATH", "PLAYIT_BINARY", "PLAYIT_PROTOCOL", "PLAYIT_TUNNEL_ID", "PLAYIT_LOCAL_TARGET", "PLAYIT_TARGET", "PLAYIT_LOCAL_ADDRESS"]) {
  delete process.env[key];
}

const results = [];
async function check(id, name, fn) {
  try {
    await fn();
    results.push({ id, name, ok: true });
  } catch (error) {
    results.push({ id, name, ok: false, error });
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Playit service harness (Agent + desktop modules, everything faked)
// ---------------------------------------------------------------------------

const PLAYIT_MODULES = [
  path.join(ROOT, "agent", "src", "services", "playitService.js"),
  path.join(ROOT, "src", "services", "playitService.js"),
  path.join(ROOT, "src", "services", "playitAccountService.js"),
];
const FAKE_BINARY = "/opt/fake-playit/playit";
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
let world = null;

function enoent(target) {
  return Object.assign(new Error(`ENOENT ${target}`), { code: "ENOENT" });
}

const fakeFsPromises = {
  access: async (target) => {
    if (world?.binary && target === world.binary) return;
    throw enoent(target);
  },
  open: async (target) => { throw enoent(target); },
  readFile: async (target) => { throw enoent(target); },
  stat: async (target) => {
    if (String(target).endsWith(".sock")) {
      return { mode: 0o140660, uid: 0, gid: 0, size: 0, isSocket: () => true, isFile: () => false, isDirectory: () => false };
    }
    throw enoent(target);
  },
};

function fakeExecFile(command, args, options, callback) {
  const done = typeof options === "function" ? options : callback;
  const line = [command, ...(args || [])].join(" ");
  world.calls.push(line);
  const answer = world.exec ? world.exec(command, args || [], line) : null;
  process.nextTick(() => {
    if (answer && answer.ok) done(null, answer.stdout || "", "");
    else done(Object.assign(new Error("fake command failed"), { code: 1 }), "", "");
  });
  return { on() {}, kill() {} };
}

function fakeCreateConnection() {
  const socket = new EventEmitter();
  socket.setTimeout = () => {};
  socket.destroy = () => {};
  socket.write = (data) => {
    for (const raw of String(data).split("\n").filter(Boolean)) {
      const request = JSON.parse(raw);
      let payload = {};
      if (request.request.type === "get_state") payload = { tunnels: world.ipcTunnels || [] };
      if (request.request.type === "get_status") payload = { status: "connected" };
      if (request.request.type === "subscribe") payload = { tunnels: world.ipcTunnels || [] };
      process.nextTick(() => socket.emit("data", Buffer.from(`${JSON.stringify({ message_kind: "response", request_id: request.request_id, data: payload })}\n`)));
    }
  };
  process.nextTick(() => socket.emit("data", Buffer.from(`${JSON.stringify({ message_kind: "hello", data: { protocol: { ipc_version: 2 } } })}\n`)));
  return socket;
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  const fromPlayit = parent && PLAYIT_MODULES.includes(parent.filename);
  if (fromPlayit && world) {
    if (request === "child_process") {
      return {
        ...originalLoad.call(this, request, parent, isMain),
        execFile: fakeExecFile,
        spawn: () => { throw new Error("spawn is not allowed in this smoke"); },
      };
    }
    if (request === "net") return { ...originalLoad.call(this, request, parent, isMain), createConnection: fakeCreateConnection };
    if (request === "fs/promises") return fakeFsPromises;
  }
  return originalLoad.call(this, request, parent, isMain);
};

function loadPlayitServices(nextWorld) {
  world = { calls: [], ...nextWorld };
  Object.defineProperty(process, "platform", { value: world.platform, configurable: true });
  if (world.binary) process.env.PLAYIT_BINARY = world.binary;
  else delete process.env.PLAYIT_BINARY;
  for (const modulePath of PLAYIT_MODULES) delete require.cache[modulePath];
  return {
    agent: require(PLAYIT_MODULES[0]),
    desktop: require(PLAYIT_MODULES[1]),
    account: require(PLAYIT_MODULES[2]),
  };
}

function restorePlatform() {
  Object.defineProperty(process, "platform", realPlatform);
  delete process.env.PLAYIT_BINARY;
}

// Linux node running Playit with its IPC socket on the command line.
function linuxIpcWorld(ipcTunnels) {
  return {
    platform: "linux",
    binary: FAKE_BINARY,
    ipcTunnels,
    exec(command, args, line) {
      if (command === "pgrep") return { ok: true, stdout: `4242 ${FAKE_BINARY} --socket-path /run/playit/playit.sock` };
      if (line === "systemctl is-active playit") return { ok: true, stdout: "active" };
      return null;
    },
  };
}

const MC_TUNNEL = { display_address: "mc-abc.gl.at.ply.gg:12345", destination: "127.0.0.1:25565", is_disabled: false, disabled_reason: null };
const PAL_TUNNEL = { display_address: "pal-def.gl.at.ply.gg:23456", destination: "127.0.0.1:8211", is_disabled: false, disabled_reason: null };

// ---------------------------------------------------------------------------
// app.js extraction
// ---------------------------------------------------------------------------

function extractAppFunction(name, optional = false) {
  const needle = `function ${name}(`;
  let start = APP_SOURCE.indexOf(needle);
  if (start < 0) {
    if (optional) return "";
    throw new Error(`app.js has no function ${name}.`);
  }
  if (APP_SOURCE.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  // Skip the whole parameter list: defaults such as `entry = {}` contain braces.
  let parenDepth = 0;
  let paramsEnd = APP_SOURCE.indexOf("(", start);
  for (; paramsEnd < APP_SOURCE.length; paramsEnd += 1) {
    if (APP_SOURCE[paramsEnd] === "(") parenDepth += 1;
    else if (APP_SOURCE[paramsEnd] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  const open = APP_SOURCE.indexOf("{", paramsEnd);
  let depth = 0;
  for (let index = open; index < APP_SOURCE.length; index += 1) {
    const char = APP_SOURCE[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return APP_SOURCE.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}.`);
}

function functionText(name) {
  return extractAppFunction(name, true);
}

// State variables are `var`s so the test can read and set them on the context.
function makeAppSandbox({ functions = [], optional = [], state = {}, stubs = {} }) {
  const fields = {};
  const context = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    Map,
    Set,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Error,
    RegExp,
    URL,
    fields,
    setField: (name, value) => { fields[name] = value; },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    ...stubs,
  };
  vm.createContext(context);
  const declarations = Object.keys(state).map((key) => `var ${key};`).join("\n");
  const code = [
    declarations,
    ...functions.map((name) => extractAppFunction(name)),
    ...optional.map((name) => extractAppFunction(name, true)),
  ].join("\n\n");
  vm.runInContext(code, context, { filename: "app-extract.js" });
  Object.assign(context, state);
  return context;
}

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "g");
  const bodies = [];
  let match;
  while ((match = pattern.exec(STYLES)) !== null) bodies.push(match[2]);
  return bodies.join("\n");
}

function declares(body, property, valuePattern) {
  const pattern = new RegExp(`(^|;|\\s)${property}\\s*:\\s*${valuePattern}\\s*(;|$)`, "m");
  return pattern.test(body);
}

(async () => {
  // -------------------------------------------------------------------------
  // sharing-1: the detected Playit address keeps its public port
  // -------------------------------------------------------------------------
  await check("sharing-1", "Playit public address keeps its port end to end", async () => {
    const { agent, desktop } = loadPlayitServices(linuxIpcWorld([MC_TUNNEL]));
    const snapshot = await agent.getPlayitSnapshot();
    assert.strictEqual(snapshot.tunnelAddress, "mc-abc.gl.at.ply.gg:12345", "the Agent snapshot keeps the public port Playit reports");
    assert.strictEqual(snapshot.tunnelDomain, "mc-abc.gl.at.ply.gg", "the domain is still the host alone");
    const listed = await agent.listPlayitTunnels();
    assert.strictEqual(listed.ok, true, JSON.stringify(listed));
    assert.strictEqual(listed.tunnels[0].publicAddress, "mc-abc.gl.at.ply.gg:12345");
    assert.strictEqual(listed.tunnels[0].publicPort, 12345, "the listed tunnel carries the public port");
    restorePlatform();

    const agentExtract = agent._test && agent._test.extractPlayitAddress;
    const desktopExtract = desktop._test && desktop._test.extractPlayitAddress;
    assert.strictEqual(typeof agentExtract, "function", "the Agent exposes extractPlayitAddress for tests");
    assert.strictEqual(typeof desktopExtract, "function", "the desktop service exposes extractPlayitAddress for tests");
    for (const extract of [agentExtract, desktopExtract]) {
      assert.strictEqual(extract("tunnel mc-abc.gl.at.ply.gg:12345 => 127.0.0.1:25565"), "mc-abc.gl.at.ply.gg:12345");
      assert.strictEqual(extract("tcp://mc-abc.gl.at.ply.gg:12345 => 127.0.0.1:25565"), "mc-abc.gl.at.ply.gg:12345");
      assert.strictEqual(extract("address: anx-mc.joinmc.link"), "anx-mc.joinmc.link", "Minecraft Java joinmc.link addresses are Playit addresses");
    }
    assert.strictEqual(agentExtract("connecting to api.playit.gg:443"), null, "the Playit control endpoint is never a tunnel address");

    // A manual address with a port beats a detected address without one.
    const sandbox = makeAppSandbox({
      functions: ["getPublicAccessPublicAddress"],
      optional: ["preferConfiguredPlayitAddress"],
      state: { latestPlayitSnapshot: { tunnelAddress: "mc-abc.gl.at.ply.gg" } },
      stubs: {
        getSelectedPublicAccessService: () => ({ id: "playit-primary", providerId: "playit", publicAddress: "mc-abc.gl.at.ply.gg" }),
        getSelectedPublicAccessProvider: () => ({ id: "playit", publicAddress: "mc-abc.gl.at.ply.gg" }),
        getConfiguredPlayitAddress: () => "mc-abc.gl.at.ply.gg:12345",
      },
    });
    assert.strictEqual(sandbox.getPublicAccessPublicAddress(), "mc-abc.gl.at.ply.gg:12345", "the configured host:port wins over a portless detected address");
    sandbox.getConfiguredPlayitAddress = () => "other.ply.gg:1";
    sandbox.getSelectedPublicAccessService = () => ({ id: "playit-primary", providerId: "playit", publicAddress: "mc-abc.gl.at.ply.gg:12345" });
    assert.strictEqual(sandbox.getPublicAccessPublicAddress(), "mc-abc.gl.at.ply.gg:12345", "a detected address with a port still wins");
  });
  restorePlatform();

  // -------------------------------------------------------------------------
  // sharing-2: every tunnel is listed, synced and reconciled
  // -------------------------------------------------------------------------
  await check("sharing-2", "All Playit tunnels are listed, synced and adopted by saved shares", async () => {
    const { agent } = loadPlayitServices(linuxIpcWorld([MC_TUNNEL, PAL_TUNNEL]));
    const snapshot = await agent.getPlayitSnapshot();
    const listed = await agent.listPlayitTunnels();
    assert.strictEqual(listed.ok, true, JSON.stringify(listed));
    assert.deepStrictEqual(
      listed.tunnels.map((tunnel) => [tunnel.publicAddress, tunnel.localPort]).sort(),
      [["mc-abc.gl.at.ply.gg:12345", 25565], ["pal-def.gl.at.ply.gg:23456", 8211]],
      "both IPC tunnels are listed once each",
    );
    assert(Array.isArray(snapshot.tunnels) && snapshot.tunnels.length === 2, "the snapshot carries a sanitized tunnels array");
    for (const tunnel of snapshot.tunnels) {
      assert.deepStrictEqual(Object.keys(tunnel).filter((key) => /secret|token|key/i.test(key)), [], "no credential-like fields on tunnels");
    }
    restorePlatform();

    // The desktop reaches a remote computer's snapshot through agentClient;
    // its normalizer must carry the tunnel list (only sanitized fields).
    const agentClient = require(path.join(ROOT, "src", "services", "agentClient"));
    const normalizeRemote = agentClient._test && agentClient._test.normalizePlayitSnapshot;
    assert.strictEqual(typeof normalizeRemote, "function", "agentClient exposes normalizePlayitSnapshot for tests");
    const remote = normalizeRemote({ ok: true, snapshot: { ...snapshot, tunnels: snapshot.tunnels.map((tunnel) => ({ ...tunnel, rawSecret: "x" })) } });
    assert(Array.isArray(remote.tunnels) && remote.tunnels.length === 2, "a remote computer's snapshot keeps its tunnels");
    assert(remote.tunnels.every((tunnel) => !("rawSecret" in tunnel)), "unknown tunnel fields are dropped");
    assert.deepStrictEqual(remote.tunnels.map((tunnel) => tunnel.publicAddress).sort(), ["mc-abc.gl.at.ply.gg:12345", "pal-def.gl.at.ply.gg:23456"]);

    // Provider sync creates an endpoint per tunnel; IPC v2 reports no
    // protocol, so it is taken from the server's own endpoint on that port.
    const { createEndpointStore } = require(path.join(ROOT, "src", "services", "endpointStore"));
    const { createEndpointService } = require(path.join(ROOT, "src", "services", "endpointService"));
    const { createProviderIntegrationService } = require(path.join(ROOT, "src", "services", "providerIntegrationService"));
    const store = createEndpointStore({ configDirectory: fs.mkdtempSync(path.join(tempRoot, "endpoints-")) });
    const endpoints = createEndpointService({ store });
    endpoints.createEndpoint({ name: "Minecraft LAN", type: "lan", host: "lan-host.test", port: 25565, protocol: "tcp", serviceId: "svc-mc", computerId: "vps", source: "manual" });
    endpoints.createEndpoint({ name: "Palworld LAN", type: "lan", host: "lan-host.test", port: 8211, protocol: "udp", serviceId: "svc-pal", computerId: "vps", source: "manual" });
    const integration = createProviderIntegrationService({
      deps: {
        cacheTtlMs: 0,
        getPlayitSnapshot: () => remote,
        endpointGateway: {
          listEndpoints: (filter) => endpoints.listEndpoints(filter),
          upsertProviderEndpoint: (payload) => endpoints.upsertProviderEndpoint(payload),
          recordProviderSync: (nodeId, patch) => endpoints.recordProviderSync(nodeId, patch),
          getProviderSyncs: () => endpoints.getProviderSyncs(),
        },
      },
    });
    const sync = await integration.syncTunnels({ nodeId: "vps" });
    assert.strictEqual(sync.ok, true, JSON.stringify(sync.notes));
    assert.strictEqual(sync.endpointsCreated.length, 2, `two provider endpoints are created (notes: ${JSON.stringify(sync.notes)})`);
    const created = endpoints.listEndpoints({ nodeId: "vps" }).filter((endpoint) => endpoint.source === "provider");
    assert.deepStrictEqual(created.map((endpoint) => [endpoint.host, endpoint.port, endpoint.protocol, endpoint.serviceId]).sort(), [
      ["mc-abc.gl.at.ply.gg", 12345, "tcp", "svc-mc"],
      ["pal-def.gl.at.ply.gg", 23456, "udp", "svc-pal"],
    ]);

    // Saved records adopt their tunnel whatever protocol Playit reports.
    const { buildServiceFromPlayitSnapshot } = require(path.join(ROOT, "src", "shared", "publicAccessProviderDetection"));
    const { reconcileAccessServices } = require(path.join(ROOT, "src", "shared", "publicAccessServiceRegistry"));
    const record = (port, protocol) => ({ id: `svc-${port}`, nodeId: "vps", providerId: "playit", providerName: "Playit.gg", name: "Share", localPort: port, protocol, linkedInstanceId: `inst-${port}`, state: "pending-provider-setup" });
    const detected = (protocol) => buildServiceFromPlayitSnapshot({ installed: true, running: true, connected: true, tunnelAddress: "mc.gl.at.ply.gg:12345", localPort: "25565", protocol });
    for (const [protocol, savedProtocol] of [[null, "tcp"], ["TCP+UDP", "udp"], ["TCP+UDP", "tcp"]]) {
      const [reconciled] = reconcileAccessServices([record(25565, savedProtocol)], { services: [detected(protocol)] });
      assert.strictEqual(reconciled.state, "running", `protocol ${protocol} adopts a ${savedProtocol} record`);
      assert.strictEqual(reconciled.publicAddress, "mc.gl.at.ply.gg:12345");
    }
    const [wrongProtocol] = reconcileAccessServices([record(25565, "udp")], { services: [detected("TCP")] });
    assert.notStrictEqual(wrongProtocol.state, "running", "a known different protocol is still not adopted");
    // The second server's record is matched against the second tunnel.
    const [second] = reconcileAccessServices([record(8211, "udp")], { services: [detected(null)], playit: { running: true, connected: true, tunnels: snapshot.tunnels } });
    assert.strictEqual(second.state, "running", "a record on the second tunnel's port is adopted");
    assert.strictEqual(second.publicAddress, "pal-def.gl.at.ply.gg:23456");
  });
  restorePlatform();

  // -------------------------------------------------------------------------
  // sharing-3: an unavailable refresh never re-renders the old live state
  // -------------------------------------------------------------------------
  await check("sharing-3", "Unavailable Sharing page does not show the last snapshot as live", async () => {
    const { buildPublicAccessSnapshot } = require(path.join(ROOT, "src", "shared", "publicAccessProviderDetection"));
    const snapshot = await buildPublicAccessSnapshot({
      runCommand: async () => ({ ok: false, errorCode: "ENOENT", stdout: "", stderr: "" }),
      getPlayitSnapshot: async () => ({ installed: true, running: true, connected: true, tunnelAddress: "old-node.gl.at.ply.gg:12345", localPort: "25565" }),
      nodeId: "node-a",
      platform: "linux",
    });
    const actions = [];
    const element = () => ({ className: "", textContent: "", replaceChildren() {}, append() {} });
    const sandbox = makeAppSandbox({
      functions: [
        "renderPlayitUnavailable",
        "renderPublicAccessProviderDetails",
        "renderPublicAccessProviderMetricFields",
        "getSelectedPublicAccessProvider",
        "getSelectedPublicAccessService",
        "getPublicAccessProviderLabel",
        "getPublicAccessProviderTone",
        "formatPublicAccessHealth",
        "formatPublicAccessReachability",
        "formatPublicAccessCapabilities",
        "getPublicAccessActionDefinitions",
      ],
      optional: ["markPublicAccessSnapshotUnavailable"],
      state: {
        latestPublicAccessSnapshot: snapshot,
        latestPlayitSnapshot: snapshot.playit,
        latestPlayitAccount: null,
        selectedPublicAccessProviderId: "playit",
        selectedPublicAccessServiceId: "playit-primary",
        publicAccessProviderDetailPill: element(),
        publicAccessProviderDetailSummary: element(),
        publicAccessServiceActions: element(),
        publicAccessProviderActions: element(),
        publicAccessProviderUnsupported: element(),
      },
      stubs: {
        getPublicAccessRequestUnavailableReason: (error, message) => ({ message }),
        renderPlayitAccount() {},
        setPlayitVisualState() {},
        getConfiguredPlayitAddress: () => null,
        renderPublicAccessUnavailableState() {},
        getPublicAccessUnavailableReason: () => null,
        renderInstanceNetwork() {},
        findInstance: () => null,
        renderFriendlyDashboard() {},
        updateTitlebar() {},
        formatDateTime: (value) => String(value || ""),
        createTextElement: (tag, text) => ({ tag, text }),
        renderPublicAccessActionButtons: (container, list) => { actions.push(list); },
      },
    });
    const message = "Agent unavailable. Reconnect the selected computer, then refresh.";
    sandbox.renderPlayitUnavailable(message);
    const { fields } = sandbox;
    assert.strictEqual(fields.playitConnected, "Unavailable");
    assert.strictEqual(fields.playitRunning, "Unavailable");
    assert.strictEqual(fields.playitTunnelAddress, "Unavailable", "the old address is not shown as current");
    assert.strictEqual(fields.playitSummary, message, "the failure message stays visible");
    assert.strictEqual(fields.publicAccessReachability, message);
    assert.strictEqual(fields.publicAccessConnectionHealth, "Unavailable");
    assert.notStrictEqual(sandbox.publicAccessProviderDetailPill.textContent, "Running", "the detail pill does not say Running");
    const copy = (actions[actions.length - 1] || []).find((entry) => entry.action === "copy-public-address");
    assert(copy && copy.supported === false, "Copy public address is not offered for a stale address");
    // Provider configuration is still known (the list was not cleared).
    assert(Array.isArray(sandbox.latestPublicAccessSnapshot?.providers) && sandbox.latestPublicAccessSnapshot.providers.length > 0, "known providers are kept");

    const reset = functionText("resetNodeScopedRendererState");
    assert(/latestPublicAccessSnapshot\s*=\s*null/.test(reset), "a computer switch clears the previous computer's Public Access snapshot");
  });

  // -------------------------------------------------------------------------
  // sharing-4: Share dialog and server page never judge from foreign/empty caches
  // -------------------------------------------------------------------------
  await check("sharing-4", "Share dialog refreshes the selected computer and shows Checking until it knows", async () => {
    const reset = functionText("resetNodeScopedRendererState");
    assert(/latestPlayitTunnels\s*=\s*\[\]/.test(reset), "a computer switch clears the tunnel list");
    assert(/latestPlayitServiceStatus\s*=\s*null/.test(reset), "a computer switch clears the Playit service status");

    const shareHealth = require(path.join(ROOT, "src", "shared", "shareHealth.js"));
    const sandbox = makeAppSandbox({
      functions: [
        "getShareServerAccessHealth",
        "getShareServerAddresses",
        "findSharePlayitTunnelMatches",
        "getInstanceAccessServices",
        "getInstanceAccessProvider",
        "normalizeShareAddress",
        "isUsableShareAddress",
        "getInstanceAccessAddress",
        "getInstanceProcessAccessState",
        "getInstanceListeningPorts",
      ],
      optional: ["isShareAccessStateLoaded", "isLoopbackShareHost", "getShareLanHost"],
      state: {
        latestPublicAccessSnapshot: null,
        latestPlayitTunnels: [],
        latestPlayitServiceStatus: null,
        latestPlayitTunnelsLoaded: false,
        networkInventoryState: { nodeId: null, status: "idle", data: null },
      },
      stubs: {
        AnxShareHealth: shareHealth,
        getInstancePrimaryPort: (instance) => instance?.port || null,
        formatInstanceAddress: (instance) => `lan-host.test:${instance.port}`,
        getInstanceConnectionHost: () => "lan-host.test",
        getSelectedNodeId: () => "vps",
        getSelectedNodeAgentUrl: () => "http://lan-host.test:47131",
        isInstanceRunning: (instance) => instance.state === "running",
        getRecentShareConnectionTest: () => null,
        getPublicAccessUnavailableReason: () => null,
        getInstanceAccessSuggestions: () => [{ providerId: "playit", protocol: "tcp" }],
        getInstanceAccessBadgeLabel: () => "Access",
        chooseTailscaleEndpoint: (provider, port) => ({ address: `${String(provider.DNSName || "").replace(/\.$/, "")}:${port}` }),
      },
    });
    const instance = { id: "mc", port: 25565, state: "running", runtime: { ports: [25565] } };
    const health = sandbox.getShareServerAccessHealth(instance);
    assert.notStrictEqual(health.tunnelMatch, "not-matched", "with no tunnel list loaded yet, the tunnel is not reported as missing");
    const checklist = shareHealth.buildShareChecklist(health);
    assert.notStrictEqual((checklist.find((item) => item.id === "tunnel") || {}).state, "problem", "the checklist does not flag a tunnel problem before it knows");

    const openBody = functionText("openShareServerModal");
    assert(/refreshShareAccessState\(/.test(openBody), "opening the Share dialog refreshes the selected computer's sharing state");
    assert(/Checking/.test(openBody), "the Share dialog says it is checking until the refresh returns");
    assert(/isShareAccessStateLoaded/.test(SERVER_VIEW_SOURCE) && /Checking/.test(SERVER_VIEW_SOURCE), "the server page Connect card shows Checking instead of a verdict from empty caches");

    // refreshShareAccessState waits for the tunnel list, even off the Sharing page.
    const calls = [];
    const refreshSandbox = makeRefreshSandbox({ page: "servers", calls, statusDelay: 5, tunnelsDelay: 5, snapshotDelay: 2 });
    assert.strictEqual(typeof refreshSandbox.refreshShareAccessState, "function", "refreshShareAccessState exists");
    await refreshSandbox.refreshShareAccessState();
    assert(calls.includes("render:tunnels"), "the tunnel list is rendered before the Share refresh resolves");
    assert(calls.includes("render:status"), "the Playit status is rendered before the Share refresh resolves");
  });

  // -------------------------------------------------------------------------
  // sharing-5: Stop sharing reports a resolved failure as a failure
  // -------------------------------------------------------------------------
  await check("sharing-5", "Stop sharing counts an { ok:false } delete as failed", async () => {
    const sandbox = makeAppSandbox({
      functions: ["deleteAccessServicesForInstance", "getAgentErrorCode"],
      stubs: {
        getDesktopApiState: () => ({
          hasPublicAccess: true,
          api: { publicAccess: { deleteService: async () => ({ ok: false, error: { code: "AGENT_TIMEOUT", message: "Agent timed out." } }) } },
        }),
        getInstanceAccessServices: () => [{ id: "svc-1", providerId: "playit" }],
        createNodeActionContext: () => ({ nodeId: "vps" }),
        isNodeActionStillCurrent: () => true,
        refreshPlayitStatus: async () => {},
      },
    });
    const result = await sandbox.deleteAccessServicesForInstance({ id: "mc" });
    assert.strictEqual(result.removed, 0, "nothing is counted as removed");
    assert.strictEqual(result.failed, 1, "the resolved failure is counted");
    assert.strictEqual(result.failures[0] && result.failures[0].code, "AGENT_TIMEOUT");
  });

  // -------------------------------------------------------------------------
  // sharing-6: one refresh cycle runs one Playit inspection
  // -------------------------------------------------------------------------
  await check("sharing-6", "A Sharing refresh cycle inspects Playit once, and Dashboard ticks skip management", async () => {
    const { agent, account } = loadPlayitServices({ platform: "win32", binary: null, exec: () => null });
    const accountService = account.createPlayitAccountService({ getStatus: () => agent.getPlayitStatus() });
    await agent.getPlayitSnapshot();
    await Promise.all([agent.getPlayitStatus(), agent.listPlayitTunnels(), accountService.getAccountState()]);
    const where = world.calls.filter((line) => line === "where.exe playit").length;
    const cim = world.calls.filter((line) => /Get-CimInstance Win32_Process/.test(line)).length;
    const total = world.calls.length;
    restorePlatform();
    assert.strictEqual(where, 1, `where.exe playit runs once per cycle (ran ${where} times)`);
    assert.strictEqual(cim, 1, `the Win32_Process query runs once per cycle (ran ${cim} times)`);
    assert(total <= 15, `a cycle without Playit spawns few processes (spawned ${total})`);

    // A control action is never answered from the cache.
    assert.strictEqual(typeof agent.invalidatePlayitCache, "function", "the Agent can drop its Playit cache");

    const calls = [];
    const sandbox = makeRefreshSandbox({ page: "dashboard", calls, statusDelay: 1, tunnelsDelay: 1, snapshotDelay: 1 });
    await sandbox.refreshPlayitStatus();
    await delay(20);
    assert(calls.includes("snapshot"), "the Dashboard still refreshes the Public Access snapshot");
    assert(!calls.includes("status") && !calls.includes("tunnels") && !calls.includes("account"), `Dashboard ticks do not run Playit management (${calls.join(",")})`);
  });
  restorePlatform();

  // -------------------------------------------------------------------------
  // visual-sharing-1: polling never throws away the management result
  // -------------------------------------------------------------------------
  await check("visual-sharing-1", "Playit service and tunnels render while the 5 s poll keeps running", async () => {
    const calls = [];
    const sandbox = makeRefreshSandbox({ page: "playit", calls, snapshotDelay: 10, statusDelay: 100, tunnelsDelay: 100 });
    const timer = setInterval(() => { sandbox.refreshPlayitStatus(); }, 20);
    sandbox.refreshPlayitStatus();
    await delay(400);
    const renderedWhilePolling = calls.filter((entry) => entry === "render:status").length;
    const tunnelsWhilePolling = calls.filter((entry) => entry === "render:tunnels").length;
    clearInterval(timer);
    await delay(250);
    assert(renderedWhilePolling >= 1, "the Playit Service card renders while polling continues");
    assert(tunnelsWhilePolling >= 1, "the tunnel list renders while polling continues");
  });

  // -------------------------------------------------------------------------
  // visual-sharing-2: a loopback Agent URL is never a LAN address
  // -------------------------------------------------------------------------
  await check("visual-sharing-2", "Share dialog never offers 127.0.0.1 as the LAN address", async () => {
    const shareHealth = require(path.join(ROOT, "src", "shared", "shareHealth.js"));
    const build = (inventory) => makeAppSandbox({
      functions: [
        "getShareServerAddresses",
        "getRecommendedShareServerAddress",
        "buildShareServerInviteText",
        "getShareServerInvitePrefix",
        "formatInstanceAddress",
        "getInstanceConnectionHost",
        "findSharePlayitTunnelMatches",
        "getInstanceAccessServices",
        "getInstanceAccessProvider",
        "normalizeShareAddress",
        "isUsableShareAddress",
        "getInstanceAccessAddress",
      ],
      optional: ["isLoopbackShareHost", "getShareLanHost", "isShareAccessStateLoaded"],
      state: {
        latestPublicAccessSnapshot: null,
        latestPlayitTunnels: [],
        latestPlayitTunnelsLoaded: true,
        networkInventoryState: inventory,
      },
      stubs: {
        AnxShareHealth: shareHealth,
        getInstancePrimaryPort: (instance) => instance?.port || null,
        getSelectedNodeId: () => "this-pc",
        getSelectedNodeAgentUrl: () => "http://127.0.0.1:47131",
        getInstanceAccessGameKind: () => "minecraft",
        getInstanceAccessBadgeLabel: () => "Access",
        chooseTailscaleEndpoint: () => null,
      },
    });
    const instance = { id: "mc", port: 25565 };
    const plain = build({ nodeId: null, status: "idle", data: null });
    const addresses = plain.getShareServerAddresses(instance);
    assert(!addresses.some((entry) => entry.availability === "lan" && /^(?:127\.|localhost|\[?::1)/i.test(entry.address)), `no LAN row on a loopback host (${JSON.stringify(addresses)})`);
    const recommended = plain.getRecommendedShareServerAddress(instance);
    assert(!recommended || !/^(?:127\.|localhost)/i.test(recommended.address), "a loopback address is never recommended");
    assert.strictEqual(plain.isUsableShareAddress("127.0.0.1:25565"), false, "loopback is not a usable share address");
    assert.strictEqual(plain.buildShareServerInviteText(instance, { address: "127.0.0.1:25565", availability: "lan" }), "", "loopback never goes into invite text");

    const withInventory = build({
      nodeId: "this-pc",
      status: "ready",
      data: { interfaces: [
        { name: "lo", address: "127.0.0.1", family: "IPv4", internal: true },
        { name: "eth0", address: "172.16.99.7", family: "IPv4", internal: false },
      ] },
    });
    const lan = withInventory.getShareServerAddresses(instance).find((entry) => entry.availability === "lan");
    assert(lan, "the computer's private LAN address is offered when known");
    assert.strictEqual(lan.address, "172.16.99.7:25565");

    // A Docker or WSL adapter listed first is never offered as the LAN address.
    const withVirtual = build({
      nodeId: "this-pc",
      status: "ready",
      data: { interfaces: [
        { name: "vEthernet (WSL)", address: "172.20.16.1", family: "IPv4", internal: false },
        { name: "docker0", address: "172.17.0.1", family: "IPv4", internal: false },
        { name: "Wi-Fi", address: "192.168.50.20", family: "IPv4", internal: false },
      ] },
    });
    const lanPreferred = withVirtual.getShareServerAddresses(instance).find((entry) => entry.availability === "lan");
    assert.strictEqual(lanPreferred && lanPreferred.address, "192.168.50.20:25565", "the physical adapter wins over virtual ones");
  });

  // -------------------------------------------------------------------------
  // visual-sharing-4: only the Share dialog body scrolls; the footer stays visible
  // -------------------------------------------------------------------------
  await check("visual-sharing-4", "Share dialog is a flex column with one scrolling body", async () => {
    const dialog = cssRule(".app-modal--share-server");
    assert(declares(dialog, "display", "flex"), "the Share dialog is a flex container");
    assert(declares(dialog, "flex-direction", "column"), "the Share dialog stacks header, body and footer");
    assert(declares(dialog, "overflow", "hidden"), "the Share dialog itself does not scroll");
    const body = cssRule(".app-modal--share-server .share-server-body");
    assert(declares(body, "flex", "1 1 auto"), "the body takes the free height");
    assert(declares(body, "min-height", "0"), "the body may shrink so it scrolls instead of the dialog");
    assert(declares(body, "max-height", "none"), "the body is not capped separately from the dialog");
  });

  // -------------------------------------------------------------------------
  // visual-sharing-5: the Sharing summary counts only real services
  // -------------------------------------------------------------------------
  await check("visual-sharing-5", "Sharing summary does not count the Playit placeholder as a service", async () => {
    const { buildPublicAccessSnapshot } = require(path.join(ROOT, "src", "shared", "publicAccessProviderDetection"));
    const snapshot = await buildPublicAccessSnapshot({
      runCommand: async () => ({ ok: false, errorCode: "ENOENT", stdout: "", stderr: "" }),
      getPlayitSnapshot: async () => ({ installed: false, running: false, connected: false }),
      platform: "linux",
    });
    const sandbox = makeAppSandbox({
      functions: ["renderPublicAccessSnapshot"],
      optional: ["isRealPublicAccessService"],
      state: { latestPublicAccessSnapshot: null, selectedPublicAccessServiceId: null },
      stubs: {
        renderPlayitSnapshot() {},
        renderPublicAccessProviders() {},
        getDesktopApiState: () => ({ api: {} }),
        renderPublicAccessProviderDetails() {},
        renderInstanceRows() {},
        getInstances: () => [],
        renderInstanceNetwork() {},
        findInstance: () => null,
        renderFriendlyDashboard() {},
      },
    });
    sandbox.renderPublicAccessSnapshot(snapshot);
    assert.strictEqual(sandbox.fields.publicAccessServices, "No access services");
    assert(/^0 services/.test(sandbox.fields.dashboardPublicAccessDetail), `dashboard detail: ${sandbox.fields.dashboardPublicAccessDetail}`);

    const running = await buildPublicAccessSnapshot({
      runCommand: async () => ({ ok: false, errorCode: "ENOENT", stdout: "", stderr: "" }),
      getPlayitSnapshot: async () => ({ installed: true, running: true, connected: true, tunnelAddress: "mc.gl.at.ply.gg:12345", localPort: "25565" }),
      platform: "linux",
    });
    sandbox.renderPublicAccessSnapshot(running);
    assert.strictEqual(sandbox.fields.publicAccessServices, "1 service", "a detected tunnel is still counted");
  });

  // -------------------------------------------------------------------------
  // visual-sharing-6: Settings positional rules do not place Network panels
  // -------------------------------------------------------------------------
  await check("visual-sharing-6", "Network & addresses panels stay full width", async () => {
    const guard = cssRule(".network-shell > .settings-section:not([hidden])");
    assert(declares(guard, "grid-column", "auto"), "Network panels are not pushed into a second column");
    assert(declares(guard, "grid-row", "auto"), "Network panels are not given Settings grid rows");
    const shell = cssRule(".network-shell");
    assert(declares(shell, "grid-template-columns", "minmax\\(0,\\s*1fr\\)"), "the Network shell has one explicit column");
  });

  // -------------------------------------------------------------------------
  // visual-sharing-7: the Remove button keeps its label on one line
  // -------------------------------------------------------------------------
  await check("visual-sharing-7", "Phone Access Remove button is not squeezed", async () => {
    const info = cssRule(".phone-device__info");
    assert(declares(info, "flex", "1 1 auto"), "the device info takes the free width");
    assert(declares(info, "min-width", "0"), "the device info can shrink instead of the button");
    const button = cssRule(".phone-device > .inline-action");
    assert(declares(button, "flex", "0 0 auto"), "the Remove button keeps its width");
    assert(declares(button, "white-space", "nowrap"), "the Remove label never wraps");
  });

  // -------------------------------------------------------------------------
  // visual-sharing-8: Share dialog header stacks and clears the close button
  // -------------------------------------------------------------------------
  await check("visual-sharing-8", "Share dialog header is stacked and leaves room for the close button", async () => {
    const header = cssRule(".app-modal--share-server .app-modal__header");
    assert(declares(header, "display", "grid"), "eyebrow, title and description stack");
    assert(declares(header, "padding-right", "36px"), "the description never runs under the close button");
  });

  // -------------------------------------------------------------------------
  // sharing-7 (review R0): the global Playit address setting never replaces
  // another computer's or service's detected address
  // -------------------------------------------------------------------------
  await check("sharing-7", "R0: the configured Playit address is used only for the same host", async () => {
    let selectedAddress = "b.joinmc.link";
    let configured = "a.ply.gg:41234";
    const sandbox = makeAppSandbox({
      functions: ["getPublicAccessPublicAddress", "preferConfiguredPlayitAddress"],
      state: { latestPlayitSnapshot: null },
      stubs: {
        getSelectedPublicAccessService: () => ({ id: "playit-primary", providerId: "playit", publicAddress: selectedAddress }),
        getSelectedPublicAccessProvider: () => ({ id: "playit" }),
        getConfiguredPlayitAddress: () => configured,
      },
    });
    assert.strictEqual(sandbox.getPublicAccessPublicAddress(), "b.joinmc.link", "another computer's tunnel never replaces this computer's joinmc.link address");
    selectedAddress = "anx-mc.joinmc.link";
    configured = "pal-def.gl.at.ply.gg:23456";
    assert.strictEqual(sandbox.getPublicAccessPublicAddress(), "anx-mc.joinmc.link", "another service's tunnel never replaces the selected service's address");
    selectedAddress = "play.example.com";
    configured = "a.ply.gg:41234";
    assert.strictEqual(sandbox.getPublicAccessPublicAddress(), "play.example.com", "a custom domain is not swapped for a different host");
    selectedAddress = "MC-abc.gl.at.ply.gg";
    configured = "mc-abc.gl.at.ply.gg:12345";
    assert.strictEqual(sandbox.getPublicAccessPublicAddress(), "mc-abc.gl.at.ply.gg:12345", "the same host (any case) still gets its configured port");
    selectedAddress = "anx-mc.joinmc.link";
    configured = "anx-mc.joinmc.link:25565";
    assert.strictEqual(sandbox.getPublicAccessPublicAddress(), "anx-mc.joinmc.link", "joinmc.link addresses need no port");
    // renderPlayitSnapshot passes the configured address explicitly.
    assert.strictEqual(sandbox.preferConfiguredPlayitAddress("b.joinmc.link", "a.ply.gg:41234"), "b.joinmc.link");
    assert.strictEqual(sandbox.preferConfiguredPlayitAddress("", "a.ply.gg:41234"), "a.ply.gg:41234", "with nothing detected the configured address is still shown");
  });

  // -------------------------------------------------------------------------
  // sharing-8 (review R1): tunnel-derived shares follow Playit's real state
  // -------------------------------------------------------------------------
  await check("sharing-8", "R1: a share matched to a listed tunnel is Public only while Playit is connected", async () => {
    const { buildServiceFromPlayitSnapshot } = require(path.join(ROOT, "src", "shared", "publicAccessProviderDetection"));
    const { reconcileAccessServices } = require(path.join(ROOT, "src", "shared", "publicAccessServiceRegistry"));
    const tunnels = [
      { publicAddress: "mc-abc.gl.at.ply.gg:12345", localPort: 25565, protocol: null, status: "online" },
      { publicAddress: "pal-def.gl.at.ply.gg:23456", localPort: 8211, protocol: null, status: "online" },
    ];
    const record = { id: "svc-8211", nodeId: "vps", providerId: "playit", providerName: "Playit.gg", name: "Share", localPort: 8211, protocol: "udp", linkedInstanceId: "inst-8211", state: "pending-provider-setup" };
    const reconcile = (playit) => reconcileAccessServices([record], {
      services: [buildServiceFromPlayitSnapshot({ ...playit, tunnelAddress: "mc-abc.gl.at.ply.gg:12345", localPort: "25565" })],
      playit: { ...playit, tunnels },
    })[0];
    const unknown = reconcile({ installed: true, running: true, connected: null });
    assert.strictEqual(unknown.status, "Provider running", "an unknown connection is not reported as Public");
    assert.notStrictEqual(unknown.state, "running");
    assert.strictEqual(unknown.publicAddress, "pal-def.gl.at.ply.gg:23456", "the second tunnel is still matched");
    const stopped = reconcile({ installed: true, running: false, connected: false });
    assert.notStrictEqual(stopped.status, "Provider running", "a stopped Playit is never 'Provider running'");
    assert.notStrictEqual(stopped.status, "Public");
    assert.notStrictEqual(stopped.state, "running");
    const connected = reconcile({ installed: true, running: true, connected: true });
    assert.strictEqual(connected.status, "Public");
    assert.strictEqual(connected.state, "running");
  });

  // -------------------------------------------------------------------------
  // sharing-9 (review R2/R5): Checking... settles after one finished refresh
  // -------------------------------------------------------------------------
  await check("sharing-9", "R2/R5: the Connect card settles once, and stops polling, when the tunnel list cannot load", async () => {
    let clock = 1000000;
    class FakeDate extends Date {
      static now() { return clock; }
    }
    const cases = [
      ["older Agent", { ok: false, error: { code: "AGENT_PLAYIT_CONTROLS_UNSUPPORTED" } }, true],
      ["refused tunnel request", { ok: false, error: { code: "FORBIDDEN" } }, false],
    ];
    for (const [label, tunnelsAnswer, unsupported] of cases) {
      const calls = [];
      let ctx = null;
      ctx = makeRefreshSandbox({
        page: "instances",
        calls,
        snapshotDelay: 1,
        statusDelay: 1,
        tunnelsDelay: 1,
        api: { listPlayitTunnels: async () => { calls.push("tunnels"); return tunnelsAnswer; } },
        optional: ["ensureShareAccessState", "waitForPlayitRefreshToSettle", "renderPlayitTunnels", "renderPlayitTunnelsFromLegacySnapshot"],
        state: { shareAccessRefreshPromise: null, shareAccessRefreshStartedAt: 0, latestPlayitTunnels: [], playitTunnelMessage: null, playitTunnelList: null },
        stubs: {
          Date: FakeDate,
          isPlayitEndpointUnsupported: () => unsupported,
          renderPublicAccessSnapshot: (snapshot) => { calls.push("render:snapshot"); ctx.latestPublicAccessSnapshot = snapshot; },
          findInstanceForTunnel: () => null,
          getLegacyPlayitAccessFallback: () => null,
        },
      });
      assert.strictEqual(typeof ctx.ensureShareAccessState, "function", "ensureShareAccessState exists");
      for (let elapsed = 0; elapsed <= 120000; elapsed += 5000) {
        clock += 5000;
        const pending = ctx.ensureShareAccessState();
        if (pending) await pending;
      }
      assert.strictEqual(ctx.latestPlayitTunnelsLoaded, false, `${label}: the tunnel list itself is still unknown`);
      assert.strictEqual(ctx.isShareAccessStateLoaded(), true, `${label}: one finished refresh settles Checking...`);
      const snapshots = calls.filter((entry) => entry === "snapshot").length;
      assert.strictEqual(snapshots, 1, `${label}: one refresh in 2 minutes, not one every 15 s (ran ${snapshots})`);
      // Another computer is selected: its state is not settled by this one.
      ctx.selectedNodeContextVersion += 1;
      assert.strictEqual(ctx.isShareAccessStateLoaded(), false, `${label}: a computer switch starts over`);
    }
    assert(/getActivePageName\(\) === "instances"[\s\S]{0,200}ensureShareAccessState\(\)/.test(SERVER_VIEW_SOURCE), "the server page refreshes sharing only while it is on screen");
  });

  // -------------------------------------------------------------------------
  // sharing-10 (review R3): no rebuild over a confirmation or running action
  // -------------------------------------------------------------------------
  await check("sharing-10", "R3: the Share dialog is not rebuilt over a confirmation or while an action runs", async () => {
    let activeModals = [];
    let busy = false;
    let busySelector = "";
    const overlay = {
      querySelector: (selector) => {
        busySelector = selector;
        return busy && /:disabled/.test(selector) ? {} : null;
      },
    };
    const sandbox = makeAppSandbox({
      optional: ["isShareServerModalIdle"],
      stubs: {
        document: { querySelector: () => null, querySelectorAll: (selector) => (selector === '[data-modal-active="true"]' ? activeModals : []) },
      },
    });
    assert.strictEqual(typeof sandbox.isShareServerModalIdle, "function", "isShareServerModalIdle exists");
    activeModals = [overlay];
    assert.strictEqual(sandbox.isShareServerModalIdle(overlay), true, "an idle dialog on top can be rebuilt");
    activeModals = [{ id: "below" }, overlay];
    assert.strictEqual(sandbox.isShareServerModalIdle(overlay), true, "a dialog below does not block the rebuild");
    activeModals = [overlay, { id: "confirmation" }];
    assert.strictEqual(sandbox.isShareServerModalIdle(overlay), false, "a confirmation opened above blocks the rebuild");
    activeModals = [overlay];
    busy = true;
    assert.strictEqual(sandbox.isShareServerModalIdle(overlay), false, "a running action or test blocks the rebuild");
    for (const name of ["data-share-server-start", "data-share-server-stop", "data-share-server-test"]) {
      assert(busySelector.includes(`[${name}]:disabled`), `the busy check covers ${name}`);
    }
    const openBody = functionText("openShareServerModal");
    assert(/isShareServerModalIdle\(overlay\)[\s\S]*?setTimeout\(rebuildWhenIdle[\s\S]*?close\(\);\s*openShareServerModal\(fresh, \{ accessRefreshed: true[\w\s,]*\}\)/.test(openBody), "the rebuild waits until the dialog is idle");
  });

  // -------------------------------------------------------------------------
  // sharing-11 (review R4): a refresh after a user action is not dropped
  // -------------------------------------------------------------------------
  await check("sharing-11", "R4: a refresh asked for while one runs runs once more after it", async () => {
    const calls = [];
    let snapshots = 0;
    let releaseStatus = null;
    const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
    const rendered = [];
    const sandbox = makeRefreshSandbox({
      page: "playit",
      calls,
      snapshotDelay: 1,
      statusDelay: 1,
      tunnelsDelay: 1,
      api: {
        getSnapshot: async () => { snapshots += 1; return { providers: [], services: [], n: snapshots }; },
        getPlayitStatus: () => (snapshots === 1 ? statusGate : Promise.resolve({ ok: true, installed: false, serviceState: "missing" })),
      },
      stubs: { renderPublicAccessSnapshot: (snapshot) => { rendered.push(snapshot.n); } },
    });
    // The 5 s poll: its snapshot is in, its management is still waiting.
    await sandbox.refreshPlayitStatus();
    assert.strictEqual(sandbox.playitRequestInFlight, true, "the poll's management is still pending");
    // Two post-action refreshes arrive meanwhile (Start Playit, then a share).
    const first = sandbox.refreshPlayitStatus();
    const second = sandbox.refreshPlayitStatus();
    releaseStatus({ ok: true, installed: true, serviceState: "running" });
    const outcome = await Promise.race([Promise.all([first, second]).then(() => "done"), delay(2000).then(() => "timeout")]);
    assert.strictEqual(outcome, "done", "the waiting callers are resolved");
    assert.strictEqual(snapshots, 2, `the queued calls ran one more refresh (snapshots: ${snapshots})`);
    assert.deepStrictEqual(rendered, [1, 2], "the state after the action is rendered before the callers resume");
    await delay(20);
    assert.strictEqual(sandbox.playitRequestInFlight, false, "nothing stays in flight");
  });

  // -------------------------------------------------------------------------
  // sharing-12 (review Q0): a failed or backed-off snapshot does not settle
  // -------------------------------------------------------------------------
  await check("sharing-12", "Q0: Checking... stays, and is retried, until the Public Access snapshot loads", async () => {
    const homeSnapshot = { providers: [{ id: "playit", running: true }], services: [{ id: "svc-mc", providerId: "playit", publicAddress: "mc-abc.gl.at.ply.gg:12345" }] };
    const cases = [
      ["failed snapshot", { failing: true, backoff: false, prior: null }],
      ["failed snapshot after Home loaded one", { failing: true, backoff: false, prior: homeSnapshot }],
      ["polling backoff", { failing: false, backoff: true, prior: null }],
    ];
    for (const [label, scenario] of cases) {
      let clock = 1000000;
      class FakeDate extends Date {
        static now() { return clock; }
      }
      const calls = [];
      let ctx = null;
      ctx = makeRefreshSandbox({
        page: "instances",
        calls,
        snapshotDelay: 1,
        statusDelay: 1,
        tunnelsDelay: 1,
        api: {
          getSnapshot: async () => {
            calls.push("snapshot");
            return scenario.failing ? { ok: false, error: { code: "AGENT_TIMEOUT", message: "timed out" } } : { providers: [], services: [] };
          },
          listPlayitTunnels: async () => { calls.push("tunnels"); return { ok: false, error: { code: "AGENT_PLAYIT_CONTROLS_UNSUPPORTED" } }; },
        },
        optional: ["ensureShareAccessState", "waitForPlayitRefreshToSettle", "renderPlayitTunnels", "renderPlayitTunnelsFromLegacySnapshot"],
        state: { shareAccessRefreshPromise: null, shareAccessRefreshStartedAt: 0, latestPlayitTunnels: [], playitTunnelMessage: null, playitTunnelList: null, latestPublicAccessSnapshot: scenario.prior },
        stubs: {
          Date: FakeDate,
          shouldBackOffAgentPolling: () => scenario.backoff,
          isPlayitEndpointUnsupported: () => true,
          // As markPublicAccessSnapshotUnavailable: keep a known snapshot, marked unavailable.
          renderPlayitUnavailable: () => {
            calls.push("render:unavailable");
            ctx.latestPublicAccessSnapshot = ctx.latestPublicAccessSnapshot ? { ...ctx.latestPublicAccessSnapshot, unavailable: true } : null;
          },
          renderPublicAccessSnapshot: (snapshot) => { calls.push("render:snapshot"); ctx.latestPublicAccessSnapshot = snapshot; },
          findInstanceForTunnel: () => null,
          getLegacyPlayitAccessFallback: () => null,
        },
      });
      const runFor = async (ms) => {
        for (let elapsed = 0; elapsed < ms; elapsed += 5000) {
          clock += 5000;
          const pending = ctx.ensureShareAccessState();
          if (pending) await pending;
        }
      };
      const count = (name) => calls.filter((entry) => entry === name).length;
      await runFor(120000);
      assert.strictEqual(ctx.isShareAccessStateLoaded(), false, `${label}: a snapshot that did not load leaves Checking... on screen`);
      const attempts = count("render:unavailable");
      // First attempt on the first tick, then at most one every 15 s: 8 in 2 minutes.
      assert(attempts >= 2 && attempts <= 8, `${label}: retried every 15 s, no faster (attempts: ${attempts})`);
      if (scenario.backoff) assert.strictEqual(count("snapshot"), 0, `${label}: no request is sent during the backoff`);
      // The Agent answers again: the next retry loads it and settles.
      scenario.failing = false;
      scenario.backoff = false;
      await runFor(15000);
      assert.strictEqual(ctx.isShareAccessStateLoaded(), true, `${label}: the snapshot loads on a retry and settles Checking...`);
      assert.strictEqual(ctx.latestPublicAccessSnapshot.unavailable, undefined, `${label}: a live snapshot is shown`);
      const settledAt = count("snapshot");
      await runFor(60000);
      assert.strictEqual(count("snapshot"), settledAt, `${label}: retries stop once settled`);
    }
  });

  // -------------------------------------------------------------------------
  // sharing-13 (review Q1): a failed test result survives the deferred rebuild
  // -------------------------------------------------------------------------
  await check("sharing-13", "Q1: a failed connection test is still shown after the Share dialog is rebuilt", async () => {
    const camel = (text) => text.replace(/^data-/, "").replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    let body = null;
    class FakeElement {
      constructor(tag) { this.tag = tag; this.children = []; this.parent = null; this.dataset = {}; this.className = ""; this.disabled = false; this.listeners = {}; this.ownText = ""; }
      get isConnected() { let node = this; while (node.parent) node = node.parent; return node === body; }
      get childNodes() { return this.children.slice(); }
      append(...kids) {
        for (let kid of kids) {
          if (kid == null) continue;
          if (typeof kid === "string") { const text = new FakeElement("#text"); text.ownText = kid; kid = text; }
          if (kid.parent) kid.remove();
          kid.parent = this;
          this.children.push(kid);
        }
      }
      replaceChildren(...kids) { this.children.forEach((child) => { child.parent = null; }); this.children = []; this.append(...kids); }
      remove() { if (this.parent) { this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; } }
      setAttribute() {}
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
      set textContent(value) { this.ownText = value; this.children = []; }
      get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(""); }
      *walk() { for (const child of this.children) { yield child; yield* child.walk(); } }
      matches(selector) {
        return selector.split(",").map((part) => part.trim()).some((part) => {
          const match = /^\[([a-z-]+)\](:disabled)?$/.exec(part);
          return Boolean(match) && camel(match[1]) in this.dataset && (!match[2] || this.disabled);
        });
      }
      querySelector(selector) { for (const node of this.walk()) if (node.matches(selector)) return node; return null; }
      closest() { return null; }
    }
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const cases = [
      ["the test request fails", { discarded: false, failure: "The connection test failed." }],
      ["the server changed while testing", { discarded: true, failure: "The server changed while testing. Try again." }],
      // Without a test in this dialog, the rebuilt one shows the cached result.
      ["no test in the dialog", { noTest: true, failure: "Every check that could run passed.Port: open" }],
    ];
    for (const [label, scenario] of cases) {
      body = new FakeElement("body");
      let activeModals = [];
      let accessLoaded = false;
      let finishRefresh = null;
      let finishTest = null;
      const timers = [];
      const instance = { id: "mc1", displayName: "MC" };
      const sandbox = makeAppSandbox({
        functions: ["getRecentShareConnectionTest", "renderShareConnectionTest", "runShareConnectionTest", "openShareServerModal", "isShareServerModalIdle"],
        state: { shareConnectionTests: new Map(), SHARE_CONNECTION_TEST_FRESH_MS: 5 * 60 * 1000 },
        stubs: {
          setTimeout: (fn) => { timers.push(fn); return timers.length; },
          window: {},
          document: {
            body,
            createElement: (tag) => new FakeElement(tag),
            querySelector: () => null,
            querySelectorAll: (selector) => (selector === '[data-modal-active="true"]' ? activeModals.slice() : []),
            addEventListener() {},
            removeEventListener() {},
          },
          showToast() {},
          findInstance: () => instance,
          createTextElement: (tag, text, className) => { const element = new FakeElement(tag); element.ownText = text; if (className) element.className = className; return element; },
          getShareServerAccessHealth: () => ({ status: "LOCAL_ONLY", nodeState: "connected", processState: "running", portState: "unknown" }),
          getShareServerAddresses: () => [],
          getRecommendedShareServerAddress: () => null,
          AnxShareHealth: {
            describeShareHealth: () => ({ tone: "warning", headline: "Only people on your network can join" }),
            explainDiagnostics: () => ({ rows: [{ label: "Port", stateLabel: "open", state: "healthy" }], firstFailure: null }),
          },
          createShareChecklist: () => new FakeElement("ul"),
          formatDateTime: () => "",
          getShareServerDiagnosticMessages: () => [],
          createShareServerAddressRow: () => new FakeElement("div"),
          createShareServerControls: () => null,
          getShareServerInstructions: () => [],
          openInstanceAccessManager() {},
          isShareAccessStateLoaded: () => accessLoaded,
          refreshShareAccessState: () => new Promise((resolve) => { finishRefresh = () => { accessLoaded = true; resolve(); }; }),
          activateModal: (overlay) => {
            overlay.dataset.modalActive = "true";
            activeModals.push(overlay);
            return () => { activeModals = activeModals.filter((entry) => entry !== overlay); };
          },
          getDesktopApi: () => ({
            connectivity: {
              runDiagnostics: () => new Promise((resolve, reject) => {
                finishTest = () => (scenario.discarded ? resolve({ ok: true, discarded: true }) : reject(new Error("diagnostics failed")));
              }),
            },
          }),
          getSelectedNodeId: () => "local",
          normalizeIpcErrorMessage: (message, fallback) => message || fallback,
          isDiscardedConnectivityResult: (result) => result?.discarded === true,
          getFriendlyErrorMessage: (error, fallback) => fallback,
        },
      });
      // An earlier success, still under five minutes old, is cached.
      sandbox.shareConnectionTests.set("mc1", { result: { ok: true }, at: Date.now() - 60000 });
      const resultOf = (overlay) => overlay.querySelector("[data-share-server-test-result]").textContent;
      sandbox.openShareServerModal(instance);
      const first = activeModals[0];
      assert(first.textContent.includes("Checking whether friends can join"), `${label}: the dialog opens while still checking`);
      if (scenario.noTest) {
        finishRefresh();
        await settle();
      } else {
        const button = first.querySelector("[data-share-server-test]");
        button.listeners.click[0]();
        assert.strictEqual(button.disabled, true, `${label}: the test is running`);
        finishRefresh();
        await settle();
        assert.strictEqual(activeModals[0], first, `${label}: no rebuild while the test runs`);
        finishTest();
        await settle();
        assert.strictEqual(resultOf(first), scenario.failure, `${label}: the failure is shown`);
        assert.strictEqual(button.disabled, false, `${label}: the Test button is enabled again`);
      }
      // The deferred rebuild's 500 ms poll now finds the dialog idle.
      while (timers.length) timers.shift()();
      await settle();
      assert.strictEqual(activeModals.length, 1, `${label}: one dialog is open`);
      const rebuilt = activeModals[0];
      assert.notStrictEqual(rebuilt, first, `${label}: the dialog was rebuilt with the loaded state`);
      assert.strictEqual(first.isConnected, false);
      assert(!rebuilt.textContent.includes("Checking whether friends can join"), `${label}: the rebuilt dialog gives the verdict`);
      assert.strictEqual(resultOf(rebuilt), scenario.failure, `${label}: the test result is kept, never cleared or replaced by an older success`);
    }
  });

  restorePlatform();
  Module._load = originalLoad;
  fs.rmSync(tempRoot, { recursive: true, force: true });

  const failed = results.filter((entry) => !entry.ok);
  for (const entry of results) {
    console.log(`${entry.ok ? "PASS" : "FAIL"} ${entry.id}: ${entry.name}`);
    if (!entry.ok) console.log(`     ${String(entry.error && entry.error.stack || entry.error).split("\n").slice(0, 4).join("\n     ")}`);
  }
  console.log(`sharing-fixes-smoke: ${results.length - failed.length}/${results.length} passed (${results.length} checks)`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// A renderer sandbox for refreshPlayitStatus and the Playit management refresh.
function makeRefreshSandbox({ page, calls, snapshotDelay, statusDelay, tunnelsDelay, api: apiOverrides = {}, state = {}, stubs = {}, optional = [] }) {
  const later = (ms, value, label) => new Promise((resolve) => setTimeout(() => { calls.push(label); resolve(value); }, ms));
  const api = {
    publicAccess: {
      getSnapshot: () => later(snapshotDelay, { providers: [], services: [] }, "snapshot"),
      getPlayitStatus: () => later(statusDelay, { ok: true, installed: false, serviceState: "missing" }, "status"),
      listPlayitTunnels: () => later(tunnelsDelay, { ok: false, code: "PLAYIT_NOT_INSTALLED", tunnels: [] }, "tunnels"),
      getPlayitAccount: () => later(1, { installed: false }, "account"),
      ...apiOverrides,
    },
  };
  return makeAppSandbox({
    functions: [
      "refreshPlayitStatus",
      "refreshPlayitManagement",
      "refreshPlayitAccount",
      "getNodeRequestContext",
      "isNodeRequestCurrent",
      "getNodeScopedPayload",
    ],
    optional: ["refreshShareAccessState", "isShareAccessStateLoaded", "queuePlayitTrailingRefresh", "runPlayitTrailingRefresh", "getShareAccessNodeKey", ...optional],
    state: {
      playitRequestInFlight: false,
      playitManagementPromise: null,
      playitTrailingRefresh: null,
      shareAccessSettledNodeKey: null,
      latestPlayitAccount: null,
      latestPublicAccessSnapshot: null,
      latestPlayitTunnelsLoaded: false,
      selectedNodeContextVersion: 1,
      nodeRequestSerials: new Map(),
      ...state,
    },
    stubs: {
      getDesktopApiState: () => ({ hasBridge: true, hasPublicAccess: true, hasPlayit: false, api }),
      getPublicAccessUnavailableReason: () => null,
      getSelectedNodeId: () => "node-1",
      getActivePageName: () => page,
      shouldBackOffAgentPolling: () => false,
      clearAgentPollingBackoff() {},
      recordAgentPollingFailure() {},
      getFriendlyStatusFailureMessage: (error, fallback) => fallback,
      renderPlayitUnavailable: () => { calls.push("render:unavailable"); },
      renderPublicAccessSnapshot: () => { calls.push("render:snapshot"); },
      refreshPublicAccessFirewall: async () => { calls.push("firewall"); },
      refreshPublicAccessReverseProxy: async () => { calls.push("reverse-proxy"); },
      renderPlayitServiceStatus: () => { calls.push("render:status"); },
      renderPlayitTunnels: () => { calls.push("render:tunnels"); },
      renderPlayitAccount() {},
      renderPlayitSnapshot() {},
      renderPublicAccessUnavailableState() {},
      isPlayitEndpointUnsupported: () => false,
      getPublicAccessRequestUnavailableReason: (error, message) => ({ code: "X", message }),
      renderPlayitServiceStatusFromLegacySnapshot() {},
      renderPlayitTunnelsFromLegacySnapshot() {},
      ...stubs,
    },
  });
}
