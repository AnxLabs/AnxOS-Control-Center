"use strict";

// Route fallback (src/services/nodeRouteResolver.js) and Tailscale route
// suggestions (src/services/tailscaleRouteService.js), with scripted probes:
// no network access.
// Run: node scripts/node-route-fallback-smoke.js

const assert = require("assert");
const { createNodeRouteResolver } = require("../src/services/nodeRouteResolver");
const { _test: tailscale } = require("../src/services/tailscaleRouteService");
const { _test: nodeTest } = require("../src/services/nodeService");

const LAN = "http://192.168.1.134:47131";
const TS = "http://anxlab.tail6fda7f.ts.net:47131";
const DEVICE = "device-anxlab";

function anxlab(extra = {}) {
  return { id: "anxlab", kind: "agent", enabled: true, baseUrl: LAN, agentIdentity: { deviceId: DEVICE, hostname: "Anxlab" }, fallbackUrls: [{ url: TS, label: "Tailscale" }], ...extra };
}

async function main() {
  // R1: fallback URLs are validated so the token only travels on safe routes.
  const normalize = nodeTest.normalizeNodeFallbackUrls;
  assert.deepStrictEqual(normalize([TS, "http://100.89.98.89:47131", "https://agent.example.com"], LAN).map((entry) => entry.label), ["Tailscale", "Tailscale", "Fallback"]);
  assert.deepStrictEqual(normalize(["http://8.8.8.8:47131", "http://u:p@10.0.0.1:1", "ftp://10.0.0.1", LAN], LAN), [], "public http, credentials, other schemes and the main URL are refused");
  assert.strictEqual(normalize(["http://10.0.0.1:1", "http://10.0.0.2:1", "http://10.0.0.3:1", "http://10.0.0.4:1", "http://10.0.0.5:1"], LAN).length, 4, "at most 4 fallbacks");
  console.log("PASS R1 fallback routes are limited to https, LAN and Tailscale addresses");

  // R2: at home the LAN route wins; away, the Tailscale route takes over.
  const reachable = new Set([LAN, TS]);
  const probed = [];
  const probe = async (url) => {
    probed.push(url);
    return reachable.has(url) ? { ok: true, latencyMs: 5, deviceId: DEVICE } : { ok: false, error: "ETIMEDOUT" };
  };
  let nodes = [anxlab()];
  let timers = [];
  const resolver = createNodeRouteResolver({ probe, getNodes: () => nodes, setTimeout: (fn) => timers.push(fn) });
  const changes = [];
  resolver.onRouteChanged((change) => changes.push(change));
  assert.strictEqual(resolver.getActiveUrl(nodes[0]), LAN, "before any check the main URL is used");
  await resolver.refreshAll();
  assert.strictEqual(resolver.getActiveUrl(nodes[0]), LAN);
  assert.deepStrictEqual(probed, [LAN], "fallbacks are not probed while the main route works");
  reachable.delete(LAN);
  await resolver.refreshAll();
  assert.strictEqual(resolver.getActiveUrl(nodes[0]), TS, "away from home the Tailscale route is used");
  const status = resolver.getRouteStatus("anxlab");
  assert.deepStrictEqual(status.routes.map((route) => [route.label, route.verified, route.error]), [["Main", false, "ETIMEDOUT"], ["Tailscale", true, null]]);
  reachable.add(LAN);
  await resolver.refreshAll();
  assert.strictEqual(resolver.getActiveUrl(nodes[0]), LAN, "back home the LAN route is preferred again");
  assert.deepStrictEqual(changes.map((change) => change.to), [LAN, TS, LAN]);
  console.log("PASS R2 the first working route wins, and the main route is preferred when it returns");

  // R3: a route answering as a different Agent is never used.
  reachable.delete(LAN);
  const impostor = createNodeRouteResolver({
    probe: async (url) => (url === TS ? { ok: true, latencyMs: 5, deviceId: "someone-else" } : { ok: false, error: "ECONNREFUSED" }),
    getNodes: () => nodes,
  });
  await impostor.refreshAll();
  assert.strictEqual(impostor.getActiveUrl(nodes[0]), LAN, "an unverified route never receives requests");
  assert.strictEqual(impostor.getRouteStatus("anxlab").routes[1].error, "IDENTITY_MISMATCH");
  assert.strictEqual(impostor.getRouteStatus("anxlab").reachable, false);
  console.log("PASS R3 a route that reports a different Agent identity is refused");

  // R4: a failed request triggers one debounced re-check; nodes without
  // fallbacks are untouched.
  reachable.add(LAN);
  timers = [];
  resolver.reportTransportFailure("anxlab");
  resolver.reportTransportFailure("anxlab");
  assert.strictEqual(timers.length, 1, "repeated failures are debounced");
  const plain = { id: "ovh", kind: "agent", baseUrl: "http://127.0.0.1:47132", agentIdentity: { deviceId: "ovh" } };
  assert.strictEqual(resolver.getActiveUrl(plain), "http://127.0.0.1:47132", "nodes without fallbacks keep their URL");
  nodes = [];
  await resolver.refreshAll();
  assert.strictEqual(resolver.getRouteStatus("anxlab"), null, "removed nodes are forgotten");
  console.log("PASS R4 request failures trigger a re-check; other nodes are unaffected");

  // R5: Tailscale suggestions match the node's hostname on the tailnet.
  const tailnet = {
    BackendState: "Running",
    Peer: {
      a: { HostName: "Anxlab", DNSName: "anxlab.tail6fda7f.ts.net.", TailscaleIPs: ["100.89.98.89"], Online: true },
      b: { HostName: "Bungo", DNSName: "bungo.tail6fda7f.ts.net.", TailscaleIPs: ["100.81.46.18"], Online: false },
    },
  };
  assert.deepStrictEqual(tailscale.suggestFromStatus(anxlab(), tailnet), [{ url: TS, label: "Tailscale", online: true, peerName: "Anxlab" }]);
  assert.deepStrictEqual(tailscale.suggestFromStatus(anxlab({ hostname: "", agentIdentity: { hostname: "" }, displayName: "Other" }), tailnet), []);
  assert.deepStrictEqual(tailscale.suggestFromStatus(anxlab(), { ...tailnet, BackendState: "Stopped" }), [], "no suggestions while Tailscale is stopped");
  console.log("PASS R5 Tailscale routes are suggested for nodes found on the tailnet");

  console.log("node route fallback smoke passed (5 checks).");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
