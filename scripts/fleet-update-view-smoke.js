// Fleet "Server Updates" panel: lists SteamCMD servers across every enabled
// node with their build status, and updates stopped servers strictly one at a
// time through the normal update call. The panel logic runs verbatim from
// app.js in a sandbox against a fake desktop API.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function extractFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert(start >= 0, `Could not find function ${name} in app.js.`);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}.`);
}

function createHarness() {
  const calls = { list: [], check: [], update: [], toasts: [] };
  let activeUpdates = 0;
  let peakUpdates = 0;
  const instancesByNode = {
    "node-a": [
      { id: "palworld", displayName: "Palworld", installerType: "steamcmd-native", steamAppId: 2394010, state: "Stopped" },
      { id: "rust", displayName: "Rust", installerType: "steamcmd-native", steamAppId: 258550, state: "Running" },
      { id: "mc", displayName: "Minecraft", type: "minecraft-java", state: "Stopped" },
    ],
    "node-b": [
      { id: "valheim", displayName: "Valheim", installerType: "steamcmd-native", steamAppId: 896660, state: "Stopped" },
      { id: "cs2", displayName: "CS2", installerType: "steamcmd-native", steamAppId: 730, state: "Stopped" },
    ],
  };
  const checks = {
    palworld: { updateAvailable: true, installedBuildId: "1", latestBuildId: "2" },
    rust: { updateAvailable: true, installedBuildId: "5", latestBuildId: "6" },
    valheim: { updateAvailable: false, installedBuildId: "9", latestBuildId: "9" },
    cs2: { updateAvailable: true, installedBuildId: "3", latestBuildId: "4" },
  };
  const api = {
    instances: {
      list: async ({ nodeId }) => {
        calls.list.push(nodeId);
        if (nodeId === "node-offline") throw Object.assign(new Error("offline"), { code: "AGENT_UNAVAILABLE" });
        return { instances: instancesByNode[nodeId] || [] };
      },
      checkSteamUpdate: async (instanceId, payload) => {
        calls.check.push({ instanceId, ...payload });
        return checks[instanceId];
      },
    },
    marketplace: {
      updateSteamServer: async (payload) => {
        activeUpdates += 1;
        peakUpdates = Math.max(peakUpdates, activeUpdates);
        calls.update.push(payload);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeUpdates -= 1;
        if (payload.instanceId === "cs2") return { ok: false, error: { code: "STEAMCMD_NETWORK_UNAVAILABLE", message: "network" } };
        return { ok: true };
      },
    },
  };
  const context = {
    console,
    nodesState: { nodes: [{ id: "node-a", displayName: "Anxlab" }, { id: "node-b", displayName: "VPS" }, { id: "node-offline", displayName: "Old box" }, { id: "node-off", displayName: "Disabled", enabled: false }] },
    getDesktopApiState: () => ({ api }),
    normalizeInstancesPayload: (payload) => ({ instances: Array.isArray(payload?.instances) ? payload.instances : [] }),
    isInstanceRunning: (instance) => instance?.state === "Running",
    formatDateTime: (value) => String(value),
    renderServerUpdates: () => {},
    createSecurityConfirmation: async () => true,
    showToast: (message, tone) => calls.toasts.push({ message, tone }),
  };
  vm.createContext(context);
  vm.runInContext([
    "let serverUpdatesState = { rows: [], checkedAt: null, busy: false };",
    extractFunction("isSteamCmdUpdateInstance"),
    extractFunction("summarizeServerUpdateRow"),
    extractFunction("getServerUpdateCandidates"),
    extractFunction("refreshServerUpdates"),
    extractFunction("updateStoppedServers"),
    "this.refresh = refreshServerUpdates; this.updateStopped = updateStoppedServers; this.state = () => serverUpdatesState; this.summarize = summarizeServerUpdateRow;",
  ].join("\n"), context);
  return { context, calls, peak: () => peakUpdates };
}

async function main() {
  const { context, calls, peak } = createHarness();
  await context.refresh();
  assert.strictEqual(calls.list.length, 0, "Opening the Nodes page does not query every node until Check All.");

  await context.refresh({ refresh: true });
  assert.deepStrictEqual(calls.list, ["node-a", "node-b", "node-offline"], "Every enabled node is queried; disabled nodes are skipped.");
  assert(calls.check.every((call) => call.refresh === true && call.nodeId), "Check All forces a fresh lookup on the right node.");
  const rows = context.state().rows;
  assert.deepStrictEqual(Array.from(rows, (row) => row.instanceId), ["palworld", "rust", "valheim", "cs2", null], "Only SteamCMD servers are listed, plus a row for an unreachable node.");
  assert.strictEqual(rows.find((row) => row.instanceId === null).error, "Node unavailable");
  assert.match(context.summarize(rows[0]).label, /Update available: build 2 \(installed 1\)/);
  assert.match(context.summarize(rows[2]).label, /Up to date \(build 9\)/);

  await context.updateStopped();
  assert.deepStrictEqual(calls.update.map((call) => `${call.nodeId}/${call.instanceId}`), ["node-a/palworld", "node-b/cs2"], "Only stopped servers with an update are updated; running ones are skipped.");
  assert.strictEqual(peak(), 1, "Servers are updated strictly one at a time.");
  assert(calls.update.every((call) => call.backupBeforeUpdate === true), "Fleet updates ask for a backup first.");
  const toast = calls.toasts.at(-1);
  assert.strictEqual(toast.tone, "warning");
  assert.match(toast.message, /1 of 2 servers updated\. Failed: CS2 \(STEAMCMD_NETWORK_UNAVAILABLE\)/, "A failure does not stop the queue and is reported.");
  assert.strictEqual(context.state().busy, false);

  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert(html.includes("data-server-updates-panel") && html.includes('data-server-updates-action="update-stopped" disabled'), "The panel sits on the Nodes page with Update disabled until there is something to update.");
  console.log("Fleet update view smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
