#!/usr/bin/env node
"use strict";

// A remote computer reached through a hand-started SSH tunnel has a loopback
// address (http://127.0.0.1:47132). When the tunnel died, its card only said
// "Agent unavailable", and the OVH VPS sat Offline for two weeks with nothing
// pointing at the cause. The Route line now says the address is a local port
// and where AnxOS can keep the tunnel open. Runs the real helper from app.js.
// Run: node scripts/node-local-port-route-hint-smoke.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");
const match = app.match(/\nfunction describeUnmanagedLocalPortRoute\(node, visualState\) \{[\s\S]*?\n\}\n/);
assert(match, "describeUnmanagedLocalPortRoute should exist in app.js");
assert(/const tunnelHint = describeUnmanagedLocalPortRoute\(node, getNodeVisualState\(node\)\);/.test(app), "describeNodeRoute should use the hint");
const hint = (node, state) => vm.runInNewContext(`${match[0]}; describeUnmanagedLocalPortRoute(node, state);`, { node, state, URL });

const vps = { id: "vps", kind: "agent", baseUrl: "http://127.0.0.1:47132", agentUrl: "http://127.0.0.1:47132", localAgent: false };

const offline = hint(vps, "offline");
assert.match(offline, /Local port 47132 not answering/, "an offline tunneled computer names its local port");
assert.match(offline, /Routes › SSH tunnel/, "and points to the built-in tunnel");
assert.strictEqual(hint(vps, "online"), null, "no hint while it answers");
assert.strictEqual(hint({ ...vps, transport: { type: "ssh-tunnel", sshProfileId: "p", remoteHost: "127.0.0.1", remotePort: 47132 } }, "offline"), null, "no hint once AnxOS manages the tunnel");
assert.strictEqual(hint({ ...vps, localAgent: true, baseUrl: "http://127.0.0.1:47131", agentUrl: "http://127.0.0.1:47131" }, "offline"), null, "this PC's own Agent is not a tunnel");
assert.strictEqual(hint({ ...vps, connection: { localAgent: true } }, "offline"), null, "a node the health check marked local is not a tunnel");
assert.strictEqual(hint({ ...vps, baseUrl: "http://192.168.1.134:47131", agentUrl: "http://192.168.1.134:47131" }, "offline"), null, "a LAN address is not a local port");
assert.strictEqual(hint({ id: "host", kind: "application-host" }, "offline"), null, "the application host has no route");
assert.match(hint({ ...vps, baseUrl: "http://localhost:47140", agentUrl: "" }, "offline"), /Local port 47140/, "localhost counts as a local port");
assert.strictEqual(hint({ ...vps, fallbackUrls: [{ url: "http://vps.tailnet.ts.net:47132", label: "Tailscale" }] }, "offline"), null, "a computer with fallback routes lets the route list explain itself");

console.log("node local port route hint smoke passed (10 checks).");
