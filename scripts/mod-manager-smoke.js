// Mod Manager: Modrinth mods/plugins for Fabric, Forge, NeoForge, Quilt,
// Paper and Purpur servers. Hermetic: a fake Modrinth provider and an
// in-memory instance file system stand in for the network and the Agent.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const mods = require("../src/services/modManagerService");

const sha512 = (buffer) => crypto.createHash("sha512").update(buffer).digest("hex");
const jar = (name) => Buffer.from(`jar:${name}`);

function createWorld() {
  const files = new Map();
  let instance = { id: "fabric-server", serverSoftware: "Fabric", minecraftVersion: "1.21.1", workingDirectory: "data" };
  const downloads = [];
  const versions = {
    lithium: [
      { id: "lith-1", projectId: "lithium", versionNumber: "0.13.0", type: "release", datePublished: "2026-09-01", minecraftVersions: ["1.21.1"], loaders: ["fabric"], dependencies: [{ project_id: "fabricapi", dependency_type: "required" }, { project_id: "optional-thing", dependency_type: "optional" }], files: [{ url: "https://cdn.modrinth.com/data/lithium/lithium-0.13.0.jar", filename: "lithium-0.13.0.jar", size: 10, hashes: { sha512: sha512(jar("lithium-0.13.0.jar")) }, primary: true }] },
      { id: "lith-old-mc", projectId: "lithium", versionNumber: "0.12.0", type: "release", datePublished: "2026-10-01", minecraftVersions: ["1.20.4"], loaders: ["fabric"], dependencies: [], files: [] },
    ],
    fabricapi: [
      { id: "fapi-1", projectId: "fabricapi", versionNumber: "0.100.0", type: "release", datePublished: "2026-09-01", minecraftVersions: ["1.21.1"], loaders: ["fabric"], dependencies: [], files: [{ url: "https://cdn.modrinth.com/data/fabricapi/fabric-api-0.100.0.jar", filename: "fabric-api-0.100.0.jar", size: 10, hashes: { sha512: sha512(jar("fabric-api-0.100.0.jar")) }, primary: true }] },
    ],
    badhash: [
      { id: "bad-1", projectId: "badhash", versionNumber: "1", type: "release", datePublished: "2026-09-01", minecraftVersions: ["1.21.1"], loaders: ["fabric"], dependencies: [], files: [{ url: "https://cdn.modrinth.com/data/badhash/bad.jar", filename: "bad.jar", size: 10, hashes: { sha512: "0".repeat(128) }, primary: true }] },
    ],
    offcdn: [
      { id: "off-1", projectId: "offcdn", versionNumber: "1", type: "release", datePublished: "2026-09-01", minecraftVersions: ["1.21.1"], loaders: ["fabric"], dependencies: [], files: [{ url: "https://evil.example.com/x.jar", filename: "x.jar", size: 10, hashes: { sha512: sha512(jar("x.jar")) }, primary: true }] },
    ],
    traversal: [
      { id: "trav-1", projectId: "traversal", versionNumber: "1", type: "release", datePublished: "2026-09-01", minecraftVersions: ["1.21.1"], loaders: ["fabric"], dependencies: [], files: [{ url: "https://cdn.modrinth.com/data/t/evil.jar", filename: "../../config.json", size: 10, hashes: { sha512: "1".repeat(128) }, primary: true }] },
    ],
  };
  const provider = {
    searchServerProjects: async (options) => ({ hits: [{ id: "lithium", name: "Lithium", author: "Caffeine", downloads: 5 }], total: 1, received: options }),
    getProject: async (id) => ({ id, name: id === "fabricapi" ? "Fabric API" : id[0].toUpperCase() + id.slice(1), projectUrl: `https://modrinth.com/mod/${id}` }),
    getVersions: async (id) => versions[id] || [],
    downloadVersionFiles: async (version) => {
      const file = version.files[0];
      downloads.push(file.url);
      return [{ fileName: file.filename, buffer: jar(file.filename) }];
    },
  };
  mods.configureModManager({
    provider,
    files: {
      status: async () => ({ instance }),
      list: async (instanceId, folder) => {
        const prefix = `${folder}/`;
        const entries = [...files.keys()].filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/")).map((key) => ({ name: key.slice(prefix.length), type: "file", size: files.get(key).length }));
        if (!entries.length && ![...files.keys()].some((key) => key.startsWith(prefix))) throw Object.assign(new Error("missing"), { code: "PATH_NOT_FOUND" });
        return { entries };
      },
      read: async (instanceId, filePath) => {
        if (!files.has(filePath)) throw Object.assign(new Error("missing"), { code: "FILE_NOT_FOUND" });
        return { content: files.get(filePath).toString("utf8") };
      },
      write: async (instanceId, filePath, content, options = {}) => {
        files.set(filePath, options.encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(String(content)));
      },
      remove: async (instanceId, filePath) => {
        assert(files.delete(filePath), `deleted ${filePath}`);
      },
      rename: async (instanceId, from, to) => {
        assert(files.has(from), `rename source ${from}`);
        files.set(to, files.get(from));
        files.delete(from);
      },
    },
  });
  return { files, versions, downloads, setInstance: (next) => { instance = next; } };
}

function contextChecks() {
  assert.deepStrictEqual(mods.getModContext({ serverSoftware: "Fabric", minecraftVersion: "1.21.1", workingDirectory: "data" }), { software: "fabric", minecraftVersion: "1.21.1", projectType: "mod", loaders: ["fabric"], folder: "mods" });
  assert.strictEqual(mods.getModContext({ serverSoftware: "Paper", minecraftVersion: "1.21.4", workingDirectory: "data/server" }).folder, "server/plugins", "Plugins live next to the server jar.");
  assert.deepStrictEqual(mods.getModContext({ serverSoftware: "Quilt", minecraftVersion: "1.20.1" }).loaders, ["quilt", "fabric"], "Quilt also accepts Fabric mods.");
  assert.strictEqual(mods.getModContext({ serverSoftware: "Vanilla", minecraftVersion: "1.21.1" }), null);
  assert.strictEqual(mods.getModContext({ serverSoftware: "Fabric" }), null, "A known Minecraft version is required.");
  assert.strictEqual(mods.getModContext({ serverSoftware: "Fabric", minecraftVersion: "1.21.1", workingDirectory: "data/../../etc" }), null, "A working directory that escapes is refused.");
}

async function lifecycleChecks() {
  const world = createWorld();
  let listed = await mods.listMods({ instanceId: "fabric-server" });
  assert.deepStrictEqual(listed.mods, [], "An instance without a mods folder lists nothing.");

  const search = await mods.searchMods({ instanceId: "fabric-server", query: "lith" });
  assert.deepStrictEqual(search.received, { query: "lith", projectType: "mod", minecraftVersion: "1.21.1", loaders: ["fabric"], limit: undefined, offset: undefined }, "Search is scoped to the server's version and loader.");

  const installed = await mods.installMod({ instanceId: "fabric-server", projectId: "lithium" });
  assert.deepStrictEqual(installed.installed, ["lithium-0.13.0.jar", "fabric-api-0.100.0.jar"], "Required dependencies are installed too; optional ones are not.");
  assert(world.files.get("mods/lithium-0.13.0.jar").equals(jar("lithium-0.13.0.jar")), "The verified bytes are written.");
  const manifest = JSON.parse(world.files.get(`mods/${mods.MANIFEST_NAME}`).toString("utf8"));
  assert.strictEqual(manifest.mods["lithium-0.13.0.jar"].versionId, "lith-1");
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "lithium" }), (error) => error.code === "MOD_ALREADY_INSTALLED");

  world.files.set("mods/handmade.jar", jar("handmade"));
  listed = await mods.listMods({ instanceId: "fabric-server" });
  assert.deepStrictEqual(listed.mods.map((mod) => `${mod.title}:${mod.source}:${mod.enabled}`), ["Fabric API:modrinth:true", "handmade.jar:manual:true", "Lithium:modrinth:true"]);

  await mods.setModEnabled({ instanceId: "fabric-server", fileName: "handmade.jar", enabled: false });
  assert(world.files.has("mods/handmade.jar.disabled") && !world.files.has("mods/handmade.jar"), "Disabling renames the jar so the server skips it.");
  listed = await mods.listMods({ instanceId: "fabric-server" });
  assert.strictEqual(listed.mods.find((mod) => mod.fileName === "handmade.jar").enabled, false);
  await mods.setModEnabled({ instanceId: "fabric-server", fileName: "handmade.jar", enabled: true });
  assert(world.files.has("mods/handmade.jar"));

  assert.deepStrictEqual((await mods.checkModUpdates({ instanceId: "fabric-server" })).updates, []);
  world.versions.lithium.unshift({ id: "lith-2", projectId: "lithium", versionNumber: "0.14.0", type: "release", datePublished: "2026-10-20", minecraftVersions: ["1.21.1"], loaders: ["fabric"], dependencies: [], files: [{ url: "https://cdn.modrinth.com/data/lithium/lithium-0.14.0.jar", filename: "lithium-0.14.0.jar", size: 10, hashes: { sha512: sha512(jar("lithium-0.14.0.jar")) }, primary: true }] });
  const updates = (await mods.checkModUpdates({ instanceId: "fabric-server" })).updates;
  assert.deepStrictEqual(updates.map((update) => `${update.fileName}->${update.latestVersion}`), ["lithium-0.13.0.jar->0.14.0"], "Only AnxOS-installed mods with a newer compatible version are offered.");
  const updated = await mods.updateMod({ instanceId: "fabric-server", fileName: "lithium-0.13.0.jar" });
  assert.deepStrictEqual({ to: updated.fileName, from: updated.previousFileName }, { to: "lithium-0.14.0.jar", from: "lithium-0.13.0.jar" });
  assert(world.files.has("mods/lithium-0.14.0.jar") && !world.files.has("mods/lithium-0.13.0.jar"), "The new jar replaces the old one.");
  await assert.rejects(mods.updateMod({ instanceId: "fabric-server", fileName: "handmade.jar" }), (error) => error.code === "MOD_NOT_TRACKED");

  await mods.removeMod({ instanceId: "fabric-server", fileName: "lithium-0.14.0.jar" });
  assert(!world.files.has("mods/lithium-0.14.0.jar"));
  assert(!JSON.parse(world.files.get(`mods/${mods.MANIFEST_NAME}`).toString("utf8")).mods["lithium-0.14.0.jar"], "Removal clears the manifest entry.");
  return world;
}

async function safetyChecks(world) {
  const before = new Set(world.files.keys());
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "badhash" }), (error) => error.code === "MOD_CHECKSUM_MISMATCH");
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "offcdn" }), (error) => error.code === "MOD_DOWNLOAD_HOST_NOT_ALLOWED");
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "traversal" }), (error) => error.code === "MOD_FILE_INVALID");
  assert.deepStrictEqual([...world.files.keys()].filter((key) => !before.has(key)), [], "A refused install writes nothing.");
  assert(!world.downloads.includes("https://evil.example.com/x.jar"), "Off-CDN files are never downloaded.");
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "../x" }), (error) => error.code === "MOD_PROJECT_INVALID");
  await assert.rejects(mods.removeMod({ instanceId: "fabric-server", fileName: "../server.properties" }), (error) => error.code === "MOD_FILE_INVALID");
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "nothing" }), (error) => error.code === "MOD_VERSION_NOT_FOUND");
  world.setInstance({ id: "vanilla", serverSoftware: "Vanilla", minecraftVersion: "1.21.1" });
  await assert.rejects(mods.listMods({ instanceId: "vanilla" }), (error) => error.code === "MODS_UNSUPPORTED");
}

function contractChecks() {
  const root = path.join(__dirname, "..");
  const ipc = fs.readFileSync(path.join(root, "src", "ipc", "instancesIpc.js"), "utf8");
  for (const channel of ["install", "setEnabled", "remove", "update"]) {
    assert(new RegExp(`"instances:mods:${channel}"[\\s\\S]{0,120}requirePermission\\("files:write"`).test(ipc), `instances:mods:${channel} needs files:write.`);
  }
  for (const channel of ["list", "search", "checkUpdates"]) {
    assert(new RegExp(`"instances:mods:${channel}"[\\s\\S]{0,120}requirePermission\\("instance:read"`).test(ipc), `instances:mods:${channel} is instance:read.`);
  }
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert(html.includes('data-instance-tab="mods" hidden') && html.includes('data-instance-panel="mods"'), "The Mods tab exists and is hidden unless supported.");
  const ui = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert(ui.includes('} else if (activeInstanceTab === "mods") {') && ui.includes("refreshInstanceMods();"), "Opening the tab loads the list.");
}

async function main() {
  contextChecks();
  const world = await lifecycleChecks();
  await safetyChecks(world);
  contractChecks();
  console.log("Mod Manager smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
