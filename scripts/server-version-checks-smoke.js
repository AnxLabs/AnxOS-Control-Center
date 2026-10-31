// Update checks beyond SteamCMD: Paper, Vanilla, FiveM and Hytale servers
// compare the version recorded at install time with the latest upstream
// version (via the Marketplace resolvers). Hermetic: a fake resolver replaces
// the network.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const marketplace = require("../src/services/marketplaceService");
const { getServerVersionCheckTarget } = marketplace._test;

const instances = {
  paper: { id: "paper", serverSoftware: "Paper", minecraftVersion: "1.21.4", paperBuild: "220" },
  vanilla: { id: "vanilla", serverSoftware: "Vanilla", minecraftVersion: "1.21.3" },
  fivem: { id: "fivem", templateId: "fivem", serverVersion: "12913-8bd84d0be4a3f2b4c1e3b06c1b8d1e2d8a4c90f0" },
  fivemWindows: { id: "fivem-win", templateId: "fivem-windows", serverVersion: "12913-8bd84d0be4" },
  hytale: { id: "hytale", templateId: "hytale", serverVersion: "2026.10.1-abc" },
  forge: { id: "forge", serverSoftware: "Forge", minecraftVersion: "1.20.1" },
  steam: { id: "palworld", installerType: "steamcmd-native", steamAppId: 2394010, serverSoftware: "Palworld" },
};

function targetChecks() {
  assert.deepStrictEqual(getServerVersionCheckTarget(instances.paper), { kind: "paper", track: "paper:1.21.4", minecraftVersion: "1.21.4", installedVersion: "220" });
  assert.strictEqual(getServerVersionCheckTarget(instances.vanilla).kind, "minecraft-release");
  assert.deepStrictEqual({ kind: getServerVersionCheckTarget(instances.fivem).kind, track: getServerVersionCheckTarget(instances.fivem).track }, { kind: "fivem", track: "fivem-linux" });
  assert.strictEqual(getServerVersionCheckTarget(instances.fivemWindows).track, "fivem-windows");
  assert.strictEqual(getServerVersionCheckTarget(instances.hytale).kind, "hytale");
  assert.strictEqual(getServerVersionCheckTarget(instances.forge), null, "Unsupported software is not checked.");
  assert.strictEqual(getServerVersionCheckTarget(instances.steam), null, "SteamCMD servers use the Steam check instead.");
  assert.strictEqual(getServerVersionCheckTarget({ serverSoftware: "Paper", minecraftVersion: "1.21.4", paperBuild: "220; rm" }), null, "Malformed recorded versions are ignored.");
}

async function checkChecks() {
  let clockMs = Date.parse("2026-10-31T12:00:00Z");
  const lookups = [];
  let latest = { paper: "231", "minecraft-release": "1.21.4", fivem: "13050-aaaaaaaa", hytale: "2026.10.1-abc" };
  let failNext = false;
  marketplace._test.resetServerVersionChecks();
  marketplace._test.setServerVersionCheckClock(() => clockMs);
  marketplace._test.setServerVersionLatestResolver(async (target) => {
    lookups.push(target.track);
    if (failNext) {
      failNext = false;
      throw Object.assign(new Error("offline"), { code: "DOWNLOAD_RESOLVE_FAILED" });
    }
    return latest[target.kind];
  });

  let result = await marketplace.checkServerVersionUpdate(instances.paper);
  assert.deepStrictEqual({ available: result.updateAvailable, installed: result.installedVersion, latest: result.latestVersion, checkOnly: result.checkOnly }, { available: true, installed: "220", latest: "231", checkOnly: true });
  assert.match(result.note, /Paper build 231 is available for Minecraft 1\.21\.4/);

  result = await marketplace.checkServerVersionUpdate(instances.vanilla);
  assert.strictEqual(result.updateAvailable, true);
  assert.match(result.note, /upgrades the world, so back up first/, "A Minecraft release update warns about world upgrades.");

  result = await marketplace.checkServerVersionUpdate(instances.fivem);
  assert.strictEqual(result.updateAvailable, true, "A higher FXServer artifact number is an update.");
  latest.fivem = "12000-bbbbbbbb";
  marketplace._test.resetServerVersionChecks();
  result = await marketplace.checkServerVersionUpdate(instances.fivem);
  assert.strictEqual(result.updateAvailable, false, "An older listed artifact is not an update.");

  result = await marketplace.checkServerVersionUpdate(instances.hytale);
  assert.strictEqual(result.updateAvailable, false);
  assert.strictEqual(result.link, null);

  // The FiveM step reset the cache, so prime the Paper track again first.
  await marketplace.checkServerVersionUpdate(instances.paper);
  const before = lookups.length;
  await marketplace.checkServerVersionUpdate(instances.paper);
  await marketplace.checkServerVersionUpdate(instances.paper, { refresh: true });
  assert.strictEqual(lookups.length, before, "Cached within the TTL, and a forced refresh within the floor does not re-query.");
  clockMs += 3 * 60 * 1000;
  failNext = true;
  result = await marketplace.checkServerVersionUpdate(instances.paper, { refresh: true });
  assert.strictEqual(lookups.length, before + 1);
  assert.deepStrictEqual({ error: result.error, latest: result.latestVersion }, { error: "DOWNLOAD_RESOLVE_FAILED", latest: "231" }, "A failed lookup keeps the last known version.");

  const unsupported = await marketplace.checkServerVersionUpdate(instances.forge);
  assert.deepStrictEqual(unsupported, { supported: false, updateAvailable: null });
  marketplace._test.setServerVersionLatestResolver(null);
  marketplace._test.setServerVersionCheckClock(null);
}

function rendererChecks() {
  const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const extract = (name) => {
    const start = source.indexOf(`function ${name}(`);
    const open = source.indexOf("{", source.indexOf(")", start));
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(name);
  };
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${extract("isSteamCmdUpdateInstance")}\n${extract("isServerVersionCheckable")}\nthis.checkable = isServerVersionCheckable;`, context);
  for (const [name, expected] of [["paper", true], ["vanilla", true], ["fivem", true], ["hytale", true], ["forge", false], ["steam", false]]) {
    assert.strictEqual(context.checkable(instances[name]), expected, `Renderer asks for ${name}: ${expected}`);
  }
  const ipc = fs.readFileSync(path.join(__dirname, "..", "src", "ipc", "instancesIpc.js"), "utf8");
  assert(ipc.includes('"instances:checkServerUpdate"') && ipc.includes('requirePermission("instance:read", payload.instanceId);\n    const status = await getInstanceStatus'), "The check is instance:read and reads the instance from its node.");
  assert(source.includes("Update the server files manually"), "The badge says the update itself is manual.");
}

async function main() {
  targetChecks();
  await checkChecks();
  rendererChecks();
  console.log("Server version checks smoke passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
