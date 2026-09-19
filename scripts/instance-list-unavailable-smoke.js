const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-instance-list-unavailable-"));
const service = require("../src/shared/instances/instanceServiceCore");
service.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });

function configPath(id) {
  return path.join(root, id, "config.json");
}

function writeMalformed(id) {
  fs.mkdirSync(path.dirname(configPath(id)), { recursive: true });
  fs.writeFileSync(configPath(id), "{ this is not valid JSON\n");
}

async function main() {
  await service.createInstance({
    id: "valid-instance",
    displayName: "Valid Instance",
    type: "node-app",
    executable: "node",
    args: ["app.js"],
  });

  // A directory that exists and matches the instance id pattern but whose
  // config.json is malformed must not silently vanish from the list.
  writeMalformed("malformed-config");

  // A matching directory with no config.json at all is not an instance record
  // (the "forgotten instance preserving its data" case), so it must stay hidden
  // exactly as before — unreadable is not the same as absent.
  fs.mkdirSync(path.join(root, "missing-config"), { recursive: true });

  // A valid installation in progress should stay hidden, exactly as before.
  fs.mkdirSync(path.dirname(configPath("installing-record")), { recursive: true });
  fs.writeFileSync(configPath("installing-record"), `${JSON.stringify({
    id: "installing-record",
    displayName: "Installing Record",
    type: "node-app",
    executable: "node",
    args: ["app.js"],
    installationState: "installing",
    installationOperationId: "smoke-operation",
    state: "Setup Required",
  }, null, 2)}\n`);

  const result = await service.listInstances();
  const byId = new Map(result.instances.map((entry) => [entry.id, entry]));

  assert(byId.has("valid-instance"), "A readable instance must still be listed.");
  assert(!byId.get("valid-instance").unavailable, "A readable instance must not be marked unavailable.");

  const malformed = byId.get("malformed-config");
  assert(malformed, "An unreadable (malformed) config must remain listed instead of being dropped.");
  assert.strictEqual(malformed.unavailable, true, "Unreadable configs must be surfaced as unavailable.");
  assert.strictEqual(malformed.available, false, "Unavailable entries must not claim availability.");
  assert.strictEqual(malformed.unavailableReason, "INSTANCE_CONFIG_UNREADABLE", "Unreadable configs carry a useful diagnostic.");
  assert.strictEqual(malformed.state, "Unknown", "Unavailable entries report an honest Unknown state.");
  assert.strictEqual(malformed.readinessState, "unknown");
  assert.strictEqual(malformed.healthState, "unknown");

  const missing = byId.get("missing-config");
  assert(!missing, "A directory with no config (forgotten instance) must stay hidden, not surface as unavailable.");

  assert(!byId.has("installing-record"), "An in-progress installation must stay hidden from the list.");

  console.log(JSON.stringify({
    status: "PASS",
    classification: "UNREADABLE INSTANCES SURFACED",
    readableRetained: true,
    malformedSurfaced: true,
    missingConfigHidden: true,
    installingHidden: true,
    inventoryCount: result.instances.length,
  }, null, 2));
}

main().finally(() => {
  try {
    service.disposeInstanceService();
  } catch {}
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});