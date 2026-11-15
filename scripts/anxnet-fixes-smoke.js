#!/usr/bin/env node
"use strict";

// Regression checks for the AnxNet fixes (gateway link, route reopen,
// startup republish, coordinator addresses, control-line decoder, panel
// redraw). Real TLS/TCP sockets on loopback only (ephemeral ports, temp data
// folders); the desktop service runs in-process with a temp config folder
// and a stubbed nodeService; the renderer panel runs in a vm with a small
// DOM stub. Nothing here talks to a real Agent, service or other host.
//   F1 anxnet-1   one connect per gateway link: start() then publish() opens
//                 the route once, the link settles, no re-register loop
//   F2 anxnet-2   routes the gateway drops (edge restart, grant expiry) are
//                 reopened; grants are renewed before they expire
//   F3 anxnet-3   a failed reopen at startup keeps the saved route, reports
//                 it in status(), and retries until the gateway is back
//   F4 anxnet-4   the panel's refresh keeps a focused edge field and restores
//                 unsaved edge form values after a redraw
//   F5 anxnet-5   coordinator addresses follow the owner: invites use the
//                 current address and members learn new ones from the roster
//   F6 anxnet-6   the control-line reader decodes whole lines from bytes
//   F7 visual-sharing-3  the 5 s tick doesn't erase a focused edge field
//   F8 R9         a route request that times out while the gateway link
//                 stays up is asked for again (not hidden until a reconnect)
//   F9 R10        turning Anyone can join off removes a route the node
//                 reopened under a new id while the gateway is down
//   F10 R11       a member that was disconnected when the owner moved
//                 reconnects to the owner's new address
//   F11 Q4        a member whose coordinator link was left half-open (the
//                 owner's address vanished, no FIN) drops it when the moved
//                 owner tells it the new address, and reconnects; both ends
//                 of the link use TCP keepalive
//   F12 Q4        an owner whose address changes while running still tells a
//                 member on a pre-move half-open link; a member whose link
//                 works keeps it
//   F13 R3-review a member the owner cannot dial, whose link works, re-registers
//                 when the roster moves the coordinator, which clears the
//                 owner's notice instead of a peer dial retried for ever
//   F14 R4-review the same on an older build (no re-register): the owner stops
//                 after a bounded number of dials while the link stays open
// Run: node scripts/anxnet-fixes-smoke.js

const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const vm = require("vm");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxnet-fixes-smoke-"));
// The desktop service reads its config folder from these; keep them in the temp folder.
for (const key of ["ANXHUB_CONFIG_DIR", "ANXOS_CONFIG_DIR", "ANXOS_LOG_DIR"]) process.env[key] = path.join(root, key);

const { AnxNetNode, fileStore } = require("../src/anxnet/node");
const { AnxNetEdge } = require("../src/anxnet/edge");
const roster = require("../src/anxnet/roster");
const { jsonLineReader } = require("../src/anxnet/frames");

const nodes = [];
const edges = [];
const servers = [];
let checks = 0;
const failures = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function check(label, work) {
  try {
    await work();
    checks += 1;
    console.log(`PASS ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`FAIL ${label}\n     ${error && (error.stack || error.message || error)}`);
  }
}

async function waitFor(test, timeoutMs = 8000, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let value = false;
    try { value = await test(); } catch { value = false; }
    if (value) return value;
    if (Date.now() > end) return false;
    await delay(stepMs);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

async function echoServer() {
  const server = net.createServer((socket) => { socket.on("error", () => {}); socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from("echo:"), data]))); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return server;
}

// A plain TCP client (a player without AnxNet) through a public port.
function playerReaches(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    const done = (ok) => { clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => done(false), 3000);
    socket.on("connect", () => socket.write("hi"));
    socket.on("data", (chunk) => { data += chunk; if (data.includes("echo:hi")) done(true); });
    socket.on("error", () => done(false));
    socket.on("close", () => done(false));
  });
}

async function makeNode(name, options = {}) {
  const node = new AnxNetNode({ dataDir: path.join(root, name), deviceName: name, listenHost: "127.0.0.1", dnsPort: 0, enableDns: false, enableForwards: false, ...options });
  nodes.push(node);
  await node.start();
  return node;
}

async function makeEdge(name, owner, { port = 0, gateway = {}, ...extra } = {}) {
  const low = gateway.low || await freePort();
  const edge = new AnxNetEdge({
    keyStore: fileStore(path.join(root, `${name}.key`)),
    listenHost: "127.0.0.1",
    port,
    networks: [{ networkId: owner.networkId, ownerPublicKey: owner.ownerPublicKey }],
    relay: { enabled: false },
    gateway: { enabled: true, bindHost: "127.0.0.1", publicHost: "127.0.0.1", portRange: [low, low + 9], ...gateway },
    ...extra,
  });
  edges.push(edge);
  const info = await edge.start();
  return { edge, info, low };
}

function countRegistrations(edge) {
  const counter = { count: 0 };
  const original = edge.onHello.bind(edge);
  edge.onHello = (socket, peer, hello) => { if (hello.t === "gateway-register") counter.count += 1; return original(socket, peer, hello); };
  return counter;
}

// Owner + gateway + one shared echo service, gateway link connected.
async function gatewaySetup(name, edgeOptions = {}) {
  const owner = await makeNode(`${name}-owner`);
  await owner.createNetwork({ deviceName: "Desktop" });
  const ids = { networkId: owner.doc.networkId, ownerPublicKey: owner.doc.owner.publicKey };
  const { edge, info, low } = await makeEdge(`${name}-edge`, ids, edgeOptions);
  const game = await echoServer();
  await owner.setEdges({ relays: [], gateways: [{ host: "127.0.0.1", port: info.port, fingerprint: info.fingerprint }] });
  const service = await owner.shareService({ name: "Game", port: 25565, protocol: "tcp", targetHost: "127.0.0.1", targetPort: game.address().port });
  const key = `gateway:127.0.0.1:${info.port}`;
  assert(await waitFor(() => owner.edgeLinks.get(key)?.state === "connected"), "gateway link connects");
  return { owner, edge, info, low, service, key, ids };
}

function grantFor(owner, ctx, extra = {}) {
  return owner.signGatewayGrant({ serviceId: ctx.service.serviceId, protocol: "tcp", gatewayFingerprint: ctx.info.fingerprint, ...extra });
}

// ---- F1 ----------------------------------------------------------------------------------

async function checkGatewayLinkOneConnect() {
  const ctx = await gatewaySetup("f1", { gateway: { hostGraceMs: 500 } });
  const counter = countRegistrations(ctx.edge);
  await ctx.owner.stop();
  await delay(200);
  counter.count = 0;
  // A fresh node (reboot, host respawn): start() opens the gateway link in
  // the background and republish runs right after it.
  const owner = await makeNode("f1-owner");
  const gateway = owner.doc.gateways[0];
  const route = await owner.publish({ gateway, ...grantFor(owner, ctx) });
  assert(route.publicPort, "publish resolves with a public port");
  await delay(1500);
  const settled = counter.count;
  await delay(1500);
  assert(counter.count <= 2, `the node registered ${counter.count} times (expected 1, at most 2)`);
  assert.strictEqual(counter.count, settled, `registrations kept growing (${settled} -> ${counter.count})`);
  const link = owner.edgeLinks.get(ctx.key);
  assert.strictEqual(link.state, "connected", "the gateway link stays connected");
  assert(link.socket && !link.socket.destroyed, "the link has a live socket");
  assert.strictEqual(ctx.edge.status().routes.length, owner.status().publicRoutes.length, "edge and node agree on the routes");
  assert(await playerReaches(route.publicPort), "a player reaches the game through the public port");

  // Concurrent connects on one link make one registration.
  await owner.stop();
  await delay(200);
  counter.count = 0;
  const again = await makeNode("f1-owner");
  await Promise.allSettled([again.openEdgeLink(ctx.key, gateway, "gateway-register"), again.openEdgeLink(ctx.key, gateway, "gateway-register")]);
  await delay(1500);
  assert.strictEqual(counter.count, 1, `three concurrent connects (start + 2) registered ${counter.count} times`);
  assert.strictEqual(again.edgeLinks.get(ctx.key).state, "connected");
}

// ---- F2 ----------------------------------------------------------------------------------

async function liveRouteReachable(owner, serviceId) {
  const route = owner.status().publicRoutes.find((entry) => entry.serviceId === serviceId);
  return Boolean(route && (await playerReaches(route.publicPort)));
}

async function checkDroppedRoutesReopen() {
  // Edge restart (VPS reboot or update): its routes lived only in memory.
  const a = await gatewaySetup("f2a");
  const first = await a.owner.publish({ gateway: a.owner.doc.gateways[0], ...grantFor(a.owner, a) });
  assert(await playerReaches(first.publicPort), "route works before the restart");
  await a.edge.stop();
  assert(await waitFor(() => a.owner.status().publicRoutes.length === 0, 3000, 50), "a route isn't listed as public while its gateway is down");
  const { edge: restarted } = await makeEdge("f2a-edge", a.ids, { port: a.info.port, gateway: { low: a.low } });
  assert(await waitFor(() => restarted.status().routes.length === 1, 8000), "the node reopens its route on the restarted gateway");
  assert(await waitFor(() => liveRouteReachable(a.owner, a.service.serviceId), 6000, 300), "the listed public route reaches the game after a gateway restart");

  // Grant expiry: the gateway closes the route and tells the host, which
  // reopens it with a fresh grant.
  const b = await gatewaySetup("f2b", { grantSweepMs: 200 });
  const shortLived = await b.owner.publish({ gateway: b.owner.doc.gateways[0], ...grantFor(b.owner, b, { ttlMs: 1500 }) });
  assert(await playerReaches(shortLived.publicPort), "route works before the grant expires");
  await delay(2500);
  assert(await waitFor(() => liveRouteReachable(b.owner, b.service.serviceId), 4000, 300), "the listed public route reaches the game after its grant expired");
  const reopened = b.edge.status().routes;
  assert.strictEqual(reopened.length, 1, "exactly one route at the gateway");

  // Renewal before expiry keeps the same route (no dropped players). The
  // clock is passed in: 90 minutes into a 2-hour grant.
  const c = await gatewaySetup("f2c");
  const renewing = await c.owner.publish({ gateway: c.owner.doc.gateways[0], ...grantFor(c.owner, c, { ttlMs: 2 * 60 * 60 * 1000 }) });
  assert.strictEqual(typeof c.owner.renewGatewayGrants, "function", "the node renews gateway grants");
  // A player whose connection is spliced through to the game (an echo back
  // proves it), not one still waiting for the host to accept.
  const player = net.connect(renewing.publicPort, "127.0.0.1");
  player.on("error", () => {});
  let echoed = "";
  player.on("data", (chunk) => { echoed += chunk; });
  await new Promise((resolve) => player.once("connect", resolve));
  player.write("before");
  assert(await waitFor(() => echoed.includes("echo:before"), 3000, 50), "the player reaches the game before the renewal");
  await c.owner.renewGatewayGrants(Date.now() + 30 * 60 * 1000);
  const notYet = [...c.edge.routes.values()][0];
  assert(Date.parse(notYet.grant.expiresAt) - Date.now() < 3 * 60 * 60 * 1000, "a grant with most of its time left isn't renewed");
  await c.owner.renewGatewayGrants(Date.now() + 90 * 60 * 1000);
  const edgeRoute = [...c.edge.routes.values()][0];
  assert(edgeRoute && edgeRoute.routeId === renewing.routeId, "the renewed route keeps its id");
  assert(Date.parse(edgeRoute.grant.expiresAt) - Date.now() > 24 * 60 * 60 * 1000, "the gateway holds the renewed grant");
  assert(!player.destroyed, "a connected player stays connected through the renewal");
  player.write("after");
  assert(await waitFor(() => echoed.includes("echo:after"), 3000, 50), "the player still reaches the game after the renewal");
  player.destroy();
}

// ---- F3 ----------------------------------------------------------------------------------

// The desktop service in-process (in-app backend), with nodeService stubbed.
function loadDesktopService() {
  const nodeServicePath = require.resolve("../src/services/nodeService.js");
  require.cache[nodeServicePath] = { id: nodeServicePath, filename: nodeServicePath, loaded: true, exports: { getAllNodesSync: () => [], getNode: () => null } };
  const service = require("../src/services/anxnetService.js");
  const dataDir = service.dataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const settingsFile = path.join(dataDir, "anxnet-settings.json");
  if (!fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify({ backgroundService: false, listenHost: "127.0.0.1", listenPort: 0, dnsPort: 0 }));
  const savedRoutes = () => JSON.parse(fs.readFileSync(settingsFile, "utf8")).publicRoutes || {};
  return { service, dataDir, savedRoutes };
}

async function checkRepublishFailureKeepsRoute() {
  const { service, dataDir, savedRoutes } = loadDesktopService();
  try {
    await service.createNetwork({ name: "anx-fixes33" });
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, "anxnet-state.json"), "utf8"));
    const ids = { networkId: state.network.networkId, ownerPublicKey: state.network.ownerPublicKey };
    const { edge, info, low } = await makeEdge("f3-edge", ids);
    await service.setEdges({ relays: [], gateways: [{ host: "127.0.0.1", port: info.port, fingerprint: info.fingerprint }] });
    assert(await waitFor(async () => (await service.status()).edgeLinks?.some((link) => link.state === "connected")), "gateway link connects");
    const game = await echoServer();
    const { service: shared } = await service.shareService({ name: "Game", port: game.address().port, protocol: "tcp", targetPort: game.address().port });
    await service.publishService({ serviceId: shared.serviceId });
    assert.strictEqual(Object.values(savedRoutes()).filter((route) => route.serviceId === shared.serviceId).length, 1, "the route is saved");

    // Restart while the gateway is down.
    await service.shutdown();
    await edge.stop();
    await service.resume();
    assert.strictEqual(Object.values(savedRoutes()).filter((route) => route.serviceId === shared.serviceId).length, 1, "the saved route survives a failed reopen");
    const failed = await service.status();
    const reported = (failed.publicRouteErrors || []).find((entry) => entry.serviceId === shared.serviceId);
    assert(reported && reported.message, "status() reports the route that couldn't be reopened");

    // The gateway comes back: AnxOS reopens the route by itself.
    await makeEdge("f3-edge", ids, { port: info.port, gateway: { low } });
    assert(await waitFor(async () => ((await service.status()).publicRoutes || []).some((route) => route.serviceId === shared.serviceId), 12000, 250), "the route is reopened once the gateway is back");
    assert.strictEqual(((await service.status()).publicRouteErrors || []).length, 0, "the error clears after the reopen");
  } finally {
    await service.shutdown().catch(() => {});
  }
}

// ---- F4 / F7: renderer panel in a vm -------------------------------------------------------

class FakeElement {
  constructor(document, tag) {
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.className = "";
    this.ownText = "";
    this.value = "";
    this.checked = false;
    this.placeholder = "";
    this.type = tag === "input" ? "text" : "";
    this.disabled = false;
    this.title = "";
    this.listeners = {};
  }

  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(""); }
  get open() { return "open" in this.attrs; }
  set open(value) { if (value) this.attrs.open = ""; else delete this.attrs.open; }
  append(...items) {
    for (const item of items) {
      const node = typeof item === "string" ? Object.assign(new FakeElement(this.ownerDocument, "#text"), { ownText: item }) : item;
      if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...items) { for (const child of this.children) child.parent = null; this.children = []; this.append(...items); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return key in this.attrs ? this.attrs[key] : null; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  removeEventListener(type, handler) { this.listeners[type] = (this.listeners[type] || []).filter((entry) => entry !== handler); }
  fire(type) { const event = { type, target: this, preventDefault() {} }; for (const handler of this.listeners[type] || []) handler(event); }
  requestSubmit() { this.fire("submit"); }
  click() { this.fire("click"); }
  matches(selector) {
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    const attribute = /^\[([\w-]+)\]$/.exec(selector);
    if (attribute) return attribute[1] in this.attrs;
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) { for (let node = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
  querySelector(selector) { for (const child of this.children) { if (child.matches(selector)) return child; const found = child.querySelector(selector); if (found) return found; } return null; }
  all(test, out = []) { for (const child of this.children) { if (test(child)) out.push(child); child.all(test, out); } return out; }
  contains(node) { for (let current = node; current; current = current.parent) if (current === this) return true; return false; }
  focus() { this.ownerDocument.focused = this; }
  blur() { if (this.ownerDocument.focused === this) this.ownerDocument.focused = null; }
}

function loadPanel(statusValue, { setEdges } = {}) {
  const document = {
    hidden: false,
    focused: null,
    // As in a browser: a detached element loses focus to <body>.
    get activeElement() { return this.focused && this.body.contains(this.focused) ? this.focused : this.body; },
    createElement: (tag) => new FakeElement(document, tag),
    querySelector: (selector) => (panel.matches(selector) ? panel : document.body.querySelector(selector)),
    addEventListener() {},
  };
  document.body = new FakeElement(document, "body");
  const panel = new FakeElement(document, "section");
  panel.setAttribute("data-anxnet-panel", "");
  document.body.append(panel);
  const state = { status: statusValue, tick: null, saved: [] };
  const anxnet = {
    status: async () => JSON.parse(JSON.stringify(state.status)),
    dnsStatus: async () => ({ available: false, reason: "n/a" }),
    setEdges: setEdges || (async (edgesInput) => { state.saved.push(edgesInput); return { ok: true }; }),
  };
  const window = { setInterval: (handler) => { state.tick = handler; return 1; } };
  const context = { window, document, console, getDesktopApiState: () => ({ api: { anxnet } }), nodesState: { nodes: [] }, showToast() {}, getActivePageName: () => "nodes", navigator: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "anxnetPanel.js"), "utf8"), context);
  const edgeInputs = () => panel.all((node) => node.tagName === "INPUT" && node.closest(".anxnet-edges"));
  return { ui: window.AnxNetUi, panel, document, state, edgeInputs };
}

function ownerStatus() {
  return {
    network: { name: "anx-test", domain: "anx-test.internal", role: "owner", relays: [], gateways: [] },
    devices: [{ self: true, name: "pc", hostname: "pc.anx-test.internal", connection: "self", address: "100.64.0.1", deviceId: "d1" }],
    services: [],
    pending: [],
    invites: [],
    deviceId: "d1",
    fingerprint: "SHA256:x",
    settings: {},
    mode: "in-app",
  };
}

const FINGERPRINT = "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";

async function checkPanelKeepsEdgeDraft() {
  const view = loadPanel(ownerStatus());
  await delay(20);
  view.panel.querySelector(".anxnet-advanced").setAttribute("open", "");
  let [host, port, fingerprint, relayBox, gatewayBox] = view.edgeInputs();
  assert(host && gatewayBox, "the edge form is rendered");
  host.value = "edge.example.net"; host.fire("input");
  port.value = "47701"; port.fire("input");
  fingerprint.value = FINGERPRINT; fingerprint.fire("input");
  relayBox.checked = true; relayBox.fire("change");
  gatewayBox.checked = true; gatewayBox.fire("change");
  host.focus();
  await view.ui.refresh();
  assert(view.panel.contains(host), "the focused host field is not replaced by a refresh");
  assert.strictEqual(host.value, "edge.example.net");
  assert.strictEqual(view.document.activeElement, host, "focus stays in the host field");

  // Focus on a checkbox (or nowhere): the panel may redraw, but the
  // unsaved values come back.
  relayBox.focus();
  await view.ui.refresh();
  [host, port, fingerprint, relayBox, gatewayBox] = view.edgeInputs();
  assert.strictEqual(host.value, "edge.example.net", "host survives a redraw");
  assert.strictEqual(String(port.value), "47701", "port survives a redraw");
  assert.strictEqual(fingerprint.value, FINGERPRINT, "fingerprint survives a redraw");
  assert(relayBox.checked && gatewayBox.checked, "both checkboxes survive a redraw");
  view.document.focused = null;
  await view.ui.refresh();
  [host] = view.edgeInputs();
  assert.strictEqual(host.value, "edge.example.net", "host survives a redraw with nothing focused");

  // Save sends the draft and clears it.
  const form = view.panel.querySelector(".anxnet-edges");
  form.requestSubmit();
  await delay(20);
  assert.strictEqual(view.state.saved.length, 1, "Save calls setEdges");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(view.state.saved[0])), { relays: [{ host: "edge.example.net", port: 47701, fingerprint: FINGERPRINT }], gateways: [{ host: "edge.example.net", port: 47701, fingerprint: FINGERPRINT }] });
  view.state.status.network.relays = [{ host: "saved.example.net", port: 47700, fingerprint: FINGERPRINT }];
  await view.ui.refresh();
  [host] = view.edgeInputs();
  assert.strictEqual(host.value, "saved.example.net", "after Save the form shows the saved edge again");

  // The setup invite field (it has a placeholder) is still protected.
  view.state.status = { network: null, settings: {} };
  await view.ui.refresh();
  const join = view.panel.all((node) => node.tagName === "INPUT")[0];
  join.value = "anx1.partial"; join.focus();
  await view.ui.refresh();
  assert(view.panel.contains(join) && join.value === "anx1.partial", "the invite field is still protected");
}

async function checkTickKeepsFocusedField() {
  const view = loadPanel(ownerStatus());
  await delay(20);
  assert.strictEqual(typeof view.state.tick, "function", "the panel polls");
  view.panel.querySelector(".anxnet-advanced").setAttribute("open", "");
  const fingerprint = view.edgeInputs()[2];
  fingerprint.focus();
  fingerprint.value = "SHA256:abcdefghij"; fingerprint.fire("input");
  for (let round = 0; round < 2; round += 1) { view.state.tick(); await delay(20); }
  assert(view.panel.contains(fingerprint), "the focused fingerprint field is still in the panel after the 5 s ticks");
  assert.strictEqual(view.document.activeElement, fingerprint, "it is still focused");
  assert.strictEqual(fingerprint.value, "SHA256:abcdefghij", "it still holds what was typed");
  assert(view.panel.querySelector(".anxnet-advanced").open, "the details stay open");
}

// ---- F5 ----------------------------------------------------------------------------------

async function checkCoordinatorAddressesFollowOwner() {
  const owner = await makeNode("f5-owner", { listenHost: "127.0.0.1" });
  await owner.createNetwork({ deviceName: "Desktop" });
  const member = await makeNode("f5-member");
  await member.joinNetwork(owner.createInvite({ preApproved: true }).code);
  assert(await waitFor(() => member.status().network.coordinator.state === "connected"), "member connects");
  await owner.stop();
  nodes.splice(nodes.indexOf(owner), 1);

  // The owner's address changed (new DHCP lease, Wi-Fi -> Ethernet).
  const moved = await makeNode("f5-owner", { listenHost: "127.0.0.2" });
  const invite = roster.decodeInviteCode(moved.createInvite({ preApproved: true }).code);
  assert.deepStrictEqual(invite.coordinator.map((entry) => entry.host), ["127.0.0.2"], `a new invite points at ${invite.coordinator.map((entry) => `${entry.host}:${entry.port}`).join(", ")}`);
  assert.strictEqual(invite.coordinator[0].port, moved.server.address().port, "the invite carries the current port");
  const newcomer = await makeNode("f5-newcomer");
  await newcomer.joinNetwork(moved.createInvite({ preApproved: true }).code);
  assert(await waitFor(() => newcomer.status().network.coordinator.state === "connected"), "a device joins with the new invite");

  // While running, a changed address reaches connected members in the roster.
  assert.strictEqual(typeof moved.refreshOwnerEndpoints, "function", "the owner refreshes its endpoints");
  moved.options.advertiseHosts = ["127.0.0.2", "localhost"];
  await moved.refreshOwnerEndpoints();
  assert(await waitFor(() => newcomer.state.network.coordinator.some((entry) => entry.host === "localhost")), "a connected member learns the owner's new addresses");
  assert.deepStrictEqual(newcomer.state.network.coordinator.map((entry) => entry.host), ["127.0.0.2", "localhost"]);
}

// ---- F8 ----------------------------------------------------------------------------------

async function checkTimedOutRouteRequestRetries() {
  const ctx = await gatewaySetup("f8");
  await ctx.owner.publish({ gateway: ctx.owner.doc.gateways[0], ...grantFor(ctx.owner, ctx) });
  const link = ctx.owner.edgeLinks.get(ctx.key);
  const route = [...ctx.owner.gatewayRoutes.values()][0];
  // The gateway is slow to answer one route request while the link stays
  // up: that request's 10 s timeout is answered at once instead.
  const original = ctx.owner.edgeRequest.bind(ctx.owner);
  let timedOut = 0;
  ctx.owner.edgeRequest = (target, message, timeoutMs) => {
    if (message.t === "route" && timedOut === 0) { timedOut += 1; return Promise.resolve({ error: { code: "ANXNET_EDGE_TIMEOUT", message: "The edge didn't answer." } }); }
    return original(target, message, timeoutMs);
  };
  await ctx.owner.reopenGatewayRoute(link, route);
  assert.strictEqual(timedOut, 1, "one route request timed out");
  assert.strictEqual(link.state, "connected", "the gateway link is still up after the timeout");
  assert(await waitFor(() => liveRouteReachable(ctx.owner, ctx.service.serviceId), 6000, 200), "the route is asked for again and listed as public while the link stays up");
  assert.strictEqual(ctx.edge.status().routes.length, 1, "exactly one route at the gateway");
}

// ---- F9 ----------------------------------------------------------------------------------

async function checkTurnOffRemovesReopenedRoute() {
  const { service, dataDir, savedRoutes } = loadDesktopService();
  const linkConnected = async () => (await service.status()).edgeLinks?.some((link) => link.state === "connected");
  try {
    await service.leaveNetwork().catch(() => {}); // whatever an earlier check left
    await service.createNetwork({ name: "anx-fixes-r10" });
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, "anxnet-state.json"), "utf8"));
    const ids = { networkId: state.network.networkId, ownerPublicKey: state.network.ownerPublicKey };
    const { edge, info, low } = await makeEdge("f9-edge", ids);
    await service.setEdges({ relays: [], gateways: [{ host: "127.0.0.1", port: info.port, fingerprint: info.fingerprint }] });
    assert(await waitFor(linkConnected), "gateway link connects");
    const game = await echoServer();
    const { service: shared } = await service.shareService({ name: "Game", port: game.address().port, protocol: "tcp", targetPort: game.address().port });
    await service.publishService({ serviceId: shared.serviceId });
    const [storedId] = Object.keys(savedRoutes());
    assert(storedId, "the route is saved");

    // The gateway restarts: the node reopens the route under a new id, and
    // the saved settings still hold the old one.
    await edge.stop();
    const { edge: second } = await makeEdge("f9-edge", ids, { port: info.port, gateway: { low } });
    assert(await waitFor(() => second.status().routes.length === 1, 10000), "the node reopens its route on the restarted gateway");
    assert.notStrictEqual(second.status().routes[0].routeId, storedId, "the reopened route has a new id");

    // The gateway link drops again, and the owner turns Anyone can join off.
    await second.stop();
    assert(await waitFor(async () => ((await service.status()).publicRoutes || []).length === 0, 3000, 50), "the route isn't listed while the gateway is down");
    await service.unpublishService(shared.serviceId);
    assert.strictEqual(Object.keys(savedRoutes()).length, 0, "the setting is off");

    // The gateway comes back: the route the owner turned off stays closed.
    const { edge: third } = await makeEdge("f9-edge", ids, { port: info.port, gateway: { low } });
    assert(await waitFor(linkConnected, 20000, 200), "the gateway link reconnects");
    await delay(1500);
    assert.strictEqual(third.status().routes.length, 0, "the gateway didn't reopen the route the owner turned off");
    assert.strictEqual(((await service.status()).publicRoutes || []).length, 0, "no public route is listed");
  } finally {
    await service.shutdown().catch(() => {});
  }
}

// ---- F10 ---------------------------------------------------------------------------------

async function checkExistingMemberFollowsMovedOwner() {
  const port = await freePort();
  const owner = await makeNode("f10-owner", { listenHost: "127.0.0.1", listenPort: port });
  await owner.createNetwork({ deviceName: "Desktop" });
  const member = await makeNode("f10-member");
  await member.joinNetwork(owner.createInvite({ preApproved: true }).code);
  const memberId = member.identity.deviceId;
  assert(await waitFor(() => member.status().network.coordinator.state === "connected" && owner.endpoints.get(memberId)?.tcp?.length), "member connects and registers its address");
  await owner.stop();
  nodes.splice(nodes.indexOf(owner), 1);
  await delay(300);

  // The owner comes back at another address (new DHCP lease, other network).
  // The member was disconnected, so it never saw a roster with that address.
  const moved = await makeNode("f10-owner", { listenHost: "127.0.0.2", listenPort: port });
  const reconnected = await waitFor(() => member.status().network.coordinator.state === "connected" && moved.coordClients.has(memberId), 10000, 100);
  assert(reconnected, `the existing member reconnects to the moved owner (member: ${member.status().network.coordinator.state}, dials ${member.state.network.coordinator.map((entry) => `${entry.host}:${entry.port}`).join(", ")})`);
  assert.deepStrictEqual(member.state.network.coordinator.map((entry) => entry.host), ["127.0.0.2"], "the member saved the owner's new address");
}

// ---- F11 / F12 ---------------------------------------------------------------------------

// A loopback TCP proxy in front of the owner. freeze() makes the links open
// now stop forwarding without closing either side: what a member sees when
// the owner's address vanishes (no FIN can be sent from it). Later links
// forward normally.
async function freezableProxy(targetPort) {
  const pairs = [];
  const server = net.createServer((client) => {
    const pair = { client, upstream: net.connect(targetPort, "127.0.0.1"), frozen: false };
    pairs.push(pair);
    client.on("data", (data) => { if (!pair.frozen) pair.upstream.write(data); });
    pair.upstream.on("data", (data) => { if (!pair.frozen) client.write(data); });
    pair.upstream.on("close", () => { if (!pair.frozen) client.destroy(); });
    client.on("close", () => pair.upstream.destroy());
    client.on("error", () => {});
    pair.upstream.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return {
    port: server.address().port,
    freeze() { for (const pair of pairs) pair.frozen = true; },
    close() { for (const pair of pairs) { pair.client.destroy(); pair.upstream.destroy(); } server.close(); },
  };
}

// An owner that members reach only through the proxy.
async function ownerBehindProxy(name) {
  const port = await freePort();
  const proxy = await freezableProxy(port);
  const owner = await makeNode(name, { listenHost: "127.0.0.1", listenPort: port });
  owner.tcpEndpoints = () => [{ host: "127.0.0.1", port: proxy.port, udpPort: null }];
  await owner.createNetwork({ deviceName: "Desktop" });
  return { owner, port, proxy };
}

async function joinAndRegister(owner, name) {
  const member = await makeNode(name);
  await member.joinNetwork(owner.createInvite({ preApproved: true }).code);
  const memberId = member.identity.deviceId;
  assert(await waitFor(() => member.status().network.coordinator.state === "connected" && owner.coordClients.has(memberId) && owner.endpoints.get(memberId)?.tcp?.length), `${name} connects and registers its address`);
  return { member, memberId };
}

// Records the sockets that had TCP keepalive turned on (TLS sockets inherit
// net.Socket's setKeepAlive).
function spyKeepAlive() {
  const sockets = new WeakSet();
  const original = net.Socket.prototype.setKeepAlive;
  net.Socket.prototype.setKeepAlive = function setKeepAlive(enable, ...rest) {
    if (enable) sockets.add(this);
    return original.call(this, enable, ...rest);
  };
  return { sockets, restore() { net.Socket.prototype.setKeepAlive = original; } };
}

async function checkHalfOpenMemberFollowsRestartedOwner() {
  const keepAlive = spyKeepAlive();
  let proxy = null;
  try {
    const setup = await ownerBehindProxy("f11-owner");
    proxy = setup.proxy;
    const { member, memberId } = await joinAndRegister(setup.owner, "f11-member");
    // The owner's address vanishes and AnxOS restarts its node elsewhere. The
    // member's link is left half-open, so it still says "connected".
    proxy.freeze();
    await setup.owner.stop();
    nodes.splice(nodes.indexOf(setup.owner), 1);
    await delay(300);
    assert(member.coordinator.socket && member.status().network.coordinator.state === "connected", "the member still holds its half-open link");
    const moved = await makeNode("f11-owner", { listenHost: "127.0.0.2", listenPort: setup.port });
    const reconnected = await waitFor(() => moved.coordClients.has(memberId) && member.status().network.coordinator.state === "connected" && member.coordinator.socket?.remotePort === setup.port, 15000, 100);
    assert(reconnected, `the member drops its dead link and reconnects to the moved owner (member: ${member.status().network.coordinator.state}, saved ${member.state.network.coordinator.map((entry) => `${entry.host}:${entry.port}`).join(", ")}, owner notify entries ${moved.coordinatorNotify?.size})`);
    assert.deepStrictEqual(member.state.network.coordinator.map((entry) => entry.host), ["127.0.0.2"], "the member saved the owner's new address");
    // Both ends now notice a peer that vanishes without a FIN.
    assert(keepAlive.sockets.has(member.coordinator.socket), "the member's coordinator link has TCP keepalive");
    assert(keepAlive.sockets.has(moved.coordClients.get(memberId)), "the owner's side of the coordinator link has TCP keepalive");
  } finally {
    keepAlive.restore();
    proxy?.close();
  }
}

async function checkOwnerTellsHalfOpenMemberAfterMove() {
  const setup = await ownerBehindProxy("f12-owner");
  const { owner, port, proxy } = setup;
  try {
    const stale = await joinAndRegister(owner, "f12-stale");
    proxy.freeze(); // the stale member's link stops passing anything, both sides stay open
    const healthy = await joinAndRegister(owner, "f12-healthy");
    const healthySocket = healthy.member.coordinator.socket;

    // The owner's address changes while it keeps running (refreshOwnerEndpoints
    // on the 15 s tick). Its roster push to the stale member goes into the dead link.
    owner.tcpEndpoints = () => [{ host: "127.0.0.1", port, udpPort: null }];
    await owner.refreshOwnerEndpoints();
    assert(owner.coordClients.has(stale.memberId), "the owner still lists the stale member's old link");
    const reconnected = await waitFor(() => stale.member.coordinator.socket?.remotePort === port && stale.member.status().network.coordinator.state === "connected" && owner.coordClients.get(stale.memberId)?.remotePort === stale.member.coordinator.socket.localPort, 15000, 100);
    assert(reconnected, `the owner tells the member with a pre-move link where it is now, and the member reconnects (member: ${stale.member.status().network.coordinator.state}, saved ${stale.member.state.network.coordinator.map((entry) => `${entry.host}:${entry.port}`).join(", ")}, owner notify entries ${owner.coordinatorNotify?.size})`);
    assert.deepStrictEqual(stale.member.state.network.coordinator.map((entry) => `${entry.host}:${entry.port}`), [`127.0.0.1:${port}`], "the stale member saved the owner's new address");
    assert(await waitFor(() => !owner.coordinatorNotify?.size, 3000, 100), "no member is left to tell");
    // A member whose link still works learns the address from the roster and
    // keeps that link: it is not made to reconnect.
    assert.deepStrictEqual(healthy.member.state.network.coordinator.map((entry) => `${entry.host}:${entry.port}`), [`127.0.0.1:${port}`], "the healthy member learned the new address");
    assert.strictEqual(healthy.member.coordinator.socket, healthySocket, "the healthy member kept its working link");
    assert.strictEqual(healthy.member.status().network.coordinator.state, "connected");
  } finally {
    proxy.close();
  }
}

// A member whose coordinator link works, but which the owner cannot dial
// (NAT or an inbound firewall, no relay). When the owner gains an address,
// the member re-registers over its working link once the new roster arrives,
// and that answer clears the owner's notice: no peer dial retried for ever.
async function checkHealthyUndialableMemberClearsNotice() {
  const owner = await makeNode("f13-owner");
  await owner.createNetwork({ deviceName: "Desktop" });
  const { member, memberId } = await joinAndRegister(owner, "f13-member");
  const dead = await freePort();
  owner.endpoints.set(memberId, { tcp: [{ host: "127.0.0.1", port: dead }], seenAt: Date.now() });
  owner.state.memberEndpoints = { ...(owner.state.memberEndpoints || {}), [memberId]: [{ host: "127.0.0.1", port: dead }] };
  const socket = member.coordinator.socket;
  // A VPN, WSL or Hyper-V adapter appears; the old address keeps working.
  const original = owner.tcpEndpoints.bind(owner);
  owner.tcpEndpoints = () => [...original(), { host: "127.0.0.2", port: original()[0].port, udpPort: null }];
  await owner.refreshOwnerEndpoints();
  assert(await waitFor(() => member.state.network.coordinator.some((entry) => entry.host === "127.0.0.2"), 5000, 50), "the member learns the new address from the roster");
  const cleared = await waitFor(() => !owner.coordinatorNotify?.has(memberId), 5000, 50);
  assert(cleared, `the owner stops trying to reach a member whose link answered (entry: ${JSON.stringify(owner.coordinatorNotify?.get(memberId) || null)})`);
  // Later ticks dial nothing for it.
  for (let tick = 0; tick < 3; tick += 1) await owner.notifyMovedCoordinator(Date.now() + 1e9);
  assert(!owner.coordinatorNotify?.has(memberId), "no notice comes back on later ticks");
  assert.strictEqual(member.coordinator.socket, socket, "the member kept its working link");
  assert.strictEqual(member.status().network.coordinator.state, "connected");
}

// The same member on an older build, which never re-registers when a roster
// moves the coordinator. Its pre-move link stays open well past the time TCP
// keepalive would close a dead one, so after a bounded number of failed dials
// the owner stops. A member whose link is gone is still retried.
async function checkOldBuildMemberNoticeIsBounded() {
  const owner = await makeNode("f14-owner");
  await owner.createNetwork({ deviceName: "Desktop" });
  const { member, memberId } = await joinAndRegister(owner, "f14-member");
  member.onRosterFromCoordinator = function onRosterFromCoordinatorOldBuild(signed) {
    try { this.acceptRoster(signed); this.saveState(); this.applyRoster().then(() => this.emit("change")); } catch {}
  };
  const dead = await freePort();
  owner.endpoints.set(memberId, { tcp: [{ host: "127.0.0.1", port: dead }], seenAt: Date.now() });
  owner.state.memberEndpoints = { ...(owner.state.memberEndpoints || {}), [memberId]: [{ host: "127.0.0.1", port: dead }] };
  const original = owner.tcpEndpoints.bind(owner);
  owner.tcpEndpoints = () => [...original(), { host: "127.0.0.2", port: original()[0].port, udpPort: null }];
  await owner.refreshOwnerEndpoints();
  assert(await waitFor(() => member.state.network.coordinator.some((entry) => entry.host === "127.0.0.2"), 5000, 50), "the old-build member learns the new address from the roster");
  let ticks = 0;
  while (owner.coordinatorNotify?.has(memberId) && ticks < 12) {
    await owner.notifyMovedCoordinator(Date.now() + 1e9);
    ticks += 1;
  }
  assert(!owner.coordinatorNotify?.has(memberId), `the owner stops dialing a member whose pre-move link stays open (entry after ${ticks} ticks: ${JSON.stringify(owner.coordinatorNotify?.get(memberId) || null)})`);
  assert(owner.coordClients.has(memberId), "the member is still on its working link");

  // A member whose link is gone keeps being retried until it can be told.
  owner.markCoordinatorNotify(0);
  owner.coordClients.get(memberId).destroy();
  assert(await waitFor(() => !owner.coordClients.has(memberId), 3000, 20), "the owner sees the link close");
  member.stop?.();
  nodes.splice(nodes.indexOf(member), 1);
  for (let tick = 0; tick < 10; tick += 1) await owner.notifyMovedCoordinator(Date.now() + 1e9);
  assert(owner.coordinatorNotify?.has(memberId), "a disconnected member is still retried");
}

// ---- F6 ----------------------------------------------------------------------------------

async function checkLineReaderDecodesBytes() {
  const fakeStream = () => Object.assign(new EventEmitter(), { destroyed: false, destroy(cause) { this.destroyed = true; this.cause = cause; } });
  const message = { t: "roster", name: "サーバー 日本語 ✓", pad: "x".repeat(100) };
  const line = Buffer.from(`${JSON.stringify(message)}\n`);
  const split = line.indexOf(Buffer.from("日")) + 1; // inside the 3-byte character
  for (const cut of [split, split + 1]) {
    const stream = fakeStream();
    const received = [];
    jsonLineReader(stream, (value) => received.push(value));
    stream.emit("data", line.subarray(0, cut));
    stream.emit("data", line.subarray(cut));
    assert.strictEqual(received.length, 1);
    assert.deepStrictEqual(received[0], message, "a character split across chunks is decoded whole");
  }
  // Two lines in one chunk, and a line split over three chunks.
  const stream = fakeStream();
  const received = [];
  jsonLineReader(stream, (value) => received.push(value));
  const two = Buffer.from(`${JSON.stringify({ a: "é" })}\n${JSON.stringify({ b: "日本" })}\n`);
  stream.emit("data", two);
  const three = Buffer.from(`${JSON.stringify({ c: "😀" })}\n`);
  stream.emit("data", three.subarray(0, 8)); stream.emit("data", three.subarray(8, 9)); stream.emit("data", three.subarray(9));
  assert.deepStrictEqual(received, [{ a: "é" }, { b: "日本" }, { c: "😀" }]);
  // The limit counts bytes, not UTF-16 characters.
  const limited = fakeStream();
  jsonLineReader(limited, () => {}, { maxLineBytes: 200 });
  limited.emit("data", Buffer.from(`"${"日".repeat(100)}`)); // 301 bytes, 101 characters, no newline yet
  assert(limited.destroyed && limited.cause?.code === "ANXNET_CONTROL_TOO_LARGE", "a line over the byte limit is refused");
}

(async () => {
  await check("F1 anxnet-1 gateway link: start() then publish() connects once, no re-register loop, route reachable", checkGatewayLinkOneConnect);
  await check("F2 anxnet-2 dropped gateway routes are reopened (edge restart, grant expiry) and grants renew", checkDroppedRoutesReopen);
  await check("F3 anxnet-3 failed startup reopen keeps the saved route, reports it and retries", checkRepublishFailureKeepsRoute);
  await check("F4 anxnet-4 panel refresh keeps the focused edge field and restores unsaved edge values", checkPanelKeepsEdgeDraft);
  await check("F5 anxnet-5 invites use the owner's current address; members learn new addresses", checkCoordinatorAddressesFollowOwner);
  await check("F6 anxnet-6 control lines are decoded from bytes (UTF-8 across chunks, byte limit)", checkLineReaderDecodesBytes);
  await check("F7 visual-sharing-3 the 5 s tick doesn't erase a focused edge field", checkTickKeepsFocusedField);
  await check("F8 R9 a route request that times out while the gateway link stays up is retried", checkTimedOutRouteRequestRetries);
  await check("F9 R10 turning Anyone can join off removes a route reopened under a new id while the gateway is down", checkTurnOffRemovesReopenedRoute);
  await check("F10 R11 an existing member reconnects after the owner moves to a new address", checkExistingMemberFollowsMovedOwner);
  await check("F11 Q4 a member on a half-open link drops it when the restarted owner says it moved, and reconnects", checkHalfOpenMemberFollowsRestartedOwner);
  await check("F12 Q4 an owner that moves while running still tells a member whose old link is half-open", checkOwnerTellsHalfOpenMemberAfterMove);
  await check("F13 R3-review a member the owner cannot dial, on a working link, clears the move notice by re-registering", checkHealthyUndialableMemberClearsNotice);
  await check("F14 R4-review an older-build member on a working link is dialed a bounded number of times; a gone one is still retried", checkOldBuildMemberNoticeIsBounded);
  if (failures.length) {
    console.error(`AnxNet fixes smoke FAILED: ${failures.length} of ${failures.length + checks} checks (${failures.join("; ")}).`);
    process.exitCode = 1;
  } else {
    console.log(`AnxNet fixes smoke passed (${checks} checks). Real sockets on loopback; the panel runs in a vm DOM stub.`);
  }
})()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    // Bounded, so a socket left open can't keep the run from finishing.
    const settle = (work) => Promise.race([work.catch(() => {}), delay(3000)]);
    for (const node of nodes) await settle(node.stop());
    for (const edge of edges) await settle(edge.stop());
    for (const server of servers) server.close();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
  });
