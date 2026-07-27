"use strict";

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const manager = require("../src/shared/gameServerConfigManager");
const instanceService = require("../src/shared/instances/instanceServiceCore");

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anxos-game-config-"));
  instanceService.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });

  await testMinecraft(root);
  await testPalworld(root);
  await testUnsupportedAndTraversal(root);

  console.log("game-server-config-smoke passed");
}

async function testMinecraft(root) {
  const id = "mc-config-smoke";
  await instanceService.createInstance({
    id,
    type: "minecraft-paper",
    displayName: "Minecraft Config Smoke",
    workingDirectory: "data",
    executable: "java",
    args: ["-jar", "server.jar", "nogui"],
    game: "minecraft",
    tags: ["minecraft"],
  });
  const filePath = path.join(root, id, "data", "server.properties");
  await fs.writeFile(filePath, [
    "# keep this comment",
    "server-port=25565",
    "unknown-feature=keep-me",
    "motd=Original MOTD",
    "",
  ].join("\n"), "utf8");

  const loaded = await instanceService.readGameServerConfig(id);
  assert.strictEqual(loaded.adapterId, "minecraft");
  assert.strictEqual(loaded.filePath, "server.properties");
  assert.strictEqual(loaded.values["server-port"], 25565);
  assert.strictEqual(loaded.values.motd, "Original MOTD");

  await assert.rejects(
    () => instanceService.writeGameServerConfig(id, {
      adapterId: "minecraft",
      sourceHash: loaded.sourceHash,
      values: { "server-port": 70000 },
    }),
    /CONFIG_VALIDATION_FAILED/,
  );

  const saved = await instanceService.writeGameServerConfig(id, {
    adapterId: "minecraft",
    sourceHash: loaded.sourceHash,
    values: { "server-port": 25566, motd: "Updated MOTD", pvp: false },
  });
  assert.strictEqual(saved.saved, true);
  assert.strictEqual(saved.restartRequired, true);
  assert.ok(saved.backupPath, "backup path returned");
  assert.ok(await exists(path.join(root, id, "data", saved.backupPath)), "backup was created");

  const text = await fs.readFile(filePath, "utf8");
  assert.match(text, /# keep this comment/);
  assert.match(text, /unknown-feature=keep-me/);
  assert.match(text, /server-port=25566/);
  assert.match(text, /motd=Updated MOTD/);

  await fs.writeFile(filePath, `${text}external-change=true\n`, "utf8");
  await assert.rejects(
    () => instanceService.writeGameServerConfig(id, {
      adapterId: "minecraft",
      sourceHash: saved.sourceHash,
      values: { motd: "Lost update" },
    }),
    /CONFIG_MODIFIED_EXTERNALLY/,
  );
}

async function testPalworld(root) {
  const id = "pal-config-smoke";
  await instanceService.createInstance({
    id,
    type: "custom-command",
    displayName: "Palworld Config Smoke",
    workingDirectory: "data/server",
    executable: "bash",
    args: ["-lc", "exec ./PalServer.sh -port=8211 -players=32"],
    game: "palworld",
    templateId: "palworld",
    tags: ["palworld", "steamcmd", "game-server"],
    steamInstallDir: "server",
    steamAppId: 2394010,
  });
  const palPath = path.join(root, id, "data", "server", "Pal", "Saved", "Config", "LinuxServer", "PalWorldSettings.ini");
  await fs.mkdir(path.dirname(palPath), { recursive: true });
  await fs.writeFile(palPath, [
    "[/Script/Pal.PalGameWorldSettings]",
    "OptionSettings=(Difficulty=None,ServerName=\"Original Pal\",ServerDescription=\"Line one\",AdminPassword=\"top-secret\",ServerPassword=\"join-secret\",PublicPort=8211,RCONEnabled=False,RCONPort=25575,ServerPlayerMaxNum=32,bIsPvP=False,UnknownPalOption=42)",
    "",
  ].join("\n"), "utf8");

  const loaded = await instanceService.readGameServerConfig(id);
  assert.strictEqual(loaded.adapterId, "palworld");
  assert.strictEqual(loaded.filePath, "server/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini");
  assert.strictEqual(loaded.values.AdminPassword, "[REDACTED]");
  assert.strictEqual(loaded.fields.find((field) => field.key === "AdminPassword").hasCurrentValue, true);

  const parsed = manager.parsePalworldDocument(await fs.readFile(palPath, "utf8"));
  assert.strictEqual(manager._test.readDocumentValues(manager.getAdapter("palworld"), parsed).UnknownPalOption, 42);

  const saved = await instanceService.writeGameServerConfig(id, {
    adapterId: "palworld",
    sourceHash: loaded.sourceHash,
    values: { ServerName: "Updated Pal", PublicPort: 8212, bIsPvP: true },
  });
  assert.strictEqual(saved.restartRequired, true);
  assert.ok(saved.backupPath, "palworld backup path returned");
  const text = await fs.readFile(palPath, "utf8");
  assert.match(text, /ServerName="Updated Pal"/);
  assert.match(text, /AdminPassword="top-secret"/);
  assert.match(text, /ServerPassword="join-secret"/);
  assert.match(text, /UnknownPalOption=42/);
  assert.doesNotMatch(JSON.stringify(loaded), /top-secret|join-secret/);
}

async function testUnsupportedAndTraversal(root) {
  await instanceService.createInstance({
    id: "unsupported-config-smoke",
    type: "custom-command",
    displayName: "Unsupported Config Smoke",
    workingDirectory: "data",
    executable: "node",
    args: ["server.js"],
  });
  const unsupported = await instanceService.readGameServerConfig("unsupported-config-smoke");
  assert.strictEqual(unsupported.supported, false);

  await instanceService.createInstance({
    id: "pal-traversal-smoke",
    type: "custom-command",
    displayName: "Palworld Traversal Smoke",
    workingDirectory: "data",
    executable: "bash",
    args: ["-lc", "exec ./PalServer.sh"],
    game: "palworld",
    steamInstallDir: "../outside",
  });
  await assert.rejects(
    () => instanceService.readGameServerConfig("pal-traversal-smoke"),
    /PATH_NOT_ALLOWED|INVALID_PATH/,
  );
}

async function exists(filePath) {
  return Boolean(await fs.stat(filePath).catch(() => null));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
