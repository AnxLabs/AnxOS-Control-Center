#!/usr/bin/env node
"use strict";

// A remote node reached through an SSH tunnel has a loopback URL on its own
// port (for example http://127.0.0.1:47132). It must never be treated as this
// PC's Local Agent: that made every registry read turn a selected application
// host ("Windows Desktop") into the tunneled node, so it could not be
// selected, and labelled the remote node "Local Agent".
// Run: node scripts/node-tunnel-not-local-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-node-tunnel-not-local-"));
process.env.ANXHUB_CONFIG_DIR = tempDir;
for (const key of ["AGENT_URL", "AGENT_TOKEN", "BACKEND_MODE"]) delete process.env[key];

const { APPLICATION_HOST_NODE_ID, getNodesPath, getSelectedNodeId, listNodes, selectNode } = require("../src/services/nodeService");

const write = (name, value) => fs.writeFileSync(path.join(tempDir, name), `${JSON.stringify(value, null, 2)}\n`);

(async () => {
  try {
    // This PC's Agent is the global Agent on its own port, as on the real machine.
    write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:47131" });
    write("agent-runtime.json", { host: "127.0.0.1", port: 47131 });
    write(path.basename(getNodesPath()), {
      schemaVersion: 2,
      selectedNodeId: "tunneled-vps",
      nodes: [
        // Saved by an older build with the stored flag it wrongly derived.
        { id: "tunneled-vps", kind: "agent", displayName: "VPS", baseUrl: "http://127.0.0.1:47132", agentUrl: "http://127.0.0.1:47132", localAgent: true, agentIdentity: { deviceId: "device-vps" } },
        { id: "lan-node", kind: "agent", displayName: "LAN", baseUrl: "http://192.168.1.134:47131", agentUrl: "http://192.168.1.134:47131", agentIdentity: { deviceId: "device-lan" } },
      ],
      // The owner removed this PC's Local Agent node, as on the real machine.
      removedLocalAgents: [{ nodeId: "agent-local-agent-47131", deviceId: "local-agent-47131" }],
    });

    // T1: selecting this PC sticks across registry reads.
    await selectNode(APPLICATION_HOST_NODE_ID);
    assert.strictEqual(getSelectedNodeId(), APPLICATION_HOST_NODE_ID, "the application host stays selected; it is not resolved to the tunneled node");
    const state = await listNodes({ discoverLocalAgent: false, refreshIdentity: false });
    assert.strictEqual(state.selectedNodeId, APPLICATION_HOST_NODE_ID);
    console.log("PASS T1 Windows Desktop can be selected while a tunneled node exists");

    // T2: the tunneled node is a remote node, not "Local Agent".
    const vps = state.nodes.find((node) => node.id === "tunneled-vps");
    assert.ok(vps, "the tunneled node is still listed");
    assert.notStrictEqual(vps.localAgent, true, "a loopback URL on another port is not this PC's Local Agent");
    assert.ok(!/local agent/i.test(vps.modeLabel || ""), `the tunneled node is not labelled Local Agent (got ${vps.modeLabel})`);
    console.log("PASS T2 the tunneled node is reported as a remote node");

    // T3: selecting it, and back, both stick.
    await selectNode("tunneled-vps");
    assert.strictEqual(getSelectedNodeId(), "tunneled-vps");
    await selectNode(APPLICATION_HOST_NODE_ID);
    assert.strictEqual(getSelectedNodeId(), APPLICATION_HOST_NODE_ID);
    console.log("PASS T3 switching between the tunneled node and this PC sticks both ways");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  console.log("node tunnel not local smoke passed (3 checks).");
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
