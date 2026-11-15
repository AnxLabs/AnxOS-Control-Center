#!/usr/bin/env node
"use strict";

// Agent versions shown in the UI come from the release build the Agent
// reports (identity.agentArtifactVersion), never from agent/package.json's
// fixed "0.1.0" placeholder (Build 212 acceptance: Agent Control showed
// "Version 0.1.0" for a 2.0-build212 Agent).
//   B1 a health reply's build is kept on the node's connection and identity
//   B2 a later reply WITHOUT a build (a downgraded or older Agent) clears it,
//      instead of carrying the old build forward from the saved record
//   B3 a check that got no reply (offline) keeps the last known build
//   B4 the renderer's label: "2.0 Build 212" for a build, "" for the
//      placeholder or anything that is not a full artifact version
// Hermetic: a temporary config folder, no network, no Electron.
// Run: node scripts/agent-build-display-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-agent-build-display-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
process.env.ANXOS_LOG_DIR = path.join(root, "logs");
process.env.AGENT_URL = "http://127.0.0.1:9";
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.ANXHUB_CONFIG_DIR, "nodes.json"), JSON.stringify({
  schemaVersion: 2,
  selectedNodeId: "lab",
  nodes: [{ id: "lab", kind: "agent", name: "Lab", displayName: "Lab", baseUrl: "http://192.0.2.10:47131", agentUrl: "http://192.0.2.10:47131", enabled: true }],
}));

const health = (identity) => ({
  ok: true,
  apiVersion: "v1",
  protocolVersion: 1,
  identity: { deviceId: "device-lab", hostname: "lab", platform: "linux", agentVersion: "0.1.0", apiVersion: "v1", protocolVersion: 1, ...identity },
});

try {
  const nodes = require("../src/services/nodeService");
  const read = () => nodes.getNode("lab");

  nodes.updateNodeHealthState("lab", { state: "online", health: health({ agentArtifactVersion: "2.0-build212" }) });
  let node = read();
  assert.strictEqual(node.connection?.agentArtifactVersion, "2.0-build212", "the connection keeps the reported build");
  assert.strictEqual(node.agentIdentity?.agentArtifactVersion, "2.0-build212", "the identity keeps the reported build");
  assert.strictEqual(node.agentIdentity?.agentVersion, "0.1.0", "the placeholder is still recorded for protocol checks");
  console.log("PASS B1 a reported build is kept on the connection and the identity");

  nodes.updateNodeHealthState("lab", { state: "offline", message: "Agent unavailable." });
  node = read();
  assert.strictEqual(node.connection?.agentArtifactVersion, "2.0-build212", "an offline check keeps the last known build");
  console.log("PASS B3 a check with no reply keeps the last known build");

  nodes.updateNodeHealthState("lab", { state: "online", health: health({}) });
  node = read();
  assert.strictEqual(node.connection?.agentArtifactVersion ?? null, null, "a reply without a build clears the connection's build");
  assert.ok(!node.agentIdentity?.agentArtifactVersion, "a reply without a build clears the identity's build");
  console.log("PASS B2 a reply without a build clears the old one");

  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const start = appSource.indexOf("const AGENT_BUILD_NOT_REPORTED");
  const end = appSource.indexOf("function getAgentCompatibilityView", start);
  assert.ok(start > 0 && end > start, "the renderer defines its Agent build label");
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${appSource.slice(start, end)}\nthis.getAgentBuildLabel = getAgentBuildLabel; this.formatAgentVersionForDisplay = formatAgentVersionForDisplay;`, context);
  assert.strictEqual(context.getAgentBuildLabel({ identity: { agentArtifactVersion: "2.0-build212" } }), "2.0 Build 212");
  assert.strictEqual(context.getAgentBuildLabel({ build: "2.0-build212" }), "2.0 Build 212", "runtime summaries carry it as build");
  assert.strictEqual(context.getAgentBuildLabel({ connection: { agentArtifactVersion: "v2.1-build7" } }), "2.1 Build 7");
  assert.strictEqual(context.getAgentBuildLabel({ agentVersion: "0.1.0", identity: { agentVersion: "0.1.0" } }), "", "the placeholder is never a build");
  assert.strictEqual(context.getAgentBuildLabel({ agentArtifactVersion: "2.0-build" }), "", "a malformed build is not shown");
  assert.strictEqual(context.getAgentBuildLabel(null, {}, { agentIdentity: { agentArtifactVersion: "2.0-build211" } }), "2.0 Build 211", "later sources are tried in order");
  assert.strictEqual(context.formatAgentVersionForDisplay({ agentVersion: "0.1.0" }), "Build not reported");
  console.log("PASS B4 the label shows a reported build and never the placeholder");
  console.log("Agent build display smoke passed (4 checks).");
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
