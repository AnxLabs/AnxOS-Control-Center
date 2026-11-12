#!/usr/bin/env node
"use strict";

// Regression for the restore confirmation preview (Phase 3.3).
//   R1 the Agent's read-only preview is described in plain words: what is
//      replaced, the safety copy, and every warning;
//   R2 the renderer asks for the preview before confirming, falls back to its
//      generic wording when the preview is unavailable, and the server's
//      Backups tab imports a backup without asking for the server ID.
// Run: node scripts/restore-preview-smoke.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const restore = require(path.join(root, "src", "shared", "restorePreview.js"));
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");

// R1
assert.strictEqual(restore.describeRestorePreview(null), null);
assert.strictEqual(restore.describeRestorePreview({ backup: {} }), null, "a non-preview result is not described");
const full = restore.describeRestorePreview({
  preview: true,
  backup: { createdAt: "2026-11-01T10:00:00Z" },
  scope: { type: "full", willWipeWholeInstance: true, safetyType: "full", backupSourcePaths: ["."] },
  conflict: { verdict: "overwrite", warnings: ["RESTORE_TARGET_RUNNING"] },
}, { formatDate: () => "1 Nov 2026" });
assert.match(full.lines[0], /Everything in this server's folder is replaced/);
assert.ok(full.lines.includes("The backup was taken 1 Nov 2026."));
assert.ok(full.lines.some((line) => /safety copy of the whole server/.test(line)));
assert.deepStrictEqual(full.warnings, ["The server is running. AnxOS stops it before restoring."]);
const world = restore.describeRestorePreview({
  preview: true,
  backup: {},
  scope: { type: "world", willWipeWholeInstance: false, safetyType: "world", backupSourcePaths: ["world", "world_nether", "world_the_end"], safetySourcePaths: ["world"] },
  conflict: { verdict: "new-restore", warnings: ["SOMETHING_NEW"] },
});
assert.match(world.lines[0], /Only the world is replaced \(world, world_nether, world_the_end\)/);
assert.ok(world.lines.some((line) => /original server is not changed/.test(line)));
assert.deepStrictEqual(world.warnings, ["SOMETHING_NEW"], "unknown warnings are passed through, not hidden");
console.log("PASS R1 the restore preview is described in plain words");

// R2
const restoreFn = app.slice(app.indexOf("async function restoreSelectedBackup("), app.indexOf("function getLatestBackupForInstance("));
assert.ok(restoreFn.indexOf("getRestorePreviewMessage(selected, requestContext)") < restoreFn.indexOf("confirmDestructiveAction("), "the preview is fetched before confirmation");
assert.ok(restoreFn.includes("message: previewMessage ||"), "the generic wording remains the fallback");
assert.ok(app.includes("backups.restore({ nodeId: requestContext.nodeId, backupId: backup.id, preview: true })"), "the preview uses the Agent's dry run");
assert.ok(app.includes('} else if (action === "import") {\n    importBackupForInstance(selectedInstance.id);') || app.includes('} else if (action === "import") {\r\n    importBackupForInstance(selectedInstance.id);'), "the Backups tab imports into the selected server");
assert.ok(index.includes('data-instance-backup-action="import"'), "the Backups tab offers Import a Backup");
const moduleAt = index.indexOf('src="src/shared/restorePreview.js"');
assert.ok(moduleAt > 0 && moduleAt < index.indexOf('src="app.js"'), "restorePreview.js loads before app.js");
console.log("PASS R2 restore asks for the preview first and import knows the server");

console.log("Restore preview smoke passed (2 checks).");
