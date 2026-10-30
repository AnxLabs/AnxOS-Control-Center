#!/usr/bin/env node
"use strict";

// Palworld's PalServer.sh copies linux64/steamclient.so next to the server
// binary only when that copy is missing, so after a SteamCMD update the server
// kept loading a stale Steam client library (found on Anxlab: a July copy
// loaded after the September update). After a verified update, while the
// server is stopped, AnxOS refreshes existing copies atomically.
// Run: node scripts/steamclient-runtime-sync-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { syncSteamClientRuntimeCopies, STEAMCLIENT_RUNTIME_COPIES } = require("../src/shared/instances/instanceServiceCore");

const PALWORLD = 2394010;
let results = 0;
const pass = (label) => { results += 1; console.log(`PASS ${label}`); };

function makeInstall({ source = "steamclient-september", copy = "steamclient-july" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-steamclient-"));
  const write = (relative, content, mode = 0o644) => {
    const target = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    fs.chmodSync(target, mode);
    return target;
  };
  if (source !== null) write("linux64/steamclient.so", source);
  const copyPath = copy !== null ? write("Pal/Binaries/Linux/steamclient.so", copy, 0o755) : path.join(root, "Pal", "Binaries", "Linux", "steamclient.so");
  return { root, copyPath };
}

(async () => {
  assert.deepStrictEqual([...STEAMCLIENT_RUNTIME_COPIES[PALWORLD]], ["Pal/Binaries/Linux/steamclient.so"]);

  // S1: a stale copy is replaced with the updated library, atomically.
  let install = makeInstall();
  const inodeBefore = fs.statSync(install.copyPath).ino;
  let synced = await syncSteamClientRuntimeCopies({ appId: PALWORLD, installDirectory: install.root });
  assert.deepStrictEqual(synced.map(({ target, refreshed, reason }) => ({ target, refreshed, reason })), [{ target: "Pal/Binaries/Linux/steamclient.so", refreshed: true, reason: "updated-from-linux64" }]);
  assert.strictEqual(fs.readFileSync(install.copyPath, "utf8"), "steamclient-september");
  if (process.platform !== "win32") {
    assert.strictEqual(fs.statSync(install.copyPath).mode & 0o777, 0o755, "the copy keeps its permissions");
    assert.notStrictEqual(fs.statSync(install.copyPath).ino, inodeBefore, "replaced by rename (new inode), never rewritten in place");
  }
  assert.deepStrictEqual(fs.readdirSync(path.dirname(install.copyPath)).filter((name) => name.endsWith(".tmp")), [], "no temp file left behind");
  pass("S1 a stale steamclient.so copy is refreshed from linux64 by temp-file + rename, keeping its mode");

  // S2: running it again is a no-op.
  synced = await syncSteamClientRuntimeCopies({ appId: PALWORLD, installDirectory: install.root });
  assert.deepStrictEqual(synced.map((entry) => entry.reason), ["current"]);
  fs.rmSync(install.root, { recursive: true, force: true });
  pass("S2 an up-to-date copy is left alone");

  // S3: a missing copy is not created (the launcher creates it on first start).
  install = makeInstall({ copy: null });
  synced = await syncSteamClientRuntimeCopies({ appId: PALWORLD, installDirectory: install.root });
  assert.deepStrictEqual(synced.map((entry) => entry.reason), ["not-present"]);
  assert.strictEqual(fs.existsSync(install.copyPath), false);
  fs.rmSync(install.root, { recursive: true, force: true });
  pass("S3 a missing copy is not created");

  // S4: other apps and installs without linux64/steamclient.so are untouched.
  install = makeInstall();
  assert.deepStrictEqual(await syncSteamClientRuntimeCopies({ appId: 258550, installDirectory: install.root }), []);
  assert.strictEqual(fs.readFileSync(install.copyPath, "utf8"), "steamclient-july", "a non-Palworld app never touches the file");
  fs.rmSync(install.root, { recursive: true, force: true });
  install = makeInstall({ source: null });
  assert.deepStrictEqual(await syncSteamClientRuntimeCopies({ appId: PALWORLD, installDirectory: install.root }), []);
  assert.strictEqual(fs.readFileSync(install.copyPath, "utf8"), "steamclient-july");
  fs.rmSync(install.root, { recursive: true, force: true });
  pass("S4 other apps and installs without an updated library are untouched");

  // S5: wiring: the update refreshes only after its stopped check and verified build.
  const core = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "instances", "instanceServiceCore.js"), "utf8");
  const update = core.slice(core.indexOf("async function executeSteamCmdUpdate("), core.indexOf("function terminateInstallationSession("));
  const stoppedAt = update.indexOf("STEAMCMD_UPDATE_REQUIRES_STOPPED");
  const verifiedAt = update.indexOf("STEAMCMD_UPDATE_NOT_APPLIED");
  const syncAt = update.indexOf("syncSteamClientRuntimeCopies(");
  assert.ok(stoppedAt > 0 && verifiedAt > stoppedAt && syncAt > verifiedAt, "sync runs only after the stopped check and every verification");
  assert.ok(update.includes("steamClientSync,"), "the update result reports what was refreshed");
  // The Steam API lines stay visible: AnxOS only treats them as non-fatal for health.
  assert.ok(core.includes("[S_API FAIL]\\]\\s+Tried to access Steam interface") || core.includes("S_API FAIL"), "Palworld's S_API lines remain classified, not removed");
  pass("S5 the update refreshes the copy only after the stopped check and a verified build");

  console.log(`steamclient runtime sync smoke passed (${results} checks).`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
