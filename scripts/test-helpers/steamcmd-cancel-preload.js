"use strict";

// Loaded with --require into a disposable test Agent only
// (scripts/steamcmd-cancel-ui-qa.js through the service-managed fixture).
// It makes a SteamCMD update observable and holdable without SteamCMD:
// - SteamCMD is a fake path; a spawn of it is recorded in spawns.log and
//   finishes as a successful update to build 42 (no real process starts);
// - the pre-update backup waits for <control>/release-backup;
// - the Steam build lookup (which holds the SteamCMD lock) waits for
//   <control>/release-lookup;
// - ANXOS_QA_LEGACY_STATUS=1 drops cancelBeforeStart from the update status,
//   so the desktop sees what an Agent before Build 213 reports.

const childProcess = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { PassThrough } = require("stream");

const control = process.env.ANXOS_QA_STEAM_CONTROL;
if (!control) throw new Error("ANXOS_QA_STEAM_CONTROL is required");
fs.mkdirSync(control, { recursive: true });
const repo = process.env.AGENT_REPO_ROOT;
const core = require(path.join(repo, "src", "shared", "instances", "instanceServiceCore"));
const FAKE_STEAMCMD = path.join(control, "fake-steamcmd");
const mark = (name) => fs.writeFileSync(path.join(control, name), new Date().toISOString());
const released = (name) => new Promise((resolve) => {
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(control, name))) { clearInterval(timer); resolve(); }
  }, 50);
});

core._test.setSteamCmdExecutable(FAKE_STEAMCMD);
const realSpawn = childProcess.spawn;
childProcess.spawn = function spawn(command, args, options) {
  if (command !== FAKE_STEAMCMD) return realSpawn.call(this, command, args, options);
  fs.appendFileSync(path.join(control, "spawns.log"), `${JSON.stringify(args)}\n`);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  const finish = (code, signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code; child.signalCode = signal;
    child.emit("exit", code, signal);
    child.stdout.end(); child.stderr.end();
    child.emit("close", code, signal);
  };
  child.kill = () => { setImmediate(() => finish(null, "SIGKILL")); return true; };
  const installDir = args[args.indexOf("+force_install_dir") + 1];
  const appId = args[args.indexOf("+app_update") + 1];
  setTimeout(() => {
    const manifest = path.join(installDir, "steamapps", `appmanifest_${appId}.acf`);
    fs.writeFileSync(manifest, `"AppState"\n{\n\t"StateFlags"\t\t"4"\n\t"buildid"\t\t"42"\n}\n`);
    child.stdout.write(`Success! App '${appId}' fully installed.\n`);
    finish(0, null);
  }, 300);
  return child;
};

core._test.setSteamAppInfoRunner(async (config) => {
  mark("lookup-started");
  await released("release-lookup");
  return { exitCode: 0, stdout: `"${config.steamAppId}"\n{\n"depots"\n{\n"branches"\n{\n"public"\n{\n"buildid" "42"\n}\n}\n}\n}\n` };
});

if (process.env.ANXOS_QA_LEGACY_STATUS === "1") {
  // Before the Agent's routes take their references (they load after this).
  const status = core.getSteamCmdUpdateStatus;
  core.getSteamCmdUpdateStatus = async (...args) => {
    const result = await status(...args);
    delete result.cancelBeforeStart;
    return result;
  };
}

// After the Agent configured its real backup provider at load.
setImmediate(() => core.configureInstanceService({
  createPreUpdateBackup: async () => {
    mark("backup-started");
    await released("release-backup");
    return { backup: { id: "qa-pre-update", name: "QA pre-update backup", createdAt: new Date().toISOString() } };
  },
}));
