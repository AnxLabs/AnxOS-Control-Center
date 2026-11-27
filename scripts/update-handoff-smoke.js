#!/usr/bin/env node
"use strict";

// 217-E: installing an update closes the app through its normal shutdown,
// never by the installer forcing it, and waits for sensitive work.
//   U1 work that must finish first: active long operations and running jobs
//      of servers this app runs; finished, failed and interrupted ones do not count
//   U2 the refusal names the work in plain words
//   U3 install() with work in progress refuses (UPDATE_BUSY): no quit, no installer
//   U4 install() with nothing running asks the app to quit and opens the
//      installer only in completeInstallHandoff(); a second Install is refused
//   U5 a failed installer launch after shutdown is recorded (handoff-failed)
//   U5b an update cut off before its installer opened is reported next start
//   U6 main.js opens the installer only after servers stopped and pending
//      long-operation writes were saved
//   U7 orphan temp files: old ones from a dead writer are moved aside (never
//      deleted, never restored); young, live-writer and own-process ones stay;
//      a missing store is reported; the aside folder keeps 20
//   U8 the renderer asks before discarding unsaved edits and shows a busy
//      refusal as a notice
// Run: node scripts/update-handoff-smoke.js

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const opened = [];
let openResult = "";
require.cache[require.resolve("electron")] = {
  id: "electron", filename: "electron", loaded: true,
  exports: { app: { getPath: () => os.tmpdir(), isPackaged: false }, shell: { openPath: async (target) => { opened.push(target); return openResult; } } },
};

const handoff = require("../src/services/updateHandoffService");
const { recoverOrphanTempFiles, QUARANTINE_DIR, QUARANTINE_KEEP } = require("../src/shared/orphanTempRecovery");

const results = [];
async function check(label, fn) {
  try { await fn(); results.push(`PASS ${label}`); } catch (error) { results.push(`FAIL ${label}\n  ${error.stack || error.message}`); }
}

function preparedManager(dir) {
  delete require.cache[require.resolve("../src/services/updateManager")];
  const { UpdateManager } = require("../src/services/updateManager");
  const manager = new UpdateManager();
  manager.storePath = path.join(dir, "updates.json");
  const installerPath = path.join(dir, `AnxHost-Setup-${crypto.randomBytes(3).toString("hex")}.exe`);
  const payload = crypto.randomBytes(1024);
  fs.writeFileSync(installerPath, payload);
  manager.state.downloadedPath = installerPath;
  manager.state.status = "downloaded";
  manager.state.latest = { latestReleaseVersion: "2.0", latestBuild: 999, asset: { name: path.basename(installerPath), size: payload.length, sha256: crypto.createHash("sha256").update(payload).digest("hex") } };
  manager.verifyInstallerSignature = async () => ({ applicable: true, verified: true, publisher: "AnxLabs test", issuer: "test", timestamped: true });
  return { manager, installerPath };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-update-handoff-"));
  try {
    await check("U1 active operations and running jobs block; finished ones do not", async () => {
      const blocking = await handoff.findBlockingWork({
        listOperations: () => [
          { id: "a", kind: "file-transfer", status: "running" },
          { id: "b", kind: "marketplace-download", status: "queued" },
          { id: "c", kind: "docker-image-pull", status: "completed" },
          { id: "d", kind: "file-transfer", status: "interrupted" },
          { id: "e", kind: "pack", status: "failed" },
        ],
        listInstanceJobs: async () => ({ jobs: [
          { id: "j1", type: "instance.create", state: "running" },
          { id: "j2", type: "instance.stop", state: "succeeded" },
          { id: "j3", type: "instance.update", state: "enqueued" },
        ] }),
      });
      assert.deepStrictEqual(blocking.map((entry) => entry.id), ["a", "b", "j1", "j3"]);
      assert.deepStrictEqual(await handoff.findBlockingWork({ listOperations: () => { throw new Error("store unreadable"); }, listInstanceJobs: async () => { throw new Error("no jobs"); } }), [], "an unreadable store does not block");
    });

    await check("U2 the refusal names the work in plain words", () => {
      const message = handoff.describeBlockingWork([{ label: "a file transfer" }, { label: "a server install" }, { label: "a file transfer" }]);
      assert.strictEqual(message, "Wait until a file transfer and a server install on this PC has finished, then install the update. Closing AnxHost now would cut it off.");
      assert.strictEqual(handoff.describeBlockingWork([]), "");
    });

    await check("U3 work in progress: UPDATE_BUSY, no quit, no installer", async () => {
      const { manager } = preparedManager(dir);
      let quits = 0;
      manager.configureInstallHandoff({ findBlockingWork: async () => [{ label: "a backup", kind: "file-transfer", source: "operation" }], describeBlockingWork: handoff.describeBlockingWork, requestQuit: () => { quits += 1; } });
      opened.length = 0;
      const result = await manager.install();
      assert.strictEqual(result.installed, false);
      assert.strictEqual(result.code, "UPDATE_BUSY");
      assert.match(result.error, /^Wait until a backup on this PC has finished/);
      assert.strictEqual(quits, 0);
      assert.deepStrictEqual(opened, []);
      assert.strictEqual(manager.pendingInstall, null, "nothing recorded as handed off");
    });

    await check("U4 nothing running: quit first, installer opened only after shutdown", async () => {
      const { manager, installerPath } = preparedManager(dir);
      let quits = 0;
      manager.configureInstallHandoff({ findBlockingWork: async () => [], describeBlockingWork: handoff.describeBlockingWork, requestQuit: () => { quits += 1; } });
      opened.length = 0;
      openResult = "";
      const result = await manager.install();
      assert.deepStrictEqual(result, { installed: true, closing: true });
      assert.strictEqual(quits, 1, "the app was asked to quit");
      assert.deepStrictEqual(opened, [], "the installer is not opened while the app is still running");
      assert.strictEqual(manager.pendingInstall.status, "handoff-pending");
      const again = await manager.install();
      assert.strictEqual(again.alreadyRequested, true, "a second Install while closing is refused");
      assert.strictEqual(quits, 1);
      assert.deepStrictEqual(await manager.completeInstallHandoff(), { opened: true });
      assert.deepStrictEqual(opened, [installerPath]);
      assert.strictEqual(manager.pendingInstall.status, "handed-off");
      assert.strictEqual(JSON.parse(fs.readFileSync(manager.storePath, "utf8")).pendingInstall.status, "handed-off", "saved before the app exits");
      assert.deepStrictEqual(await manager.completeInstallHandoff(), { opened: false }, "opened once");
    });

    await check("U5 a failed launch after shutdown is recorded", async () => {
      const { manager } = preparedManager(dir);
      manager.configureInstallHandoff({ requestQuit: () => {} });
      await manager.install();
      openResult = "Access is denied.";
      const result = await manager.completeInstallHandoff();
      openResult = "";
      assert.strictEqual(result.opened, false);
      assert.strictEqual(result.code, "UPDATE_INSTALLER_OPEN_FAILED");
      assert.strictEqual(manager.pendingInstall.status, "handoff-failed");
    });

    await check("U5b an update cut off before its installer opened is reported at the next start", async () => {
      const { manager } = preparedManager(dir);
      manager.pendingInstall = { status: "handoff-pending", targetVersion: "2.0", targetBuild: 999 };
      manager.reconcilePendingInstall();
      assert.strictEqual(manager.pendingInstall.status, "handoff-unconfirmed");
      assert.match(manager.pendingInstall.guidance, /previous version is still running/);
    });

    await check("U6 main.js opens the installer after shutdown and saves pending writes", () => {
      const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
      const start = main.indexOf('app.on("before-quit", (event) => {');
      const body = main.slice(start, main.indexOf("\n});", start));
      const stopAt = body.indexOf("localInstanceService.shutdownInstanceService()");
      const flushAt = body.indexOf("flushPendingWrites()");
      const openAt = body.indexOf("updateManager.completeInstallHandoff()");
      const quitAt = body.lastIndexOf("app.quit()");
      assert.ok(stopAt > 0 && flushAt > stopAt && openAt > flushAt && quitAt > openAt, "servers stop, then writes flush, then the installer opens, then the app quits");
      assert.ok(main.includes("updateManager.configureInstallHandoff({") && main.includes("requestQuit: () => app.quit()"), "the handoff is configured");
      const operations = require("../src/shared/longOperationService");
      assert.strictEqual(typeof operations.flushPendingWrites, "function");
    });

    await check("U7 orphan temp files are moved aside, never deleted or restored", () => {
      const config = path.join(dir, "config");
      fs.mkdirSync(path.join(config, "mobile"), { recursive: true });
      const now = Date.now();
      const write = (name, body, ageMs) => { const file = path.join(config, name); fs.writeFileSync(file, body); const at = new Date(now - ageMs); fs.utimesSync(file, at, at); return file; };
      write("alerts.json", "{}", 0);
      write("alerts.json.15172.1795769144673.tmp", "{\"rules\":[]}", 60 * 60 * 1000);
      write("account.json.4242.17.tmp", "{\"session\":\"old\"}", 60 * 60 * 1000); // store deleted on sign-out
      write("mobile/settings.json.777.tmp", "{\"port\":47800}", 60 * 60 * 1000);
      write("nodes.json.5151.1.tmp", "{}", 30 * 1000); // young: a save may be in progress
      write("telemetry.json.8888.2.tmp", "{}", 60 * 60 * 1000); // writer still running
      write(`notes.json.${process.pid}.3.tmp`, "{}", 60 * 60 * 1000); // this process
      write("notes.txt.999.tmp", "x", 60 * 60 * 1000); // not a JSON store
      const result = recoverOrphanTempFiles(config, { now, isPidAlive: (pid) => pid === 8888 });
      assert.deepStrictEqual(result.quarantined.map((entry) => entry.replace(/\\/g, "/")).sort(), ["account.json.4242.17.tmp", "alerts.json.15172.1795769144673.tmp", "mobile/settings.json.777.tmp"]);
      assert.deepStrictEqual(result.orphanedStore.map((entry) => entry.replace(/\\/g, "/")).sort(), ["account.json", "mobile/settings.json"], "missing stores are reported");
      assert.ok(!fs.existsSync(path.join(config, "account.json")), "a deleted session store is never brought back");
      assert.strictEqual(fs.readFileSync(path.join(config, "alerts.json"), "utf8"), "{}", "an existing store is untouched");
      assert.ok(fs.existsSync(path.join(config, QUARANTINE_DIR, "alerts.json.15172.1795769144673.tmp")), "moved aside, not deleted");
      for (const kept of ["nodes.json.5151.1.tmp", "telemetry.json.8888.2.tmp", `notes.json.${process.pid}.3.tmp`, "notes.txt.999.tmp"]) assert.ok(fs.existsSync(path.join(config, kept)), `${kept} stays`);
      for (let index = 0; index < QUARANTINE_KEEP + 5; index += 1) write(`bulk.json.${100000 + index}.1.tmp`, "{}", 60 * 60 * 1000 + index * 1000);
      recoverOrphanTempFiles(config, { now, isPidAlive: () => false });
      assert.strictEqual(fs.readdirSync(path.join(config, QUARANTINE_DIR)).length, QUARANTINE_KEEP, "the aside folder keeps the newest 20");
    });

    await check("U8 the renderer guards unsaved edits and shows busy as a notice", () => {
      const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
      const start = app.indexOf("async function installUpdate()");
      const body = app.slice(start, app.indexOf("\n}\n", start));
      assert.ok(body.indexOf("hasUnsavedEditsBeforeClosing()") >= 0 && body.indexOf("hasUnsavedEditsBeforeClosing()") < body.indexOf("updates.install"), "asks before installing");
      assert.ok(body.includes('result?.code === "UPDATE_BUSY"') && body.includes("result?.closing"), "handles busy and closing");
      const guard = app.slice(app.indexOf("function hasUnsavedEditsBeforeClosing()"), app.indexOf("async function installUpdate()"));
      for (const name of ["hasDirtyFileEditor", "hasDirtyInstanceFile", "hasUnsavedInstanceSettings", "isGameConfigDirty"]) assert.ok(guard.includes(name), `checks ${name}`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  for (const line of results) console.log(line);
  const failed = results.filter((line) => line.startsWith("FAIL")).length;
  if (failed) { process.exitCode = 1; console.log(`update-handoff-smoke: ${failed} failed`); } else console.log(`update-handoff-smoke passed (${results.length} checks)`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
