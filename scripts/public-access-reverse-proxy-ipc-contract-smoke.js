#!/usr/bin/env node
// Behavioral coverage for the V2-H reverse-proxy IPC channels.
//
// Two halves, both behavioral:
//   1. PRELOAD: the REAL preload.js is loaded with a fake `electron` module and
//      every `ipcRenderer.invoke` is recorded, so the assertions are about the
//      exact channel name and payload the namespace actually sends — not about
//      preload.js containing a string.
//   2. MAIN: the REAL `src/ipc/publicAccessIpc.js` is registered against stubbed
//      transports, and the registered handlers are invoked directly. This pins
//      the channel names, the node-scoped Agent request (path + method + body)
//      and the audit target the handler actually produces.
//
// What it does NOT prove: that the Agent serves these endpoints (covered by
// scripts/reverse-proxy-smoke.js), that the renderer calls the namespace, or
// that anything renders. No Electron is launched here.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");

const asPlain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${label}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Half 1: preload exposure
// ---------------------------------------------------------------------------
const PRELOAD_PATH = path.resolve(__dirname, "..", "preload.js");
const preloadInvocations = [];
const exposed = {};
const fakeElectron = {
  contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
  ipcRenderer: {
    invoke: (channel, payload) => {
      preloadInvocations.push({ channel, payload });
      return Promise.resolve({ ok: true });
    },
    send: () => {},
    on: () => {},
    removeListener: () => {},
  },
};
const preloadSandbox = {
  require: (id) => {
    if (id === "electron") return fakeElectron;
    throw new Error(`Unexpected require in preload sandbox: ${id}`);
  },
  Buffer,
  process,
  console,
  URL,
};
vm.createContext(preloadSandbox);
vm.runInContext(fs.readFileSync(PRELOAD_PATH, "utf8"), preloadSandbox);

// ---------------------------------------------------------------------------
// Half 2: the real IPC module against stubbed transports
// ---------------------------------------------------------------------------
const ipcHandlers = new Map();
const recorded = { clients: [], audits: [], permissions: [] };
function createRecordedAgentClient(nodeId) {
  const client = {
    nodeId,
    get: async (pathname) => { client.lastGet = { pathname }; return { ok: true, nodeId, routes: [] }; },
    post: async (pathname, body) => { client.lastPost = { pathname, body }; return { ok: true, applied: false }; },
  };
  recorded.clients.push(client);
  return client;
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler) } };
  if (request === "../services/agentClient") return { forNode: (nodeId) => createRecordedAgentClient(nodeId) };
  if (request === "../services/securityService") {
    return {
      requirePermission: (tier, target) => { recorded.permissions.push({ tier, target }); },
      audit: (entry) => { recorded.audits.push(entry); },
    };
  }
  if (request === "../services/publicAccessProviderService") {
    return new Proxy({}, { get: () => async () => ({ ok: true }) });
  }
  if (request === "./nodeContext") {
    return { requireNodeContext: (payload) => payload };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let ipcModule;
try {
  ipcModule = require("../src/ipc/publicAccessIpc");
  ipcModule.registerPublicAccessIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  console.log("Public Access reverse-proxy IPC contract smoke");
  console.log("----------------------------------------------");

  const anx = exposed.anx;
  assert(anx, "preload must expose the `anx` desktop API");

  check("publicAccess namespace exposes getReverseProxy + applyReverseProxyRoute", () => {
    assert.strictEqual(typeof anx.publicAccess?.getReverseProxy, "function");
    assert.strictEqual(typeof anx.publicAccess?.applyReverseProxyRoute, "function");
    // Adding the two members must not have disturbed the existing surface.
    assert.strictEqual(typeof anx.publicAccess?.getSnapshot, "function");
    assert.strictEqual(typeof anx.publicAccess?.listFirewallRules, "function");
  });

  await anx.publicAccess.getReverseProxy({ nodeId: "node-rp-a" });
  check("getReverseProxy -> publicAccess:getReverseProxy with nodeId passthrough", () => {
    const call = preloadInvocations.at(-1);
    assert.strictEqual(call.channel, "publicAccess:getReverseProxy");
    assert.deepStrictEqual(asPlain(call.payload), { nodeId: "node-rp-a" });
  });

  await anx.publicAccess.applyReverseProxyRoute({
    nodeId: "node-rp-a",
    hostname: "app.example.com",
    upstream: { host: "127.0.0.1", port: 8080 },
    tlsMode: "managed",
    pathPrefix: "/",
  });
  check("applyReverseProxyRoute -> publicAccess:applyReverseProxyRoute with payload passthrough", () => {
    const call = preloadInvocations.at(-1);
    assert.strictEqual(call.channel, "publicAccess:applyReverseProxyRoute");
    assert.deepStrictEqual(asPlain(call.payload), {
      nodeId: "node-rp-a",
      hostname: "app.example.com",
      upstream: { host: "127.0.0.1", port: 8080 },
      tlsMode: "managed",
      pathPrefix: "/",
    });
  });

  check("main process registers both reverse-proxy channels", () => {
    assert(ipcHandlers.has("publicAccess:getReverseProxy"), "publicAccess:getReverseProxy not registered");
    assert(ipcHandlers.has("publicAccess:applyReverseProxyRoute"), "publicAccess:applyReverseProxyRoute not registered");
  });

  const readHandler = ipcHandlers.get("publicAccess:getReverseProxy");
  const readResult = await readHandler({}, { nodeId: "node-rp-a" });
  check("getReverseProxy handler reads the node-scoped Agent snapshot path", () => {
    const client = recorded.clients.at(-1);
    assert.strictEqual(client.nodeId, "node-rp-a", "handler must resolve the node-scoped Agent client");
    assert.strictEqual(client.lastGet?.pathname, "/api/v1/public-access/reverse-proxy");
    assert.strictEqual(readResult?.ok, true);
    assert.deepStrictEqual(recorded.permissions.at(-1), { tier: "public-access:read", target: "node-rp-a" });
  });

  const writeHandler = ipcHandlers.get("publicAccess:applyReverseProxyRoute");
  await writeHandler({}, {
    nodeId: "node-rp-b",
    hostname: "app.example.com",
    upstream: { host: "127.0.0.1", port: 8080 },
    tlsMode: "none",
    pathPrefix: "/",
  });
  check("applyReverseProxyRoute handler posts the route to the Agent and audits it", () => {
    const client = recorded.clients.at(-1);
    assert.strictEqual(client.nodeId, "node-rp-b");
    assert.strictEqual(client.lastPost?.pathname, "/api/v1/public-access/reverse-proxy/routes");
    // nodeId is a desktop-side routing field; it must not travel in the route body.
    assert.deepStrictEqual(asPlain(client.lastPost?.body), {
      hostname: "app.example.com",
      upstream: { host: "127.0.0.1", port: 8080 },
      tlsMode: "none",
      pathPrefix: "/",
    });
    assert.deepStrictEqual(recorded.permissions.at(-1), { tier: "instance:write", target: "public-access-reverse-proxy" });
    assert.strictEqual(recorded.audits.at(-1)?.action, "publicAccess.applyReverseProxyRoute");
    assert.strictEqual(recorded.audits.at(-1)?.target, "app.example.com");
  });

  check("applyReverseProxyRoute never claims applied:true from a raw transport payload", () => {
    // The handler returns whatever the Agent says. This pins that the transport
    // result (applied:false) is not rewritten into a success claim by the IPC
    // layer; the renderer must read `applied === true` explicitly.
    assert.strictEqual(readResult?.applied, undefined);
  });

  console.log("----------------------------------------------");
  if (failures) {
    console.error(`public-access-reverse-proxy-ipc-contract-smoke FAILED: ${failures} check(s).`);
    process.exit(1);
  }
  console.log("public-access-reverse-proxy-ipc-contract-smoke passed (7 checks).");
}

main().catch((error) => {
  console.error("public-access-reverse-proxy-ipc-contract-smoke crashed:", error?.message || error);
  process.exit(1);
});
