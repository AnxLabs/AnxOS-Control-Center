#!/usr/bin/env node
// Behavioral coverage for the preload exposure of the alerts and durable-job
// channels (frozen-audit roadmap finding: 10 registered channels were reachable
// from nothing — no preload exposure and no renderer caller, so the alert engine
// computed alerts an operator could never see).
//
// This loads the REAL preload.js with a fake `electron` module, records every
// `ipcRenderer.invoke` call, and asserts the namespaces call the exact registered
// channels with the payload shape the main-process handlers expect
// (`src/ipc/alertsIpc.js`, `src/ipc/instancesIpc.js`).
//
// This is BEHAVIORAL for the exposure wire-up: a static "preload.js contains
// alerts:list" pin would pass even if the namespace were wired to the wrong
// channel or dropped the payload.
//
// What it does NOT prove: the handlers themselves (they have their own smokes),
// that the renderer calls these namespaces, or that the panels render. No
// Electron is launched here.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Objects created inside the vm context carry that realm's Object.prototype, so
// cross-realm deepStrictEqual is prototype-sensitive. Normalize through JSON.
const asPlain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const PRELOAD_PATH = path.resolve(__dirname, "..", "preload.js");
const source = fs.readFileSync(PRELOAD_PATH, "utf8");

const invocations = [];
const exposed = {};

const fakeElectron = {
  contextBridge: {
    exposeInMainWorld: (name, api) => { exposed[name] = api; },
  },
  ipcRenderer: {
    invoke: (channel, payload) => {
      invocations.push({ channel, payload });
      return Promise.resolve({ ok: true });
    },
    send: () => {},
    on: () => {},
    removeListener: () => {},
  },
};

const sandbox = {
  require: (id) => {
    if (id === "electron") return fakeElectron;
    throw new Error(`Unexpected require in preload sandbox: ${id}`);
  },
  Buffer,
  process,
  console,
  URL,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

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

const anx = exposed.anx;
assert(anx, "preload must expose the `anx` desktop API");

async function main() {
  console.log("Preload exposure contract smoke");
  console.log("-------------------------------");

  check("bridge aliases all resolve to one desktop API (no shadowing)", () => {
    assert.strictEqual(exposed.anx, exposed.anxos, "anx and anxos must share the desktop API");
    assert.strictEqual(exposed.anx, exposed.anxhub, "anx and anxhub must share the desktop API");
    assert.strictEqual(exposed.anx, exposed.electronAPI, "anx and electronAPI must share the desktop API");
  });

  check("alerts namespace exposes list + acknowledge only", () => {
    assert.strictEqual(typeof anx.alerts?.list, "function");
    assert.strictEqual(typeof anx.alerts?.acknowledge, "function");
    assert.deepStrictEqual(Object.keys(anx.alerts).sort(), ["acknowledge", "list"]);
  });

  check("instances.jobs sub-namespace exposes list + get + cancel", () => {
    assert.strictEqual(typeof anx.instances?.jobs?.list, "function");
    assert.strictEqual(typeof anx.instances?.jobs?.get, "function");
    assert.strictEqual(typeof anx.instances?.jobs?.cancel, "function");
    // The pre-existing instances members must be untouched by the addition.
    assert.strictEqual(typeof anx.instances.list, "function");
    assert.strictEqual(typeof anx.instances.start, "function");
  });

  // alerts:list takes no payload (the handler ignores it).
  await anx.alerts.list();
  check("alerts.list -> alerts:list with no payload", () => {
    const call = invocations.at(-1);
    assert.strictEqual(call.channel, "alerts:list");
    assert.strictEqual(call.payload, undefined);
  });

  // alerts:acknowledge reads payload.id (src/ipc/alertsIpc.js).
  await anx.alerts.acknowledge("alert:DISK_PRESSURE:node-1");
  check("alerts.acknowledge -> alerts:acknowledge { id }", () => {
    const call = invocations.at(-1);
    assert.strictEqual(call.channel, "alerts:acknowledge");
    assert.deepStrictEqual(asPlain(call.payload), { id: "alert:DISK_PRESSURE:node-1" });
  });

  const JOB_ID = `job_${"a".repeat(32)}`;

  await anx.instances.jobs.list({ nodeId: "node-1", limit: 50 });
  check("instances.jobs.list -> instances:jobs:list with nodeId passthrough", () => {
    const call = invocations.at(-1);
    assert.strictEqual(call.channel, "instances:jobs:list");
    assert.deepStrictEqual(asPlain(call.payload), { nodeId: "node-1", limit: 50 });
  });

  await anx.instances.jobs.get(JOB_ID, { nodeId: "node-1" });
  check("instances.jobs.get -> instances:jobs:get { nodeId, jobId }", () => {
    const call = invocations.at(-1);
    assert.strictEqual(call.channel, "instances:jobs:get");
    assert.deepStrictEqual(asPlain(call.payload), { nodeId: "node-1", jobId: JOB_ID });
  });

  await anx.instances.jobs.cancel(JOB_ID, { nodeId: "node-1", instanceId: "inst-1", reason: "operator" });
  check("instances.jobs.cancel -> instances:jobs:cancel { nodeId, instanceId, reason, jobId }", () => {
    const call = invocations.at(-1);
    assert.strictEqual(call.channel, "instances:jobs:cancel");
    assert.deepStrictEqual(asPlain(call.payload), { nodeId: "node-1", instanceId: "inst-1", reason: "operator", jobId: JOB_ID });
  });

  console.log("-------------------------------");
  if (failures) {
    console.error(`preload-exposure-contract-smoke FAILED: ${failures} check(s).`);
    process.exit(1);
  }
  console.log("preload-exposure-contract-smoke passed (8 checks).");
}

main().catch((error) => {
  console.error("preload-exposure-contract-smoke crashed:", error?.message || error);
  process.exit(1);
});
