const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createStore, shouldAcceptOperation } = require("../src/shared/resourceOperationLifecycle");

function visible(store, id) {
  return store.getVisibleResource(id);
}

const instances = createStore();
const original = { id: "server-1", name: "Survival", state: "Running" };
instances.reconcileResources([original]);
assert.strictEqual(visible(instances, original.id).id, original.id, "instance should initially render");

instances.updateOperation(original.id, { type: "reload", status: "running", startedAt: 100, updatedAt: 100 });
assert.strictEqual(visible(instances, original.id).operation.type, "reload", "reload should become visible immediately");
assert.strictEqual(visible(instances, original.id).state, "Running", "reload must not replace persistent resource state");

instances.reconcileResources([]);
assert.strictEqual(visible(instances, original.id).name, "Survival", "empty refetch during reload must retain the resource");

instances.updateOperation(original.id, { type: "reload", status: "success", progress: 100, updatedAt: 200, completedAt: 200 });
assert.strictEqual(visible(instances, original.id).operation.status, "success", "successful reload should reach terminal success");
instances.clearOperation(original.id, "reload");
assert.strictEqual(visible(instances, original.id).operation, null, "successful reload completion should clear its overlay");

instances.updateOperation(original.id, { type: "reload", status: "running", updatedAt: 300 });
instances.updateOperation(original.id, { type: "reload", status: "failed", error: "agent unavailable", updatedAt: 400 });
assert.strictEqual(visible(instances, original.id).id, original.id, "failed reload must preserve the instance");
assert.strictEqual(visible(instances, original.id).operation.error, "agent unavailable", "failed reload should expose its error");

const identityBefore = instances.getResource(original.id);
instances.reconcileResources([{ id: original.id, state: "Running", version: "1.2.3" }]);
assert.strictEqual(instances.getResource(original.id).id, identityBefore.id, "resource key must remain stable across refetch");

const downloads = createStore();
downloads.reconcileResources([{ id: "download-1", name: "Pack", provider: "Modrinth" }]);
downloads.updateOperation("download-1", {
  type: "download", status: "running", progress: 64,
  bytesCompleted: 2100, bytesTotal: 3300, speedBytesPerSecond: 38, updatedAt: 1000,
});
assert.deepStrictEqual(
  { id: visible(downloads, "download-1").id, progress: visible(downloads, "download-1").operation.progress },
  { id: "download-1", progress: 64 },
  "download progress must remain attached to the same resource",
);

downloads.updateOperation("download-1", { type: "download", status: "success", progress: 100, updatedAt: 1200, completedAt: 1200 });
downloads.updateOperation("download-1", { type: "download", status: "running", progress: 72, updatedAt: 1100 });
assert.strictEqual(visible(downloads, "download-1").operation.status, "success", "stale progress must not regress completion");
assert.strictEqual(visible(downloads, "download-1").operation.progress, 100, "stale percentage must not regress completion");

downloads.updateOperation("download-1", { type: "download", status: "failed", error: "checksum failed", updatedAt: 1300 });
assert.strictEqual(visible(downloads, "download-1").name, "Pack", "download failure must preserve its resource");
assert.strictEqual(visible(downloads, "download-1").operation.error, "checksum failed", "download failure must expose its error");

downloads.reset();
assert.strictEqual(visible(downloads, "download-1"), null, "node/workspace reset must not leak resources across scopes");

assert.strictEqual(shouldAcceptOperation(
  { status: "success", progress: 100, updatedAt: 500 },
  { status: "running", progress: 50, updatedAt: 500 },
), false, "duplicate same-version active events must not overwrite terminal state");

const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
assert.match(appSource, /existingRows\.get\(instance\.id\)/, "instance renderer must reconcile keyed rows");
assert.match(appSource, /existingItems\.get\(download\.id\)/, "download renderer must reconcile keyed entries");
assert.doesNotMatch(
  appSource.slice(appSource.indexOf("async function refreshMarketplaceDownloads"), appSource.indexOf("async function cancelMarketplaceDownload")),
  /catch[^}]*renderMarketplaceDownloads\(\[\]\)/s,
  "download refresh failure must not blank the last-known list",
);
assert.match(appSource, /type:\s*resourceOperationType[\s\S]*status:\s*"running"/, "instance action must attach an immediate operation overlay");

console.log("Resource operation lifecycle smoke passed.");
