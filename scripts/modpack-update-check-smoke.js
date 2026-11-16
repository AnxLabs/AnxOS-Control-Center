#!/usr/bin/env node
// Modpack update checks (Build 213-E): servers installed from a Modrinth or
// CurseForge modpack are compared with newer versions of the same pack for
// the same Minecraft version and loader. Hermetic: the resolver seam replaces
// the network.
//   K1 a Modrinth modpack server gets a modpack target, not a Minecraft one
//   K2 a newer pack version is reported with the installed label and a link
//   K3 the same version is up to date
//   K4 a CurseForge modpack server is tracked by its file id
//   K5 unsafe ids or a missing installed version are not checked
//   K6 a modpack server whose software reads "vanilla" is never told to
//      move to a new Minecraft release
const assert = require("assert");
const marketplace = require("../src/services/marketplaceService");

const { getServerVersionCheckTarget } = marketplace._test;
const modrinthServer = { id: "cobble", provider: "modrinth", providerProjectId: "cobblemon-pack", providerVersionId: "AbC123", modpackVersion: "1.5.2", minecraftVersion: "1.21.1", loader: "Fabric", serverSoftware: "fabric", game: "minecraft" };

(async () => {
  let clockMs = 1_000_000;
  marketplace._test.resetServerVersionChecks();
  marketplace._test.setServerVersionCheckClock(() => clockMs);

  // K1
  const target = getServerVersionCheckTarget(modrinthServer);
  assert.strictEqual(target.kind, "modrinth-modpack");
  assert.strictEqual(target.track, "modrinth-modpack:cobblemon-pack:1.21.1:fabric");
  assert.strictEqual(target.installedVersion, "AbC123");
  console.log("  ok K1 modpack target");

  // K2
  const asked = [];
  marketplace._test.setServerVersionLatestResolver(async (resolverTarget) => { asked.push(resolverTarget.kind); return "XyZ789"; });
  const newer = await marketplace.checkServerVersionUpdate(modrinthServer, { refresh: true });
  assert.deepStrictEqual(asked, ["modrinth-modpack"]);
  assert.strictEqual(newer.updateAvailable, true);
  assert.strictEqual(newer.checkOnly, true, "detection only; nothing is applied");
  assert(/installed 1\.5\.2/.test(newer.note) && /back up first/.test(newer.note) && /does not apply modpack updates yet/.test(newer.note), newer.note);
  assert.strictEqual(newer.link, "https://modrinth.com/modpack/cobblemon-pack");
  console.log("  ok K2 newer version reported with label and link");

  // K3
  marketplace._test.resetServerVersionChecks();
  clockMs += 10 * 60 * 60 * 1000;
  marketplace._test.setServerVersionLatestResolver(async () => "AbC123");
  const same = await marketplace.checkServerVersionUpdate(modrinthServer, { refresh: true });
  assert.strictEqual(same.updateAvailable, false);
  console.log("  ok K3 same version is up to date");

  // K4
  const curse = getServerVersionCheckTarget({ provider: "curseforge", providerProjectId: "925200", providerFileId: "5551234", minecraftVersion: "1.20.1", loader: "forge" });
  assert.strictEqual(curse.kind, "curseforge-modpack");
  assert.strictEqual(curse.installedVersion, "5551234");
  assert.strictEqual(curse.link, "https://www.curseforge.com/projects/925200");
  console.log("  ok K4 CurseForge tracked by file id");

  // K5
  assert.strictEqual(getServerVersionCheckTarget({ provider: "modrinth", providerProjectId: "../etc", providerVersionId: "x", minecraftVersion: "1.21.1" }), null);
  assert.strictEqual(getServerVersionCheckTarget({ provider: "modrinth", providerProjectId: "pack", providerVersionId: "", minecraftVersion: "1.21.1" }), null);
  console.log("  ok K5 unsafe or incomplete records are not checked");

  // K6
  const vanillaLabel = getServerVersionCheckTarget({ ...modrinthServer, serverSoftware: "vanilla" });
  assert.strictEqual(vanillaLabel.kind, "modrinth-modpack", "never minecraft-release for a modpack");
  console.log("  ok K6 a modpack is never told to change Minecraft version");

  marketplace._test.setServerVersionLatestResolver(null);
  console.log("Modpack update check smoke passed (6 cases).");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
