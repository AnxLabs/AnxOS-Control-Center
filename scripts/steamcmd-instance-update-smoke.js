const assert = require("assert");
const fs = require("fs");
const {
  classifySteamCmdFailure,
  parseSteamCmdUpdateProgress,
} = require("../src/shared/instances/instanceServiceCore");
const core = fs.readFileSync("src/shared/instances/instanceServiceCore.js", "utf8");
const routes = fs.readFileSync("agent/src/routes/instances.js", "utf8");
const client = fs.readFileSync("src/services/agentClient.js", "utf8");
const installService = fs.readFileSync("src/services/marketplaceInstallService.js", "utf8");
const ui = fs.readFileSync("app.js", "utf8");
const settingsRestoreSource = ui.slice(
  ui.indexOf("function readStoredSettings()"),
  ui.indexOf("function isStartupSoundEnabled()"),
);

assert(core.includes("beginSteamCmdUpdateSession"));
assert(core.includes("repairLegacySteamCmdMetadata"));
assert(core.includes("STEAMCMD_METADATA_MIGRATION_REQUIRED"));
assert(core.includes("LEGACY_STEAMCMD_TEMPLATES"));
assert(core.includes("executeSteamCmdUpdate"));
assert(core.includes("getSteamCmdUpdateStatus"));
assert(core.includes("STEAMCMD_UPDATE_REQUIRES_STOPPED"));
assert(core.includes("STEAMCMD_UPDATE_ARTIFACTS_MISSING"));
assert(core.includes("STEAMCMD_UPDATE_NOT_CONFIRMED"), "SteamCMD exit code alone must not be treated as a successful update.");
assert(core.includes("STEAMCMD_UPDATE_BUILD_UNVERIFIED"), "SteamCMD updates must verify the installed app manifest build.");
assert(core.includes("buildIdBefore") && core.includes("buildIdAfter"), "SteamCMD updates must record before/after build evidence.");
assert(core.includes("steamBuildId: buildIdAfter"), "Verified Steam build metadata must be persisted.");
assert(core.includes("if (existing.child) throw createInstanceError(\"STEAMCMD_UPDATE_CONFLICT\""), "Only an actively running installer may block update-session recovery.");
assert(core.includes("+app_update", "SteamCMD app update command is trusted"));
assert(core.includes('"/usr/games/steamcmd"'), "Debian must resolve the standard SteamCMD installation path.");
assert(core.includes("shell: false"), "SteamCMD must execute without a shell.");
assert(core.includes("recordSteamCmdUpdateOutput"), "SteamCMD stdout and stderr must feed the live status model.");
assert(routes.includes("/steamcmd/update/session"));
assert(routes.includes("/steamcmd/update"));
assert(routes.includes("/steamcmd/update/status"), "The Agent must expose an authorized live update status contract.");
const agentServer = fs.readFileSync("agent/src/server.js", "utf8");
assert(agentServer.includes("isLongInstallerOperation"), "Agent HTTP timeouts must distinguish long-running installer operations.");
assert(agentServer.includes("11 * 60 * 1000"), "Agent must allow SteamCMD to reach its bounded ten-minute execution timeout.");
assert(client.includes("beginSteamCmdUpdateSession"));
assert(client.includes("executeSteamCmdUpdate"));
assert(client.includes("getSteamCmdUpdateStatus"));
assert(installService.includes('operation: "steamcmd-update"'), "SteamCMD updates must resolve the selected Marketplace target.");
assert(installService.includes("const agentConfig = target.agentConfig;"), "SteamCMD updates must use the resolved target Agent configuration.");
assert(installService.includes("getSteamCmdUpdateStatus"), "SteamCMD updates must poll the authorized live status contract.");
assert(installService.includes("registerCancelHandler"), "SteamCMD updates must register a real cancellation handler.");
assert(installService.includes("logs: status.logs"), "SteamCMD logs must synchronize with Download Manager and the console.");
assert(!installService.includes("const agentConfig = resolveMarketplaceAgentConfig(nodeId);"), "SteamCMD updates must not call a resolver that is unavailable in the provider-install service.");
assert(ui.includes('data-instance-action="update-steam"'));
assert(ui.includes("marketplace.updateSteamServer"));
assert(ui.includes("actionResult?.ok === false"), "SteamCMD update UI must surface structured IPC failures.");
assert(ui.includes("Updating server files with SteamCMD..."), "SteamCMD update UI must show progress before the request.");
assert(ui.includes("Server Already Up to Date"), "The UI must distinguish an already-current server.");
assert(ui.includes('confirmLabel: "Restart Server"'), "Successful updates must offer to restart the server.");
assert(ui.includes('button.hidden = !supported'), "Supported SteamCMD instances must keep the Update action visible while running.");
assert(ui.includes("busy || running"), "The Update action must be disabled while the instance is running or another action is busy.");
assert(!settingsRestoreSource.includes('actionName === "update-steam"'), "SteamCMD update state must not leak into settings restoration.");
assert(!ui.includes('updateSteamServer({ instanceId: targetInstanceId, command:'));

assert.deepStrictEqual(
  parseSteamCmdUpdateProgress("Connecting anonymously to Steam Public..."),
  { stage: "connecting", label: "Connecting to Steam...", percent: 1 },
);
assert.strictEqual(
  parseSteamCmdUpdateProgress("Update state (0x61) downloading, progress: 42.5%").stage,
  "downloading",
);
assert.strictEqual(
  parseSteamCmdUpdateProgress("Update state (0x5) verifying install").stage,
  "verifying",
);
assert.deepStrictEqual(
  parseSteamCmdUpdateProgress("Success! App '2394010' fully installed."),
  { stage: "success", label: "Finished successfully.", percent: 100 },
);
assert.strictEqual(classifySteamCmdFailure("ERROR! Invalid App ID"), "STEAMCMD_APP_ID_INVALID");
assert.strictEqual(classifySteamCmdFailure("Could not connect to Steam network"), "STEAMCMD_NETWORK_UNAVAILABLE");
assert.strictEqual(classifySteamCmdFailure("Account does not own this license"), "STEAMCMD_AUTHORIZATION_FAILED");
console.log("SteamCMD instance update smoke checks passed.");
