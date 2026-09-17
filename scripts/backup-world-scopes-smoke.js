const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxhub-backup-world-scopes-"));
process.env.AGENT_INSTANCE_ROOT = path.join(root, "instances");
process.env.AGENT_BACKUP_ROOT = path.join(root, "backups");

const backupService = require("../agent/src/services/backupService");
const instanceService = require("../agent/src/services/instances/instanceService");

function createInstanceDir(instanceId) {
  const instancePath = path.join(process.env.AGENT_INSTANCE_ROOT, instanceId);
  fs.mkdirSync(instancePath, { recursive: true });
  return instancePath;
}

function writeInstanceConfig(instancePath, config) {
  fs.writeFileSync(path.join(instancePath, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function writeInstanceFile(instancePath, relativePath, content) {
  const target = path.join(instancePath, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  // Tar entries are stored relative to the instance root with forward slashes,
  // so return the caller-provided relative path for archive assertions.
  return relativePath.replace(/\\/g, "/");
}

function readArchiveEntryNames(backup) {
  const archivePath = path.join(process.env.AGENT_BACKUP_ROOT, backup.archiveName);
  const parsed = backupService._test.parseTarEntries(fs.readFileSync(archivePath));
  return new Set(parsed.entries.map((entry) => entry.name));
}

async function main() {
  assert.strictEqual(typeof instanceService.getWorldScopeCandidates, "function", "Instance service should expose the canonical per-game world-scope candidates.");

  // Minecraft: the recorded game identity resolves through the adapter chain,
  // but the historical generic candidates already match its layout, so world
  // scope must remain byte-identical to the pre-per-game behavior.
  const minecraftPath = createInstanceDir("smoke-mc-world");
  writeInstanceConfig(minecraftPath, {
    id: "smoke-mc-world",
    displayName: "Paper Server",
    type: "minecraft-paper",
    templateId: "minecraft-paper",
    game: "minecraft",
    serverSoftware: "Paper",
    tags: ["minecraft", "paper", "game-server"],
    state: "Stopped",
  });
  const minecraftServerProperties = writeInstanceFile(minecraftPath, "data/server.properties", "level-name=world\n");
  const minecraftLevelDat = writeInstanceFile(minecraftPath, "data/world/level.dat", "mc-level");
  const minecraftRegion = writeInstanceFile(minecraftPath, "data/world/region/r.0.0.mca", "mc-region");
  const minecraftBackup = (await backupService.createBackup({
    instanceId: "smoke-mc-world",
    type: "world",
    name: "smoke-mc-world world backup",
    createdBy: "smoke",
  })).backup;
  assert.deepStrictEqual(
    minecraftBackup.sourcePaths,
    ["data/world"],
    "Minecraft world scope must stay byte-identical to the historical generic candidates.",
  );
  const minecraftEntries = readArchiveEntryNames(minecraftBackup);
  assert(minecraftEntries.has(minecraftLevelDat.replace(/\\/g, "/")), "Minecraft world backup must contain the level file.");
  assert(minecraftEntries.has(minecraftRegion.replace(/\\/g, "/")), "Minecraft world backup must contain region data.");
  assert(!minecraftEntries.has(minecraftServerProperties.replace(/\\/g, "/")), "Minecraft world scope must not pull unrelated server files.");

  // Palworld: the template layout installs the game under data/server, and the
  // server writes saves plus settings under Pal/Saved. World scope must
  // capture Pal/Saved only (deepest sensible set) instead of failing with
  // WORLD_PATH_NOT_FOUND or archiving the whole install.
  const palworldPath = createInstanceDir("smoke-pal-world");
  writeInstanceConfig(palworldPath, {
    id: "smoke-pal-world",
    displayName: "Palworld Dedicated Server",
    type: "custom-command",
    templateId: "palworld",
    game: "Palworld",
    serverSoftware: "Dedicated Server",
    tags: ["palworld", "steamcmd", "game-server"],
    installerType: "steamcmd-native",
    steamAppId: 2394010,
    steamInstallDir: "server",
    workingDirectory: "data/server",
    state: "Stopped",
  });
  const palworldLauncher = writeInstanceFile(palworldPath, "data/server/PalServer.sh", "#!/bin/sh\nexec ./Pal/Binaries/Linux/PalServer-Linux-Shipping\n");
  const palworldBinary = writeInstanceFile(palworldPath, "data/server/Pal/Binaries/Linux/PalServer-Linux-Shipping", "pal-binary");
  writeInstanceFile(palworldPath, "data/server/steamapps/appmanifest_2394010.acf", '"buildid"\t"1234567"');
  const palworldSettings = writeInstanceFile(palworldPath, "data/server/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini", "[/Script/Pal.PalGameWorldSettings]\n");
  const palworldSave = writeInstanceFile(palworldPath, "data/server/Pal/Saved/SaveGames/0/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d/Level.sav", "pal-level");
  const palworldBackup = (await backupService.createBackup({
    instanceId: "smoke-pal-world",
    type: "world",
    name: "smoke-pal-world world backup",
    createdBy: "smoke",
  })).backup;
  assert.deepStrictEqual(
    palworldBackup.sourcePaths,
    ["data/server/Pal/Saved"],
    "Palworld world scope must resolve the template install layout and archive only the save-data directory.",
  );
  const palworldEntries = readArchiveEntryNames(palworldBackup);
  assert(palworldEntries.has(palworldSave.replace(/\\/g, "/")), "Palworld world backup must contain the saved game.");
  assert(palworldEntries.has(palworldSettings.replace(/\\/g, "/")), "Palworld world backup must contain the saved settings.");
  assert(!palworldEntries.has(palworldLauncher.replace(/\\/g, "/")), "Palworld world scope must not pull the server launcher.");
  assert(!palworldEntries.has(palworldBinary.replace(/\\/g, "/")), "Palworld world scope must not pull the game binaries.");

  // FiveM: FXServer runs from data/server; txAdmin operator data and locally
  // deployed resources are the restorable state, while the artifact runtime
  // and cache stay out of world scope.
  const fivemPath = createInstanceDir("smoke-fivem-world");
  writeInstanceConfig(fivemPath, {
    id: "smoke-fivem-world",
    displayName: "FiveM FXServer",
    type: "custom-command",
    templateId: "fivem",
    serverSoftware: "FXServer",
    tags: ["fivem", "fxserver", "gta", "game-server"],
    workingDirectory: "data/server",
    state: "Stopped",
  });
  const fivemRuntime = writeInstanceFile(fivemPath, "data/server/FXServer", "fxserver-binary");
  const fivemRunScript = writeInstanceFile(fivemPath, "data/server/run.sh", "#!/bin/sh\nexec ./FXServer +exec server.cfg\n");
  writeInstanceFile(fivemPath, "data/server/server.cfg", "endpoint_add_tcp \"0.0.0.0:30120\"\n");
  const fivemPlayerlist = writeInstanceFile(fivemPath, "data/server/txData/playerlist.json", "[]");
  const fivemResource = writeInstanceFile(fivemPath, "data/server/resources/[local]/myresource/fxmanifest.lua", "fx_version 'cerulean'\n");
  const fivemCache = writeInstanceFile(fivemPath, "data/server/cache/files/cache.img", "cache-data");
  const fivemArtifact = writeInstanceFile(fivemPath, "data/server/citizen/runtime.dll", "citizen-runtime");
  const fivemBackup = (await backupService.createBackup({
    instanceId: "smoke-fivem-world",
    type: "world",
    name: "smoke-fivem-world world backup",
    createdBy: "smoke",
  })).backup;
  assert.deepStrictEqual(
    fivemBackup.sourcePaths,
    ["data/server/txData", "data/server/resources/[local]"],
    "FiveM world scope must resolve the FXServer data dir operator data.",
  );
  const fivemEntries = readArchiveEntryNames(fivemBackup);
  assert(fivemEntries.has(fivemPlayerlist.replace(/\\/g, "/")), "FiveM world backup must contain txAdmin operator data.");
  assert(fivemEntries.has(fivemResource.replace(/\\/g, "/")), "FiveM world backup must contain locally deployed resources.");
  assert(!fivemEntries.has(fivemCache.replace(/\\/g, "/")), "FiveM world scope must exclude the runtime cache.");
  assert(!fivemEntries.has(fivemArtifact.replace(/\\/g, "/")), "FiveM world scope must exclude the artifact runtime.");
  assert(!fivemEntries.has(fivemRuntime.replace(/\\/g, "/")), "FiveM world scope must exclude the FXServer binary.");
  assert(!fivemEntries.has(fivemRunScript.replace(/\\/g, "/")), "FiveM world scope must exclude the run script.");

  // Terraria: TShock runs from data/server, worlds land in Worlds/ and TShock
  // state (database, configs) in tshock/.
  const terrariaPath = createInstanceDir("smoke-terr-world");
  writeInstanceConfig(terrariaPath, {
    id: "smoke-terr-world",
    displayName: "Terraria TShock",
    type: "custom-command",
    templateId: "terraria-tshock",
    game: "Terraria",
    serverSoftware: "TShock",
    tags: ["terraria", "tshock", "game-server"],
    workingDirectory: "data/server",
    state: "Stopped",
  });
  const terrariaBinary = writeInstanceFile(terrariaPath, "data/server/TShock.Server", "tshock-binary");
  const terrariaWorld = writeInstanceFile(terrariaPath, "data/server/Worlds/world.wld", "terraria-world");
  const terrariaDatabase = writeInstanceFile(terrariaPath, "data/server/tshock/tshock.sqlite", "tshock-database");
  writeInstanceFile(terrariaPath, "data/server/tshock/config.json", "{}");
  const terrariaLog = writeInstanceFile(terrariaPath, "data/server/server.log", "log-line\n");
  const terrariaBackup = (await backupService.createBackup({
    instanceId: "smoke-terr-world",
    type: "world",
    name: "smoke-terr-world world backup",
    createdBy: "smoke",
  })).backup;
  assert.deepStrictEqual(
    terrariaBackup.sourcePaths,
    ["data/server/Worlds", "data/server/tshock"],
    "Terraria world scope must resolve the TShock world and state directories.",
  );
  const terrariaEntries = readArchiveEntryNames(terrariaBackup);
  assert(terrariaEntries.has(terrariaWorld.replace(/\\/g, "/")), "Terraria world backup must contain the world file.");
  assert(terrariaEntries.has(terrariaDatabase.replace(/\\/g, "/")), "Terraria world backup must contain the TShock database.");
  assert(!terrariaEntries.has(terrariaBinary.replace(/\\/g, "/")), "Terraria world scope must exclude the TShock binary.");
  assert(!terrariaEntries.has(terrariaLog.replace(/\\/g, "/")), "Terraria world scope must exclude unrelated server files.");

  // Unknown game: world scope must fall back to the generic Minecraft-style
  // candidates exactly as before the per-game resolution existed.
  const unknownPath = createInstanceDir("smoke-custom-world");
  writeInstanceConfig(unknownPath, {
    id: "smoke-custom-world",
    displayName: "Custom App",
    state: "Stopped",
  });
  const unknownWorldFile = writeInstanceFile(unknownPath, "data/world/level.dat", "custom-level");
  const unknownBackup = (await backupService.createBackup({
    instanceId: "smoke-custom-world",
    type: "world",
    name: "smoke-custom-world world backup",
    createdBy: "smoke",
  })).backup;
  assert.deepStrictEqual(
    unknownBackup.sourcePaths,
    ["data/world"],
    "Instances without a recognized game identity must keep the generic world candidates.",
  );
  assert(readArchiveEntryNames(unknownBackup).has(unknownWorldFile.replace(/\\/g, "/")), "Unknown game world backup must archive the generic world directory.");

  // Known game whose save layout has not been created yet (fresh install with
  // no server start): the documented WORLD_PATH_NOT_FOUND error must remain
  // so the renderer keeps steering users to full scope.
  const palworldEmptyPath = createInstanceDir("smoke-pal-empty");
  writeInstanceConfig(palworldEmptyPath, {
    id: "smoke-pal-empty",
    displayName: "Palworld No Saves",
    type: "custom-command",
    templateId: "palworld",
    tags: ["palworld", "steamcmd", "game-server"],
    installerType: "steamcmd-native",
    steamAppId: 2394010,
    steamInstallDir: "server",
    state: "Stopped",
  });
  writeInstanceFile(palworldEmptyPath, "data/server/PalServer.sh", "#!/bin/sh\n");
  await assert.rejects(
    () => backupService.createBackup({
      instanceId: "smoke-pal-empty",
      type: "world",
      name: "smoke-pal-empty world backup",
      createdBy: "smoke",
    }),
    (error) => error?.code === "WORLD_PATH_NOT_FOUND",
    "Known games without any recognized save layout must keep the documented WORLD_PATH_NOT_FOUND error.",
  );

  // Pin the per-game layout knowledge in the shared instance service core.
  const coreSource = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "instances", "instanceServiceCore.js"), "utf8");
  [
    "function getWorldScopeCandidates",
    "server/txData",
    "server/resources/[local]",
    "server/Pal/Saved",
    "server/Worlds",
    "server/tshock",
  ].forEach((needle) => assert(coreSource.includes(needle), `Per-game world-scope pinning missing in instance service core: ${needle}`));

  // Pin the renderer labeling source strings: the World option must be labeled
  // with the resolved game and the dialog must surface the no-layout message.
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  [
    "const BACKUP_WORLD_GAME_LABELS = Object.freeze({",
    "function getBackupWorldGameLabel",
    "BACKUP_WORLD_GAME_LABELS[getInstanceAccessGameKind(instance)] || null",
    "World data (${gameLabel}) will be included. Choose World Backup for world-only data, or Cancel to create a full instance backup.",
    "This instance does not have a recognized world data layout, so World Backup may not be available. Cancel to create a full instance backup, or continue to try a World Backup.",
    "confirmLabel: gameLabel ? `World Backup (${gameLabel})` : \"World Backup\",",
    "await chooseBackupType(\"Create world-only backup?\", findInstance(targetInstanceId) || null, { offerPause: true })",
    "await chooseBackupType(\"Schedule world-only backups?\", findInstance(instanceId) || null)",
  ].forEach((needle) => assert(appSource.includes(needle), `Backup world-scope renderer pinning missing: ${needle}`));

  fs.rmSync(root, { recursive: true, force: true });
  console.log("backup-world-scopes-smoke passed");
}

main().catch((error) => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  console.error(error);
  process.exit(1);
});
