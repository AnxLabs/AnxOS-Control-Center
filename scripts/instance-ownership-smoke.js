const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// V2-B app-slice ownership smoke (docs/v2/V2B_DASHBOARD_APPS_WAVE1.md §3.3):
// instances carry managed/imported/external ownership, ownership is immutable
// on update except the explicit one-way adoption transition, and adoption
// stamps adoptedAt. Hermetic — real lifecycle ops, no engine required.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-instance-ownership-"));
const core = require("../src/shared/instances/instanceServiceCore");
const jobLifecycle = require("../src/shared/instances/jobLifecycle");

core.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });
jobLifecycle.configureJobLifecycle({ getRoot: () => path.join(root, "jobs") });
process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);

// createInstance/updateInstance return the record flattened with the durable
// job attached; getStatus may wrap it. Normalize both shapes.
const asRecord = (result) => (result && result.instance ? result.instance : result);

function basePayload(id, overrides = {}) {
  return {
    id,
    displayName: `Ownership ${id}`,
    type: "custom-command",
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    ...overrides,
  };
}

// Read-only runtime fields must never be sent back through updateInstance.
function writableFields(record) {
  const copy = { ...record };
  for (const key of ["state", "pid", "exitCode", "signal", "setupRequired", "setupReadiness", "readinessState", "healthState", "events", "versionInfo", "adoptedAt", "job", "javaRuntime", "javaRuntimeOverride", "requiredJavaMajor"]) {
    delete copy[key];
  }
  return copy;
}

async function main() {
  // 1. Default ownership is anxos-managed (back-compat for every V1 record).
  const managed = asRecord(await core.createInstance(basePayload("own-managed")));
  assert.strictEqual(managed.ownership, "anxos-managed", "New instances default to anxos-managed.");
  assert.strictEqual(managed.adoptedAt, null, "A natively managed instance has no adoption stamp.");

  // 2. External ownership is accepted at create time and persists.
  const external = asRecord(await core.createInstance(basePayload("own-external", { ownership: "external" })));
  assert.strictEqual(external.ownership, "external", "External ownership must persist.");
  const externalRead = asRecord(await core.getStatus("own-external"));
  assert.strictEqual(externalRead.ownership, "external", "External ownership must survive a fresh read.");

  // 3. Imported ownership is accepted at create time.
  const imported = asRecord(await core.createInstance(basePayload("own-imported", { ownership: "imported" })));
  assert.strictEqual(imported.ownership, "imported", "Imported ownership must persist.");

  // 4. Ownership is immutable on update without the explicit adopt opt-in.
  await assert.rejects(
    () => core.updateInstance("own-external", { ...writableFields(externalRead), ownership: "anxos-managed" }),
    (error) => error.code === "INSTANCE_OWNERSHIP_IMMUTABLE" && error.statusCode === 409,
    "A silent ownership flip must be refused.",
  );

  // 5. Invalid ownership values fail closed.
  await assert.rejects(
    () => core.updateInstance("own-external", { ...writableFields(externalRead), ownership: "mine-now" }),
    (error) => error.code === "INSTANCE_OWNERSHIP_INVALID" && error.statusCode === 400,
    "Unknown ownership values must be rejected.",
  );

  // 6. Explicit adoption transitions external → managed and stamps adoptedAt.
  const adopted = asRecord(await core.updateInstance("own-external", {
    ...writableFields(externalRead),
    ownership: "anxos-managed",
    adopt: true,
  }));
  assert.strictEqual(adopted.ownership, "anxos-managed", "Adoption must move external to managed.");
  assert.ok(adopted.adoptedAt, "Adoption must stamp adoptedAt.");
  const adoptedRead = asRecord(await core.getStatus("own-external"));
  assert.strictEqual(adoptedRead.ownership, "anxos-managed", "Adoption must persist.");

  // 7. Adopting an already-managed instance is a no-op (no second stamp).
  const again = asRecord(await core.updateInstance("own-external", {
    ...writableFields(adoptedRead),
    ownership: "anxos-managed",
    adopt: true,
  }));
  assert.strictEqual(again.adoptedAt, adopted.adoptedAt, "Re-adoption must not restamp adoptedAt.");

  // 8. A managed instance restating its current ownership needs no adopt flag.
  const same = asRecord(await core.updateInstance("own-managed", { ...writableFields(managed), ownership: "anxos-managed" }));
  assert.strictEqual(same.ownership, "anxos-managed", "Restating current ownership must be accepted.");

  console.log("instance:ownership:smoke passed");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });