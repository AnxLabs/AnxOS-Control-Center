#!/usr/bin/env node
"use strict";

// Regression: restoring an IMPORTED world backup must only replace the world.
//
// importBackup recorded every imported archive with sourcePaths ["."]. A world
// restore deletes each recorded source path before extracting, so restoring an
// imported world backup deleted the whole server folder (config.json, server
// files) and its world-only safety copy could not bring them back.
//
//   W1 an imported world archive records the world folders it contains, not
//      the whole server;
//   W2 restoring it replaces the world and leaves every other server file;
//   W3 an imported "world" archive with files outside a folder (or a
//      config.json) is refused instead of being recorded as a world backup;
//   W4 world records an older build already wrote with ["."] are re-derived
//      from the archive at restore time, and refused (nothing deleted) when
//      the archive is not world-only.
//
// Runs entirely in pinned temporary roots with a stubbed lifecycle; it never
// touches a real instance or backup folder.
// Run: node scripts/world-import-restore-smoke.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const root = pinAgentRoots("anx-world-import-");
process.env.AGENT_BACKUP_ROOT = path.join(root, "backups");

const backupService = require("../agent/src/services/backupService");
const instanceService = require("../agent/src/services/instances/instanceService");

const INSTANCE_ID = "world-import-target";
const instancePath = path.join(process.env.AGENT_INSTANCE_ROOT, INSTANCE_ID);

instanceService.getStatus = async () => ({ state: "Stopped", pid: null });
instanceService.stopInstance = async (instanceId) => ({ id: instanceId, state: "Stopped" });
instanceService.startInstance = async (instanceId) => ({ id: instanceId, state: "Running" });

function write(relative, content) {
  const target = path.join(instancePath, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

// Minimal ustar writer for test fixtures only (regular files, short names).
function tarGz(files) {
  const blocks = [];
  for (const [name, content] of files) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(" ", 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

async function main() {
  write("config.json", `${JSON.stringify({ id: INSTANCE_ID, name: "World import target" }, null, 2)}\n`);
  write("data/server.jar", "server-binary");
  write("data/server.properties", "level-name=world\n");
  write("data/world/level.dat", "original-world");

  // W1: a real world backup's archive, imported back as a world backup.
  const created = (await backupService.createBackup({ instanceId: INSTANCE_ID, type: "world", name: "fixture world", createdBy: "smoke" })).backup;
  write("data/world/level.dat", "changed-after-backup");
  const archive = fs.readFileSync(created.path || path.join(process.env.AGENT_BACKUP_ROOT, created.archiveName));
  const imported = (await backupService.importBackup({
    instanceId: INSTANCE_ID,
    content: archive.toString("base64"),
    encoding: "base64",
    type: "world",
    name: "imported world",
  }));
  const importedBackup = imported.backup || imported;
  assert.strictEqual(importedBackup.type, "world");
  assert.ok(!importedBackup.sourcePaths.includes("."), `an imported world backup must not claim the whole server (sourcePaths ${JSON.stringify(importedBackup.sourcePaths)})`);
  assert.deepStrictEqual(importedBackup.sourcePaths, created.sourcePaths, "the imported world records the same world folders as the original backup");
  console.log("PASS W1 an imported world archive records its world folders");

  // W2: restoring it replaces the world only.
  await backupService.restoreBackup({ backupId: importedBackup.id, confirmOverwrite: true });
  assert.ok(fs.existsSync(path.join(instancePath, "config.json")), "config.json survives a world restore");
  assert.strictEqual(fs.readFileSync(path.join(instancePath, "data", "server.jar"), "utf8"), "server-binary", "server files survive a world restore");
  assert.strictEqual(fs.readFileSync(path.join(instancePath, "data", "world", "level.dat"), "utf8"), "original-world", "the world is replaced by the imported one");
  console.log("PASS W2 restoring an imported world replaces only the world");

  // W3: archives that are not world-only are refused as world imports.
  for (const [label, files] of [
    ["a top-level file", [["level.dat", "loose"]]],
    ["the server record", [["config.json", "{}"], ["data/world/level.dat", "x"]]],
  ]) {
    await assert.rejects(
      backupService.importBackup({ instanceId: INSTANCE_ID, content: tarGz(files).toString("base64"), encoding: "base64", type: "world" }),
      (error) => error?.code === "BACKUP_WORLD_ARCHIVE_INVALID",
      `a world import with ${label} is refused`,
    );
  }
  // A full import keeps the historical whole-server meaning.
  const full = await backupService.importBackup({ instanceId: INSTANCE_ID, content: tarGz([["config.json", "{}"]]).toString("base64"), encoding: "base64", type: "full" });
  assert.deepStrictEqual((full.backup || full).sourcePaths, ["."], "full imports still cover the whole server");
  console.log("PASS W3 non-world archives are refused as world imports");

  // W4: records an older build already wrote (world type, sourcePaths ["."])
  // are re-derived from the archive at restore time instead of wiping.
  const metadataFile = path.join(process.env.AGENT_BACKUP_ROOT, `${importedBackup.id}.json`);
  const legacy = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  fs.writeFileSync(metadataFile, JSON.stringify({ ...legacy, sourcePaths: ["."] }, null, 2));
  write("data/world/level.dat", "changed-again");
  await backupService.restoreBackup({ backupId: importedBackup.id, confirmOverwrite: true });
  assert.ok(fs.existsSync(path.join(instancePath, "config.json")), "a legacy world record no longer deletes config.json");
  assert.strictEqual(fs.readFileSync(path.join(instancePath, "data", "server.jar"), "utf8"), "server-binary");
  assert.strictEqual(fs.readFileSync(path.join(instancePath, "data", "world", "level.dat"), "utf8"), "original-world");

  // A legacy "world" record whose archive is not world-only is refused before
  // anything is deleted.
  const looseArchive = tarGz([["config.json", "{\"id\":\"evil\"}"], ["loose.txt", "x"]]);
  const looseId = `${INSTANCE_ID}-legacy-loose`;
  const loosePath = path.join(process.env.AGENT_BACKUP_ROOT, `${looseId}.tar.gz`);
  fs.writeFileSync(loosePath, looseArchive);
  fs.writeFileSync(path.join(process.env.AGENT_BACKUP_ROOT, `${looseId}.json`), JSON.stringify({
    ...legacy,
    id: looseId,
    archiveName: path.basename(loosePath),
    archiveSha256: require("crypto").createHash("sha256").update(looseArchive).digest("hex"),
    sourcePaths: ["."],
  }, null, 2));
  await assert.rejects(
    backupService.restoreBackup({ backupId: looseId, confirmOverwrite: true }),
    (error) => error?.code === "BACKUP_WORLD_ARCHIVE_INVALID",
    "a legacy non-world archive is refused",
  );
  assert.ok(fs.existsSync(path.join(instancePath, "config.json")) && fs.existsSync(path.join(instancePath, "data", "server.jar")), "nothing is deleted when the restore is refused");
  console.log("PASS W4 world backups recorded by older builds no longer wipe the server");

  console.log("World import restore smoke passed (4 checks).");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
});
